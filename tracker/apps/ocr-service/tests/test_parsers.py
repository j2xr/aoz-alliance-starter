import dataclasses
import re
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest

from app.parsers import sword_icon_utils
from app.parsers.polar_invasion_v1 import (
    _EMULATOR_LAYOUT,
    _EMULATOR_RANK_OCR_ORDER,
    _LAYOUT_BY_PROFILE,
    _PHONE_LAYOUT,
    _RANK_OCR_ORDER,
    _TWO_COL_EVENTS,
    PolarInvasionV1Parser,
    _clean_rank,
    _detect_rank_from_crop,
    _parse_datetime,
    _power_from_psm8_crop,
)
from app.preprocess import EMULATOR_PROFILE, UnsupportedAspectRatioError

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


def _power_crop_side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
    """image_to_data stand-in that answers by crop width, i.e. by stage.

    Each layout's stages produce a distinct crop width, so the width alone
    identifies which stage asked. The wrong-value branches below are the
    measured misreads each layout's stage list exists to avoid.
    """
    width = crop.shape[1]
    if width == _EMULATOR_LAYOUT.points_x[0]:
        # Emulator "row_scan": wrong value (avatar ink bleeding into the sweep).
        return _ocr_data("999999999", conf=90)
    if width == _EMULATOR_LAYOUT.power_x[1] - _EMULATOR_LAYOUT.power_x[0]:
        return _ocr_data("15,806,413", conf=90)
    if width == _PHONE_LAYOUT.points_x[0]:
        return _ocr_data("23,324,091", conf=96)
    if width == _PHONE_LAYOUT.power_x[1] - _PHONE_LAYOUT.power_x[0]:
        # Phone "normalized": wrong value, must never be reached.
        return _ocr_data("2,332,409", conf=89)
    return _ocr_data("", conf=-1)


