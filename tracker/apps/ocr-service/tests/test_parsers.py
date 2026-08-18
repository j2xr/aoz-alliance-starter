from typing import Any
from unittest.mock import patch

import numpy as np
import pytest

from app.parsers import sword_icon_utils
from app.parsers.polar_invasion_v1 import (
    _EMULATOR_LAYOUT,
    _PHONE_LAYOUT,
    _TWO_COL_EVENTS,
    PolarInvasionV1Parser,
    _clean_rank,
    _parse_datetime,
)
from app.preprocess import UnsupportedAspectRatioError

_OCR_STRING = "app.parsers.polar_invasion_v1.pytesseract.image_to_string"
_OCR_DATA = "app.parsers.polar_invasion_v1.pytesseract.image_to_data"


def _ocr_data(text: str = "", conf: int = 90) -> dict[str, list[Any]]:
    """Build a minimal pytesseract image_to_data dict."""
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


@pytest.mark.parametrize(
    "text,expected",
    [
        ("R1", "R1"),
        ("R5", "R5"),
        ("r3", "R3"),
        ("rank R2 player", "R2"),
        ("nothing", None),
        ("R6", None),
        ("", None),
    ],
)
def test_clean_rank(text: str, expected: str | None) -> None:
    assert _clean_rank(text) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("2026-04-07 15:00", "2026-04-07T15:00"),
        ("2026-04-07T15:00", "2026-04-07T15:00"),
        ("event date 2026-04-07 15:00 rank", "2026-04-07T15:00"),
        ("no date here", None),
        ("", None),
    ],
)
def test_parse_datetime(text: str, expected: str | None) -> None:
    assert _parse_datetime(text) == expected


