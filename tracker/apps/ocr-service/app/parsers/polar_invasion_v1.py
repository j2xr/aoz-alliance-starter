import logging
import os
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

import cv2
import numpy as np

from app import tess_engine as pytesseract
from app.parsers._trace import FieldBox, RowTrace
from app.parsers.base import BaseParser, MemberResult, ParseResult
from app.parsers.name_ocr import disambiguate_cyrillic, normalize_name
from app.parsers.name_ocr import fix_name_substitutions as _fix_name_substitutions
from app.parsers.name_ocr import mean_word_conf as _mean_word_conf
from app.parsers.name_ocr import words_from_data as _words_from_data
from app.parsers.run_detection import find_runs
from app.tess_engine import Output
from app.validators import maybe_swap_power_points, parse_number, validate_member

from .sword_icon_utils import mask_sword_icon

logger = logging.getLogger(__name__)

# ── Layout constants at TARGET_WIDTH=1080px ──────────────────────────────────
# Used by extract.py for LLM fallback row slicing.
# After preprocess() the image is always 1080px wide, but the game UI
# elements' pixel positions depend on which source produced the image: real
# phone screenshots (device aspect ratio only changes the visible bottom
# area, not the UI element pitch) vs. the 400x652 emulator source
# (aoz-alliance-starter#91), whose UI chrome has different proportions
# entirely — not just "less screen". `_Layout` bundles one profile's worth
# of crop constants; `parse()` selects which one applies per image (see
# `_layout_for_height`) rather than assuming a single fixed layout.

CANONICAL_HEIGHT = 2400


@dataclass(frozen=True)
class _Layout:
    """Crop constants for one source's Polar-Invasion-family screen layout.

    All coordinates are pixel positions in the 1080-wide preprocessed image.
    y-offsets inside a row (name_y_off, power fields, rank badge) are
    relative to that row's top; everything else is an absolute image
    coordinate.
    """

    # Header crop y-coordinates
    date_y: tuple[int, int]
    stats_y: tuple[int, int]
    # Header crop x-coordinates for the 3-column layout (Battlers | Alliance
    # Ranking | Alliance Points) used by polar_invasion and elite_wars.
    date_x: tuple[int, int]
    battlers_x: tuple[int, int]
    alliance_rank_x: tuple[int, int]
    total_points_x: tuple[int, int]

    # Member list layout
    member_list_top: int  # fallback y-start of first row when detection fails
    row_height: int

    # _detect_list_top's dynamic gap-detection: a right-edge column band
    # sampled for narrow bright zones (row separators), and the pitch range
    # between consecutive zones that confirms a real row boundary (vs. noise).
    list_top_edge_x: tuple[int, int]
    list_top_search_start: int
    row_gap_pitch: tuple[int, int]

    # Column crops within each row (y-offsets relative to row top, x absolute)
    name_y_off: tuple[int, int]  # primary crop
    name_y_off_wide: tuple[int, int]  # fallback crop when primary reads <2 words
    name_x: tuple[int, int]
    power_y_off: tuple[int, int]  # used only for parse()'s usable_end truncation guard
    power_fallback_y_off: tuple[int, int]  # _detect_power's PSM-8/normalized crops
    power_fallback_x: tuple[int, int]  # _detect_power's PSM-8 crop x-range
    power_x: tuple[int, int]  # _detect_power's normalized-contrast crop x-range
    points_x: tuple[int, int]

    # Tight badge crop: inner R-disc only, no avatar overlap.
    rank_badge_x: tuple[int, int]
    rank_badge_y: tuple[int, int]


# Phone screenshots (1080x[1920-2400]) — values unchanged from before the
# emulator profile existed; this is a pure refactor of the phone path.
_PHONE_LAYOUT = _Layout(
    date_y=(135, 195),
    stats_y=(278, 340),
    date_x=(380, 710),
    battlers_x=(200, 310),
    alliance_rank_x=(480, 595),
    total_points_x=(720, 925),
    member_list_top=411,
    row_height=179,
    list_top_edge_x=(970, 1070),
    list_top_search_start=380,
    row_gap_pitch=(175, 185),
    name_y_off=(50, 103),
    name_y_off_wide=(45, 130),
    name_x=(220, 680),
    power_y_off=(100, 165),
    power_fallback_y_off=(85, 175),
    power_fallback_x=(100, 545),
    power_x=(240, 545),
    points_x=(720, 1060),
    rank_badge_x=(38, 90),
    rank_badge_y=(33, 80),
)

