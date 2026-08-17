import numpy as np
import pytest

from app.preprocess import TARGET_WIDTH, UnsupportedAspectRatioError, preprocess


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


def test_rejects_aspect_ratio_below_band() -> None:
    """A wider-than-16:9 source (e.g. an emulator capture) is rejected, not silently rescaled."""
    img = _bgr(652, 400)  # ratio 1.63, below the 1.778 (16:9) floor
    with pytest.raises(UnsupportedAspectRatioError):
        preprocess(img)


def test_rejects_aspect_ratio_above_band() -> None:
    img = _bgr(3000, 1080)  # ratio 2.78, above the 2.222 (2400/1080) ceiling
    with pytest.raises(UnsupportedAspectRatioError):
        preprocess(img)


def test_accepts_band_boundaries() -> None:
    for height, width in [(960, 540), (2400, 1080)]:
        preprocess(_bgr(height, width))  # must not raise
