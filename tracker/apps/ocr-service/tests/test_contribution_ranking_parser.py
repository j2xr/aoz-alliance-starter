"""Unit tests for the contribution_ranking_v1 (donation) parser and dispatcher."""

import json
import logging
from math import ceil
from pathlib import Path
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest

from app.dispatcher import DONATION_CODE, UnknownEventError, detect_screen_kind
from app.parsers.base import DonationMember, DonationParseResult
from app.parsers.contribution_ranking_v1 import (
    _MAX_ROWS,
    _MEMBER_LIST_TOP,
    _MIN_NAME_BAND_HEIGHT,
    _NAME_Y_OFF,
    _POSITION_PSMS,
    _POSITION_THRESHOLDS,
    _ROW_HEIGHT,
    _TAB_DETECT_MIN_DELTA,
    _TAB_X,
    _TABS_Y,
    CANONICAL_HEIGHT,
    ContributionRankingV1Parser,
    _ocr_position_from_crop,
    _strip_alliance_tag,
    tab_zone_stats,
)
from app.preprocess import preprocess_image
from app.validators import validate_donation_member

_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "contribution_ranking"

_OCR_STRING = "app.parsers.contribution_ranking_v1.pytesseract.image_to_string"
_OCR_DATA = "app.parsers.contribution_ranking_v1.pytesseract.image_to_data"
_DISPATCHER_OCR = "app.dispatcher.pytesseract.image_to_string"


def _ocr_data(text: str = "", conf: int = 90) -> dict[str, list[Any]]:
    words = text.split() if text.strip() else [""]
    n = len(words)
    return {
        "text": words,
        "conf": [str(conf)] * n,
        "level": [0] * n,
        "page_num": [0] * n,
        "block_num": [0] * n,
        "par_num": [0] * n,
        "line_num": [0] * n,
        "word_num": [0] * n,
        "left": [0] * n,
        "top": [0] * n,
        "width": [0] * n,
        "height": [0] * n,
    }


# ── Alliance-tag stripping ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected_tag,expected_name",
    [
        ("(SOD) jeinsolaya", "SOD", "jeinsolaya"),
        ("(SOD)Аня", "SOD", "Аня"),
        ("(LOL) The_Hatter", "LOL", "The_Hatter"),
        ("  (sod)  jαsmIN", "sod", "jαsmIN"),
        ("noTagPlayer", None, "noTagPlayer"),
        ("", None, ""),
        # Leading rank-column bleed: digit(s) before the alliance tag
        ("6 (LOL) CATFIGHT", "LOL", "CATFIGHT"),
        ("16 (LOL) Hardcore101", "LOL", "Hardcore101"),
        # Leading OCR junk character before the tag (e.g. Tesseract noise)
        ("`(LOL) Genesis", "LOL", "Genesis"),
        # Space inside the closing paren (Tesseract artifact)
        ("(LOL ) Name", "LOL", "Name"),
        # Avatar bleed: a letter-like glyph before the tag must still strip
        # (the old [^A-Za-z(]* excluded letters and left "(SOD) Name" intact).
        ("x (SOD) Аня", "SOD", "Аня"),
        ("Sai (SOD) CumStang", "SOD", "CumStang"),
        ("D| (SOD) Noside", "SOD", "Noside"),
        ("y) (SOD) Andy_G29", "SOD", "Andy_G29"),
        # Avatar bleed forming a bogus *leading paren* of its own (a stray '('
        # glyph followed by a non-alphanumeric character before the real
        # tag) — the old anchored [^(]{0,6} prefix could never skip past that
        # first '(' and left the whole string un-stripped in production.
        ("(а (SOD) KOR.Chawoo", "SOD", "KOR.Chawoo"),
        ("(해 (SOD) moco", "SOD", "moco"),
        # But a genuinely tag-less name (no paren) is untouched, even with a
        # short leading token.
        ("xX noTag", None, "xX noTag"),
        # The tag pattern consumes the entire string, leaving no name: reject
        # the split and fall back to the raw text untouched.
        ("(SOD)", None, "(SOD)"),
    ],
)
def test_strip_alliance_tag(raw: str, expected_tag: str | None, expected_name: str) -> None:
    tag, name = _strip_alliance_tag(raw)
    assert tag == expected_tag
    assert name == expected_name


# ── Leaderboard position (best-effort, informational) ───────────────────────────

_POSITION_CALLS_PER_CROP = len(_POSITION_THRESHOLDS) * len(_POSITION_PSMS)


def test_ocr_position_from_crop_strong_majority() -> None:
    """Unanimous vote across every threshold/psm combo: return the value."""
    crop = np.zeros((10, 10), dtype=np.uint8)
    with patch(_OCR_STRING, return_value="42"):
        assert _ocr_position_from_crop(crop) == 42


def test_ocr_position_from_crop_no_majority_returns_none() -> None:
    """An even split (no reading reaches the 70% bar): don't guess."""
    crop = np.zeros((10, 10), dtype=np.uint8)
    calls = {"n": 0}

    def side_effect(*args: Any, **kwargs: Any) -> str:
        calls["n"] += 1
        return "5" if calls["n"] % 2 == 0 else "8"

    with patch(_OCR_STRING, side_effect=side_effect):
        assert _ocr_position_from_crop(crop) is None


def test_ocr_position_from_crop_no_digits_returns_none() -> None:
    """The top-3 medal rows have no plain digit to whitelist-OCR: no votes at all."""
    crop = np.zeros((10, 10), dtype=np.uint8)
    with patch(_OCR_STRING, return_value=""):
        assert _ocr_position_from_crop(crop) is None


def test_ocr_position_from_crop_ignores_out_of_range_values() -> None:
    """A value outside 1-999 (whitelist noise) never wins the vote."""
    crop = np.zeros((10, 10), dtype=np.uint8)
    with patch(_OCR_STRING, return_value="10000"):
        assert _ocr_position_from_crop(crop) is None


def test_ocr_position_from_crop_majority_survives_a_few_dissenting_votes() -> None:
    """A strong-but-not-unanimous majority (>=70%) still wins.

    Dissent count is derived from the actual combo count so the test doesn't
    silently stop exercising the "not quite unanimous" path if
    _POSITION_THRESHOLDS/_POSITION_PSMS ever change size.
    """
    crop = np.zeros((10, 10), dtype=np.uint8)
    total = _POSITION_CALLS_PER_CROP
    dissent_count = max(1, total - ceil(total * 0.75))  # majority stays >= 75% > 70% bar
    assert 0 < dissent_count < total * 0.3, "fixture assumption: dissent must stay a minority"
    calls = {"n": 0}

    def side_effect(*args: Any, **kwargs: Any) -> str:
        i = calls["n"]
        calls["n"] += 1
        return "3" if i < dissent_count else "9"

    with patch(_OCR_STRING, side_effect=side_effect):
        assert _ocr_position_from_crop(crop) == 9


