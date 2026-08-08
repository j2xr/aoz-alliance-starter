import logging
import os
import re
from typing import Any, cast

import numpy as np

from app.dispatcher import DONATION_CODE, PLAYER_STATS_CODE, detect_screen_kind
from app.parsers import get_parser
from app.parsers.base import (
    BaseParser,
    DonationMember,
    DonationParseResult,
    MemberResult,
    ParseResult,
    PlayerStatsMember,
    PlayerStatsParseResult,
)
from app.parsers.contribution_ranking_v1 import _strip_alliance_tag
from app.parsers.name_ocr import fix_name_substitutions, normalize_name

# Leading rank-column digits that bleed into the name — mirrors the same
# cleanup step in ContributionRankingV1Parser._parse_row.
_LEADING_RANK_RE = re.compile(r"^\s*\d{1,2}\s+")

logger = logging.getLogger(__name__)

_CONFIDENCE_THRESHOLD = float(os.getenv("OCR_CONFIDENCE_THRESHOLD", "0.75"))
# Weak, low confidence floor kept as ONE input among the orthogonal misread
# signals below — NOT the old 0.75 primary gate. Tesseract name confidence is
# anti-correlated with correctness (measured: wrong names average 0.71, correct-
# but-flagged 0.64; several pure-garbage reads score 1.00), so triggering the LLM
# on `confidence < 0.75` spent ~19% of calls on already-correct rows while
# skipping high-confidence garbage. `looks_like_misread` (which inspects the OCR
# output itself) is the primary trigger; this floor only adds a look at a
# genuinely uncertain read whose output happens to look clean.
_CONF_FLOOR_NAME = float(os.getenv("OCR_LLM_NAME_CONF_FLOOR", "0.35"))

# Frame/junk debris a real handle essentially never contains — chat-bubble
# borders, currency, math symbols. `~ ^ —` are deliberately NOT here: they occur
# in real decorated handles (e.g. `~Loki~`).
_LLM_JUNK_CHARS = frozenset("|\\«»№<>§¢")
# Punctuation/decoration legitimate in a handle, so it never reads as junk.
_LLM_NAME_PUNCT = frozenset("._-•⚓←→'’`.,()[]! *~^")
# Below this alphanumeric share the output is mostly symbols → almost certainly a
# misread ("A > №", "¢ JE", "= mm ..", "{ (LOL)").
_LLM_MIN_ALNUM_RATIO = 0.6
# Script blocks a legitimate handle can use: Latin (+ accents/Vietnamese),
# Cyrillic, CJK/kana, Hangul, plus a few decoration blocks. A char outside all of
# these (and not allowed punctuation/digit) is OCR noise, not a handle.
_ALLOWED_SCRIPT_RANGES: tuple[tuple[int, int], ...] = (
    (0x00C0, 0x024F),  # Latin-1 supplement + extended (accents, Đ, Ø …)
    (0x1E00, 0x1EFF),  # Latin extended additional (Vietnamese, Ṣ)
    (0x0400, 0x04FF),  # Cyrillic
    (0x3040, 0x30FF),  # hiragana + katakana (incl. ・ ー)
    (0x3400, 0x9FFF),  # CJK unified
    (0xF900, 0xFAFF),  # CJK compatibility
    (0xAC00, 0xD7A3),  # Hangul syllables
    (0x1100, 0x11FF),  # Hangul jamo
    (0x2020, 0x2022),  # dagger, double dagger, bullet
    (0x2190, 0x21FF),  # arrows
    (0x2460, 0x24FF),  # enclosed alphanumerics (circled)
    (0x1F000, 0x1FAFF),  # emoji / pictographs
)


def _char_out_of_script(ch: str) -> bool:
    """True when a character belongs to no script a real handle would use."""
    if ch.isspace() or ch.isdigit() or ch in _LLM_NAME_PUNCT:
        return False
    if ch.isascii() and ch.isalpha():
        return False
    cp = ord(ch)
    return not any(lo <= cp <= hi for lo, hi in _ALLOWED_SCRIPT_RANGES)


