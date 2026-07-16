"""Parser for the Alliance Honor "Contribution Ranking" screen (donation tracking).

Layout (canonical 1080×2400 Android portrait, after preprocess to grayscale):

    y=0..200    Header (back arrow + title "Contribution Ranking")
    y=200..320  Tab band (Daily / Weekly / History) — selected pill detected by
                gray-level outlier among the three tab zones (_detect_selected_tab)
    y=320..395  Column headers (Rank / Commander Name / Alliance Honor)
    y=395..     12 member rows of ~175 px each

Each row contains:
    x=0..170     Rank column (digit OR gold/silver/bronze trophy for top 3)
    x=140..240   Avatar with an R1..R5 disc badge overlaid in the upper-left
    x=240..760   Commander name, prefixed by an alliance tag like "(SOD) "
    x=760..1080  Alliance Honor integer (the contribution score)

This parser intentionally:
  * does NOT OCR the rank column (the row order already encodes the ranking,
    and trophy icons would otherwise be misread as digits "1", "2", "3");
  * does NOT extract a power value (donations have no power column);
  * uses a simple `validate_donation_member` check (name + honor ≥ 0).

The R-badge detection is imported from PolarInvasionV1Parser; the name-OCR
helpers (Cyrillic disambiguation, word joining, misread fixes) come from the
shared ``app.parsers.name_ocr`` module. This parser joins OCR words with a
space (names on the donation screen keep their spaces), hence the local
``_words_from_data`` wrapper.
"""

import logging
import os
import re
from typing import Any, Literal

import cv2
import numpy as np

from app import tess_engine as pytesseract
from app.parsers._trace import FieldBox, RowTrace
from app.parsers.base import BaseParser, DonationMember, DonationParseResult
from app.parsers.name_ocr import (
    disambiguate_cyrillic,
    fix_name_substitutions,
    normalize_name,
    words_from_data,
)
from app.parsers.polar_invasion_v1 import _detect_rank_from_crop
from app.tess_engine import Output
from app.validators import (
    parse_number,
    validate_donation_member,
)

logger = logging.getLogger(__name__)

# ── Layout constants at TARGET_WIDTH=1080 px, canonical height 2400 px ───────
CANONICAL_HEIGHT = 2400

_HEADER_Y = (0, 200)
_TABS_Y = (200, 320)

# Centre x-ranges of the three tab buttons, in canonical selection order.
_TAB_X = {
    "daily": (60, 370),
    "weekly": (380, 700),
    "history": (710, 1020),
}
_TABS_ORDER: tuple[str, ...] = ("daily", "weekly", "history")

# Tab detection fires only when the selected pill's mean gray level deviates
# from the median of the three tab zones by at least this many levels. On the
# real (dark-theme, inverted) weekly fixtures the selected pill sits ~9 levels
# off the two unselected tabs, which cluster within <1 level of each other; a
# threshold of 4 cleanly separates that signal from noise while a flat/blank
# band (deviation ≈ 0) falls back to the safe default below.
_TAB_DETECT_MIN_DELTA: float = float(os.getenv("OCR_TAB_DETECT_MIN_DELTA", "4.0"))
# Weekly is the safe default: every shipped capture is a Weekly leaderboard and
# the bot only ingests weekly (upsert.ts rejects other period types), so an
# undetectable band degrades to the historically-correct value.
_DEFAULT_PERIOD_TYPE: Literal["weekly"] = "weekly"

_MEMBER_LIST_TOP = 395  # y-start of first row (canonical)
_ROW_HEIGHT = 175  # 12 rows fit in ~2100 px after the tabs/headers band
_MAX_ROWS = 12

# Badge crop for R1..R5 detection. Same x as polar invasion (identical avatar
# widget), but a taller y window: the donation screen packs 12 rows, so the
# fixed 175 px pitch drifts a couple of pixels per row and by rows 10-11 the
# badge slides below a tight (15, 65) window — the detector then misreads the
# partial disc as R4. The taller band absorbs that drift (rank 85%→99% on the
# fixtures) while staying within the avatar's upper-left, so it never catches a
# neighbouring badge.
_RANK_BADGE_X = (148, 200)
_RANK_BADGE_Y = (15, 90)

# Name and alliance-honor crops within each row.
_NAME_X = (240, 760)
_NAME_Y_OFF = (45, 130)
# A long pseudo wraps to a 2nd line: the "(SOD)" tag stays on line 1 while the
# name drops to line 2, so the line-1 crop above comes back empty and the row
# would be dropped. This lower band grabs that 2nd line — used only as a
# fallback when the primary crop yields nothing (see _ocr_name).
_NAME_WRAP_Y_OFF = (85, 160)
_HONOR_X = (770, 1060)
_HONOR_Y_OFF = (40, 130)