# Emulator source (400x652, ratio 1.63 — aoz-alliance-starter#91). Measured
# directly on 4 real captures at the 1080-wide preprocessed scale (row pitch
# 153px, list_top 399px; see the fixtures under
# tests/fixtures/polar_invasion_emulator/ and its README for the ground
# truth these were calibrated against). Not a uniform rescale of the phone
# layout — this source's UI chrome has different proportions, so every value
# was measured independently rather than derived by scaling _PHONE_LAYOUT.
_EMULATOR_LAYOUT = _Layout(
    date_y=(130, 185),
    stats_y=(260, 310),
    date_x=(280, 650),
    battlers_x=(230, 350),
    alliance_rank_x=(490, 610),
    total_points_x=(700, 900),
    member_list_top=399,
    row_height=153,
    list_top_edge_x=(970, 1070),
    list_top_search_start=380,
    row_gap_pitch=(148, 158),
    name_y_off=(28, 60),
    name_y_off_wide=(25, 85),
    name_x=(285, 730),
    power_y_off=(74, 112),
    power_fallback_y_off=(65, 150),
    power_fallback_x=(90, 650),
    power_x=(285, 650),
    points_x=(750, 1010),
    rank_badge_x=(78, 158),
    rank_badge_y=(2, 55),
)

# Post-preprocess image height that distinguishes the two known profiles:
# preprocess() only accepts ratios that resolve to phone (h >= 1920 at
# TARGET_WIDTH=1080) or emulator (h ~= 1760, since that source's native
# resolution is fixed) — see app.preprocess.detect_layout_profile. Any image
# reaching parse() has already been gated into one of these two bands, so a
# single height cutoff between them (1760 and 1920 leave a wide margin)
# unambiguously identifies which layout produced it.
_EMULATOR_MAX_HEIGHT = 1850


def _layout_for_height(h: int) -> _Layout:
    return _EMULATOR_LAYOUT if h < _EMULATOR_MAX_HEIGHT else _PHONE_LAYOUT


# Header crop x-coordinates for the 2-column layout (Battlers or
# "Alliance Members" | Alliance Points) used by wasteland_showdown,
# battle_frenzy, void_war — these screens don't show an alliance ranking.
# Phone-only: not yet verified against any emulator capture of a 2-column
# event (only polar_invasion, a 3-column screen, has been observed from that
# source). Reused unchanged for the emulator profile if this path is ever
# hit for it — flagged here as an explicit follow-up, not a silent gap.
_BATTLERS_X_2COL = (350, 500)
_TOTAL_POINTS_X_2COL = (550, 800)

# Header layout per event code (verified on the fixtures: ironblood is
# 3 columns — with battlers/points sometimes unreadable — and battle_frenzy
# 2 columns). When the code is known, the layout is chosen here
# deterministically; the old heuristic ("a digit read in the rank cell →
# 3 columns") remains as a fallback, but a stray digit could force the
# wrong columns on a 2-column screen (the 2-column ranges overlap x=480-595).
_THREE_COL_EVENTS = frozenset({"polar_invasion", "elite_wars", "ironblood_battlefield"})
_TWO_COL_EVENTS = frozenset({"wasteland_showdown", "battle_frenzy", "void_war"})

_MAX_ROWS = 12

# Column crops within each row (y-offsets, x-coordinates)
_RANK_CROPS: list[tuple[int, int, int, int]] = [
    (35, 80, 45, 115),
    (30, 80, 40, 120),
    (40, 75, 50, 110),
]

# Public aliases expected by extract.py
MEMBER_LIST_TOP = _PHONE_LAYOUT.member_list_top
ROW_HEIGHT = _PHONE_LAYOUT.row_height

_DIGIT_MAP = {"I": "1", "i": "1", "l": "1", "L": "1", "|": "1", "!": "1", "D": "1", "d": "1"}

# Rank OCR (threshold, psm) combos ordered by empirical first-hit rate on the
# fixture set: combos at the front yield a strong R[1-5] reading more often,
# so trying them first lets us exit after ≤ 2-3 attempts on most rows instead
# of running the full 7×3 = 21-call sweep. Order measured on 181 rows across
# all event fixtures; (100, 11) and (120, 11) alone cover ~96% of rows. The
# tail (combos that never produced a strong hit in measurement) is kept as a
# safety net for outlier lighting conditions.
_RANK_OCR_ORDER: tuple[tuple[int, int], ...] = (
    (100, 11),
    (120, 11),
    (80, 11),
    (160, 11),
    (180, 11),
    (160, 7),
    (140, 11),
    (120, 7),
    (140, 7),
    (100, 7),
    (80, 7),
    (180, 7),
    (60, 7),
    (60, 11),
    (60, 8),
    (80, 8),
    (100, 8),
    (120, 8),
    (140, 8),
    (160, 8),
    (180, 8),
)