def looks_like_misread(name: str) -> bool:
    """Heuristic (OCR-output-only) that a name is a garbage misread worth the LLM.

    Orthogonal to Tesseract confidence (see `_CONF_FLOOR_NAME`): fires on the
    *shape* of the output — frame debris, a low alphanumeric share, an
    out-of-script character, or a near-empty read. These catch the confident
    garbage the confidence gate missed (`علE`→`¢ JE`, `Bulleit`→`A > №`,
    `ÐÃŘĶ§ĮĐĒ•築`→`ĐÄRK§|ĐE s 3Š`) with near-zero waste on correct names.

    It cannot catch a *clean-but-wrong* misread (`VTN`→`VIN`, `GOAT••`→`GOATe e`):
    that output looks like a valid handle, so no output-only signal separates it
    from a correct read — those are the roster-collision path's job, not this.
    """
    s = name.strip()
    if sum(1 for c in s if c.isalnum()) < 2:
        return True
    if any(c in _LLM_JUNK_CHARS for c in s):
        return True
    if sum(1 for c in s if c.isalnum()) / len(s) < _LLM_MIN_ALNUM_RATIO:
        return True
    return any(_char_out_of_script(c) for c in s)


# Confidence assigned when a suspect alliance_honor (flagged by
# _enforce_honor_monotonicity, which could not itself confirm a fix) is
# replaced by an LLM score that fits the same monotonicity window. Distinct
# from the -1.0 sentinel used for an accepted *name* correction: -1.0 means
# an independently-produced, UNSUSPECTED number was exactly confirmed; here
# the OCR honor is already known wrong and the corroboration is interval
# membership, which _enforce_honor_monotonicity's own docstring calls a
# plausibility check, not proof of correctness. 0.45 lands inside
# needsReview()'s exclusive [0, 0.5) bound (apps/discord-bot/src/lib/
# upsert.ts) on purpose: best estimate available, flagged for confirmation.
_LLM_HONOR_REPLACED_CONFIDENCE = 0.45
_LLM_FALLBACK_ENABLED = os.getenv("LLM_FALLBACK_ENABLED", "false").lower() == "true"
# Stop calling the LLM after this many CONSECUTIVE failures within a single
# image (the counter resets on any success). When Ollama is OOM or the model is
# overloaded every call hits the httpx timeout (OLLAMA_TIMEOUT_SECONDS, default
# 300s), so without a cap an 11-row image would hang the OCR service for
# minutes and the Discord bot fetch would drop the connection.
#
# Default 2, not 1: a single transient blip — one slow row, a momentary
# connection reset, a lone malformed JSON — should not disable the LLM for every
# remaining row of the image. Two *consecutive* failures still trip the breaker,
# so a genuinely-down Ollama is abandoned after at most 2×timeout rather than
# grinding through the whole list. Raise it if transient blips are common on
# your host; lower it (or OLLAMA_TIMEOUT_SECONDS) if the worst-case hang matters
# more than salvaging names after a blip.
_LLM_MAX_CONSECUTIVE_FAILURES = int(os.getenv("LLM_MAX_CONSECUTIVE_FAILURES", "2"))