def test_parser_populates_leaderboard_position_best_effort() -> None:
    """The parser wires the position vote into DonationMember, end to end."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            return _ocr_data("(SOD) Ghost", conf=85)
        return _ocr_data("", conf=-1)

    def string_side_effect(*args: Any, **kwargs: Any) -> str:
        config = (
            kwargs.get("config", "") if "config" in kwargs else (args[1] if len(args) > 1 else "")
        )
        if "tessedit_char_whitelist=0123456789," in config:  # honor (comma in whitelist)
            return "630"
        if "tessedit_char_whitelist=0123456789" in config:  # position (no comma)
            return "7"
        return ""

    with (
        patch("app.parsers.contribution_ranking_v1._POSITION_OCR_ENABLED", True),
        patch(_OCR_DATA, side_effect=data_side_effect),
        patch(_OCR_STRING, side_effect=string_side_effect),
    ):
        result = parser.parse(image)

    assert result.members
    assert result.members[0].leaderboard_position == 7


def test_parser_skips_position_ocr_when_disabled() -> None:
    """OCR_LEADERBOARD_POSITION_ENABLED=false is a hard escape hatch: no OCR calls at all."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            return _ocr_data("(SOD) Ghost", conf=85)
        return _ocr_data("", conf=-1)

    def string_side_effect(*args: Any, **kwargs: Any) -> str:
        config = (
            kwargs.get("config", "") if "config" in kwargs else (args[1] if len(args) > 1 else "")
        )
        if "tessedit_char_whitelist=0123456789," in config:
            return "630"
        # If position OCR ran despite the flag, it would hit this branch and
        # "succeed" — asserting None below would then catch the regression.
        if "tessedit_char_whitelist=0123456789" in config:
            return "7"
        return ""

    with (
        patch("app.parsers.contribution_ranking_v1._POSITION_OCR_ENABLED", False),
        patch(_OCR_DATA, side_effect=data_side_effect),
        patch(_OCR_STRING, side_effect=string_side_effect),
    ):
        result = parser.parse(image)

    assert result.members
    assert result.members[0].leaderboard_position is None


# ── Validator ───────────────────────────────────────────────────────────────────


def _donor(**overrides: object) -> DonationMember:
    defaults: dict[str, object] = {
        "name": "Aña",
        "alliance_tag": "SOD",
        "rank": "R1",
        "alliance_honor": 1234,
        "confidence": 0.9,
    }
    defaults.update(overrides)
    return DonationMember(**defaults)  # type: ignore[arg-type]


def test_valid_donor() -> None:
    assert validate_donation_member(_donor()) is True


def test_zero_honor_kept() -> None:
    """alliance_honor = 0 is a legitimate row (player ranked but didn't donate yet)."""
    assert validate_donation_member(_donor(alliance_honor=0)) is True


def test_empty_name_rejected() -> None:
    assert validate_donation_member(_donor(name="")) is False


def test_negative_honor_rejected() -> None:
    # Pydantic accepts negative ints (no constraint at the model level), but
    # the validator catches them.
    assert validate_donation_member(_donor(alliance_honor=-1)) is False


def test_empty_rank_accepted_for_viewer_row() -> None:
    """The highlighted "viewer" row has no R-badge; rank='' must still pass."""
    assert validate_donation_member(_donor(rank="")) is True


# ── Parser shape ────────────────────────────────────────────────────────────────