def _detect_rank_from_crop(
    crop: np.ndarray,
    last_winning_combo: tuple[int, int] | None = None,
) -> tuple[str, tuple[int, int] | None]:
    """Run the multi-threshold × multi-PSM sweep on a pre-cropped badge.

    Returns ``(rank, winning_combo)`` where ``winning_combo`` is the
    ``(threshold, psm)`` pair whose strong R[1-5] reading carried the vote
    (or ``None`` when no strong hit was found and a weak fallback or the R1
    default decided).  Callers should remember this combo and pass it as
    ``last_winning_combo`` for subsequent rows in the same image — lighting
    is constant within a screenshot, so the combo that worked on row N is
    very likely to work on row N+1 too, letting the early-exit path fire on
    the first attempt.

    Early-exit strategy:
        * Try combos in ``_RANK_OCR_ORDER`` (cached combo first if given).
        * Collect strong matches (``R[1-5]``) and weak matches (lone digit).
        * Return as soon as the same strong rank has been seen ≥ 2 times
          (high-confidence majority).
        * Once all combos are exhausted, fall back to the most-voted strong
          match, then to the most-voted weak match, then to ``R1`` default.
    """
    if last_winning_combo is not None and last_winning_combo in _RANK_OCR_ORDER:
        order: tuple[tuple[int, int], ...] = (
            last_winning_combo,
            *(c for c in _RANK_OCR_ORDER if c != last_winning_combo),
        )
    else:
        order = _RANK_OCR_ORDER

    strong_hits: list[tuple[tuple[int, int], str]] = []  # (combo, "R<digit>")
    weak_hits: list[str] = []  # "R<digit>" reconstructed from lone digits

    for combo in order:
        thresh, psm = combo
        _, mask = cv2.threshold(crop, thresh, 255, cv2.THRESH_BINARY)
        padded = cv2.copyMakeBorder(mask, 30, 30, 30, 30, cv2.BORDER_CONSTANT, value=255)
        big = cv2.resize(padded, None, fx=5, fy=5, interpolation=cv2.INTER_CUBIC)
        text = pytesseract.image_to_string(
            big,
            config=f"--psm {psm} -c tessedit_char_whitelist=R12345",
        ).strip()
        m = re.search(r"R([1-5])", text)
        if m:
            rank_str = f"R{m.group(1)}"
            strong_hits.append((combo, rank_str))
            counts = Counter(r for _, r in strong_hits)
            best_rank, best_count = counts.most_common(1)[0]
            if best_count >= 2:
                winning_combo = next(c for c, r in strong_hits if r == best_rank)
                return best_rank, winning_combo
        else:
            m2 = re.search(r"(?<!R)([1-5])", text)
            if m2:
                weak_hits.append(f"R{m2.group(1)}")

    if strong_hits:
        # A single un-confirmed strong hit — still more reliable than a weak
        # vote.  Return it without setting the cache (we have no confidence
        # it'll repeat on the next row).
        return strong_hits[0][1], None
    if weak_hits:
        return Counter(weak_hits).most_common(1)[0][0], None
    # No strategy matched — default to R1 so validate_member accepts the row.
    return "R1", None


def _clean_rank(text: str) -> str | None:
    """Extract normalised R1–R5 from OCR text; return None if absent."""
    m = re.search(r"[Rr]([1-5])", text)
    if m:
        return f"R{m.group(1)}"
    return None


def _parse_datetime(text: str) -> str | None:
    """Return 'YYYY-MM-DDTHH:MM' from OCR text, or None."""
    m = re.search(r"(\d{4}-\d{2}-\d{2})\s*T?\s*(\d{2}:\d{2})", text)
    if m:
        return f"{m.group(1)}T{m.group(2)}"
    return None


def _paris_isoformat(dt: str) -> str | None:
    """'YYYY-MM-DDTHH:MM' (Europe/Paris wall-clock time) → ISO 8601 with the right offset.

    The offset depends on the date (CET +01:00 in winter, CEST +02:00 in
    summer): a hardcoded +02:00 used to shift the stored instant by an hour
    for every winter event. Returns None if OCR produced an invalid date
    (e.g. month 13), handled downstream as an unreadable header.
    """
    try:
        parsed = datetime.fromisoformat(f"{dt}:00")
    except ValueError:
        return None
    return parsed.replace(tzinfo=ZoneInfo("Europe/Paris")).isoformat()