# Public aliases consumed by extract.py for LLM-fallback row slicing.
MEMBER_LIST_TOP = _MEMBER_LIST_TOP
ROW_HEIGHT = _ROW_HEIGHT

# "(SOD) jeinsolaya" → tag="SOD", name="jeinsolaya"
# Tag is 1..5 alphanumerics inside parentheses, optionally followed by spaces.
# [^(]{0,6} tolerates a short run of leading OCR artifacts before the opening
# paren — not just non-letters. The avatar frequently bleeds a letter-like
# glyph into the left of the name crop ("x (SOD) Аня", "Sai (SOD) CumStang",
# "D| (SOD) Noside"); the previous [^A-Za-z(]* excluded letters and so left the
# whole "(SOD) Name" un-stripped. The 6-char cap keeps a genuinely tag-less
# name (no "(" at all → no match) untouched while covering the widest bleed
# observed (~5 chars incl. the gap). \s* inside the parens tolerates a space
# Tesseract occasionally inserts.
_ALLIANCE_TAG_RE = re.compile(r"^\s*[^(]{0,6}\(\s*([A-Za-z0-9]{1,5})\s*\)\s*")

# ASCII fast-path: same logic as polar_invasion_v1 — eng-only first, escalate
# to full multilang only when result is non-ASCII or confidence is too low.
_ASCII_FAST_PATH_ENABLED: bool = (
    os.getenv("OCR_NAME_ASCII_FAST_PATH_ENABLED", "true").lower() == "true"
)
_ASCII_FAST_PATH_MIN_CONF: float = float(os.getenv("OCR_NAME_ASCII_FAST_PATH_MIN_CONF", "0.60"))
_ASCII_RE = re.compile(r"^[A-Za-z0-9_|§\-\.]+$")


def _words_from_data(data: dict[str, Any], min_conf: int = 20) -> str:
    # Jointure avec espace (contrairement à polar) : les noms du classement de
    # dons conservent leurs espaces.
    return words_from_data(data, min_conf=min_conf, sep=" ")


def _strip_alliance_tag(raw: str) -> tuple[str | None, str]:
    """Split "(TAG) Name" → ("TAG", "Name"). Returns (None, raw) when no tag."""
    if not raw:
        return None, raw
    m = _ALLIANCE_TAG_RE.match(raw)
    if not m:
        return None, raw.strip()
    return m.group(1), raw[m.end() :].strip()


