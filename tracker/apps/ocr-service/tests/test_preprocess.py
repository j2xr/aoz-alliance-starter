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
    """A ratio between the emulator (1.61-1.65) and phone (1.778-2.40) bands is rejected."""
    img = _bgr(1700, 1080)  # ratio 1.57 — below the emulator floor too
    with pytest.raises(UnsupportedAspectRatioError):
        preprocess(img)
    img = _bgr(1900, 1080)  # ratio 1.76 — in the gap, just short of the phone floor
    with pytest.raises(UnsupportedAspectRatioError):
        preprocess(img)


# Real resolutions of phones this pipeline is uploaded from. The phone band is
# defined by these, NOT by the fixture corpus (which only holds 1080x2400 and
# 1080x2340): a ceiling drawn at the corpus maximum, 2400/1080 = 2.2222, would
# reject the first four of these outright, all of which parsed correctly before
# any ratio band existed.
@pytest.mark.parametrize(
    ("w", "h", "device"),
    [
        (1080, 2424, "Pixel 9 / 9 Pro — ratio 2.244"),
        (1344, 2992, "Pixel 8 Pro — ratio 2.226"),
        (1280, 2856, "Pixel 9 Pro — ratio 2.231"),
        (1644, 3840, "Sony Xperia 21:9 — ratio 2.336, tallest phone form factor sold"),
        (1080, 2340, "Galaxy S24 — ratio 2.167"),
        (1179, 2556, "iPhone 15 Pro — ratio 2.168"),
        (1080, 2400, "canonical fixture resolution — ratio 2.222"),
        (1080, 1920, "16:9, the phone floor"),
    ],
)
def test_accepts_real_phone_resolutions(w: int, h: int, device: str) -> None:
    preprocess(_bgr(h, w))  # must not raise


@pytest.mark.parametrize(
    ("w", "h", "shape"),
    [
        (1080, 4800, "Android scroll-capture stitch — stacked headers, list runs past one screen"),
        (1920, 1080, "landscape"),
        (1200, 1600, "tablet"),
        (1080, 1080, "square"),
    ],
)
def test_rejects_shapes_that_are_not_a_phone_screenshot(w: int, h: int, shape: str) -> None:
    with pytest.raises(UnsupportedAspectRatioError):
        preprocess(_bgr(h, w))


def test_accepts_sources_sitting_exactly_on_a_band_edge() -> None:
    """Resize quantization must not push an in-band source out of its band.

    Both halves of the fix are load-bearing here. The ratio is judged on the
    resized array (so preprocess can't accept an image that require_profile /
    _layout_for_image then reject mid-parse), and the resize rounds instead of
    truncating (so the height isn't systematically biased downward, which alone
    knocked 661 in-band (w,h) pairs out of their band). 234x416 is ratio
    1.777778 exactly — the phone floor — and truncates to 1080x1919 = 1.776852.
    """
    preprocess(_bgr(416, 234))  # must not raise
    preprocess(_bgr(322, 200))  # emulator floor, ratio 1.61 exactly


def test_rejection_message_names_the_source_dimensions() -> None:
    """The user uploaded a file with its own dimensions, not the resized ones."""
    with pytest.raises(UnsupportedAspectRatioError, match=r"source: 600x2400"):
        preprocess(_bgr(2400, 600))


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
