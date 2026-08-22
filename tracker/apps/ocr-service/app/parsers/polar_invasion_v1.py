import logging
import os
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
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
from app.preprocess import (
    EMULATOR_PROFILE,
    PHONE_PROFILE,
    UnsupportedAspectRatioError,
    detect_layout_profile,
)
from app.tess_engine import Output
from app.validators import MIN_POWER, maybe_swap_power_points, parse_number, validate_member

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
# `_layout_for_image`) rather than assuming a single fixed layout.

CANONICAL_HEIGHT = 2400

# Power-detection stages, in decreasing crop width. Named rather than
# referenced directly because _Layout is defined before the functions
# implementing them; _POWER_STAGE_FNS (below the functions) is the mapping,
# and this Literal keeps a typo in a layout literal a mypy error.
_PowerStage = Literal["row_scan", "psm8", "normalized"]


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

    # Header crop x-coordinates for the 2-column layout (Battlers | Alliance
    # Points) used by wasteland_showdown, battle_frenzy, void_war — these
    # screens don't show an alliance ranking, and the two remaining columns
    # sit at different x positions than their 3-column counterparts (no
    # ranking column between them to push them apart). None on a profile
    # where this hasn't been measured: parse()'s guard refuses these event
    # codes rather than fall back to another profile's bands — measured
    # corruption if it did (total_points 5780 read as 57, 4565 as 451,
    # aoz-alliance-starter#91).
    battlers_x_2col: tuple[int, int] | None
    total_points_x_2col: tuple[int, int] | None

    # Member list layout
    member_list_top: int  # fallback y-start of first row when detection fails
    row_height: int

    # _detect_list_top's dynamic gap-detection: a right-edge column band
    # sampled for narrow zones matching list_top_dip_range (row separators —
    # a bright shadow line on phone, a dark card-gap on the emulator skin;
    # see that field), and the pitch range between consecutive zones that
    # confirms a real row boundary (vs. noise). use_dynamic_list_top=False
    # skips the scan entirely and always returns member_list_top —
    # appropriate for a source with one fixed native resolution and no
    # per-row separator signal to detect around.
    #
    # The 6 fields below are only meaningful when use_dynamic_list_top=True —
    # they're Optional (None when the scan is off) rather than always
    # populated, specifically so a layout with the scan disabled can't carry
    # unmeasured values that read as measured. _detect_list_top raises before
    # use if any is None, so turning the scan on for a layout without real
    # numbers here fails loudly instead of scanning a band calibrated for a
    # different profile's UI chrome.
    use_dynamic_list_top: bool
    list_top_edge_x: tuple[int, int] | None
    list_top_search_start: int | None
    row_gap_pitch: tuple[int, int] | None
    # Inclusive (lo, hi) grayscale range that counts as "inside a separator
    # zone". Phone's separator is a bright shadow line above the row-interior
    # baseline (226-255); the emulator skin's is the opposite — a dark
    # card-gap band below its row-interior baseline (measured 0-214 on
    # wasteland_showdown/triangle_war captures, 2026-08-22) — so this can't
    # be a single hardcoded threshold+direction shared by every profile.
    list_top_dip_range: tuple[float, float] | None
    # (min, max) pixel width a zone must have to count as a separator, not
    # noise. Phone's is 5-30 (unchanged from before generalization). The
    # emulator's card-gap line is a hairline by comparison — measured 2-4px
    # across 6 captures on 2026-08-22 — so reusing phone's 5px floor drops
    # every real zone and leaves only wider, unrelated dark content (a
    # decorated name's glyphs bleeding into the sampled column) to pass the
    # width filter instead; measured directly, not assumed.
    list_top_zone_width: tuple[int, int] | None
    # Offset from a confirmed zone's start (z1, the first of a valid
    # (z1, z2) pitch-matching pair) to row 0's actual top. On phone the
    # zone marks the row_0/row_1 boundary, one full row_height below row 0's
    # top, hence -row_height (-179, preserved verbatim from the pre-generalization
    # hardcoded formula — zero behavior change). On the emulator skin the zone
    # instead marks each row's OWN top with a small fixed lag (measured +8px
    # on 20260822T0945_001/_003, where the true top is independently known
    # from the non-dynamic fixtures) — a different physical signal, not a
    # rescaled version of phone's, so it needs its own measured offset rather
    # than reusing -row_height.
    list_top_zone_offset: int | None

    # Column crops within each row (y-offsets relative to row top, x absolute)
    name_y_off: tuple[int, int]  # primary crop
    name_y_off_wide: tuple[int, int]  # fallback crop when primary reads <2 words
    name_x: tuple[int, int]
    power_y_off: tuple[int, int]  # used only for parse()'s usable_end truncation guard
    power_fallback_y_off: tuple[int, int]  # _detect_power's PSM-8/normalized crops
    power_fallback_x: tuple[int, int] | None  # "psm8" stage's crop x-range; None if unused
    power_x: tuple[int, int]  # _detect_power's normalized-contrast crop x-range
    points_x: tuple[int, int]

    # Which power-detection stages this layout uses, in the order tried;
    # _detect_power returns the first >=MIN_POWER value any of them yields.
    # A stage is listed only where it has been measured to help on THIS
    # profile — an unlisted stage isn't merely deprioritized, it never runs,
    # because a stage that can't read a profile can still return a wrong
    # value that clears MIN_POWER and so passes validate_member.
    #
    # Phone — all 3, widest first: the full-row PSM-11 sweep wins there, and
    # promoting the narrow normalized crop regresses 2 of 181 fixture rows
    # (polar_invasion/20260414T2300_001 row 4 "Yojimbo": the normalized crop
    # tokenizes 23,324,091 as '23,324,09' + '1' and the first >=1M token
    # wins, giving 2,332,409; 20260407T1500_005 row 3 "BakersBakedd27":
    # 13,888,203 -> 13,888,208 at conf 41 vs 96).
    #
    # Emulator — "normalized" only, both omissions measured on the 32
    # fixture rows:
    #   * "row_scan" spans x=0..points_x[0], which on this profile includes
    #     the avatar; "Madara⁶⁹Uchiha"'s decorative frame reads as a leading
    #     "1" fused onto the value (115,806,413 for 15,806,413) on all 3 of
    #     its rows. As a last-resort stage it would still corrupt those rows,
    #     and a dropped row (visible: possible_truncation) beats a plausible
    #     wrong one (silent) — see aoz-alliance-starter#91.
    #   * "psm8" returned 0 correct values out of 32 at its own x-band and at
    #     3 narrower candidates; at (160,650) it produced 18,200,959 and
    #     1,980,082, both >=MIN_POWER and both wrong. It has no measured
    #     value here at any band, only a measured failure mode.
    power_stages: tuple[_PowerStage, ...]

    # Search band (y-range, x-range) handed to mask_sword_icon, in
    # row-relative coordinates. None = no sword-icon masking on this profile.
    # The sprite is a fixed 49x46 at phone scale and the band was measured on
    # phone rows; the emulator's row pitch (164 vs 179) renders the same icon
    # at a different size and position, so template matching there peaks at
    # 0.288-0.457 across all 32 fixture rows — below the 0.6 accept threshold,
    # i.e. no mask is ever drawn today. None makes that explicit instead of
    # leaving it to a 24% numeric margin: a false positive in the phone band
    # would paint a white rectangle straight through the emulator power crop.
    sword_icon_band: tuple[tuple[int, int], tuple[int, int]] | None

    # Tight badge crop: inner R-disc only, no avatar overlap.
    rank_badge_x: tuple[int, int]
    rank_badge_y: tuple[int, int]

    # (threshold, psm) sweep handed to _detect_rank_from_crop for this
    # profile's badges. Per-profile because the phone list was tuned on
    # 52x47 source-pixel badges and the emulator's are 30x20 — 4.2x less
    # ink — which narrows the usable threshold window rather than shifting
    # it: the phone list steps thresholds by 20 (60,80,...,180) and the
    # emulator's readable values land on the midpoints that grid skips.
    # See _EMULATOR_RANK_OCR_ORDER for the measurement.
    rank_ocr_order: tuple[tuple[int, int], ...]