def test_parser_returns_donation_result_kind() -> None:
    """All-zero image: the tab band has no ink at all, so the tab is
    ambiguous ("unknown"), never guessed as "weekly" — this pins the
    ambiguous-input contract, not a specific detected period."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()

    with patch(_OCR_STRING, return_value=""), patch(_OCR_DATA, return_value=_ocr_data("")):
        result = parser.parse(image)

    assert isinstance(result, DonationParseResult)
    assert result.kind == "donation"
    assert result.period_type == "unknown"
    assert result.members == []


# ── Silent-truncation flag ────────────────────────────────────────────────────


def _canonical_image() -> np.ndarray:
    """Exactly canonical height (scale=1), so row_h=175 and name_end_offset=130
    match the raw canonical constants — makes rows_onscreen easy to reason
    about by hand for the tests below."""
    return np.zeros((CANONICAL_HEIGHT, 1080), dtype=np.uint8)


@pytest.mark.parametrize(
    "list_top, row_returns, expected_member_count, expected_flag, expected_rows_onscreen",
    [
        pytest.param(
            700,
            [_donor(alliance_honor=1000 - i * 10) for i in range(6)] + [None, None, None],
            6,
            True,
            9,
            id="rows_missing_within_reach_are_flagged",
        ),
        pytest.param(
            700,
            [_donor(alliance_honor=1000 - i * 10) for i in range(9)],
            9,
            False,
            9,
            id="geometric_cutoff_not_flagged",
        ),
        pytest.param(
            0,
            [_donor(alliance_honor=1000 - i * 10) for i in range(_MAX_ROWS)],
            _MAX_ROWS,
            False,
            _MAX_ROWS,
            id="every_row_reads_not_flagged",
        ),
    ],
)
def test_possible_truncation(
    list_top: int,
    row_returns: list[DonationMember | None],
    expected_member_count: int,
    expected_flag: bool,
    expected_rows_onscreen: int,
) -> None:
    """rows_onscreen subsumes every way a row can go missing: it doesn't
    matter *why* a row within physical reach didn't make it into members
    (unreadable or rejected by validate_donation_member) — fewer members
    than the rows that fit onscreen is always flagged (case 1). A capture
    where list_top leaves room for fewer than _MAX_ROWS rows (a scroll
    position further down the page, or a shorter aspect ratio) is not
    truncation as long as every row that physically fit was read — list_top
    =700 in a canonical-height image leaves room for exactly 9 rows
    ((2400-700-130)//175 + 1 == 9, case 2); list_top=0 leaves room for all
    _MAX_ROWS (case 3). expected_rows (the same rows_onscreen value) is
    exposed on the result so a caller can judge how severe a flagged
    truncation is (e.g. discord-bot's upsert.ts truncation ratio guard)
    instead of only seeing the boolean."""
    parser = ContributionRankingV1Parser()

    with (
        patch.object(parser, "_detect_list_top", return_value=list_top),
        patch.object(parser, "_parse_row", side_effect=row_returns),
    ):
        result = parser.parse(_canonical_image())

    assert result.possible_truncation is expected_flag
    assert len(result.members) == expected_member_count
    assert result.expected_rows == expected_rows_onscreen


# ── list_top detection (synthetic bands) ──────────────────────────────────────
#
# _detect_list_top had no dedicated unit test: the only coverage was via
# possible_truncation tests that patch it out entirely, and via full fixture
# images where a bug in the underlying band logic is easy to miss (that's how
# the regression below survived pytest and only showed up against a real
# capture in bench-ocr). These use small synthetic frames — no OCR involved —
# to pin the periodicity/height rules directly.


def _list_top_image(
    dark_bands: list[tuple[int, int]],
    height: int = CANONICAL_HEIGHT,
    bg: int = 230,
    ink: int = 80,
) -> np.ndarray:
    """Canonical-height (scale=1.0) grayscale frame with `ink`-colored bands
    painted into the name column (x=270:720) at the given absolute
    (y_start, y_end) pixel ranges, on an otherwise flat `bg` background."""
    image = np.full((height, 1080), bg, dtype=np.uint8)
    for y0, y1 in dark_bands:
        image[y0:y1, 270:720] = ink
    return image


def _expected_list_top(name_band: tuple[int, int]) -> int:
    """Same centring arithmetic _detect_list_top applies to an accepted band."""
    name_centre = (name_band[0] + name_band[1]) // 2
    name_offset = (_NAME_Y_OFF[0] + _NAME_Y_OFF[1]) // 2
    return name_centre - name_offset


def test_detect_list_top_rejects_tall_header_lacking_periodic_followup() -> None:
    """A 37px band (the column header's real measured height) with nothing
    ~row_h below it is skipped even though it's tall enough and comes first;
    the algorithm moves on to the real, periodic name band instead.

    Regression test for a real bug: an earlier version of the periodicity
    window was stretched by the candidate's own height, so this exact header
    aliased onto the unrelated real row-1 band below and got wrongly accepted
    as row 0 — measured on the weekly_010 fixture via bench-ocr, corrupting
    every row's crop (name accuracy dropped from 11/12 to 2/12).
    """
    header = (354, 391)
    name0 = (397, 426)
    name1 = (name0[0] + _ROW_HEIGHT, name0[1] + _ROW_HEIGHT)  # confirms name0 is periodic
    parser = ContributionRankingV1Parser()

    result = parser._detect_list_top(_list_top_image([header, name0, name1]), scale=1.0)

    assert result == _expected_list_top(name0)


def test_detect_list_top_accepts_periodic_name_band() -> None:
    """The common case: a 29px name-height band whose only neighbor is its
    own periodic followup is accepted directly as row 0."""
    name0 = (400, 429)
    name1 = (name0[0] + _ROW_HEIGHT, name0[1] + _ROW_HEIGHT)
    parser = ContributionRankingV1Parser()

    result = parser._detect_list_top(_list_top_image([name0, name1]), scale=1.0)

    assert result == _expected_list_top(name0)


def test_detect_list_top_skips_band_clipped_at_window_start() -> None:
    """A band whose ink already started above search_start (330) has an
    unknown true height/position, so it's excluded outright rather than
    measured — the real row-0 band right after it is used instead."""
    clipped = (300, 355)  # ink begins before the search window opens at 330
    name0 = (410, 439)
    name1 = (name0[0] + _ROW_HEIGHT, name0[1] + _ROW_HEIGHT)
    parser = ContributionRankingV1Parser()

    result = parser._detect_list_top(_list_top_image([clipped, name0, name1]), scale=1.0)

    assert result == _expected_list_top(name0)


def test_detect_list_top_falls_back_when_only_band_is_clipped_at_window_end() -> None:
    """A band that never turns off before the search window's far edge is
    likewise unmeasurable and excluded; with no other candidate, the
    canonical fallback is used rather than guessing from a partial band."""
    # Ink from y=600 through the bottom of the frame — still "on" past the
    # extended lookahead window used for the periodicity check.
    image = _list_top_image([(600, CANONICAL_HEIGHT)])
    parser = ContributionRankingV1Parser()

    result = parser._detect_list_top(image, scale=1.0)

    assert result == _MEMBER_LIST_TOP


def test_detect_list_top_skips_sub_floor_fragment() -> None:
    """A fragment shorter than _MIN_NAME_BAND_HEIGHT (e.g. the first line of
    a wrapped two-line name, too faint/thin on its own) is noise, not a
    candidate — the algorithm continues past it to the real name band."""
    fragment = (400, 400 + _MIN_NAME_BAND_HEIGHT - 2)
    name0 = (430, 459)
    name1 = (name0[0] + _ROW_HEIGHT, name0[1] + _ROW_HEIGHT)
    parser = ContributionRankingV1Parser()

    result = parser._detect_list_top(_list_top_image([fragment, name0, name1]), scale=1.0)

    assert result == _expected_list_top(name0)


def test_detect_list_top_falls_back_on_low_contrast_window() -> None:
    """When no row in the search window stands out from the background by at
    least the minimum span, the whole window is treated as textless (e.g. a
    faint/washed-out capture) and the canonical fallback is used."""
    image = _list_top_image([(400, 429)], bg=225, ink=215)  # span ~10 < the 15.0 floor

    parser = ContributionRankingV1Parser()
    result = parser._detect_list_top(image, scale=1.0)

    assert result == _MEMBER_LIST_TOP


# ── Tab detection ─────────────────────────────────────────────────────────────
#
# _detect_selected_tab has a documented history of silent failure: the band it
# used to sample, (200, 320), actually hit the column-header row ("Rank /
# Commander Name / Alliance Honor"), not the Daily/Weekly/History tab pills —
# see _TABS_Y's own comment for the measured evidence. Because "Commander
# Name" (the longest header string) sits in the same x-zone as the "weekly"
# tab, that band read as a confident "weekly" for every real capture ever
# processed, including real Daily-tab captures. The tests below are built
# specifically to make that class of bug fail loudly if reintroduced, rather
# than just re-testing the current (now correct) band in isolation — the
# original tests here were vacuous in three independent ways (see each test's
# docstring) and none of them caught it.

# Measured 2026-07-26 by ink-density runs over the full width, on both a real
# Daily and a real Weekly capture (docs/maintenance/2026-07-26-*.md).
_MEASURED_PILL_Y = (105, 198)  # tab pill fill
_MEASURED_TAB_DIVIDER_Y = (199, 216)  # bright divider directly under the tab row
_MEASURED_COLUMN_HEADER_Y = (259, 276)  # "Rank / Commander Name / Alliance Honor" ink


def test_tabs_y_lies_inside_the_measured_pill_and_clears_the_column_header() -> None:
    """Pins _TABS_Y against independently-measured real-capture geometry,
    rather than a synthetic image the constant itself could define. Against
    the old (wrong) band, (200, 320), both assertions fail instantly, with no
    image and no OCR involved — the cheapest possible regression guard."""
    assert _MEASURED_PILL_Y[0] <= _TABS_Y[0] < _TABS_Y[1] <= _MEASURED_PILL_Y[1]
    assert _TABS_Y[1] <= _MEASURED_TAB_DIVIDER_Y[0]


def _tab_band_image(selected: str | None, *, brighter: bool = False) -> np.ndarray:
    """Synthetic canonical-height frame with one tab pill standing out, plus a
    decoy that mimics the real "Commander Name" column-header ink.

    The pill is painted at the independently-measured `_MEASURED_PILL_Y`, NOT
    at `_TABS_Y` — deliberately, so this fixture stays adversarial even if
    `_TABS_Y` regresses. (The original version of this helper painted its
    pill using `_TABS_Y` itself, so it moved in lockstep with the constant
    and could never catch a mis-aimed band — that's one of the three ways
    this suite was vacuous.) The decoy sits at `_MEASURED_COLUMN_HEADER_Y` in
    the "weekly" x-zone, entirely outside the correct pill band, so it has no
    effect on the current (correct) implementation — see
    test_decoy_header_ink_would_confidently_win_the_old_mis_aimed_band for
    proof it would confidently mislead a regressed one.

    `brighter=True` exercises the non-inverted direction (selected pill
    lighter than the rest) to prove the median-deviation rule does not
    assume a fixed polarity.
    """
    image = np.full((2400, 1080), 200, dtype=np.uint8)
    hy0, hy1 = _MEASURED_COLUMN_HEADER_Y
    hxa, hxb = _TAB_X["weekly"]
    image[hy0:hy1, hxa:hxb] = 30  # decoy: dense header ink, always present
    if selected is not None:
        py0, py1 = _MEASURED_PILL_Y
        xa, xb = _TAB_X[selected]
        image[py0:py1, xa:xb] = 230 if brighter else 170
    return image


@pytest.mark.parametrize("selected", ["daily", "weekly", "history"])
def test_detect_selected_tab_darker_pill(selected: str) -> None:
    """The selected pill reads darker than the two unselected tabs (inverted UI)."""
    parser = ContributionRankingV1Parser()
    result = parser._detect_selected_tab(_tab_band_image(selected))
    assert result == selected


@pytest.mark.parametrize("selected", ["daily", "weekly", "history"])
def test_detect_selected_tab_brighter_pill(selected: str) -> None:
    """Direction-agnostic: a lighter selected pill is detected just the same."""
    parser = ContributionRankingV1Parser()
    result = parser._detect_selected_tab(_tab_band_image(selected, brighter=True))
    assert result == selected


def test_decoy_header_ink_would_confidently_win_the_old_mis_aimed_band() -> None:
    """Proves the decoy in `_tab_band_image` is not a no-op: sampled with the
    old, mis-aimed band, it must confidently select "weekly" — the exact
    failure mode that shipped undetected — rather than looking ambiguous. If
    this test goes red, the decoy has been weakened and the suite has gone
    vacuous again."""
    parser = ContributionRankingV1Parser()
    with patch("app.parsers.contribution_ranking_v1._TABS_Y", (200, 320)):
        result = parser._detect_selected_tab(_tab_band_image("daily"))
    assert result == "weekly"


def test_detect_selected_tab_flat_band_returns_unknown() -> None:
    """No pill stands out (uniform band) → ambiguous. Renamed from
    '..._defaults_to_weekly': an undetectable tab must never be silently
    treated as weekly (see _AMBIGUOUS_PERIOD_TYPE's rationale) — that
    assumption is what let a real Daily capture corrupt a live weekly
    donation period."""
    parser = ContributionRankingV1Parser()
    result = parser._detect_selected_tab(_tab_band_image(None))
    assert result == "unknown"


def test_detect_selected_tab_below_threshold_returns_unknown() -> None:
    """A sub-threshold deviation is treated as noise, not a detected tab."""
    image = np.full((2400, 1080), 200, dtype=np.uint8)
    y0, y1 = _MEASURED_PILL_Y
    xa, xb = _TAB_X["history"]
    image[y0:y1, xa:xb] = 195  # 5 levels off, well under _TAB_DETECT_MIN_DELTA
    parser = ContributionRankingV1Parser()
    assert parser._detect_selected_tab(image) == "unknown"


def test_detect_selected_tab_rejects_a_deviation_as_weak_as_a_mis_aimed_band() -> None:
    """A deviation of exactly 10.0 matches the ceiling measured for the old,
    mis-aimed band across 46 real captures (8.0-10.1) — must not be mistaken
    for a real signal."""
    image = np.full((2400, 1080), 200, dtype=np.uint8)
    y0, y1 = _MEASURED_PILL_Y
    xa, xb = _TAB_X["daily"]
    image[y0:y1, xa:xb] = 190  # 200 - 190 = 10.0 deviation
    parser = ContributionRankingV1Parser()
    assert parser._detect_selected_tab(image) == "unknown"


def test_detect_selected_tab_accepts_the_weakest_real_signal_observed() -> None:
    """A deviation of 25.0 sits just under the real-signal floor measured
    across 46 real captures (25.1-29.9) — must still be trusted."""
    image = np.full((2400, 1080), 200, dtype=np.uint8)
    y0, y1 = _MEASURED_PILL_Y
    xa, xb = _TAB_X["daily"]
    image[y0:y1, xa:xb] = 175  # 200 - 175 = 25.0 deviation
    parser = ContributionRankingV1Parser()
    assert parser._detect_selected_tab(image) == "daily"


def test_tab_detect_min_delta_default_separates_measured_noise_from_measured_signal() -> None:
    """Pin the effective threshold (env-overridable, hence asserted at
    runtime rather than as a hardcoded literal) strictly between the two
    ranges measured across the 56-image corpus (10 fixtures + 46 real
    captures): mis-aimed-band ceiling 10.1, real-signal floor 25.1."""
    assert 10.1 < _TAB_DETECT_MIN_DELTA < 25.1


def test_detect_selected_tab_is_not_scaled_by_image_height() -> None:
    """A 1080x1200 frame with the pill painted at its TRUE canonical y (not
    rescaled) must still be detected correctly. A height-scaled band would
    sample y=(120,195)*1200/2400=(60,97) here — entirely flat background —
    so this fails specifically if _TABS_Y is ever multiplied by a
    height-derived scale again. The extreme ratio (h=1200, half of
    canonical) is deliberate: a milder crop (e.g. h=2160) does not
    discriminate, since a height-scaled band would still overlap the real
    pill there — see the companion real-capture test below for that case."""
    image = np.full((1200, 1080), 200, dtype=np.uint8)
    y0, y1 = _MEASURED_PILL_Y
    xa, xb = _TAB_X["daily"]
    image[y0:y1, xa:xb] = 170
    parser = ContributionRankingV1Parser()
    assert parser._detect_selected_tab(image) == "daily"


@pytest.mark.parametrize("new_height", [2160, 1920])
def test_detect_selected_tab_survives_a_bottom_cropped_real_capture(new_height: int) -> None:
    """A real capture cropped shorter (simulating a phone with a shorter
    aspect ratio) must still detect correctly — top-anchored UI chrome
    doesn't move with crop height. Guards the short-frame fallback clause,
    not the scaling bug specifically (the previous test isolates that)."""
    image = preprocess_image(str(_FIXTURES_DIR / "weekly_001.jpg"))
    parser = ContributionRankingV1Parser()
    assert parser._detect_selected_tab(image[:new_height]) == "weekly"


@pytest.mark.parametrize(
    "image_path",
    sorted(_FIXTURES_DIR.glob("*.jpg")),
    ids=lambda p: p.stem,
)
def test_detect_selected_tab_matches_real_capture_ground_truth(image_path: Path) -> None:
    """Every shipped capture's detected tab matches its ground truth, derived
    from the filename prefix (weekly_<NNN> / daily_<NNN> / history_<NNN>, per
    the fixtures README's naming convention) rather than restricted to
    fixtures with a paired .json — daily_001.jpg ships without one on purpose
    (see the README), and this test is exactly what needs to see it. Where a
    .json ground truth also exists, additionally cross-check it agrees with
    the filename prefix, so the two sources of truth can't silently drift.

    Runs the real detector on the preprocessed fixture image (no Tesseract
    needed — the tab band is pure pixel intensity).
    """
    expected = image_path.stem.split("_", 1)[0]
    assert expected in ("weekly", "daily", "history")

    json_path = image_path.with_suffix(".json")
    if json_path.exists():
        with json_path.open(encoding="utf-8") as fh:
            ground_truth = json.load(fh)
        assert ground_truth["period_type"] == expected

    image = preprocess_image(str(image_path))
    parser = ContributionRankingV1Parser()
    assert parser._detect_selected_tab(image) == expected


def test_tab_fixture_set_covers_more_than_one_period() -> None:
    """Anti-vacuity guard. The original fixture-ground-truth test was
    parametrized over 10 fixtures that were all "weekly", against a detector
    that always returned "weekly" — it could never fail. If daily_001.jpg is
    ever deleted (or every fixture quietly became one period again), this
    test goes red instead of the suite silently degenerating back into
    exactly that blind spot."""
    stems = {p.stem.split("_", 1)[0] for p in _FIXTURES_DIR.glob("*.jpg")}
    assert len(stems) >= 2, f"only one period type covered by fixtures: {stems}"


def test_tab_zone_stats_returns_none_for_a_too_short_frame() -> None:
    """_detect_selected_tab used to have this early-return inline; it now
    delegates to tab_zone_stats (extracted so tools/measure_tab_delta.py
    measures exactly what production decides). Pins that the extraction kept
    the same early-return behavior."""
    y0, _y1 = _TABS_Y
    image = np.zeros((y0, 1080), dtype=np.uint8)  # shorter than the tab band itself
    assert tab_zone_stats(image) is None
    assert ContributionRankingV1Parser()._detect_selected_tab(image) == "unknown"


def test_tab_zone_stats_returns_none_for_a_too_narrow_frame() -> None:
    image = np.zeros((2400, 1), dtype=np.uint8)  # narrower than any tab zone
    assert tab_zone_stats(image) is None
    assert ContributionRankingV1Parser()._detect_selected_tab(image) == "unknown"


def test_parser_strips_alliance_tag_in_member_output() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            return _ocr_data("(SOD) jeinsolaya", conf=85)
        if "tessedit_char_whitelist=0123456789," in config:
            return _ocr_data("630", conf=85)
        return _ocr_data("", conf=-1)

    with patch(_OCR_STRING, return_value="630"), patch(_OCR_DATA, side_effect=data_side_effect):
        result = parser.parse(image)

    assert result.members
    m = result.members[0]
    assert m.name == "jeinsolaya"
    assert m.alliance_tag == "SOD"
    assert m.alliance_honor == 630


def test_parser_normalizes_fullwidth_tag_before_stripping() -> None:
    """Le repli pleine chasse → ASCII doit précéder _strip_alliance_tag.

    "ï¼ˆSODï¼‰" est le mojibake de "（SOD）" (parenthèses pleine chasse) : sans
    normalize_name avant le strip, _ALLIANCE_TAG_RE ne reconnaît pas les
    parenthèses pleine chasse et le tag reste collé au nom.
    """
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            return _ocr_data("ï¼ˆSODï¼‰jeinsolaya", conf=85)
        if "tessedit_char_whitelist=0123456789," in config:
            return _ocr_data("630", conf=85)
        return _ocr_data("", conf=-1)

    with patch(_OCR_STRING, return_value="630"), patch(_OCR_DATA, side_effect=data_side_effect):
        result = parser.parse(image)

    assert result.members
    m = result.members[0]
    assert m.alliance_tag == "SOD"
    assert m.name == "jeinsolaya"


def test_parser_zero_honor_row_kept() -> None:
    """A row with alliance_honor=0 must NOT be dropped (some members rank but don't donate)."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            return _ocr_data("(SOD) Zero", conf=85)
        return _ocr_data("", conf=-1)

    def string_side_effect(*args: Any, **kwargs: Any) -> str:
        config = (
            kwargs.get("config", "") if "config" in kwargs else (args[1] if len(args) > 1 else "")
        )
        if "tessedit_char_whitelist=0123456789," in config:
            return "0"
        return ""

    with (
        patch(_OCR_STRING, side_effect=string_side_effect),
        patch(_OCR_DATA, side_effect=data_side_effect),
    ):
        result = parser.parse(image)

    assert result.members
    assert all(m.alliance_honor == 0 for m in result.members)


def test_parser_strips_leading_rank_no_tag() -> None:
    """Rank bleed without alliance tag: '9 PlayerName' → name='PlayerName', tag=None."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            return _ocr_data("9 Медвежонок", conf=85)
        return _ocr_data("", conf=-1)

    def string_side_effect(*args: Any, **kwargs: Any) -> str:
        config = (
            kwargs.get("config", "") if "config" in kwargs else (args[1] if len(args) > 1 else "")
        )
        if "tessedit_char_whitelist=0123456789," in config:
            return "420"
        return ""

    with (
        patch(_OCR_DATA, side_effect=data_side_effect),
        patch(_OCR_STRING, side_effect=string_side_effect),
    ):
        result = parser.parse(image)

    assert result.members
    m = result.members[0]
    assert m.name == "Медвежонок"
    assert m.alliance_tag is None


def test_parser_drops_row_when_honor_unreadable() -> None:
    """Without an OCR-able honor value the row is discarded (not zeroed)."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            return _ocr_data("(SOD) Ghost", conf=85)
        return _ocr_data("", conf=-1)

    with patch(_OCR_STRING, return_value=""), patch(_OCR_DATA, side_effect=data_side_effect):
        result = parser.parse(image)

    assert result.members == []


# ── Alliance Honor OCR (tall-crop fallback) ─────────────────────────────────────
#
# A real capture (rank 40-51 of the actual batch) showed the primary (40, 130)
# and contrast-normalized bands can starve Tesseract of quiet-zone margin even
# though the digits are fully visible in the crop — "2458" came back empty,
# not just misread. Widening the module-level Y-offset constants outright
# regressed a shipped fixture (weekly_009): _detect_list_top centres row_top
# on the offset's midpoint, so widening it shifts every row's crop for every
# image, including ones where the tight band already works. The fallback-only
# taller retry below is strictly additive instead — it can only rescue a row
# that already failed, never disturb one that already succeeds.


def test_ocr_honor_tall_fallback_recovers_value_when_primary_attempts_fail() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    calls = {"n": 0}

    def side_effect(*args: Any, **kwargs: Any) -> str:
        calls["n"] += 1
        # 1st call: primary band. 2nd: contrast-normalized primary band.
        # 3rd: the taller fallback band — the only one that "succeeds" here.
        return "2458" if calls["n"] == 3 else ""

    with patch(_OCR_STRING, side_effect=side_effect):
        assert parser._ocr_honor(image, y=0, scale=1.0) == 2458
    assert calls["n"] == 3


def test_ocr_honor_returns_none_when_even_the_tall_fallback_fails() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    with patch(_OCR_STRING, return_value=""):
        assert parser._ocr_honor(image, y=0, scale=1.0) is None


def test_ocr_honor_skips_fallback_when_primary_already_succeeds() -> None:
    """The taller crop must never be attempted when the primary band already
    works — the fallback is a rescue path, not run unconditionally."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    with patch(_OCR_STRING, return_value="1234") as mock_string:
        assert parser._ocr_honor(image, y=0, scale=1.0) == 1234
    assert mock_string.call_count == 1


# ── _ocr_honor_candidates: tall-crop fallback ────────────────────────────────
#
# _ocr_honor_candidates re-OCRs the honor cell when _enforce_honor_monotonicity
# finds a violation, but until now it only ever re-tried the SAME tight band
# _ocr_honor's first two attempts already read — never the taller fallback
# crop _ocr_honor itself falls back to (see the tall-fallback section above).
# On the one row where that tight band is known to starve Tesseract (row 11,
# see docs/maintenance/2026-07-27-row11-honor-verification.md), the sweep
# therefore re-read the same bad pixels six times and predictably found
# nothing that fit the monotone window. These tests pin the fix: the tall
# band joins the sweep as a strict, order-preserving addition.


def test_ocr_honor_candidates_reaches_the_tall_band_when_the_tight_one_yields_nothing() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    calls = {"n": 0}

    def side_effect(*args: Any, **kwargs: Any) -> str:
        calls["n"] += 1
        return "" if calls["n"] <= 6 else "2385"

    with patch(_OCR_STRING, side_effect=side_effect):
        candidates = parser._ocr_honor_candidates(image, y=0, scale=1.0)

    assert 2385 in candidates
    assert calls["n"] == 12


def test_ocr_honor_candidates_orders_tight_band_variants_first() -> None:
    """Load-bearing: _enforce_honor_monotonicity takes the FIRST candidate
    that fits its window, so a row where the tight band already produces a
    fitting value must see that value before anything the tall band finds —
    otherwise this change could silently alter an already-working row."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    calls = {"n": 0}

    def side_effect(*args: Any, **kwargs: Any) -> str:
        calls["n"] += 1
        return "2135" if calls["n"] <= 6 else "2385"

    with patch(_OCR_STRING, side_effect=side_effect):
        candidates = parser._ocr_honor_candidates(image, y=0, scale=1.0)

    assert candidates == [2135, 2385]


def test_ocr_honor_candidates_skips_the_tall_band_at_the_image_bottom() -> None:
    """Near the bottom of the image the taller slice clamps back to the same
    height as the tight one — no new pixels, so no point re-reading them."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    with patch(_OCR_STRING, return_value="") as mock_string:
        parser._ocr_honor_candidates(image, y=2270, scale=1.0)
    assert mock_string.call_count == 6


def test_ocr_honor_candidates_dedupes_a_tall_reading_that_repeats_a_tight_one() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    with patch(_OCR_STRING, return_value="2135"):
        candidates = parser._ocr_honor_candidates(image, y=0, scale=1.0)
    assert candidates == [2135]


def test_ocr_honor_candidates_returns_empty_for_an_offscreen_row() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    with patch(_OCR_STRING, return_value="2385") as mock_string:
        candidates = parser._ocr_honor_candidates(image, y=3000, scale=1.0)
    assert candidates == []
    mock_string.assert_not_called()


def test_enforce_honor_monotonicity_recovers_the_row11_case_via_the_tall_band() -> None:
    """Integration: reproduces the real production pattern (see the SOD/Test
    Alliance audit reports) — moco=2458, Somethin_kool misread as 92256 (the
    documented leading-digit corruption), next row=2051. Only pytesseract is
    mocked — _ocr_honor_candidates itself runs unmodified — so this proves
    the tall band actually reaches _enforce_honor_monotonicity's correction
    path, not just that the helper function returns the right list."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(name="moco", alliance_honor=2458, row_y=0),
        _donor(name="Somethin_kool", alliance_honor=92256, row_y=175),
        _donor(name="next", alliance_honor=2051, row_y=350),
    ]
    calls = {"n": 0}

    def side_effect(*args: Any, **kwargs: Any) -> str:
        calls["n"] += 1
        return "92256" if calls["n"] <= 6 else "2385"

    with patch(_OCR_STRING, side_effect=side_effect):
        parser._enforce_honor_monotonicity(image, members, scale=1.0)

    assert members[1].alliance_honor == 2385
    assert members[1].confidence == parser._MONOTONICITY_FIX_CONFIDENCE
    # Must still be flagged suspect — this must not short-circuit the LLM
    # fallback downstream (extract.py), which is what actually replaces the
    # honor in production today (see the maintenance doc above).
    assert members[1].suspect_honor_window == (2051, 2458)


# ── Honor monotonicity guard ─────────────────────────────────────────────────────


def test_enforce_honor_monotonicity_noop_when_already_descending() -> None:
    """Nominal case (including a legitimate tie): nothing re-OCR'd, nothing changed,
    and no row is flagged suspect — extract.py's LLM fallback must not see a window
    for a value that was never in question."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(alliance_honor=3173, row_y=0),
        _donor(alliance_honor=2925, row_y=175),
        _donor(alliance_honor=1785, row_y=350),
        _donor(alliance_honor=1785, row_y=525),  # tie: not a violation
    ]

    with patch.object(parser, "_ocr_honor_candidates") as mock_candidates:
        parser._enforce_honor_monotonicity(image, members, scale=1.0)

    mock_candidates.assert_not_called()
    assert [m.alliance_honor for m in members] == [3173, 2925, 1785, 1785]
    assert all(m.suspect_honor_window is None for m in members)


def test_enforce_honor_monotonicity_corrects_when_candidate_fits() -> None:
    """A misread that breaks order is replaced by the re-OCR candidate that fits.

    Fitting the window is a plausibility check, not proof of correctness (a
    real fixture showed a fitting-but-still-wrong candidate winning — see the
    method's docstring), so confidence is capped even on a successful fix.
    The window is recorded on this fix branch too — not just the no-fix
    branch — so extract.py's LLM fallback can hold an independently-produced
    score to the same standard even when re-OCR already changed the value.
    """
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(alliance_honor=3173, row_y=0),
        _donor(alliance_honor=9044, row_y=175, confidence=0.9),  # bad; truth is 2925
        _donor(alliance_honor=2878, row_y=350),
    ]

    with patch.object(parser, "_ocr_honor_candidates", return_value=[9044, 2925]):
        parser._enforce_honor_monotonicity(image, members, scale=1.0)

    assert members[1].alliance_honor == 2925
    assert members[1].confidence == ContributionRankingV1Parser._MONOTONICITY_FIX_CONFIDENCE
    assert members[1].suspect_honor_window == (2878, 3173)


def test_enforce_honor_monotonicity_fix_never_raises_an_already_lower_confidence() -> None:
    """The cap is a ceiling (min), never a floor: an already-lower confidence stays put."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(alliance_honor=3173, row_y=0),
        _donor(alliance_honor=9044, row_y=175, confidence=0.2),
        _donor(alliance_honor=2878, row_y=350),
    ]

    with patch.object(parser, "_ocr_honor_candidates", return_value=[2925]):
        parser._enforce_honor_monotonicity(image, members, scale=1.0)

    assert members[1].confidence == 0.2


def test_enforce_honor_monotonicity_keeps_original_when_no_candidate_fits() -> None:
    """No re-OCR candidate fits the window: keep the raw value, don't fabricate,
    but flag it by zeroing confidence for downstream visibility. This is exactly
    the production case (Somethin_kool, stored 92256, LLM correctly read 2385)
    that used to be undebugged: the window recorded here — window[0] <= 2385 <=
    window[1] — is what lets extract.py trust the LLM instead of demanding it
    reproduce the already-known-wrong 92256."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(alliance_honor=2458, row_y=0),
        _donor(alliance_honor=92256, row_y=175, confidence=0.9),  # ground truth is 2385
        _donor(alliance_honor=2051, row_y=350),
    ]

    with patch.object(parser, "_ocr_honor_candidates", return_value=[92256]):
        parser._enforce_honor_monotonicity(image, members, scale=1.0)

    assert members[1].alliance_honor == 92256  # unchanged: never fabricate a number
    assert members[1].confidence == 0.0  # flagged low-confidence instead
    assert members[1].suspect_honor_window == (2051, 2458)
    assert members[1].suspect_honor_window[0] <= 2385 <= members[1].suspect_honor_window[1]


def test_enforce_honor_monotonicity_last_row_uses_zero_as_lower_bound() -> None:
    """The last row has no successor: the fitting window is [0, previous].

    All four real production cases this guard exists for were last rows, so
    this window shape is not a corner case — it's the common one.
    """
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(alliance_honor=350, row_y=0),
        _donor(alliance_honor=999999, row_y=175),  # ground truth is 0
    ]

    with patch.object(parser, "_ocr_honor_candidates", return_value=[999999, 0]):
        parser._enforce_honor_monotonicity(image, members, scale=1.0)

    assert members[1].alliance_honor == 0
    assert members[1].suspect_honor_window == (0, 350)


def test_enforce_honor_monotonicity_skips_row_without_row_y() -> None:
    """Defensive: a member missing row_y (shouldn't happen in practice) is left as-is,
    but is still flagged suspect — the window is computed and recorded before the
    row_y check, since the value already broke order regardless of whether a
    re-crop is possible."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(alliance_honor=3173, row_y=0),
        _donor(alliance_honor=9044, row_y=None),
    ]

    with patch.object(parser, "_ocr_honor_candidates") as mock_candidates:
        parser._enforce_honor_monotonicity(image, members, scale=1.0)

    mock_candidates.assert_not_called()
    assert members[1].alliance_honor == 9044
    assert members[1].suspect_honor_window == (0, 3173)


# ── Honor monotonicity guard: log messages report the physical row ─────────────
#
# `i` (enumerate() index into `members`) drifts away from the row a human sees
# in the screenshot as soon as an earlier row is dropped for being unreadable
# or failing validation. row_index (assigned before any row is dropped, see
# ContributionRankingV1Parser._parse_row / row_index's own field docstring)
# tracks the true physical slot instead — these tests pin that the log lines
# use it. This does NOT change the "row 11" signature: reaching list index 11
# in a 12-slot layout requires all 12 rows to have survived, so row_index
# always equals the list index there regardless.


def test_monotonicity_log_reports_the_physical_row_not_the_list_index(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Physical row 2 was dropped upstream (unreadable/invalid), so the
    survivor at list index 2 is actually physical row 3 — the log must say
    so, not "row 2"."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(alliance_honor=3173, row_y=0, row_index=0),
        _donor(alliance_honor=2925, row_y=175, row_index=1),
        _donor(alliance_honor=9044, row_y=525, row_index=3),
    ]

    with patch.object(parser, "_ocr_honor_candidates", return_value=[]):
        with caplog.at_level(logging.WARNING):
            parser._enforce_honor_monotonicity(image, members, scale=1.0)

    assert any("donation row 3:" in r.message for r in caplog.records)
    assert not any("donation row 2:" in r.message for r in caplog.records)


def test_monotonicity_corrected_log_reports_the_physical_row(
    caplog: pytest.LogCaptureFixture,
) -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(alliance_honor=3173, row_y=0, row_index=0),
        _donor(alliance_honor=2925, row_y=175, row_index=1),
        _donor(alliance_honor=9044, row_y=525, row_index=3),
    ]

    with patch.object(parser, "_ocr_honor_candidates", return_value=[2878]):
        with caplog.at_level(logging.INFO):
            parser._enforce_honor_monotonicity(image, members, scale=1.0)

    assert any(
        "alliance_honor corrected" in r.message and "row 3:" in r.message for r in caplog.records
    )


def test_monotonicity_log_falls_back_to_list_index_when_row_index_is_missing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(alliance_honor=3173, row_y=0, row_index=None),
        _donor(alliance_honor=9044, row_y=175, row_index=None),
    ]

    with patch.object(parser, "_ocr_honor_candidates", return_value=[]):
        with caplog.at_level(logging.WARNING):
            parser._enforce_honor_monotonicity(image, members, scale=1.0)

    assert any("donation row 1:" in r.message for r in caplog.records)


def test_donation_member_suspect_honor_window_excluded_from_wire_payload() -> None:
    """suspect_honor_window is debug/orchestration-only (like row_y/row_h/row_index
    above it) and must never leak into the wire payload — mirrors the trace-exclusion
    tests in test_row_trace.py."""
    member = _donor(suspect_honor_window=(100, 200))
    assert "suspect_honor_window" not in member.model_dump()
    assert "suspect_honor_window" not in json.loads(member.model_dump_json())


def test_monotonicity_fix_confidence_trips_needs_review() -> None:
    """_MONOTONICITY_FIX_CONFIDENCE must land inside needsReview()'s exclusive
    [0, 0.5) bound (apps/discord-bot/src/lib/upsert.ts) — a monotonicity-corrected
    row is "unverified... left at reduced confidence for downstream visibility"
    (see the method's docstring) and must always be flagged, never silently
    treated as fine. This was the secondary P1 bug: the old value, 0.5, sat
    exactly ON the exclusive bound and was therefore never flagged."""
    assert 0.0 <= ContributionRankingV1Parser._MONOTONICITY_FIX_CONFIDENCE < 0.5


# ── Leaderboard position repair ──────────────────────────────────────────────────


def test_repair_position_sequence_reconstructs_a_clean_leading_digit_drop() -> None:
    """A single dropped leading digit (position 63 read as '3') is repaired via
    the offset that explains every other reading exactly."""
    parser = ContributionRankingV1Parser()
    members = [
        _donor(leaderboard_position=p, row_index=i) for i, p in enumerate([60, 61, 62, 3, 64, 65])
    ]

    parser._repair_position_sequence(members)

    assert [m.leaderboard_position for m in members] == [60, 61, 62, 63, 64, 65]


def test_repair_position_sequence_nulls_the_tail_when_no_offset_has_a_majority() -> None:
    """A real degenerate capture: no single offset explains >=50% of the
    readings, so the strictly-increasing prefix is kept and the rest is
    nulled rather than fabricated."""
    parser = ContributionRankingV1Parser()
    members = [
        _donor(leaderboard_position=p, row_index=i)
        for i, p in enumerate([60, 61, 69, 2, 8, 7, 7, 4])
    ]

    parser._repair_position_sequence(members)

    assert [m.leaderboard_position for m in members] == [
        60,
        61,
        69,
        None,
        None,
        None,
        None,
        None,
    ]


def test_repair_position_sequence_noop_when_already_sequential() -> None:
    """Nominal case: the offset that fits is a no-op rewrite (same values)."""
    parser = ContributionRankingV1Parser()
    members = [_donor(leaderboard_position=p, row_index=i) for i, p in enumerate([10, 11, 12, 13])]

    parser._repair_position_sequence(members)

    assert [m.leaderboard_position for m in members] == [10, 11, 12, 13]


def test_repair_position_sequence_fills_gaps_when_offset_has_a_majority() -> None:
    """A row where OCR returned no position at all is reconstructed too, once
    a single offset explains the rest of the capture."""
    parser = ContributionRankingV1Parser()
    members = [
        _donor(leaderboard_position=10, row_index=0),
        _donor(leaderboard_position=None, row_index=1),
        _donor(leaderboard_position=12, row_index=2),
        _donor(leaderboard_position=13, row_index=3),
    ]

    parser._repair_position_sequence(members)

    assert [m.leaderboard_position for m in members] == [10, 11, 12, 13]


def test_repair_position_sequence_noop_when_all_positions_are_none() -> None:
    parser = ContributionRankingV1Parser()
    members = [_donor(leaderboard_position=None, row_index=i) for i in range(3)]

    parser._repair_position_sequence(members)

    assert [m.leaderboard_position for m in members] == [None, None, None]


def test_repair_position_sequence_uses_physical_row_index_not_list_index() -> None:
    """Regression test for the exact bug this repair used to have: once an
    earlier row is dropped (unreadable/failed validation), `members`' own
    list index no longer matches each row's actual on-screen position.

    12 physical rows with true positions 41-52; physical row 3 (true
    position 44) was illegible and never made it into `members`, leaving 11
    survivors whose PHYSICAL row_index is [0,1,2,4,5,6,7,8,9,10,11] (note the
    gap at 3) but whose LIST index is the contiguous [0..10]. The old code
    fit the offset against list index instead of row_index: offset=42
    explains 8/11 readings (0.727 > the 0.5 support threshold) by
    coincidence, so it used to rewrite the first 3 positions to 42,43,44
    instead of leaving them at the correct 41,42,43 — the gap happened to
    absorb the resulting shift for every row after it, masking the error
    there. Using row_index, the fit is exact for all 11 and nothing shifts.
    """
    parser = ContributionRankingV1Parser()
    true_positions = [41, 42, 43, 45, 46, 47, 48, 49, 50, 51, 52]  # 44 (row 3) is missing
    physical_indices = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]
    members = [
        _donor(leaderboard_position=p, row_index=i)
        for p, i in zip(true_positions, physical_indices, strict=True)
    ]

    parser._repair_position_sequence(members)

    assert [m.leaderboard_position for m in members] == true_positions


# ── Dispatcher ──────────────────────────────────────────────────────────────────


def test_dispatcher_routes_to_donation_for_contribution_ranking_header() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    with patch(_DISPATCHER_OCR, return_value="contribution ranking\n"):
        kind, code = detect_screen_kind(image)
    assert kind == "donation"
    assert code == DONATION_CODE


def test_dispatcher_routes_to_event_when_event_title_matches() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    with patch(_DISPATCHER_OCR, return_value="POLAR INVASION\n"):
        kind, code = detect_screen_kind(image)
    assert kind == "event"
    assert code == "polar_invasion"


def test_dispatcher_routes_to_ironblood_battlefield() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    with patch(_DISPATCHER_OCR, return_value="Ironblood Battlefield\n"):
        kind, code = detect_screen_kind(image)
    assert kind == "event"
    assert code == "ironblood_battlefield"


def test_dispatcher_routes_to_ironblood_battlefield_ocr_misread() -> None:
    # Tesseract sometimes reads the capital I as a lowercase l on the game font,
    # producing "lronblood" instead of "Ironblood".
    image = np.zeros((2400, 1080), dtype=np.uint8)
    with patch(_DISPATCHER_OCR, return_value="lronblood Battlefield\n"):
        kind, code = detect_screen_kind(image)
    assert kind == "event"
    assert code == "ironblood_battlefield"


def test_dispatcher_raises_when_neither_matches() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    with patch(_DISPATCHER_OCR, return_value="some random screen"):
        with pytest.raises(UnknownEventError):
            detect_screen_kind(image)


# ── Dispatcher fuzzy title fallback ────────────────────────────────────────────


@pytest.mark.parametrize(
    "header,expected_code",
    [
        # Glyph confusions the seeded exact aliases don't cover.
        ("wasteland showd0wn\n", "wasteland_showdown"),  # o → 0
        ("e1ite wars\n", "elite_wars"),  # l → 1
        ("po1ar invasion\n", "polar_invasion"),  # l → 1
        ("battle frenly\n", "battle_frenzy"),  # z → l
        ("vo1d war\n", "void_war"),  # i → 1 in a short title
        # Extra header tokens around a misread title must not dilute the match.
        ("polar 1nvasion\ncollect rewards", "polar_invasion"),
    ],
)
def test_dispatcher_fuzzy_matches_misread_event_title(header: str, expected_code: str) -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    with patch(_DISPATCHER_OCR, return_value=header):
        kind, code = detect_screen_kind(image)
    assert kind == "event"
    assert code == expected_code


@pytest.mark.parametrize(
    "header",
    [
        "some random screen",
        "alliance members list",
        "daily login rewards",
        # Resembles no title closely enough: the ratio's length penalty keeps a
        # short pattern like "void war" from matching a longer unrelated phrase.
        "warlord territory event",
    ],
)
def test_dispatcher_fuzzy_does_not_route_unrelated_header(header: str) -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    with patch(_DISPATCHER_OCR, return_value=header):
        with pytest.raises(UnknownEventError):
            detect_screen_kind(image)


def test_dispatcher_fuzzy_never_overrides_donation_screen() -> None:
    """A clean donation header still routes to donation, not a fuzzy event."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    with patch(_DISPATCHER_OCR, return_value="contribution ranking\n"):
        kind, code = detect_screen_kind(image)
    assert kind == "donation"
    assert code == DONATION_CODE