class ContributionRankingV1Parser(BaseParser):
    """Parser for the weekly Alliance Honor leaderboard (V1)."""

    member_list_top: int = MEMBER_LIST_TOP
    row_height: int = ROW_HEIGHT

    def parse(
        self,
        image: np.ndarray,
        emit_trace: bool = False,
        event_code: str | None = None,
    ) -> DonationParseResult:
        h = image.shape[0]
        scale = h / CANONICAL_HEIGHT

        row_h = max(1, int(_ROW_HEIGHT * scale))
        list_top = self._detect_list_top(image, scale)

        period_type = self._detect_selected_tab(image, scale)

        members: list[DonationMember] = []
        consecutive_none = 0
        name_end_offset = int(_NAME_Y_OFF[1] * scale)
        # Per-image cache of the (threshold, psm) combo that won the last
        # rank vote; mirrors PolarInvasionV1Parser.parse.
        rank_cache: dict[str, tuple[int, int] | None] = {"last": None}
        for i in range(_MAX_ROWS):
            y = list_top + i * row_h
            if y + name_end_offset > h:
                break
            member = self._parse_row(
                image,
                y,
                row_h,
                scale,
                emit_trace=emit_trace,
                list_top=list_top,
                row_index=i,
                rank_cache=rank_cache,
            )
            if member is None:
                consecutive_none += 1
                if consecutive_none >= 3:
                    break
                continue
            consecutive_none = 0
            if validate_donation_member(member):
                members.append(member)

        return DonationParseResult(period_type=period_type, members=members)

    # ── Tab detection ────────────────────────────────────────────────────────
    #
    # The Daily / Weekly / History pills sit in the _TABS_Y band. The selected
    # pill carries a solid highlight fill while the two unselected ones share the
    # same flat background, so after preprocess (grayscale, inverted for the
    # game's dark theme) the selected zone's mean gray level is the clear outlier
    # of the three — measured at ~9 levels off a <1-level cluster on all nine
    # weekly fixtures. We pick the zone whose mean deviates most from the median
    # of the three; direction (lighter vs darker) is not assumed, so the rule
    # holds whether or not preprocess inverted the frame. Sampling the "red"
    # density the original UI uses is not possible here — parse() only ever sees
    # the preprocessed grayscale image — but the intensity outlier carries the
    # same information.

    def _detect_selected_tab(
        self, image: np.ndarray, scale: float
    ) -> Literal["daily", "weekly", "history"]:
        h, w = image.shape[:2]
        y0 = int(_TABS_Y[0] * scale)
        y1 = int(_TABS_Y[1] * scale)
        if y1 <= y0 or y1 > h:
            return _DEFAULT_PERIOD_TYPE

        means: list[float] = []
        for name in _TABS_ORDER:
            xa, xb = _TAB_X[name]
            xa = min(xa, w)
            xb = min(xb, w)
            if xb - xa < 2:
                return _DEFAULT_PERIOD_TYPE
            band = image[y0:y1, xa:xb]
            if band.ndim == 3:
                band = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
            means.append(float(band.mean()))

        median = sorted(means)[1]
        deviations = [abs(m - median) for m in means]
        idx = max(range(len(_TABS_ORDER)), key=lambda i: deviations[i])
        if deviations[idx] < _TAB_DETECT_MIN_DELTA:
            logger.debug(
                "donation tab: no pill stands out (means=%s, delta=%.1f < %.1f) → default %s",
                [round(m, 1) for m in means],
                deviations[idx],
                _TAB_DETECT_MIN_DELTA,
                _DEFAULT_PERIOD_TYPE,
            )
            return _DEFAULT_PERIOD_TYPE

        selected = _TABS_ORDER[idx]
        logger.debug(
            "donation tab: selected=%s (means=%s, delta=%.1f)",
            selected,
            [round(m, 1) for m in means],
            deviations[idx],
        )
        return selected  # type: ignore[return-value]

    # ── List top detection ───────────────────────────────────────────────────

    def _detect_list_top(self, image: np.ndarray, scale: float) -> int:
        """Locate the y-start of the first member row.

        After preprocess the image is grayscale on a light background with dark
        text. We scan the column where Commander Names live (x=270..720) for
        text-density bands; the first band whose centre lies below the column
        header (y > 350×scale) marks the first row's name line. We then
        back-compute row_top so the name crop _NAME_Y_OFF=(45, 130) is centred
        on it.
        """
        canonical_top = int(_MEMBER_LIST_TOP * scale)
        h = image.shape[0]
        search_start = max(0, int(330 * scale))
        search_end = min(h, canonical_top + int(180 * scale))
        if search_end - search_start < 40:
            return canonical_top

        strip = image[search_start:search_end, 270:720]
        if strip.ndim == 3:
            gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)
        else:
            gray = strip

        text_signal = 255.0 - gray.astype(np.float32)
        row_score = text_signal.mean(axis=1)

        baseline = float(np.percentile(row_score, 20))
        peak = float(row_score.max())
        span = peak - baseline
        if span < 15.0:
            return canonical_top

        threshold = baseline + span * 0.25
        above = row_score > threshold

        # First sustained band (≥ 8 rows) is the first member name.
        run_start: int | None = None
        first_band_centre: int | None = None
        for i, v in enumerate(above):
            if v and run_start is None:
                run_start = i
            elif not v and run_start is not None:
                if i - run_start >= 8:
                    first_band_centre = (run_start + i) // 2
                    break
                run_start = None
        if first_band_centre is None and run_start is not None and len(above) - run_start >= 8:
            first_band_centre = (run_start + len(above)) // 2

        if first_band_centre is None:
            return canonical_top

        name_centre_y = search_start + first_band_centre
        # _NAME_Y_OFF=(45, 130) → centre at 87 relative to row_top.
        name_centre_offset = int(((_NAME_Y_OFF[0] + _NAME_Y_OFF[1]) / 2) * scale)
        result = name_centre_y - name_centre_offset
        result = max(0, min(h - 1, result))
        logger.debug(
            "donation list_top: canonical=%d name_centre=%d result=%d",
            canonical_top,
            name_centre_y,
            result,
        )
        return int(result)

    # ── Row parsing ──────────────────────────────────────────────────────────

    def _parse_row(
        self,
        image: np.ndarray,
        y: int,
        row_h: int,
        scale: float,
        emit_trace: bool = False,
        list_top: int = 0,
        row_index: int = 0,
        rank_cache: dict[str, tuple[int, int] | None] | None = None,
    ) -> DonationMember | None:
        rank = self._detect_rank(image, y, scale, rank_cache=rank_cache)
        raw_name, name_data = self._ocr_name(image, y, scale)
        if not raw_name:
            return None
        raw_name = normalize_name(raw_name)

        # Strip a leading 1-2 digit rank number that bleeds from the rank column
        # into the name crop when alignment drifts.  Handles "6 Name" → "Name".
        # The alliance-tag regex already covers "6 (TAG) Name" via [^A-Za-z(]*.
        raw_name = re.sub(r"^\s*\d{1,2}\s+", "", raw_name)

        tag, name = _strip_alliance_tag(raw_name)
        name = fix_name_substitutions(name)

        honor = self._ocr_honor(image, y, scale)
        if honor is None:
            return None

        confs = [int(c) for c in name_data["conf"] if str(c).lstrip("-").isdigit() and int(c) >= 0]
        confidence = sum(confs) / (len(confs) * 100) if confs else 0.0

        trace: RowTrace | None = None
        if emit_trace:
            ny1 = y + int(_NAME_Y_OFF[0] * scale)
            ny2 = y + int(_NAME_Y_OFF[1] * scale)
            hy1 = y + int(_HONOR_Y_OFF[0] * scale)
            hy2 = y + int(_HONOR_Y_OFF[1] * scale)
            ry1 = y + int(_RANK_BADGE_Y[0] * scale)
            ry2 = y + int(_RANK_BADGE_Y[1] * scale)
            trace = RowTrace(
                list_top=list_top,
                row_index=row_index,
                row_height=row_h,
                name=FieldBox(y1=ny1, y2=ny2, x1=_NAME_X[0], x2=_NAME_X[1]),
                rank=FieldBox(y1=ry1, y2=ry2, x1=_RANK_BADGE_X[0], x2=_RANK_BADGE_X[1]),
                alliance_honor=FieldBox(y1=hy1, y2=hy2, x1=_HONOR_X[0], x2=_HONOR_X[1]),
            )

        return DonationMember(
            name=name,
            alliance_tag=tag,
            rank=rank or "",
            alliance_honor=honor,
            confidence=confidence,
            trace=trace,
            row_y=y,
            row_h=row_h,
        )

    # ── R-badge detection (R1..R5) ───────────────────────────────────────────

    def _detect_rank(
        self,
        image: np.ndarray,
        y: int,
        scale: float,
        rank_cache: dict[str, tuple[int, int] | None] | None = None,
    ) -> str | None:
        """Multi-threshold + multi-PSM rank detection with empirical-order early exit.

        Delegates the OCR sweep to :func:`_detect_rank_from_crop` (shared with
        PolarInvasionV1Parser).  The ``rank_cache`` dict carries the
        (threshold, psm) combo that worked on the previous row so the early
        exit can fire on attempt 1 when lighting is uniform across the
        screenshot.  Defaults to R1 when no strategy yields a hit — same
        rationale as the event parser; the "viewer" highlighted row has no
        R-badge frame and falls through to this default.
        """
        h = image.shape[0]
        y1 = y + int(_RANK_BADGE_Y[0] * scale)
        y2 = y + int(_RANK_BADGE_Y[1] * scale)
        if y1 >= h or y2 > h:
            return None
        crop = image[y1:y2, _RANK_BADGE_X[0] : _RANK_BADGE_X[1]]
        if crop.size == 0:
            return None

        last = rank_cache["last"] if rank_cache is not None else None
        rank, winning_combo = _detect_rank_from_crop(crop, last_winning_combo=last)
        if rank_cache is not None and winning_combo is not None:
            rank_cache["last"] = winning_combo
        return rank

    # ── Name OCR (multilingual) ──────────────────────────────────────────────

    def _ocr_name(self, image: np.ndarray, y: int, scale: float) -> tuple[str, dict[str, Any]]:
        ny1 = y + int(_NAME_Y_OFF[0] * scale)
        ny2 = y + int(_NAME_Y_OFF[1] * scale)
        crop = image[ny1:ny2, _NAME_X[0] : _NAME_X[1]]
        if crop.size == 0:
            return "", {"text": [], "conf": [], "left": []}

        crop_2x = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        if _ASCII_FAST_PATH_ENABLED:
            _fp_data = pytesseract.image_to_data(
                crop_2x,
                config="--psm 7 -l eng+rus -c load_system_dawg=0 -c load_freq_dawg=0",
                output_type=Output.DICT,
            )
            _fp_name = _words_from_data(_fp_data, min_conf=10)
            _fp_confs = [
                int(c) for c in _fp_data["conf"] if str(c).lstrip("-").isdigit() and int(c) >= 0
            ]
            _fp_conf = sum(_fp_confs) / (len(_fp_confs) * 100) if _fp_confs else 0.0
            _fp_reliable = (
                _ASCII_RE.match(_fp_name)
                and len(_fp_name) >= 3
                and _fp_conf > _ASCII_FAST_PATH_MIN_CONF
            )
            if _fp_reliable:
                data = _fp_data
                name = _fp_name
                logger.debug("row y=%d name fast-path HIT: %r conf=%.2f", y, _fp_name, _fp_conf)
            else:
                logger.debug("row y=%d name fast-path MISS: %r conf=%.2f", y, _fp_name, _fp_conf)
                data = pytesseract.image_to_data(
                    crop_2x,
                    config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                    output_type=Output.DICT,
                )
                name = _words_from_data(data, min_conf=10)
        else:
            data = pytesseract.image_to_data(
                crop_2x,
                config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                output_type=Output.DICT,
            )
            name = _words_from_data(data, min_conf=10)

        # Last-resort contrast stretch for low-contrast (coloured) names.
        if len(name) < 2:
            norm_crop = cv2.normalize(crop_2x, None, 0, 255, cv2.NORM_MINMAX)  # type: ignore[call-overload]
            data = pytesseract.image_to_data(
                norm_crop,
                config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                output_type=Output.DICT,
            )
            name = _words_from_data(data, min_conf=10)

        # Wrapped-name fallback: still empty means the pseudo very likely wrapped
        # to a 2nd line (tag alone on line 1). Re-OCR the lower band to recover
        # it so the row isn't dropped — a single dropped row would shift every
        # following row under the bench's positional comparison. Fallback-only,
        # so single-line rows are never re-cropped.
        if len(name) < 2:
            wy1 = y + int(_NAME_WRAP_Y_OFF[0] * scale)
            wy2 = y + int(_NAME_WRAP_Y_OFF[1] * scale)
            wrap_crop = image[wy1:wy2, _NAME_X[0] : _NAME_X[1]]
            if wrap_crop.size:
                wrap_2x = cv2.resize(wrap_crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
                wrap_data = pytesseract.image_to_data(
                    wrap_2x,
                    config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                    output_type=Output.DICT,
                )
                wrap_name = _words_from_data(wrap_data, min_conf=10)
                if len(wrap_name) >= 2:
                    name, data, crop_2x = wrap_name, wrap_data, wrap_2x

        # Cyrillic-vs-Latin disambiguation — retourne name ET data de la passe
        # gagnante, pour que la confiance calculée par l'appelant (et donc le
        # déclenchement du fallback LLM) reflète le nom réellement retourné.
        name, data = disambiguate_cyrillic(crop_2x, name, data, sep=" ")

        return name, data

    # ── Alliance Honor OCR ───────────────────────────────────────────────────

    def _ocr_honor(self, image: np.ndarray, y: int, scale: float) -> int | None:
        hy1 = y + int(_HONOR_Y_OFF[0] * scale)
        hy2 = y + int(_HONOR_Y_OFF[1] * scale)
        crop = image[hy1:hy2, _HONOR_X[0] : _HONOR_X[1]]
        if crop.size == 0:
            return None

        crop_2x = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        # Whitelist commas in case the game ever shows >999 with a thousand
        # separator. Honor values up to ~10K in the fixtures, no comma observed,
        # but keeping it costs nothing.
        text = pytesseract.image_to_string(
            crop_2x,
            config="--psm 7 -c tessedit_char_whitelist=0123456789,",
        ).strip()
        val = parse_number(text)
        if val is not None and val >= 0:
            return val

        # Fallback: contrast stretch when the digits are coloured (e.g. green
        # on the viewer's highlighted row, like rank 18 in fixture).
        norm = cv2.normalize(crop_2x, None, 0, 255, cv2.NORM_MINMAX)  # type: ignore[call-overload]
        text = pytesseract.image_to_string(
            norm,
            config="--psm 7 -c tessedit_char_whitelist=0123456789,",
        ).strip()
        val = parse_number(text)
        if val is not None and val >= 0:
            return val
        return None