def test_detect_power_uses_each_layouts_own_stage_list() -> None:
    """Each layout runs the stages in layout.power_stages, in that order.

    Emulator lists only "normalized" (the narrow, avatar-excluding crop);
    phone lists all three widest-first. See the _Layout field's docstring for
    the measured regressions behind either list. The PSM-8 stage's crop width
    matches no branch of the stand-in, so it contributes nothing -- matching
    measured reality (inert on phone, not listed at all on emulator).
    """
    image = np.zeros((300, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with patch(_OCR_DATA, side_effect=_power_crop_side_effect):
        emulator_power = parser._detect_power(image, 0, _EMULATOR_LAYOUT)
        phone_power = parser._detect_power(image, 0, _PHONE_LAYOUT)

    assert emulator_power == 15_806_413
    assert phone_power == 23_324_091


def _psm_of(config: str) -> int:
    """Pull the page-segmentation mode back out of a Tesseract config string."""
    match = re.search(r"--psm (\d+)", config)
    assert match is not None, config
    return int(match.group(1))


def test_detect_rank_sweeps_the_combos_its_layout_names() -> None:
    """The badge sweep comes from the layout, not from a module-level default.

    Each profile carries its own (threshold, psm) list because the emulator
    badge holds 4.2x less ink than the phone one, which narrows the usable
    threshold window -- see _EMULATOR_RANK_OCR_ORDER. The `order=` argument
    carrying that list is easy to drop while refactoring, and nothing else
    would notice: the phone list still reads emulator badges, just 25/32
    instead of 31/32. So assert on the configs actually handed to Tesseract.
    """
    image = np.zeros((300, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()
    seen: list[str] = []

    def record(crop: Any, config: str) -> str:
        seen.append(config)
        return ""  # no hit, so the sweep runs to the end of the list

    profiles = (
        (_PHONE_LAYOUT, _RANK_OCR_ORDER),
        (_EMULATOR_LAYOUT, _EMULATOR_RANK_OCR_ORDER),
    )
    for layout, expected in profiles:
        seen.clear()
        with patch(_OCR_STRING, side_effect=record):
            parser._detect_rank(image, 0, layout)
        # The threshold half of each combo is applied to the crop before OCR,
        # so only the psm half reaches Tesseract's config -- that sequence
        # (and, by list equality, the sweep length) is what is observable.
        assert [_psm_of(c) for c in seen] == [psm for _, psm in expected]


def test_detect_rank_orders_the_sweep_by_the_layouts_own_list() -> None:
    """The cross-row combo cache must stay inside the layout's own list.

    _detect_rank_from_crop moves a remembered winning combo to the front. A
    combo remembered from another profile is not in this list and must be
    ignored rather than prepended, or a phone-tuned threshold would silently
    lead the emulator sweep.
    """
    crop = np.zeros((53, 80), dtype=np.uint8)
    seen: list[str] = []

    with patch(_OCR_STRING, side_effect=lambda c, config: seen.append(config) or ""):
        _detect_rank_from_crop(crop, last_winning_combo=(180, 8), order=_EMULATOR_RANK_OCR_ORDER)

    assert (180, 8) not in _EMULATOR_RANK_OCR_ORDER
    assert [_psm_of(c) for c in seen] == [psm for _, psm in _EMULATOR_RANK_OCR_ORDER]


def test_detect_power_returns_none_rather_than_an_unlisted_stages_value() -> None:
    """An unlisted stage never runs, even as a last resort.

    "row_scan" is absent from the emulator's power_stages because the only
    thing it is measured to do on that profile is fuse the avatar frame into
    the value. With the one listed stage yielding nothing, _detect_power must
    return None -- the row is then dropped and counted by parse()'s
    possible_truncation warning, rather than filled with row_scan's 999999999
    (which clears MIN_POWER and would sail through validate_member).
    """
    image = np.zeros((300, 1080), dtype=np.uint8)
    parser = PolarInvasionV1Parser()
    narrow = _EMULATOR_LAYOUT.power_x[1] - _EMULATOR_LAYOUT.power_x[0]

    def side_effect(crop: Any, config: str, output_type: Any) -> dict[str, list[Any]]:
        if crop.shape[1] == narrow:
            return _ocr_data("", conf=-1)  # the listed stage reads nothing
        return _power_crop_side_effect(crop, config, output_type)

    with patch(_OCR_DATA, side_effect=side_effect):
        assert parser._detect_power(image, 0, _EMULATOR_LAYOUT) is None


def test_psm8_stage_refuses_a_layout_with_no_measured_x_band() -> None:
    """Listing "psm8" without measuring power_fallback_x must fail loudly.

    The emulator layout carries power_fallback_x=None precisely because no
    x-band was ever measured for that stage there; calling the stage anyway
    (a future layout listing it by copy-paste) has to raise rather than crop
    at whatever band another profile happened to use.
    """
    image = np.zeros((300, 1080), dtype=np.uint8)

    with pytest.raises(ValueError, match="power_fallback_x"):
        _power_from_psm8_crop(image, 0, _EMULATOR_LAYOUT)


# ── Layout profile guard (aoz-alliance-starter#91) ────────────────────────────


@pytest.mark.parametrize("event_code", sorted(_TWO_COL_EVENTS))
def test_parse_allows_two_col_event_on_emulator_profile(event_code: str) -> None:
    """The emulator profile has its own measured 2-column header bands
    (battlers_x_2col/total_points_x_2col on _EMULATOR_LAYOUT, 2026-08-22,
    from wasteland_showdown captures 007/008 -- aoz-alliance-starter#91) --
    parse() must not refuse these event codes on this profile."""
    image = np.full((1760, 1080), 200, dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with patch(_OCR_STRING, return_value=""), patch(_OCR_DATA, return_value=_ocr_data("")):
        parser.parse(image, event_code=event_code)  # must not raise


@pytest.mark.parametrize("event_code", sorted(_TWO_COL_EVENTS))
def test_parse_rejects_two_col_event_on_a_profile_without_measured_bands(
    event_code: str,
) -> None:
    """The guard itself: a profile with no measured 2-column bands must
    still be refused rather than fall back to another profile's x-bands
    (measured corruption if it did -- see _Layout.battlers_x_2col's
    docstring). No such profile exists today (phone and emulator both have
    bands), so this exercises the guard via a synthetic layout standing in
    for a hypothetical future one, keeping the guard covered independently
    of which real profiles currently have bands."""
    unmeasured_emulator = dataclasses.replace(
        _EMULATOR_LAYOUT, battlers_x_2col=None, total_points_x_2col=None
    )
    image = np.full((1760, 1080), 200, dtype=np.uint8)
    parser = PolarInvasionV1Parser()

    with (
        patch.dict(_LAYOUT_BY_PROFILE, {EMULATOR_PROFILE: unmeasured_emulator}),
        pytest.raises(UnsupportedAspectRatioError, match=event_code),
    ):
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