# Rank OCR (threshold, psm) combos for the PHONE profile, ordered by empirical
# first-hit rate on the fixture set: combos at the front yield a strong R[1-5]
# reading more often, so trying them first lets us exit after ≤ 2-3 attempts on
# most rows instead of running the full 7×3 = 21-call sweep. Order measured on
# 181 rows across all event fixtures; (100, 11) and (120, 11) alone cover ~96%
# of rows. The tail (combos that never produced a strong hit in measurement) is
# kept as a safety net for outlier lighting conditions.
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

# Same idea for this profile, measured on its own 32 fixture badges — the
# phone list above scores 25/32 = 78.1% here. Derived by replaying a
# 19-threshold x 6-psm grid over every badge and re-running the vote logic
# offline against ground truth; three axes moved, one deliberately did not:
#
#   * threshold step 20 -> 10. The phone grid's step is wider than this
#     profile's usable window: of the 7 badges the phone list misses, not one
#     produces a single strong R[1-5] hit at any phone threshold, while 5 read
#     correctly at 110, 150 or 170 — precisely the midpoints it steps over.
#     The badge carries 30x20 source pixels against phone's 52x47 (4.2x less
#     ink), which narrows the usable window rather than shifting it.
#   * psm 6 added. Never tried on phone, and here it reads badges that psm
#     11/7 return nothing at all for.
#   * psm 8 dropped. 0 strong hits in 416 attempts (32 badges x 13
#     thresholds) — at this glyph size it is pure cost, and keeping it made a
#     full parse 37% slower for no accuracy gain. The threshold axis is kept
#     wide (60-180, including values with no measured yield) because
#     brightness is the plausible thing to vary between captures; psm is a
#     function of glyph geometry, which does not.
#   * the crop box is unchanged. Padding it by -6..+6 px was measured too:
#     -4 raises per-combo precision but loses evidence overall and scores
#     28/32 end to end, worse than leaving it alone.
#
# Result: 31/32 = 96.9%, at +5.4% full-parse wall clock. That is the ceiling
# for this crop rather than a stopping point chosen for convenience — the full
# 114-combo grid also scores 31/32, and the one miss (20260721T1500_001 row 2)
# yields its true rank under no combo in that grid at any padding. Front-loaded
# by measured strong-hit yield; ordering is a speed choice only, since the
# plain ladder order scores the same 31/32.
_EMULATOR_RANK_OCR_ORDER: tuple[tuple[int, int], ...] = (
    (150, 11),
    (140, 11),
    (160, 11),
    (130, 11),
    (130, 6),
    (150, 6),
    (120, 11),
    (120, 6),
    (120, 7),
    (110, 11),
    (170, 11),
    (110, 6),
    (140, 6),
    (130, 7),
    (180, 11),
    (170, 6),
    (180, 6),
    (110, 7),
    (150, 7),
    (180, 7),
    (100, 11),
    (60, 6),
    (70, 6),
    (80, 6),
    (90, 6),
    (100, 6),
    (160, 6),
    (60, 7),
    (70, 7),
    (80, 7),
    (90, 7),
    (100, 7),
    (140, 7),
    (160, 7),
    (170, 7),
    (60, 11),
    (70, 11),
    (80, 11),
    (90, 11),
)


