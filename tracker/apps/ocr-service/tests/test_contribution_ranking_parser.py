"""Unit tests for the contribution_ranking_v1 (donation) parser and dispatcher."""

import json
from math import ceil
from pathlib import Path
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest

from app.dispatcher import DONATION_CODE, UnknownEventError, detect_screen_kind
from app.parsers.base import DonationMember, DonationParseResult
from app.parsers.contribution_ranking_v1 import (
    _POSITION_PSMS,
    _POSITION_THRESHOLDS,
    _TAB_X,
    _TABS_Y,
    ContributionRankingV1Parser,
    _ocr_position_from_crop,
    _strip_alliance_tag,
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
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()

    with patch(_OCR_STRING, return_value=""), patch(_OCR_DATA, return_value=_ocr_data("")):
        result = parser.parse(image)

    assert isinstance(result, DonationParseResult)
    assert result.kind == "donation"
    assert result.period_type == "weekly"
    assert result.members == []


# ── Tab detection ─────────────────────────────────────────────────────────────


def _tab_band_image(selected: str | None, *, brighter: bool = False) -> np.ndarray:
    """Synthetic canonical-height frame with one tab pill standing out.

    The base tab band is flat gray; the `selected` pill zone is offset by a
    contrast the detector treats as the outlier. `brighter=True` exercises the
    non-inverted direction (selected pill lighter than the rest) to prove the
    median-deviation rule does not assume a fixed polarity.
    """
    image = np.full((2400, 1080), 200, dtype=np.uint8)
    if selected is not None:
        y0, y1 = _TABS_Y  # scale == 1.0 at canonical height
        xa, xb = _TAB_X[selected]
        image[y0:y1, xa:xb] = 230 if brighter else 170
    return image


@pytest.mark.parametrize("selected", ["daily", "weekly", "history"])
def test_detect_selected_tab_darker_pill(selected: str) -> None:
    """The selected pill reads darker than the two unselected tabs (inverted UI)."""
    parser = ContributionRankingV1Parser()
    result = parser._detect_selected_tab(_tab_band_image(selected), scale=1.0)
    assert result == selected


@pytest.mark.parametrize("selected", ["daily", "weekly", "history"])
def test_detect_selected_tab_brighter_pill(selected: str) -> None:
    """Direction-agnostic: a lighter selected pill is detected just the same."""
    parser = ContributionRankingV1Parser()
    result = parser._detect_selected_tab(_tab_band_image(selected, brighter=True), scale=1.0)
    assert result == selected


def test_detect_selected_tab_flat_band_defaults_to_weekly() -> None:
    """No pill stands out (uniform band) → safe default, never a spurious tab."""
    parser = ContributionRankingV1Parser()
    result = parser._detect_selected_tab(_tab_band_image(None), scale=1.0)
    assert result == "weekly"


def test_detect_selected_tab_below_threshold_defaults_to_weekly() -> None:
    """A sub-threshold deviation (2 levels < 4.0 default) is treated as noise."""
    image = np.full((2400, 1080), 200, dtype=np.uint8)
    y0, y1 = _TABS_Y
    xa, xb = _TAB_X["history"]
    image[y0:y1, xa:xb] = 198  # only 2 levels off → below _TAB_DETECT_MIN_DELTA
    parser = ContributionRankingV1Parser()
    assert parser._detect_selected_tab(image, scale=1.0) == "weekly"


@pytest.mark.parametrize(
    "fixture_path",
    sorted(_FIXTURES_DIR.glob("*.json")),
    ids=lambda p: p.stem,
)
def test_detect_selected_tab_matches_fixture_ground_truth(fixture_path: Path) -> None:
    """Every shipped capture's detected tab matches its ground-truth period_type.

    Runs the real detector on the preprocessed fixture image (no Tesseract
    needed — the tab band is pure pixel intensity), guarding against a
    regression that would silently mislabel a leaderboard's period.
    """
    image_path = fixture_path.with_suffix(".jpg")
    if not image_path.exists():
        pytest.skip(f"Image not found: {image_path}")
    with fixture_path.open(encoding="utf-8") as fh:
        expected = json.load(fh)

    image = preprocess_image(str(image_path))
    scale = image.shape[0] / 2400
    parser = ContributionRankingV1Parser()
    assert parser._detect_selected_tab(image, scale) == expected["period_type"]


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


# ── Honor monotonicity guard ─────────────────────────────────────────────────────


def test_enforce_honor_monotonicity_noop_when_already_descending() -> None:
    """Nominal case (including a legitimate tie): nothing re-OCR'd, nothing changed."""
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


def test_enforce_honor_monotonicity_corrects_when_candidate_fits() -> None:
    """A misread that breaks order is replaced by the re-OCR candidate that fits.

    Fitting the window is a plausibility check, not proof of correctness (a
    real fixture showed a fitting-but-still-wrong candidate winning — see the
    method's docstring), so confidence is capped even on a successful fix.
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
    but flag it by zeroing confidence for downstream visibility."""
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


def test_enforce_honor_monotonicity_last_row_uses_zero_as_lower_bound() -> None:
    """The last row has no successor: the fitting window is [0, previous]."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = ContributionRankingV1Parser()
    members = [
        _donor(alliance_honor=350, row_y=0),
        _donor(alliance_honor=999999, row_y=175),  # ground truth is 0
    ]

    with patch.object(parser, "_ocr_honor_candidates", return_value=[999999, 0]):
        parser._enforce_honor_monotonicity(image, members, scale=1.0)

    assert members[1].alliance_honor == 0


def test_enforce_honor_monotonicity_skips_row_without_row_y() -> None:
    """Defensive: a member missing row_y (shouldn't happen in practice) is left as-is."""
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


# ── Leaderboard position repair ──────────────────────────────────────────────────


def test_repair_position_sequence_reconstructs_a_clean_leading_digit_drop() -> None:
    """A single dropped leading digit (position 63 read as '3') is repaired via
    the offset that explains every other reading exactly."""
    parser = ContributionRankingV1Parser()
    members = [_donor(leaderboard_position=p) for p in [60, 61, 62, 3, 64, 65]]

    parser._repair_position_sequence(members)

    assert [m.leaderboard_position for m in members] == [60, 61, 62, 63, 64, 65]


def test_repair_position_sequence_nulls_the_tail_when_no_offset_has_a_majority() -> None:
    """A real degenerate capture: no single offset explains >=50% of the
    readings, so the strictly-increasing prefix is kept and the rest is
    nulled rather than fabricated."""
    parser = ContributionRankingV1Parser()
    members = [_donor(leaderboard_position=p) for p in [60, 61, 69, 2, 8, 7, 7, 4]]

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
    members = [_donor(leaderboard_position=p) for p in [10, 11, 12, 13]]

    parser._repair_position_sequence(members)

    assert [m.leaderboard_position for m in members] == [10, 11, 12, 13]


def test_repair_position_sequence_fills_gaps_when_offset_has_a_majority() -> None:
    """A row where OCR returned no position at all is reconstructed too, once
    a single offset explains the rest of the capture."""
    parser = ContributionRankingV1Parser()
    members = [
        _donor(leaderboard_position=10),
        _donor(leaderboard_position=None),
        _donor(leaderboard_position=12),
        _donor(leaderboard_position=13),
    ]

    parser._repair_position_sequence(members)

    assert [m.leaderboard_position for m in members] == [10, 11, 12, 13]


def test_repair_position_sequence_noop_when_all_positions_are_none() -> None:
    parser = ContributionRankingV1Parser()
    members = [_donor(leaderboard_position=None) for _ in range(3)]

    parser._repair_position_sequence(members)

    assert [m.leaderboard_position for m in members] == [None, None, None]


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