def extract(
    image: np.ndarray,
    event_type_override: str | None = None,
    force_llm: bool = False,
) -> ParseResult | DonationParseResult | PlayerStatsParseResult:
    if event_type_override == DONATION_CODE:
        screen_kind: str = "donation"
        code = DONATION_CODE
        logger.info("Screen kind forced to donation (skipping header detection)")
    elif event_type_override == PLAYER_STATS_CODE:
        screen_kind = "player_stats"
        code = PLAYER_STATS_CODE
        logger.info("Screen kind forced to player_stats (skipping header detection)")
    elif event_type_override:
        screen_kind = "event"
        code = event_type_override
        logger.info("Event type forced to %r (skipping header detection)", code)
    else:
        screen_kind, code = detect_screen_kind(image)

    parser = get_parser(code)
    if parser is None:
        raise ValueError(f"No parser registered for code: {code}")

    result = parser.parse(image, event_code=code)

    if isinstance(result, PlayerStatsParseResult):
        if _LLM_FALLBACK_ENABLED or force_llm:
            result = _apply_llm_fallback_player_stats(image, result, force_all=force_llm)
        n = len(result.members)
        avg_conf = sum(m.confidence for m in result.members) / n if n else 0.0
        logger.info("Extracted %d player stats (avg confidence %.2f)", n, avg_conf)
        return result

    if isinstance(result, ParseResult):
        # The parser may hardcode its own event_type; override with the dispatcher's
        # detection so the result always reflects the actual event on screen.
        if result.event_type != code:
            result = result.model_copy(update={"event_type": code})

    if _LLM_FALLBACK_ENABLED or force_llm:
        result = _apply_llm_fallback(image, result, parser, force_all=force_llm)

    n = len(result.members)
    avg_conf = sum(m.confidence for m in result.members) / n if n else 0.0
    logger.info("Extracted %d members (avg confidence %.2f, kind=%s)", n, avg_conf, screen_kind)
    return result


def _physical_row(member: MemberResult | DonationMember, i: int) -> int:
    """Physical on-screen row slot for log messages only — nothing downstream
    keys off this value.

    `i` is the member's index in the parser's already-compacted `members`
    list; a row dropped upstream (unreadable, failed validation) shifts
    every later index away from what's actually visible in the screenshot.
    `DonationMember.row_index` carries the true physical slot, assigned by
    the donation parser before any row is dropped (see
    ContributionRankingV1Parser._parse_row / _repair_position_sequence's
    docstring for the same distinction). `MemberResult` (event rows) has no
    such concept — event parsers don't track it — so those keep `i`,
    unchanged from before this helper existed.
    """
    if isinstance(member, DonationMember) and member.row_index is not None:
        return member.row_index
    return i