# 2-column header bands, phone scale — measured well before the emulator
# profile existed (moved above _PHONE_LAYOUT so the dataclass instance below
# can reference them; previously module-level constants used directly by
# _parse_header, now carried per-profile on _Layout instead — see that
# field's docstring).
_BATTLERS_X_2COL_PHONE = (350, 500)
_TOTAL_POINTS_X_2COL_PHONE = (550, 800)

# Emulator counterpart, measured 2026-08-22 on the wasteland_showdown
# captures 20260822T0945_007/_008 (ground truth: battlers 10/14, total_points
# 2565/4110) via image_to_data bounding boxes on the stats_y band — verified
# to read both fixtures exactly at these bands. Distinct from the phone bands
# (not a rescale): "10"/"14" render at x=399-430, "2565"/"4110" at x=634-702;
# margins below give room for one extra digit either side without reaching
# the other column.
_BATTLERS_X_2COL_EMULATOR = (370, 470)
_TOTAL_POINTS_X_2COL_EMULATOR = (590, 760)

# Phone screenshots (1080x[1920-2400]) — values unchanged from before the
# emulator profile existed; this is a pure refactor of the phone path.
_PHONE_LAYOUT = _Layout(
    date_y=(135, 195),
    stats_y=(278, 340),
    date_x=(380, 710),
    battlers_x=(200, 310),
    alliance_rank_x=(480, 595),
    total_points_x=(720, 925),
    battlers_x_2col=_BATTLERS_X_2COL_PHONE,
    total_points_x_2col=_TOTAL_POINTS_X_2COL_PHONE,
    member_list_top=411,
    row_height=179,
    use_dynamic_list_top=True,
    list_top_edge_x=(970, 1070),
    list_top_search_start=380,
    row_gap_pitch=(175, 185),
    list_top_dip_range=(226.0, 255.0),
    list_top_zone_width=(5, 30),
    list_top_zone_offset=-179,  # == -row_height, unchanged from before generalization
    name_y_off=(50, 103),
    name_y_off_wide=(45, 130),
    name_x=(220, 680),
    power_y_off=(100, 165),
    power_fallback_y_off=(85, 175),
    power_fallback_x=(100, 545),
    power_x=(240, 545),
    points_x=(720, 1060),
    power_stages=("row_scan", "psm8", "normalized"),
    sword_icon_band=((100, 170), (180, 320)),
    rank_badge_x=(38, 90),
    rank_badge_y=(33, 80),
    rank_ocr_order=_RANK_OCR_ORDER,
)