# Trailing run of digits and digit-separators (',', '.', "'", '"', spaces)
# that the OCR sometimes captures when the power column bleeds into the name
# crop. The match must start with a digit so we don't strip pure punctuation.
_TRAILING_DIGIT_RUN = re.compile(r"\d[\d.,'\"\s]*$")

# ASCII fast-path: try eng-only OCR first; escalate to full multilang only when
# the result contains non-ASCII characters or confidence is below the threshold.
_ASCII_FAST_PATH_ENABLED: bool = (
    os.getenv("OCR_NAME_ASCII_FAST_PATH_ENABLED", "true").lower() == "true"
)
_ASCII_FAST_PATH_MIN_CONF: float = float(os.getenv("OCR_NAME_ASCII_FAST_PATH_MIN_CONF", "0.60"))
_ASCII_RE = re.compile(r"^[A-Za-z0-9_|§\-\.]+$")


def _strip_trailing_power_digits(name: str) -> tuple[str, bool]:
    """Strip a trailing power-like digit run from name; return (cleaned, did_strip).

    The OCR sometimes returns names like 'Yet12,937,418', 'Ye'9519.244' or
    'Ye12893,651' where the player's power value is concatenated to the name.
    The previous logic only matched f'{power:,}' exactly and missed variants
    where the OCR misplaced commas/periods/apostrophes. Here we match any
    trailing run of digits + separators and strip it when the digit count
    suggests a value ≥ 1,000,000 (i.e. ≥ 7 digits) — the same threshold
    used by _detect_power to qualify a token as power.
    """
    m = _TRAILING_DIGIT_RUN.search(name)
    if not m:
        return name, False
    digits = re.sub(r"\D", "", m.group(0))
    if len(digits) < 7:
        return name, False
    cleaned = name[: m.start()].rstrip(" \t.,'\"`-_")
    return cleaned, True