def test_parser_event_type() -> None:
    image = np.zeros((1920, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with patch(_OCR_STRING, return_value=""), patch(_OCR_DATA, return_value=_ocr_data("")):
        result = parser.parse(image)

    assert result.event_type == "polar_invasion"


def test_parser_empty_image_yields_no_members() -> None:
    """Blank image with no recognisable text should produce zero members."""
    image = np.zeros((1920, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with patch(_OCR_STRING, return_value=""), patch(_OCR_DATA, return_value=_ocr_data("")):
        result = parser.parse(image)

    assert result.members == []


def test_parser_strips_power_suffix_from_name() -> None:
    """When OCR bleeds the power value into the name crop, the suffix is stripped."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            # Simulate OCR bleeding: name + power read together
            return _ocr_data("Ye 12,034,411", conf=85)
        if "tessedit_char_whitelist=0123456789,-" in config:
            return _ocr_data("500", conf=80)
        if "tessedit_char_whitelist=0123456789," in config:
            return _ocr_data("12,034,411", conf=85)
        return _ocr_data("", conf=-1)

    with patch(_OCR_STRING, return_value="R1"), patch(_OCR_DATA, side_effect=data_side_effect):
        result = parser.parse(image)

    assert result.members  # at least one row parsed
    assert all(m.name == "Ye" for m in result.members)
    assert result.members[0].power == 12_034_411


def test_parser_marks_non_participant_row_with_null_points() -> None:
    """A row where the points cell shows '-' is kept as a member with points=None.

    Non-participants must still be tracked in at_players / at_alliance_memberships,
    so the parser returns the row with points=None rather than dropping it.
    """
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            return _ocr_data("TestPlayer", conf=85)
        if "tessedit_char_whitelist=0123456789,-" in config:
            return _ocr_data("-", conf=60)
        if "tessedit_char_whitelist=0123456789," in config:
            return _ocr_data("15,000,000", conf=85)
        return _ocr_data("", conf=-1)

    with patch(_OCR_STRING, return_value="R1"), patch(_OCR_DATA, side_effect=data_side_effect):
        result = parser.parse(image)

    assert result.members  # row is kept
    assert all(m.points is None for m in result.members)
    assert all(m.name == "TestPlayer" for m in result.members)
    assert all(m.power == 15_000_000 for m in result.members)


def test_parser_confidence_only_reflects_words_in_name() -> None:
    """Row confidence must be computed only from the name_data entries that
    actually survived into `name` (min_conf=10, non-empty text) -- not from
    every conf value the OCR pass returned. An empty-text box with an
    unrelated high confidence, or a low-confidence word that min_conf already
    excluded from `name`, must not skew the reported confidence.
    """
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    # "Name" (conf=15) is the only word that ends up in `name` under min_conf=10.
    # The empty-text entry (conf=95) contributed no text at all, and "Extra"
    # (conf=5) falls below min_conf -- neither should count toward confidence.
    mixed_name_data = {
        "text": ["Name", "", "Extra"],
        "conf": ["15", "95", "5"],
        "level": [0, 0, 0],
        "page_num": [0, 0, 0],
        "block_num": [0, 0, 0],
        "par_num": [0, 0, 0],
        "line_num": [0, 0, 0],
        "word_num": [0, 0, 0],
        "left": [0, 10, 20],
        "top": [0, 0, 0],
        "width": [10, 10, 10],
        "height": [10, 10, 10],
    }

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            return mixed_name_data
        if "eng+rus" in config:
            return _ocr_data("", conf=-1)  # ASCII fast-path miss, fall through
        if "tessedit_char_whitelist=0123456789,-" in config:
            return _ocr_data("-", conf=60)
        if "tessedit_char_whitelist=0123456789," in config:
            return _ocr_data("15,000,000", conf=85)
        return _ocr_data("", conf=-1)

    with patch(_OCR_STRING, return_value="R1"), patch(_OCR_DATA, side_effect=data_side_effect):
        result = parser.parse(image)

    assert result.members
    m = result.members[0]
    assert m.name == "Name"
    assert m.confidence == pytest.approx(0.15)


def test_parser_member_with_low_power_skipped() -> None:
    """A member row where power < 1M should be filtered out by validate_member."""
    image = np.zeros((1920, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if "jpn" in config:
            return _ocr_data("TestPlayer", conf=85)
        if "tessedit_char_whitelist=0123456789," in config:
            return _ocr_data("500000", conf=80)
        return _ocr_data("", conf=-1)

    with patch(_OCR_STRING, return_value="R3"), patch(_OCR_DATA, side_effect=data_side_effect):
        result = parser.parse(image)

    assert result.members == []


def _header_digits_side_effect(digits: str) -> Any:
    """image_to_string that returns `digits` for any numeric header read."""

    def side_effect(crop: Any, config: str = "", **kwargs: Any) -> str:
        if "tessedit_char_whitelist=0123456789" in config:
            return digits
        return ""

    return side_effect


def test_forced_two_col_layout_ignores_stray_rank_digit() -> None:
    """A stray digit in the rank cell no longer forces the 3-column layout
    when the event code (2 columns) is known."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with (
        patch(_OCR_STRING, side_effect=_header_digits_side_effect("7")),
        patch(_OCR_DATA, return_value=_ocr_data("")),
    ):
        result = parser.parse(image, event_code="void_war")

    assert result.alliance_rank is None
    assert result.total_battlers == 7  # lu dans les colonnes 2-col


def test_forced_three_col_layout_reads_alliance_rank() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with (
        patch(_OCR_STRING, side_effect=_header_digits_side_effect("7")),
        patch(_OCR_DATA, return_value=_ocr_data("")),
    ):
        result = parser.parse(image, event_code="polar_invasion")

    assert result.alliance_rank == 7


def test_fallback_header_rejects_implausible_rank() -> None:
    """Without an event code, an implausible rank reading (>9999) makes the
    heuristic fall back to the 2-column layout."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with (
        patch(_OCR_STRING, side_effect=_header_digits_side_effect("123456")),
        patch(_OCR_DATA, return_value=_ocr_data("")),
    ):
        result = parser.parse(image)

    assert result.alliance_rank is None


# ── Power detection crop order (aoz-alliance-starter#91) ─────────────────────


def test_detect_power_prefers_narrow_crop_on_emulator_layout() -> None:
    """_detect_power's crop order is controlled by layout.power_narrow_crop_first:
    the emulator layout tries the narrow, avatar-excluding power_x crop
    first, while the phone layout still tries the wide full-row scan first
    (see the _Layout field's docstring for the measured regressions on
    either layout getting the other's order unconditionally). Crops are told
    apart by width alone -- the PSM-8 fallback crop's width never matches
    any branch below, so it returns no words, matching measured reality
    (that stage is inert on both layouts here)."""
    image = np.zeros((300, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    def data_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        width = crop.shape[1]
        if width == _EMULATOR_LAYOUT.points_x[0]:
            # Emulator full-row scan: wrong value (avatar ink bleeding in).
            return _ocr_data("999999999", conf=90)
        if width == _EMULATOR_LAYOUT.power_x[1] - _EMULATOR_LAYOUT.power_x[0]:
            return _ocr_data("15,806,413", conf=90)
        if width == _PHONE_LAYOUT.points_x[0]:
            return _ocr_data("23,324,091", conf=96)
        if width == _PHONE_LAYOUT.power_x[1] - _PHONE_LAYOUT.power_x[0]:
            # Phone narrow crop: wrong value, must never be reached.
            return _ocr_data("2,332,409", conf=89)
        return _ocr_data("", conf=-1)

    with patch(_OCR_DATA, side_effect=data_side_effect):
        emulator_power = parser._detect_power(image, 0, _EMULATOR_LAYOUT)
        phone_power = parser._detect_power(image, 0, _PHONE_LAYOUT)

    assert emulator_power == 15_806_413
    assert phone_power == 23_324_091


# ── Layout profile guard (aoz-alliance-starter#91) ────────────────────────────


@pytest.mark.parametrize("event_code", sorted(_TWO_COL_EVENTS))
def test_parse_rejects_two_col_event_on_emulator_profile(event_code: str) -> None:
    """The 2-column header bands have no emulator-profile equivalent (see
    _BATTLERS_X_2COL's docstring) -- parse() must refuse rather than mix an
    emulator y-band with phone x-bands. Raises before any OCR runs."""
    image = np.full((1760, 1080), 200, dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with pytest.raises(UnsupportedAspectRatioError, match=event_code):
        parser.parse(image, event_code=event_code)


@pytest.mark.parametrize(
    "event_code", ["polar_invasion", "elite_wars", "ironblood_battlefield", None]
)
def test_parse_allows_three_col_events_on_emulator_profile(event_code: str | None) -> None:
    """3-column events share polar_invasion's fully profile-aware geometry
    (no event_code branching outside _parse_header's header cell), so they
    are not gated even though only polar_invasion has real ground-truth
    verification -- confirmed by the user as an accepted, documented risk.
    event_code=None (the dev-tools/tests-only direct-call path) is included
    here as the executable record of that decision too."""
    image = np.full((1760, 1080), 200, dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with patch(_OCR_STRING, return_value=""), patch(_OCR_DATA, return_value=_ocr_data("")):
        parser.parse(image, event_code=event_code)  # must not raise


def test_sword_icon_sprite_is_packaged_with_app() -> None:
    sword_icon_utils.load_sword_icon.cache_clear()
    sword_icon_utils._resized_icon.cache_clear()

    assert sword_icon_utils._SWORD_ICON_PATH.exists()
    icon = sword_icon_utils.load_sword_icon()

    assert icon is not None
    assert icon.ndim == 2