# Emulator source (400x652, ratio 1.63 — aoz-alliance-starter#91). Measured
# directly on 4 real captures at the 1080-wide preprocessed scale (row pitch
# 164px confirmed via full-width brightness autocorrelation and cross-checked
# against all 8 visible rows of a fixture — an initial manual pixel-grid
# reading of 153 drifted by 11px/row and was wrong; list_top 399px; see the
# fixtures under tests/fixtures/polar_invasion_emulator/ and its README for
# the ground truth these were calibrated against). Not a uniform rescale of
# the phone layout — this source's UI chrome has different proportions, so
# every field actually in use was measured independently rather than derived
# by scaling _PHONE_LAYOUT.
_EMULATOR_LAYOUT = _Layout(
    date_y=(130, 185),
    stats_y=(260, 310),
    date_x=(270, 700),
    battlers_x=(230, 350),
    alliance_rank_x=(490, 610),
    total_points_x=(700, 900),
    battlers_x_2col=_BATTLERS_X_2COL_EMULATOR,
    total_points_x_2col=_TOTAL_POINTS_X_2COL_EMULATOR,
    member_list_top=399,
    row_height=164,
    # Enabled 2026-08-22: 399 alone only holds when the list happens to be
    # scrolled to a row boundary (true of _001/_002/_003/_006 among the
    # 20260822T0945_* captures) — on a fractional scroll offset (_004, _005)
    # it reads 0 of 8 rows (the crop grid no longer lines up with any real
    # row). The scan below reads the true per-capture top instead. Previously
    # False because no emulator measurement existed for a row-separator
    # signal at all — one does exist, just not the one phone uses (see
    # list_top_dip_range).
    use_dynamic_list_top=True,
    # Sampled column: x=900-940 lands past the name/power text columns and
    # short of the points column on every fixture row checked, so the band
    # carries mostly background fill rather than glyph ink. list_top_search_start
    # is set past stats_y (ends at 310) plus the header's own dip at
    # y~300-312 (part of the Alliance Points figure's crop) — starting any
    # earlier would let that header dip masquerade as row 0's marker.
    list_top_edge_x=(900, 940),
    list_top_search_start=350,
    # Measured pitch between consecutive zones on 001/002/003/004/005/006:
    # 161-166px, clustered tightly around row_height (164) as expected for a
    # periodic per-row signal; 155-175 leaves margin either side without
    # risking a false pair at roughly double or half that spacing.
    row_gap_pitch=(155, 175),
    # The card-gap here is a DARK band (measured 206-217 at this x-band,
    # 2026-08-22 on 20260822T0945_001) against a lighter row-interior
    # baseline (~220-233) — the opposite polarity of phone's bright
    # separator line. Not a threshold that could be shared with phone's
    # (226.0, 255.0): a single hardcoded direction can't express both.
    list_top_dip_range=(0.0, 214.0),
    list_top_zone_width=(2, 6),
    # Unlike phone, the confirmed zone here marks EACH row's own top (not
    # the row_0/row_1 boundary) with a small measured lag: on 001 and 003
    # independently, the first zone lands at y=391 while the true top
    # (established by the non-dynamic fixtures below) is 399 — a +8 offset,
    # not a -row_height one. Reusing phone's -row_height here was checked
    # and rejected: it would place row 0 up to a full row_height too high
    # for whichever row happens to produce the first detected zone.
    list_top_zone_offset=8,
    name_y_off=(28, 60),
    name_y_off_wide=(25, 85),
    name_x=(245, 730),
    power_y_off=(74, 112),
    power_fallback_y_off=(65, 150),
    # Only the "psm8" stage reads this, and that stage is not in power_stages
    # below — no measured x-band exists for it here (see _Layout.power_stages).
    power_fallback_x=None,
    power_x=(285, 650),
    points_x=(750, 1010),
    power_stages=("normalized",),
    sword_icon_band=None,
    rank_badge_x=(78, 158),
    rank_badge_y=(2, 55),
    rank_ocr_order=_EMULATOR_RANK_OCR_ORDER,
)