def _apply_llm_fallback(
    image: np.ndarray,
    result: ParseResult | DonationParseResult,
    parser: BaseParser,
    force_all: bool = False,
) -> ParseResult | DonationParseResult:  # PlayerStatsParseResult is handled before this call
    """Generic LLM fallback: corrects member.name on rows that look misread.

    A row is sent to the LLM when its OCR name looks like a garbage misread
    (`looks_like_misread`), its confidence is below `_CONF_FLOOR_NAME`, its
    alliance_honor is flagged suspect, or `force_all` is set. Works for both
    event (MemberResult) and donation (DonationMember) shapes — only the `name`
    field is rewritten; all other fields are preserved verbatim.
    """
    from app.llm_fallback import llm_fallback, llm_fallback_donation

    row_height: int = getattr(parser, "row_height", 225)
    member_list_top: int = getattr(parser, "member_list_top", 400)

    updated: list[MemberResult | DonationMember] = []
    consecutive_failures = 0
    fallback_disabled = False
    members = cast(list[MemberResult | DonationMember], result.members)
    for i, member in enumerate(members):
        # A suspect alliance_honor must reach the LLM regardless of how the name
        # scores — coupling that decision to any name signal is exactly the class
        # of accident that let _MONOTONICITY_FIX_CONFIDENCE (0.5 before that fix)
        # sit above the old name threshold and never reach the LLM either.
        honor_suspect = (
            isinstance(member, DonationMember) and member.suspect_honor_window is not None
        )
        # Trigger orthogonally to Tesseract confidence (see looks_like_misread /
        # _CONF_FLOOR_NAME): the output *shape* predicts a garbage misread far
        # better than the (anti-correlated) confidence score. Confidence survives
        # only as a weak low floor.
        name_misread = looks_like_misread(member.name)
        should_try = (
            force_all or honor_suspect or name_misread or member.confidence < _CONF_FLOOR_NAME
        )
        if not should_try or fallback_disabled:
            updated.append(member)
            continue

        row = _physical_row(member, i)

        if force_all:
            reason = "forced"
        elif honor_suspect:
            window_repr = cast(DonationMember, member).suspect_honor_window
            reason = f"suspect_honor_window={window_repr}"
        elif name_misread:
            reason = f"name {member.name!r} looks like a misread"
        else:
            reason = f"confidence {member.confidence:.2f} < floor {_CONF_FLOOR_NAME:.2f}"
        logger.info("LLM fallback triggered for %r (row %d): %s", member.name, row, reason)

        # Band actually cropped by the parser: the index in `members` doesn't
        # match the row's physical index (invalid rows are dropped), and the
        # effective list_top / row_height differ from the class constants
        # (dynamic _detect_list_top, donation parser's h/2400 scaling).
        # Recomputing here used to shift the crop and attribute one player's
        # name to another. The constants now only serve as a safety net if a
        # parser didn't set row_y/row_h.
        y = member.row_y if member.row_y is not None else member_list_top + i * row_height
        crop_h = member.row_h if member.row_h is not None else row_height
        row_crop: np.ndarray = image[y : y + crop_h, :]
        try:
            if isinstance(member, DonationMember):
                llm_name, llm_score = llm_fallback_donation(row_crop)
                consecutive_failures = 0
                window = member.suspect_honor_window

                if window is None:
                    # Self-consistency gate: trust the corrected name only when
                    # the model also reads a score matching the OCR'd Alliance
                    # Honor — proof it read *this* row and not a notification
                    # banner overlaid on it (observed: a "X helped you …" toast
                    # was transcribed as a confident, wrong player name). A
                    # rejected correction is no worse than no fallback: we keep
                    # the (flagged, low-confidence) OCR name rather than a
                    # confident hallucination. Only reachable when the honor
                    # was never flagged suspect — see the window-is-set branch
                    # below for the case _enforce_honor_monotonicity already
                    # knows this value is wrong.
                    if not llm_name:
                        logger.info("LLM confirmed name for %r (no correction)", member.name)
                        updated.append(member)
                    elif llm_score != member.alliance_honor:
                        logger.warning(
                            "LLM correction rejected for %r → %r (row %d): read score %r "
                            "≠ OCR honor %d — likely a misaligned/overlaid read, keeping OCR",
                            member.name,
                            llm_name,
                            row,
                            llm_score,
                            member.alliance_honor,
                        )
                        # Flag the rejection itself: the original OCR confidence gave
                        # no signal that a correction was attempted and failed, so a
                        # row could look merely "low-confidence" when it's actually
                        # one we know is suspect. 0.0 forces needs_review downstream
                        # (see discord-bot upsert.ts) without touching the sentinel
                        # -1.0 used for an *accepted* LLM correction.
                        updated.append(member.model_copy(update={"confidence": 0.0}))
                    else:
                        new_name = str(llm_name)
                        if new_name != member.name:
                            logger.info(
                                "LLM corrected name for %r → %r (score %d confirms row)",
                                member.name,
                                new_name,
                                member.alliance_honor,
                            )
                        else:
                            logger.info("LLM confirmed name for %r (no correction)", member.name)
                        updated.append(_rewrite_name(member, new_name))
                    continue

                # Honor already known suspect: _enforce_honor_monotonicity's own
                # re-OCR gate already failed to prove — or actively disproved —
                # this value. Demanding exact equality against it (as the
                # window-is-None branch above does) can therefore never help;
                # judge the LLM's score against the SAME [lower, upper] window
                # the re-OCR gate used instead. Deliberately NOT requiring the
                # score also appear among the re-OCR candidates: the entire
                # point is that re-OCR never produced the true value.
                lower, upper = window
                if llm_score is None or not (lower <= llm_score <= upper):
                    logger.warning(
                        "LLM correction rejected for suspect-honor row %d (%r): score %r "
                        "not in monotonicity window [%d, %d] — keeping OCR honor %d, still flagged",
                        row,
                        member.name,
                        llm_score,
                        lower,
                        upper,
                        member.alliance_honor,
                    )
                    updated.append(member.model_copy(update={"confidence": 0.0}))
                    continue

                # Accept: even when the LLM returns no name, a usable score
                # must not be discarded — that short-circuit is what made this
                # gate circular in the first place.
                new_name = str(llm_name) if llm_name else member.name
                if llm_score != member.alliance_honor:
                    logger.warning(
                        "donation row %d: alliance_honor replaced %d → %d via LLM (fits "
                        "suspect window [%d, %d]; disagrees with the monotonicity re-OCR's "
                        "value — tracked here to observe the disagreement rate)",
                        row,
                        member.alliance_honor,
                        llm_score,
                        lower,
                        upper,
                    )
                else:
                    logger.info(
                        "donation row %d: LLM score %d confirms the suspect honor's current "
                        "value (window [%d, %d])",
                        row,
                        llm_score,
                        lower,
                        upper,
                    )
                corrected = _rewrite_name(
                    member, new_name, confidence=_LLM_HONOR_REPLACED_CONFIDENCE
                )
                updated.append(
                    corrected.model_copy(
                        update={"alliance_honor": llm_score, "suspect_honor_window": None}
                    )
                )
                continue

            llm_name = llm_fallback(row_crop)
            consecutive_failures = 0

            new_name = str(llm_name) if llm_name else member.name

            if new_name != member.name:
                logger.info("LLM corrected name for %r → %r", member.name, new_name)
            else:
                logger.info("LLM confirmed name for %r (no correction)", member.name)

            updated.append(_rewrite_name(member, new_name))
        except Exception:
            consecutive_failures += 1
            logger.exception(
                "LLM fallback failed for %r (row %d), keeping OCR result",
                member.name,
                row,
            )
            updated.append(member)
            if consecutive_failures >= _LLM_MAX_CONSECUTIVE_FAILURES:
                fallback_disabled = True
                logger.warning(
                    "LLM fallback disabled for remaining rows after %d consecutive failures",
                    consecutive_failures,
                )

    updated_result = result.model_copy(update={"members": updated})

    if isinstance(updated_result, DonationParseResult):
        # Observability only, not a fix: two adjacent suspect rows can each
        # satisfy a window computed against the other's PRE-replacement
        # value, so global monotonicity isn't guaranteed after this pass.
        donation_members = updated_result.members
        for i in range(1, len(donation_members)):
            prev_honor = donation_members[i - 1].alliance_honor
            if donation_members[i].alliance_honor > prev_honor:
                logger.warning(
                    "donation row %d: alliance_honor=%d still breaks monotonicity after "
                    "LLM fallback (previous row=%d)",
                    _physical_row(donation_members[i], i),
                    donation_members[i].alliance_honor,
                    prev_honor,
                )

    return updated_result


