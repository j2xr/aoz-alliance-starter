import numpy as np
import pytest

from app.preprocess import (
    EMULATOR_PROFILE,
    PHONE_PROFILE,
    TARGET_WIDTH,
    UnsupportedAspectRatioError,
    detect_layout_profile,
    preprocess,
    require_profile,
)


def _bgr(height: int, width: int, value: int = 30) -> np.ndarray:
    return np.full((height, width, 3), value, dtype=np.uint8)


def test_normalises_width_up() -> None:
    img = _bgr(960, 540)
    result = preprocess(img)
    assert result.shape[1] == TARGET_WIDTH


def test_normalises_width_down() -> None:
    img = _bgr(2880, 1440)
    result = preprocess(img)
    assert result.shape[1] == TARGET_WIDTH


def test_preserves_aspect_ratio() -> None:
    img = _bgr(1920, 1080)
    result = preprocess(img)
    assert result.shape[1] == TARGET_WIDTH
    assert result.shape[0] == 1920


def test_output_is_grayscale() -> None:
    img = _bgr(1920, TARGET_WIDTH)
    result = preprocess(img)
    assert result.ndim == 2
    assert result.dtype == np.uint8


def test_dark_image_inverted_to_light_background() -> None:
    """A uniformly dark image should be inverted so the mean becomes bright."""
    img = _bgr(1920, TARGET_WIDTH, value=20)
    result = preprocess(img)
    assert float(np.mean(result)) > 128


def test_light_image_not_inverted() -> None:
    """A uniformly light image should stay bright (not inverted)."""
    img = _bgr(1920, TARGET_WIDTH, value=220)
    result = preprocess(img)
    assert float(np.mean(result)) > 128


def test_rejects_aspect_ratio_in_gap_between_profiles() -> None:
    """A ratio between the emulator (1.61-1.65) and phone (1.778-2.222) bands is rejected."""
    img = _bgr(1700, 1080)  # ratio 1.57 — below the emulator floor too
    with pytest.raises(UnsupportedAspectRatioError):
        preprocess(img)
    img = _bgr(1900, 1080)  # ratio 1.76 — in the gap, just short of the phone floor
    with pytest.raises(UnsupportedAspectRatioError):
        preprocess(img)


def test_rejects_aspect_ratio_above_band() -> None:
    img = _bgr(3000, 1080)  # ratio 2.78, above the 2.222 (2400/1080) ceiling
    with pytest.raises(UnsupportedAspectRatioError):
        preprocess(img)


def test_accepts_phone_band_boundaries() -> None:
    for height, width in [(960, 540), (2400, 1080)]:
        preprocess(_bgr(height, width))  # must not raise


def test_accepts_emulator_source() -> None:
    preprocess(_bgr(652, 400))  # native emulator resolution, ratio 1.63 — must not raise


def test_detect_layout_profile_phone() -> None:
    assert detect_layout_profile(1080, 2400) is PHONE_PROFILE
    assert detect_layout_profile(540, 960) is PHONE_PROFILE


def test_detect_layout_profile_emulator() -> None:
    assert detect_layout_profile(400, 652) is EMULATOR_PROFILE


def test_detect_layout_profile_unknown_raises_with_checked_profiles() -> None:
    with pytest.raises(UnsupportedAspectRatioError, match="phone.*emulator_400x652"):
        detect_layout_profile(1080, 1900)


def test_require_profile_accepts_matching_profile() -> None:
    phone_image = np.zeros((2400, TARGET_WIDTH), dtype=np.uint8)
    require_profile(phone_image, PHONE_PROFILE)  # must not raise


def test_require_profile_rejects_mismatched_profile() -> None:
    """A phone-only parser fed an emulator-profile image must fail loudly,
    not silently apply phone crop positions (aoz-alliance-starter#91)."""
    emulator_image = np.zeros((1760, TARGET_WIDTH), dtype=np.uint8)
    with pytest.raises(UnsupportedAspectRatioError, match="phone"):
        require_profile(emulator_image, PHONE_PROFILE)