# Which _Layout backs each known profile. Single source of truth for the
# profile <-> layout mapping: `app.preprocess.detect_layout_profile` is the
# only place that classifies an image by aspect ratio/height, so this module
# must ask it rather than re-derive its own height cutoff — a second,
# independently-maintained cutoff here would silently drift out of sync with
# preprocess.py's actual bands (e.g. a third profile added there would fall
# through this module's binary choice unnoticed).
_LAYOUT_BY_PROFILE = {PHONE_PROFILE: _PHONE_LAYOUT, EMULATOR_PROFILE: _EMULATOR_LAYOUT}


def _layout_for_image(image: np.ndarray) -> _Layout:
    h, w = image.shape[:2]
    profile = detect_layout_profile(w, h)
    try:
        return _LAYOUT_BY_PROFILE[profile]
    except KeyError:
        # A profile preprocess.py knows but this module has no crops for.
        # Raised as UnsupportedAspectRatioError, not the bare KeyError, so it
        # lands on main.py's dedicated unsupported_aspect_ratio path with a
        # readable message instead of surfacing as internal_error.
        raise UnsupportedAspectRatioError(
            f"image is {w}x{h}, recognized by preprocess as the {profile.name!r} profile, "
            "but polar_invasion_v1 has no measured crop positions for it"
        ) from None


# Header layout per event code (verified on the fixtures: ironblood is
# 3 columns — with battlers/points sometimes unreadable — and battle_frenzy
# 2 columns). When the code is known, the layout is chosen here
# deterministically; the old heuristic ("a digit read in the rank cell →
# 3 columns") remains as a fallback, but a stray digit could force the
# wrong columns on a 2-column screen (the 2-column ranges overlap x=480-595).
_THREE_COL_EVENTS = frozenset(
    {"polar_invasion", "elite_wars", "ironblood_battlefield", "triangle_war"}
)
_TWO_COL_EVENTS = frozenset({"wasteland_showdown", "battle_frenzy", "void_war"})

_MAX_ROWS = 12

# Column crops within each row (y-offsets, x-coordinates)
_RANK_CROPS: list[tuple[int, int, int, int]] = [
    (35, 80, 45, 115),
    (30, 80, 40, 120),
    (40, 75, 50, 110),
]

_DIGIT_MAP = {"I": "1", "i": "1", "l": "1", "L": "1", "|": "1", "!": "1", "D": "1", "d": "1"}