def _apply_llm_fallback_player_stats(
    image: np.ndarray,
    result: PlayerStatsParseResult,
    force_all: bool = False,
) -> PlayerStatsParseResult:
    """Full-image LLM fallback for player stats: re-extracts stats for candidate members.

    When force_all=True (force_llm in the API), every member is a candidate — mirrors
    the behaviour of _apply_llm_fallback for event/donation parsers.
    Otherwise only members below the confidence threshold are corrected.

    Sends the full screenshot once to the vision model and merges the returned stats
    with the OCR result; high-confidence members are preserved verbatim unless forced.
    """
    from app.llm_fallback import llm_fallback_player_stats

    candidate_count = (
        len(result.members)
        if force_all
        else sum(1 for m in result.members if m.confidence < _CONFIDENCE_THRESHOLD)
    )
    if candidate_count == 0:
        logger.info("LLM player_stats fallback: no candidates below threshold, skipping")
        return result

    logger.info(
        "LLM player_stats fallback: %d/%d candidate members (force_all=%s, threshold=%.2f)",
        candidate_count,
        len(result.members),
        force_all,
        _CONFIDENCE_THRESHOLD,
    )

    try:
        llm_members = llm_fallback_player_stats(image)
    except Exception:
        logger.exception("LLM player_stats fallback failed, keeping OCR result")
        return result

    if not llm_members:
        logger.warning("LLM player_stats fallback returned no members")
        return result

    # Index LLM results by name for O(1) lookup. Keyed by normalize_name so it
    # matches member.name (normalized by the OCR parser) even when the LLM
    # returns the same name in a different Unicode form (NFD, fullwidth, ...).
    llm_by_name: dict[str, Any] = {
        normalize_name(m["name"]): m for m in llm_members if m.get("name")
    }

    updated: list[PlayerStatsMember] = []
    for member in result.members:
        if not force_all and member.confidence >= _CONFIDENCE_THRESHOLD:
            updated.append(member)
            continue

        llm_entry = llm_by_name.get(member.name)
        if llm_entry is None:
            logger.debug("LLM player_stats: no match for OCR name %r, keeping as-is", member.name)
            updated.append(member)
            continue

        corrected = PlayerStatsMember(
            name=member.name,
            attack_pct=llm_entry.get("attack_pct")
            if llm_entry.get("attack_pct") is not None
            else member.attack_pct,
            attack_kind=member.attack_kind,
            hp_pct=llm_entry.get("hp_pct")
            if llm_entry.get("hp_pct") is not None
            else member.hp_pct,
            defense_pct=llm_entry.get("defense_pct")
            if llm_entry.get("defense_pct") is not None
            else member.defense_pct,
            confidence=-1.0,
            raw_lines=member.raw_lines,
        )
        logger.info(
            "LLM player_stats corrected %r: atk=%s hp=%s def=%s",
            member.name,
            corrected.attack_pct,
            corrected.hp_pct,
            corrected.defense_pct,
        )
        updated.append(corrected)

    return result.model_copy(update={"members": updated})


