import logging
import os
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
from app.parsers.name_ocr import normalize_name

logger = logging.getLogger(__name__)

_CONFIDENCE_THRESHOLD = float(os.getenv("OCR_CONFIDENCE_THRESHOLD", "0.75"))
# Per-field thresholds: fall back to the global if the specific var is unset.
# Names have structurally lower Tesseract confidence than numeric fields
# (e.g. a correctly-read name can score ~0.29 on certain game fonts).
# rank/power/points are near-certain with whitelisted OCR so their thresholds
# sit higher; they are not wired to LLM fallback (the LLM only improves names).
_CONFIDENCE_THRESHOLD_NAME = float(
    os.getenv("OCR_CONFIDENCE_THRESHOLD_NAME", str(_CONFIDENCE_THRESHOLD))
)
_CONFIDENCE_THRESHOLD_RANK = float(
    os.getenv("OCR_CONFIDENCE_THRESHOLD_RANK", str(_CONFIDENCE_THRESHOLD))
)
_CONFIDENCE_THRESHOLD_POWER = float(
    os.getenv("OCR_CONFIDENCE_THRESHOLD_POWER", str(_CONFIDENCE_THRESHOLD))
)
_CONFIDENCE_THRESHOLD_POINTS = float(
    os.getenv("OCR_CONFIDENCE_THRESHOLD_POINTS", str(_CONFIDENCE_THRESHOLD))
)
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


def _apply_llm_fallback(
    image: np.ndarray,
    result: ParseResult | DonationParseResult,
    parser: BaseParser,
    force_all: bool = False,
) -> ParseResult | DonationParseResult:  # PlayerStatsParseResult is handled before this call
    """Generic LLM fallback: corrects member.name on rows below confidence threshold.

    Works for both event (MemberResult) and donation (DonationMember) shapes —
    only the `name` field is rewritten; all other fields are preserved verbatim.
    """
    from app.llm_fallback import llm_fallback

    row_height: int = getattr(parser, "row_height", 225)
    member_list_top: int = getattr(parser, "member_list_top", 400)

    updated: list[MemberResult | DonationMember] = []
    consecutive_failures = 0
    fallback_disabled = False
    members = cast(list[MemberResult | DonationMember], result.members)
    for i, member in enumerate(members):
        skip_low_conf = not force_all and member.confidence >= _CONFIDENCE_THRESHOLD_NAME
        if skip_low_conf or fallback_disabled:
            updated.append(member)
            continue

        reason = (
            "forced"
            if force_all
            else f"confidence {member.confidence:.2f} < threshold {_CONFIDENCE_THRESHOLD_NAME:.2f}"
        )
        logger.info("LLM fallback triggered for %r (row %d): %s", member.name, i, reason)

        # Bande réellement découpée par le parser : l'index dans `members` ne
        # correspond pas à l'index physique de la ligne (les lignes invalides
        # sont éliminées), et list_top / row_height effectifs diffèrent des
        # constantes de classe (_detect_list_top dynamique, scaling h/2400 du
        # parser donation). Recalculer ici décalait le crop et attribuait le
        # nom d'un joueur à un autre. Les constantes ne servent plus que de
        # filet de sécurité si un parser n'a pas renseigné row_y/row_h.
        y = member.row_y if member.row_y is not None else member_list_top + i * row_height
        crop_h = member.row_h if member.row_h is not None else row_height
        row_crop: np.ndarray = image[y : y + crop_h, :]
        try:
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
                i,
            )
            updated.append(member)
            if consecutive_failures >= _LLM_MAX_CONSECUTIVE_FAILURES:
                fallback_disabled = True
                logger.warning(
                    "LLM fallback disabled for remaining rows after %d consecutive failures",
                    consecutive_failures,
                )

    return result.model_copy(update={"members": updated})


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

    # Index LLM results by name for O(1) lookup
    llm_by_name: dict[str, Any] = {m["name"]: m for m in llm_members if m.get("name")}

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
    member: MemberResult | DonationMember, new_name: str
) -> MemberResult | DonationMember:
    """Return a copy of `member` with `name` replaced and confidence flagged as LLM-corrected."""
    new_name = normalize_name(new_name)
    if isinstance(member, MemberResult):
        return MemberResult(
            name=new_name,
            rank=member.rank,
            power=member.power,
            points=member.points,
            confidence=-1.0,
            trace=member.trace,
            row_y=member.row_y,
            row_h=member.row_h,
        )
    return DonationMember(
        name=new_name,
        alliance_tag=member.alliance_tag,
        rank=member.rank,
        alliance_honor=member.alliance_honor,
        confidence=-1.0,
        trace=member.trace,
        row_y=member.row_y,
        row_h=member.row_h,
    )