def _detect_rank_from_crop(
    crop: np.ndarray,
    last_winning_combo: tuple[int, int] | None = None,
    order: tuple[tuple[int, int], ...] = _RANK_OCR_ORDER,
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

    ``order`` is the profile's (threshold, psm) sweep — ``_RANK_OCR_ORDER``
    for phone badges (also the default, used by contribution_ranking_v1,
    which is phone-only), ``_EMULATOR_RANK_OCR_ORDER`` for the smaller
    emulator ones.  The vote logic below is deliberately shared and
    identical across profiles; only the combo list differs.

    Early-exit strategy:
        * Try combos in ``order`` (cached combo first if given).
        * Collect strong matches (``R[1-5]``) and weak matches (lone digit).
        * Return as soon as the same strong rank has been seen ≥ 2 times
          (high-confidence majority).
        * Once all combos are exhausted, fall back to the most-voted strong
          match, then to the most-voted weak match, then to ``R1`` default.
    """
    if last_winning_combo is not None and last_winning_combo in order:
        order = (last_winning_combo, *(c for c in order if c != last_winning_combo))

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


# ── Power detection stages ────────────────────────────────────────────────────
# Three crops of decreasing width. Which of them a given layout runs, and in
# what order, is per profile — see _Layout.power_stages.


def _first_number_at_least(data: dict[str, list[Any]], floor: int) -> int | None:
    """Return the first token in a pytesseract image_to_data dict that parses
    to a number >= floor (skipping empty text and negative-confidence
    tokens), or None if none qualifies. Shared by the two stages below that
    scan every token looking for a plausible power value — _power_from_psm8_crop
    doesn't use this: it joins the crop's words into one string and parses
    once, a different algorithm, not the same duplication."""
    for i, t in enumerate(data["text"]):
        t = t.strip()
        if not t:
            continue
        if int(data["conf"][i]) < 0:
            continue
        val = parse_number(t)
        if val is not None and val >= floor:
            return val
    return None


def _power_from_row_scan(image: np.ndarray, y: int, layout: _Layout) -> int | None:
    """PSM 11 sparse text on the left portion of the row, up to the points
    column. Widest crop, most robust when nothing but power ink is in it.

    The points column start is excluded so that events like Ironblood
    Battlefield (where scores exceed 1 M) don't return a score value instead
    of the actual power. The power column sits well within that bound on all
    observed layouts.
    """
    h = image.shape[0]
    row_end = min(y + layout.row_height, h)
    data = pytesseract.image_to_data(
        image[y:row_end, : layout.points_x[0]],
        config="--psm 11 -c tessedit_char_whitelist=0123456789,",
        output_type=Output.DICT,
    )
    return _first_number_at_least(data, MIN_POWER)


def _power_from_psm8_crop(image: np.ndarray, y: int, layout: _Layout) -> int | None:
    """PSM 8 on a fixed crop — left margin widened to catch power numbers
    whose leading digits start further left on some layouts."""
    if layout.power_fallback_x is None:
        raise ValueError(
            "power_stages lists 'psm8' but this layout has no power_fallback_x — "
            "measure a real x-band for this profile before enabling the stage "
            "(see _Layout.power_stages)"
        )
    py1 = y + layout.power_fallback_y_off[0]
    py2 = y + layout.power_fallback_y_off[1]
    fx0, fx1 = layout.power_fallback_x
    data = pytesseract.image_to_data(
        image[py1:py2, fx0:fx1],
        config="--psm 8 -c tessedit_char_whitelist=0123456789,",
        output_type=Output.DICT,
    )
    val = parse_number(_words_from_data(data, min_conf=0))
    if val is not None and val >= MIN_POWER:
        return val
    return None


def _power_from_normalized_crop(image: np.ndarray, y: int, layout: _Layout) -> int | None:
    """Contrast-normalized PSM 11 on layout.power_x — coloured power text
    (e.g. green R3) appears as medium gray (~121) after the standard
    grayscale+inversion preprocess — same root cause as the name detection
    failure for the same row. Stretching the power crop to [0, 255] makes
    the digits legible. layout.power_x skips the avatar and the masked
    sword-icon area, both of which would corrupt normalization — this is
    also the narrowest of the 3 crops, which is why it's promoted first on
    layouts where the avatar bleeds into the wider row-scan crop instead.
    """
    py1 = y + layout.power_fallback_y_off[0]
    py2 = y + layout.power_fallback_y_off[1]
    power_crop = image[py1:py2, layout.power_x[0] : layout.power_x[1]]
    if power_crop.size == 0:
        return None
    norm_power = cv2.normalize(power_crop, None, 0, 255, cv2.NORM_MINMAX)  # type: ignore[call-overload]
    data = pytesseract.image_to_data(
        norm_power,
        config="--psm 11 -c tessedit_char_whitelist=0123456789,",
        output_type=Output.DICT,
    )
    return _first_number_at_least(data, MIN_POWER)


_POWER_STAGE_FNS: dict[_PowerStage, Callable[[np.ndarray, int, _Layout], int | None]] = {
    "row_scan": _power_from_row_scan,
    "psm8": _power_from_psm8_crop,
    "normalized": _power_from_normalized_crop,
}


class PolarInvasionV1Parser(BaseParser):
    # No member_list_top / row_height class attributes: this parser has one
    # layout per source profile, so a single pair of class-level constants
    # could only ever be right for one of them. extract.py used to read them
    # as a fallback row band; it now skips the LLM re-read instead of cropping
    # at a guessed position (see _apply_llm_fallback).

    def parse(
        self,
        image: np.ndarray,
        emit_trace: bool = False,
        event_code: str | None = None,
    ) -> ParseResult:
        h = image.shape[0]
        layout = _layout_for_image(image)

        # The 2-column header bands (layout.battlers_x_2col /
        # total_points_x_2col) are profile-aware like the rest of `layout`,
        # but not every profile has them measured — phone and emulator both
        # do now (emulator added 2026-08-22 from wasteland_showdown captures
        # 007/008), a hypothetical third profile might not. Refusing here
        # rather than falling back to another profile's bands matters:
        # mixing this profile's y-band with a different profile's x-bands
        # produced plausible-looking but silently wrong totals when this was
        # first measured (total_points 5780 read as 57, 4565 as 451 — see
        # aoz-alliance-starter#91). event_code=None (dev-tools/tests calling
        # parse() directly, never production — extract.py always supplies a
        # code via REGISTRY) is deliberately left ungated here: _parse_header's
        # own fallback refuses the 2-column bands when unmeasured instead of
        # applying them, so that path can't corrupt totals either.
        if (
            layout.battlers_x_2col is None or layout.total_points_x_2col is None
        ) and event_code in _TWO_COL_EVENTS:
            raise UnsupportedAspectRatioError(
                f"event_code={event_code!r} uses the 2-column header layout, whose crop "
                "positions have no measured bands on this profile — refusing to parse a "
                f"1080x{h} image with another profile's header bands"
            )

        dt, battlers, alliance_rank, total_points = self._parse_header(image, event_code, layout)
        event_datetime = _paris_isoformat(dt) if dt else None

        row_h = layout.row_height
        list_top = self._detect_list_top(image, layout)

        members: list[MemberResult] = []
        # Local across the whole image: the (threshold, psm) combo that
        # carried the most recent successful rank vote.  Lighting is
        # constant within a screenshot, so re-trying that combo first on
        # the next row usually lets _detect_rank exit after 1–2 attempts.
        rank_cache: dict[str, tuple[int, int] | None] = {"last": None}
        # Require most of the power crop to be inside the image. Some overhang
        # accepts the last row even when it's slightly clipped, but rows whose
        # power digits are too truncated to read reliably are rejected —
        # without this, OCR on the partial power line returns noise and
        # validate_member spuriously accepts it (e.g. void_war-002 row 10
        # returning a 49M garbage value).
        #
        # The tolerance is a fraction of the power band, not a fixed pixel
        # count: the original 20px was calibrated against the phone band
        # (65px, so 31%), and reused literally on the emulator band (38px) it
        # would allow 53% of the power crop offscreen — twice as much of the
        # failure this guard exists to stop. Derived this way it stays exactly
        # 20 on phone and becomes 11 on emulator (measured: same 8 reachable
        # rows on all 4 emulator fixtures either way).
        overhang = (layout.power_y_off[1] - layout.power_y_off[0]) * 20 // 65
        usable_end = h - (layout.power_y_off[1] - overhang)
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
            # Same fallback as the log line above: event_code is None only on
            # the dev-tools/tests-only direct-call path (production always
            # supplies one via REGISTRY). Previously hardcoded to
            # "polar_invasion" regardless of event_code — silently wrong for
            # every other event this parser backs (elite_wars,
            # wasteland_showdown, ...), papered over by extract.py's own
            # override (extract.py:166-169) whenever the two didn't match.
            # Fixed at the source instead: that override becomes a no-op in
            # the common case rather than doing the real work.
            event_type=event_code or "polar_invasion",
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

        Each member row is a panel followed by a separator zone (a bright
        shadow line on phone, a dark card-gap on the emulator skin — see
        layout.list_top_dip_range); the row-to-row pitch is consistent
        within one layout profile (see layout.row_height). We sample a
        right-edge column band (layout.list_top_edge_x) where no text
        intrudes, find narrow zones matching list_top_dip_range and
        list_top_zone_width, and pick the first pair whose pitch falls in
        layout.row_gap_pitch. row 0's top is then the first zone's start
        plus layout.list_top_zone_offset — on phone the zone marks the
        row_0/row_1 boundary (offset -row_height); on the emulator skin it
        marks each row's own top instead, with a small measured lag (see
        that field's docstring — the two profiles' separators are different
        physical signals, not the same one at different coordinates).

        Width filtering excludes the wide zone that sits above row 0 (a mix
        of stats/header background and the gap below the Member/Points
        column titles). Falls back to layout.member_list_top when no
        qualifying pair is found, or immediately when
        layout.use_dynamic_list_top is False.
        """
        if not layout.use_dynamic_list_top:
            return layout.member_list_top

        # These 6 fields are None on any layout with use_dynamic_list_top
        # False — reaching here with one unset means a layout turned the
        # scan on without ever measuring a real row-separator band for its
        # own UI chrome (see _Layout's docstring). Fail loudly rather than
        # scan whatever band happens to be left over from another profile.
        # Explicit raises, not asserts: asserts are stripped under `python -O`
        # / PYTHONOPTIMIZE, which would replace these messages with an opaque
        # "cannot unpack non-sequence NoneType" a few lines below.
        if layout.list_top_edge_x is None:
            raise ValueError("use_dynamic_list_top=True needs a measured list_top_edge_x")
        if layout.list_top_search_start is None:
            raise ValueError("use_dynamic_list_top=True needs a measured list_top_search_start")
        if layout.row_gap_pitch is None:
            raise ValueError("use_dynamic_list_top=True needs a measured row_gap_pitch")
        if layout.list_top_dip_range is None:
            raise ValueError("use_dynamic_list_top=True needs a measured list_top_dip_range")
        if layout.list_top_zone_width is None:
            raise ValueError("use_dynamic_list_top=True needs a measured list_top_zone_width")
        if layout.list_top_zone_offset is None:
            raise ValueError("use_dynamic_list_top=True needs a measured list_top_zone_offset")

        h = int(image.shape[0])

        if image.ndim == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image

        edge_x0, edge_x1 = layout.list_top_edge_x
        right_edge = gray[:, edge_x0:edge_x1].mean(axis=1)

        # drop_clipped_start=False: this scan starts at a fixed offset
        # (layout.list_top_search_start), not the array origin, so a zone
        # already matching there is a legitimate start, not an artifact of
        # the window boundary (contrast ContributionRankingV1Parser._detect_list_top,
        # which has no such fixed offset and so needs the opposite default).
        # include_clipped_end keeps a zone still matching at y=h, provided
        # it's already narrow enough to qualify.
        start = layout.list_top_search_start
        dip_lo, dip_hi = layout.list_top_dip_range
        width_min, width_max = layout.list_top_zone_width
        search_mask = (right_edge[start:h] >= dip_lo) & (right_edge[start:h] <= dip_hi)
        zones = [
            (start + s, start + e)
            for s, e in find_runs(
                search_mask,
                min_len=width_min,
                max_len=width_max,
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
                row_0_top = z1[0] + layout.list_top_zone_offset
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
            # parse()'s own guard already refuses this event_code on a profile
            # without measured 2-column bands before _parse_header is ever
            # called; these checks exist so a future direct call (bypassing
            # that guard, e.g. a new test or tool) fails loudly instead of
            # crashing on Nones or silently reading a (0, 0) crop.
            if layout.battlers_x_2col is None:
                raise ValueError("2-column event_code needs a measured battlers_x_2col")
            if layout.total_points_x_2col is None:
                raise ValueError("2-column event_code needs a measured total_points_x_2col")
            return (
                dt,
                _ocr_number(layout.battlers_x_2col),
                None,
                _ocr_number(layout.total_points_x_2col),
            )

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
        #
        # Reached only when the heuristic above didn't find a plausible
        # 3-column reading. Both phone and emulator have measured bands now;
        # a profile without them (layout.battlers_x_2col is None) would pair
        # this profile's stats_y with another profile's x-bands — the mix
        # parse()'s own guard exists to prevent when the event_code is known
        # (measured: total_points 5780 read as 57, 4565 as 451). Here the
        # event_code is unknown by definition (this is the no-code fallback),
        # so that guard can't have run — an unread header is reported as
        # unread instead; the member rows below it are fully profile-aware
        # and still parse normally.
        if layout.battlers_x_2col is None or layout.total_points_x_2col is None:
            logger.warning(
                "header unreadable: the 3-column heuristic failed and the 2-column "
                "fallback bands have no measured positions for this profile — "
                "returning an empty header rather than another profile's x-bands"
            )
            return dt, None, None, None

        battlers = _ocr_number(layout.battlers_x_2col)
        total_points = _ocr_number(layout.total_points_x_2col)
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
        # Mask the crossed-swords icon if present, in this profile's own
        # measured band. None = no band measured for this layout, so no
        # masking (see _Layout.sword_icon_band).
        if layout.sword_icon_band is not None:
            row_img = mask_sword_icon(row_img, 1.0, layout.sword_icon_band)

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
                # Power: record the widest region any _detect_power stage
                # scans (the full-row strip left of the points column, see
                # _power_from_row_scan) — that stage leads on the phone
                # layout but isn't in the emulator layout's power_stages at
                # all, so this box is a superset for visual debugging, not
                # necessarily what decided the value. The sword-icon mask is
                # applied to this strip before OCR (phone only, see
                # layout.sword_icon_band); the trace box is the pre-mask
                # extent.
                power=FieldBox(y1=y, y2=y + row_h, x1=0, x2=layout.points_x[0]),
                points=FieldBox(y1=y, y2=y + row_h, x1=layout.points_x[0], x2=layout.points_x[1]),
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
        """Detect power by trying this layout's power_stages in order.

        Which stages run, and in which order, is per-profile: the widest crop
        is the most robust when it's clean, but on a layout where it picks up
        non-power ink (an avatar bleeding into the sweep) it is demoted or
        dropped entirely. A stage absent from layout.power_stages never runs —
        see that field for the measurements behind each list.

        Returns the first stage's value, or None if every listed stage comes
        up empty (the row is then dropped by validate_member and counted by
        parse()'s possible_truncation warning, rather than filled with a
        value no stage could actually read).
        """
        for stage_name in layout.power_stages:
            val = _POWER_STAGE_FNS[stage_name](image, y, layout)
            if val is not None:
                return val
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
        rank, winning_combo = _detect_rank_from_crop(
            crop, last_winning_combo=last, order=layout.rank_ocr_order
        )
        if rank_cache is not None and winning_combo is not None:
            rank_cache["last"] = winning_combo
        return rank