def _rewrite_name(
    member: MemberResult | DonationMember, new_name: str, confidence: float = -1.0
) -> MemberResult | DonationMember:
    """Return a copy of `member` with `name` replaced and confidence flagged as LLM-corrected.

    `confidence` defaults to the -1.0 sentinel (independently-produced value,
    exactly confirmed) but the suspect-honor-replacement path in
    `_apply_llm_fallback` passes `_LLM_HONOR_REPLACED_CONFIDENCE` instead —
    see that constant's comment for why the two cases are not treated alike.
    """
    new_name = normalize_name(new_name)
    if isinstance(member, MemberResult):
        return MemberResult(
            name=new_name,
            rank=member.rank,
            power=member.power,
            points=member.points,
            confidence=confidence,
            trace=member.trace,
            row_y=member.row_y,
            row_h=member.row_h,
        )
    # Run the LLM-corrected name through the SAME cleanup the parser applies to
    # its own OCR output (ContributionRankingV1Parser._parse_row): the vision
    # model returns the name verbatim including the "(SOD)" alliance tag, so
    # without this the tag leaks straight into `name` (observed in production:
    # "(SOD) BenOVerbich" stored as the player name). Strip a leading
    # rank-column bleed, split off the tag, then apply the misread fixes.
    tag_stripped = _LEADING_RANK_RE.sub("", new_name)
    tag, cleaned_name = _strip_alliance_tag(tag_stripped)
    cleaned_name = fix_name_substitutions(cleaned_name)
    return DonationMember(
        name=cleaned_name,
        # Prefer a tag freshly recovered from the LLM output; fall back to what
        # the parser had (the OCR pass that failed may still have caught it).
        alliance_tag=tag if tag is not None else member.alliance_tag,
        rank=member.rank,
        alliance_honor=member.alliance_honor,
        confidence=confidence,
        leaderboard_position=member.leaderboard_position,
        trace=member.trace,
        row_y=member.row_y,
        row_h=member.row_h,
        row_index=member.row_index,
        # Manually-copies-every-field hazard: without this, a field this
        # constructor doesn't know about is silently dropped. The caller
        # (suspect-honor replacement branch of _apply_llm_fallback) applies
        # its own override for this field via model_copy afterward; the
        # window-is-None path's default confidence=-1.0 call never sets a
        # suspect window in the first place, so it's None either way.
        suspect_honor_window=member.suspect_honor_window,
    )
