from typing import Any
from unittest.mock import patch

import numpy as np
import pytest

from app.parsers import sword_icon_utils
from app.parsers.polar_invasion_v1 import (
    PolarInvasionV1Parser,
    _clean_rank,
    _parse_datetime,
)

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
    """image_to_string qui renvoie `digits` pour toute lecture numérique du header."""

    def side_effect(crop: Any, config: str = "", **kwargs: Any) -> str:
        if "tessedit_char_whitelist=0123456789" in config:
            return digits
        return ""

    return side_effect


def test_forced_two_col_layout_ignores_stray_rank_digit() -> None:
    """Un chiffre parasite dans la cellule rang ne force plus le layout 3 colonnes
    quand le code événement (2 colonnes) est connu."""
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
    """Sans code événement, une lecture de rang invraisemblable (>9999) fait
    basculer l'heuristique sur le layout 2 colonnes."""
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with (
        patch(_OCR_STRING, side_effect=_header_digits_side_effect("123456")),
        patch(_OCR_DATA, return_value=_ocr_data("")),
    ):
        result = parser.parse(image)

    assert result.alliance_rank is None


def test_sword_icon_sprite_is_packaged_with_app() -> None:
    sword_icon_utils.load_sword_icon.cache_clear()
    sword_icon_utils._resized_icon.cache_clear()

    assert sword_icon_utils._SWORD_ICON_PATH.exists()
    icon = sword_icon_utils.load_sword_icon()

    assert icon is not None
    assert icon.ndim == 2
