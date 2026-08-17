import logging

import cv2
import numpy as np

logger = logging.getLogger(__name__)

TARGET_WIDTH = 1080

# The only layout profile the parsers understand: phone screenshots, width
# normalized to TARGET_WIDTH, height anywhere in the band real devices shipped
# in production (1080x1920 up to 1080x2400 — see polar_invasion_v1's
# CANONICAL_HEIGHT=2400 fixed pixel positions and contribution_ranking_v1's
# CANONICAL_HEIGHT=2400 height-scaled crops, both calibrated against captures
# in this range). Expressed as height/width so it survives the width
# normalization below unchanged. A source outside this band isn't a smaller
# version of the same layout — the parsers' row pitch and fixed pixel
# positions silently drift against it instead of raising, corrupting data
# quietly (see aoz-alliance-starter#91) — so it must be rejected explicitly.
_MIN_ASPECT_RATIO = 1920 / 1080  # 1.778
_MAX_ASPECT_RATIO = 2400 / 1080  # 2.222


class UnsupportedAspectRatioError(ValueError):
    """Raised when the source image's aspect ratio matches no known layout profile."""


def preprocess_image(image_path: str) -> np.ndarray:
    """Load image from disk and return a preprocessed grayscale array."""
    raw: np.ndarray | None = cv2.imread(image_path)
    if raw is None:
        raise ValueError(f"Cannot read image: {image_path}")
    return preprocess(raw)


def preprocess(image: np.ndarray) -> np.ndarray:
    """Normalise to 1080px width, convert to grayscale, invert if dark.

    Adaptive binarisation is intentionally skipped: game UI backgrounds contain
    complex gradients and icon sprites whose local contrast misleads adaptive
    thresholding, causing numeric fields (power, points) to be destroyed.
    Tesseract achieves better accuracy on the inverted grayscale directly.
    """
    h, w = image.shape[:2]
    aspect_ratio = h / w
    if not (_MIN_ASPECT_RATIO <= aspect_ratio <= _MAX_ASPECT_RATIO):
        raise UnsupportedAspectRatioError(
            f"source is {w}x{h} (ratio {aspect_ratio:.2f}); expected "
            f"~1080x[1920-2400] (ratio {_MIN_ASPECT_RATIO:.2f}-{_MAX_ASPECT_RATIO:.2f})"
        )

    if w != TARGET_WIDTH:
        scale = TARGET_WIDTH / w
        interp = cv2.INTER_AREA if w > TARGET_WIDTH else cv2.INTER_LINEAR
        image = cv2.resize(image, (TARGET_WIDTH, int(h * scale)), interpolation=interp)

    gray: np.ndarray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Mobile game screenshots have bright text on dark backgrounds
    if float(np.mean(gray)) < 128:
        gray = cv2.bitwise_not(gray)

    return gray