class PolarInvasionV1Parser(BaseParser):
    member_list_top: int = MEMBER_LIST_TOP
    row_height: int = ROW_HEIGHT

    def parse(
        self,
        image: np.ndarray,
        emit_trace: bool = False,
        event_code: str | None = None,
    ) -> ParseResult:
        h = image.shape[0]
        layout = _layout_for_height(h)

        dt, battlers, alliance_rank, total_points = self._parse_header(
            image, event_code, layout
        )
        event_datetime = _paris_isoformat(dt) if dt else None

        row_h = layout.row_height
        list_top = self._detect_list_top(image, layout)

        members: list[MemberResult] = []
        # Local across the whole image: the (threshold, psm) combo that
        # carried the most recent successful rank vote.  Lighting is
        # constant within a screenshot, so re-trying that combo first on
        # the next row usually lets _detect_rank exit after 1–2 attempts.
        rank_cache: dict[str, tuple[int, int] | None] = {"last": None}
        # Require enough of the power crop (y + 145, i.e. layout.power_y_off[1] - 20)
        # to be inside the image. Allowing up to 20 px of overhang accepts the
        # last row even when it's slightly clipped, but rejects rows where the
        # power digits are too truncated to read reliably — without this, OCR
        # on the partial power line returns noise and validate_member spuriously
        # accepts it (e.g. void_war-002 row 10 returning a 49M garbage value).
        usable_end = h - (layout.power_y_off[1] - 20)
        for i in range(_MAX_ROWS):
            y = list_top + i * row_h
            if y > usable_end:
                break
            member = self._parse_row(
                image,
                y,
                row_h,
                layout,
                emit_trace=emit_trace,
                list_top=list_top,
                row_index=i,
                rank_cache=rank_cache,
            )
            if member is None:
                continue
            # Fixes the power ↔ points inversion at the source (ex-migration 0009):
            # without this, validate_member would reject the row and the member would be lost.
            member, _ = maybe_swap_power_points(member)
            if validate_member(member):
                members.append(member)

        # Same unified loss counter as ContributionRankingV1Parser.parse: it
        # doesn't matter whether a row within physical reach went missing
        # because it was unreadable or because validate_member rejected it —
        # fewer members than rows that fit onscreen is always worth flagging.
        # This parser backs polar_invasion, elite_wars, ironblood_battlefield,
        # wasteland_showdown, battle_frenzy and void_war alike (see REGISTRY).
        rows_onscreen = min(_MAX_ROWS, (usable_end - list_top) // row_h + 1)
        possible_truncation = len(members) < rows_onscreen
        if possible_truncation:
            logger.warning(
                "%s: parsed %d members but %d rows fit onscreen "
                "(list_top=%d, row_h=%d, h=%d) — possible silent data loss",
                event_code or "polar_invasion",
                len(members),
                rows_onscreen,
                list_top,
                row_h,
                h,
            )

        return ParseResult(
            event_type="polar_invasion",
            event_datetime=event_datetime,
            alliance_rank=alliance_rank,
            total_battlers=battlers,
            total_points=total_points,
            members=members,
            possible_truncation=possible_truncation,
            expected_rows=rows_onscreen,
        )

    # ── List top detection ────────────────────────────────────────────────────

    def _detect_list_top(self, image: np.ndarray, layout: _Layout) -> int:
        """Detect y-start of row 0 by locating the row-separator gap pattern.

        Each member row is a panel followed by a bright gap (= row
        separator); the row-to-row pitch is consistent within one layout
        profile (see layout.row_height). We sample a right-edge column band
        (layout.list_top_edge_x) where no text intrudes, find narrow bright
        zones (5–30px wide), and pick the first pair whose pitch falls in
        layout.row_gap_pitch. The first zone of that pair is the gap between
        row 0 and row 1, so row 0 top = first_gap_start - row_height.

        Width filtering excludes the wide bright zone that sits above row 0
        (a mix of stats/header background and the gap below the
        Member/Points column titles). Falls back to layout.member_list_top
        when no qualifying pair is found.
        """
        h = int(image.shape[0])

        if image.ndim == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image

        edge_x0, edge_x1 = layout.list_top_edge_x
        right_edge = gray[:, edge_x0:edge_x1].mean(axis=1)

        # Bright zones (brightness ≥ 226) of width 5–30 are row separators.
        # drop_clipped_start=False: this scan starts at a fixed offset
        # (layout.list_top_search_start), not the array origin, so a zone
        # already bright there is a legitimate start, not an artifact of the
        # window boundary (contrast ContributionRankingV1Parser._detect_list_top,
        # which has no such fixed offset and so needs the opposite default).
        # include_clipped_end keeps a zone still bright at y=h, provided it's
        # already narrow enough to qualify.
        start = layout.list_top_search_start
        search_mask = right_edge[start:h] >= 226.0
        zones = [
            (start + s, start + e)
            for s, e in find_runs(
                search_mask,
                min_len=5,
                max_len=30,
                drop_clipped_start=False,
                include_clipped_end=True,
            )
        ]

        pitch_min, pitch_max = layout.row_gap_pitch
        for i in range(len(zones) - 1):
            z1 = zones[i]
            z2 = zones[i + 1]
            pitch = z2[0] - z1[0]
            if pitch_min <= pitch <= pitch_max:
                row_0_top = z1[0] - layout.row_height
                result = max(0, min(h - 1, row_0_top))
                logger.debug(
                    "list_top: zone[%d]=%s pitch=%d row_0_top=%d",
                    i,
                    z1,
                    pitch,
                    result,
                )
                return result

        logger.debug(
            "list_top: no %d-%d zone pair found, using fallback %d",
            pitch_min,
            pitch_max,
            layout.member_list_top,
        )
        return layout.member_list_top

    # ── Header ────────────────────────────────────────────────────────────────

    def _parse_header(
        self, image: np.ndarray, event_code: str | None, layout: _Layout
    ) -> tuple[str | None, int | None, int | None, int | None]:
        date_x0, date_x1 = layout.date_x
        date_text = pytesseract.image_to_string(
            image[layout.date_y[0] : layout.date_y[1], date_x0:date_x1], config="--psm 7"
        ).strip()
        dt = _parse_datetime(date_text)

        sy1, sy2 = layout.stats_y

        def _ocr_number(x_range: tuple[int, int]) -> int | None:
            return parse_number(
                pytesseract.image_to_string(
                    image[sy1:sy2, x_range[0] : x_range[1]],
                    config="--psm 7 -c tessedit_char_whitelist=0123456789",
                ).strip()
            )

        # Layout known deterministically when the event code is provided
        # (production: dispatcher or override). The rank cell is never read
        # on a 2-column screen — it overlaps the real columns.
        if event_code in _THREE_COL_EVENTS:
            return (
                dt,
                _ocr_number(layout.battlers_x),
                _ocr_number(layout.alliance_rank_x),
                _ocr_number(layout.total_points_x),
            )
        if event_code in _TWO_COL_EVENTS:
            return dt, _ocr_number(_BATTLERS_X_2COL), None, _ocr_number(_TOTAL_POINTS_X_2COL)

        # Fallback (code absent : appels directs des tests/outils) — heuristique
        # historique durcie : un chiffre dans la cellule rang ne suffit plus,
        # il faut aussi que la lecture 3 colonnes soit plausible.
        alliance_rank = _ocr_number(layout.alliance_rank_x)
        if alliance_rank is not None and 1 <= alliance_rank <= 9999:
            battlers = _ocr_number(layout.battlers_x)
            if battlers is None or battlers <= 999:
                total_points = _ocr_number(layout.total_points_x)
                return dt, battlers, alliance_rank, total_points

        # 2-column layout: Battlers (or "Alliance Members") | Alliance Points.
        # Used by wasteland_showdown, battle_frenzy, void_war — both numeric
        # values sit further from the screen edges than in the 3-column case.
        battlers = _ocr_number(_BATTLERS_X_2COL)
        total_points = _ocr_number(_TOTAL_POINTS_X_2COL)
        return dt, battlers, None, total_points

    # ── Member row ────────────────────────────────────────────────────────────

    def _parse_row(
        self,
        image: np.ndarray,
        y: int,
        row_h: int,
        layout: _Layout,
        emit_trace: bool = False,
        list_top: int = 0,
        row_index: int = 0,
        rank_cache: dict[str, tuple[int, int] | None] | None = None,
    ) -> MemberResult | None:
        """Parse one member row. Returns None when the row appears empty.

        Masks the crossed-swords icon (⚔) via template matching before OCR of the name and power.
        Sprite source: fixture 20260407T1500_001.png, event-1, Polar Invasion, row 1,
        power crop, x≈210–270, y_off≈115–160, preprocessed with preprocess().
        """
        # Local copy of the row band (mask_sword_icon draws into it). Limited
        # to x < layout.points_x[0]: everything that reads row_img (rank
        # badge, name, power, icon search band) stays under this bound; the
        # points column is read further down directly on `image`. Copying
        # the full width wasted ~33%.
        row_img = image[y : y + row_h, : layout.points_x[0]].copy()
        # Mask the crossed-swords icon if present
        row_img = mask_sword_icon(row_img, 1.0)

        # Detection functions use row-relative coordinates
        # Adapt calls to use row_img instead of image, and y=0
        rank = self._detect_rank(row_img, 0, layout, rank_cache=rank_cache)

        # Detect power before name so we can strip it from the name string when
        # OCR bleeds across column boundaries (e.g. "Ye12,034,411" → "Ye").
        power = self._detect_power(row_img, 0, layout)

        ny1, ny2 = layout.name_y_off
        name_y_off_used = layout.name_y_off
        crop = row_img[ny1:ny2, layout.name_x[0] : layout.name_x[1]]
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
                name_data = _fp_data
                name = _fp_name
                logger.debug("row y=%d name fast-path HIT: %r conf=%.2f", y, _fp_name, _fp_conf)
            else:
                logger.debug("row y=%d name fast-path MISS: %r conf=%.2f", y, _fp_name, _fp_conf)
                name_data = pytesseract.image_to_data(
                    crop_2x,
                    config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                    output_type=Output.DICT,
                )
                name = _words_from_data(name_data, min_conf=10)
        else:
            name_data = pytesseract.image_to_data(
                crop_2x,
                config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                output_type=Output.DICT,
            )
            name = _words_from_data(name_data, min_conf=10)
        if len(name) < 2:
            # Event-2 layout: name sits ~15px lower — use wider crop
            ny1w, ny2w = layout.name_y_off_wide
            name_y_off_used = layout.name_y_off_wide
            crop_w = row_img[ny1w:ny2w, layout.name_x[0] : layout.name_x[1]]
            crop_w2x = cv2.resize(crop_w, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
            name_data = pytesseract.image_to_data(
                crop_w2x,
                config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                output_type=Output.DICT,
            )
            name = _words_from_data(name_data, min_conf=10)

        # Last resort for low-contrast names: some coloured names (e.g. green R3 text)
        # appear as medium gray (~121) after the standard grayscale+inversion preprocess
        # instead of near-black (~0). Tesseract sees no text at all in that case.
        # Stretching the crop to [0, 255] restores the contrast and fixes detection.
        if len(name) < 2:
            norm_crop = cv2.normalize(crop_2x, None, 0, 255, cv2.NORM_MINMAX)  # type: ignore[call-overload]
            name_data = pytesseract.image_to_data(
                norm_crop,
                config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                output_type=Output.DICT,
            )
            name = _words_from_data(name_data, min_conf=10)

        # Cyrillic-lookalike disambiguation — name AND name_data come from the
        # winning pass, so the confidence computed further down (and thus
        # whether the LLM fallback triggers) reflects the name actually returned.
        name, name_data = disambiguate_cyrillic(crop_2x, name, name_data)
        name = normalize_name(name)

        raw_name = name

        # Strip power value from name tail when the name crop overlaps the
        # power column and the multilingual OCR reads both on the same line.
        # Robust to comma/period/apostrophe variants the OCR introduces (e.g.
        # 'Ye'9519.244' or 'Ye12893,651' where the punctuation between digits
        # is wrong) — we match any trailing run of digits ≥ 1M, regardless
        # of separators.
        name, stripped_power = _strip_trailing_power_digits(name)
        # Belt-and-braces: when the digit run was shorter than 7 chars but
        # exactly matches the detected power, still strip it.
        if not stripped_power and power is not None and name:
            power_formatted = f"{power:,}"
            if name.endswith(power_formatted):
                name = name[: -len(power_formatted)].rstrip(" \t.,'\"`-_")
                stripped_power = True
            elif name.endswith(str(power)):
                name = name[: -len(str(power))].rstrip(" \t.,'\"`-_")
                stripped_power = True

        mean_name_conf = _mean_word_conf(name_data, min_conf=10)
        logger.debug(
            "row y=%d name OCR: raw=%r mean_conf=%.1f stripped_power=%s final=%r power=%s rank=%s",
            y,
            raw_name,
            mean_name_conf,
            stripped_power,
            name,
            power,
            rank,
        )

        if power is None and not name:
            return None

        # Include "-" in the whitelist so Tesseract returns it when the cell
        # shows the non-participant marker instead of a score.
        pts_data = pytesseract.image_to_data(
            image[y : y + row_h, layout.points_x[0] : layout.points_x[1]],
            config="--psm 6 -c tessedit_char_whitelist=0123456789,-",
            output_type=Output.DICT,
        )
        # Distinguish participation from absence:
        #   "--"  → non-participant (explicit dash marker, any confidence ≥ 10)
        #   empty → non-participant (game shows "--" but OCR confidence too low to
        #           meet min_conf=10; a genuine "0" always renders as a legible digit)
        #   "0"   → participant who scored 0 (legible, parse_number returns 0)
        #   "N"   → participant who scored N points
        # In all non-participant cases points stays None; the row is still returned
        # so the player is tracked in at_players / at_alliance_memberships.
        raw_pts = _words_from_data(pts_data, min_conf=10)
        if raw_pts and re.match(r"^-+$", raw_pts):
            points: int | None = None
        else:
            points = parse_number(_words_from_data(pts_data, min_conf=20).replace(",", ""))
            # parse_number returns None for empty/unparseable → treat as non-participant

        # Use name field only: numeric fields (pts) have high Tesseract confidence
        # and would dilute a low-confidence short name above the fallback threshold.
        # Filter must match what actually built `name` (_words_from_data above):
        # same min_conf=10, and only words with non-empty text -- a >=0 filter
        # with no text check let empty-text boxes with a "confident" score dilute
        # the average even though they contributed nothing to `name`.
        confs = [
            int(c)
            for t, c in zip(name_data["text"], name_data["conf"], strict=False)
            if t.strip() and str(c).lstrip("-").isdigit() and int(c) >= 10
        ]
        confidence = sum(confs) / (len(confs) * 100) if confs else 0.0

        trace: RowTrace | None = None
        if emit_trace:
            ny1u, ny2u = name_y_off_used
            trace = RowTrace(
                list_top=list_top,
                row_index=row_index,
                row_height=row_h,
                name=FieldBox(y1=y + ny1u, y2=y + ny2u, x1=layout.name_x[0], x2=layout.name_x[1]),
                rank=FieldBox(
                    y1=y + layout.rank_badge_y[0],
                    y2=y + layout.rank_badge_y[1],
                    x1=layout.rank_badge_x[0],
                    x2=layout.rank_badge_x[1],
                ),
                # Power: record the primary PSM-11 sweep region (full-row strip
                # left of the points column). The sword-icon mask is applied to
                # this strip before OCR; the trace box is the pre-mask extent.
                power=FieldBox(y1=y, y2=y + row_h, x1=0, x2=layout.points_x[0]),
                points=FieldBox(
                    y1=y, y2=y + row_h, x1=layout.points_x[0], x2=layout.points_x[1]
                ),
            )

        return MemberResult(
            name=_fix_name_substitutions(name),
            rank=rank or "",
            power=power or 0,
            points=points,
            confidence=confidence,
            trace=trace,
            row_y=y,
            row_h=row_h,
        )

    # ── Power detection ───────────────────────────────────────────────────────

    def _detect_power(self, image: np.ndarray, y: int, layout: _Layout) -> int | None:
        """Detect power using PSM 11 full-row scan, with PSM 8 fallback."""
        h = image.shape[0]
        row_end = min(y + layout.row_height, h)

        # Primary: PSM 11 sparse text on the left portion of the row only.
        # The points column start is excluded so that events like Ironblood
        # Battlefield (where scores exceed 1 M) don't return a score value
        # instead of the actual power. The power column sits well within
        # that bound on all observed layouts.
        data = pytesseract.image_to_data(
            image[y:row_end, : layout.points_x[0]],
            config="--psm 11 -c tessedit_char_whitelist=0123456789,",
            output_type=Output.DICT,
        )
        for i, t in enumerate(data["text"]):
            t = t.strip()
            if not t:
                continue
            conf = int(data["conf"][i])
            if conf < 0:
                continue
            val = parse_number(t)
            if val is not None and val >= 1_000_000:
                return val

        # Fallback: PSM 8 on fixed crop — left margin widened to catch power
        # numbers whose leading digits start further left on some layouts.
        py1 = y + layout.power_fallback_y_off[0]
        py2 = y + layout.power_fallback_y_off[1]
        fx0, fx1 = layout.power_fallback_x
        data = pytesseract.image_to_data(
            image[py1:py2, fx0:fx1],
            config="--psm 8 -c tessedit_char_whitelist=0123456789,",
            output_type=Output.DICT,
        )
        val = parse_number(_words_from_data(data, min_conf=0))
        if val is not None and val >= 1_000_000:
            return val

        # Normalized fallback: coloured power text (e.g. green R3) appears as medium
        # gray (~121) after the standard grayscale+inversion preprocess — same root
        # cause as the name detection failure for the same row. Stretching the power
        # crop to [0, 255] makes the digits legible. Use layout.power_x to skip the
        # avatar and the masked sword-icon area, both of which would corrupt
        # normalization.
        power_crop = image[py1:py2, layout.power_x[0] : layout.power_x[1]]
        if power_crop.size > 0:
            norm_power = cv2.normalize(power_crop, None, 0, 255, cv2.NORM_MINMAX)  # type: ignore[call-overload]
            data = pytesseract.image_to_data(
                norm_power,
                config="--psm 11 -c tessedit_char_whitelist=0123456789,",
                output_type=Output.DICT,
            )
            for i, t in enumerate(data["text"]):
                t = t.strip()
                if not t:
                    continue
                if int(data["conf"][i]) < 0:
                    continue
                nval = parse_number(t)
                if nval is not None and nval >= 1_000_000:
                    return nval
        return None

    # ── Rank detection ────────────────────────────────────────────────────────

    def _detect_rank(
        self,
        image: np.ndarray,
        y: int,
        layout: _Layout,
        rank_cache: dict[str, tuple[int, int] | None] | None = None,
    ) -> str | None:
        """Detect R1–R5 badge via tight-crop OCR with empirical-order early exit.

        Delegates the actual OCR sweep to ``_detect_rank_from_crop`` and
        threads the per-image winning-combo cache through ``rank_cache``.
        Defaults to R1 when no strategy yields a hit — R1 is the
        statistically dominant rank (~57% of fixture rows) and an empty rank
        would otherwise cause validate_member() to drop the entire row.
        """
        h = image.shape[0]
        y1 = y + layout.rank_badge_y[0]
        y2 = y + layout.rank_badge_y[1]
        if y1 >= h or y2 > h:
            return None
        crop = image[y1:y2, layout.rank_badge_x[0] : layout.rank_badge_x[1]]
        if crop.size == 0:
            return None

        last = rank_cache["last"] if rank_cache is not None else None
        rank, winning_combo = _detect_rank_from_crop(crop, last_winning_combo=last)
        if rank_cache is not None and winning_combo is not None:
            rank_cache["last"] = winning_combo
        return rank
