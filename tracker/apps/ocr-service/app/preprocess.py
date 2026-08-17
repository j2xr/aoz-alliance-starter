import logging
from dataclasses import dataclass

import cv2
import numpy as np

logger = logging.getLogger(__name__)

TARGET_WIDTH = 1080


@dataclass(frozen=True)
class LayoutProfile:
    """A source whose aspect ratio (height/width) parsers know how to crop.

    Width is always normalized to TARGET_WIDTH before parsing, so the ratio
    (not the raw resolution) is what identifies a profile — see preprocess().
    """

    name: str
    min_ratio: float
    max_ratio: float


# Phone screenshots: real devices shipped in production at heights from
# 1080x1920 up to 1080x2400 (see polar_invasion_v1's CANONICAL_HEIGHT=2400
# fixed pixel positions and contribution_ranking_v1's CANONICAL_HEIGHT=2400
# height-scaled crops, both calibrated against captures in this range). The
# wide tolerance reflects genuine device variation, not measurement slop.
PHONE_PROFILE = LayoutProfile("phone", min_ratio=1920 / 1080, max_ratio=2400 / 1080)

# Android emulator captures driven by an external automation pipeline (see
# aoz-alliance-starter#91): unlike real devices, this source has one fixed
# native resolution (400x652, ratio 1.63) that can't vary, so the tolerance
# is tight (±0.02) — just enough to absorb resize rounding, not device
# diversity. A wider band here would risk silently swallowing a genuinely
# different, uncalibrated source instead of rejecting it.
EMULATOR_PROFILE = LayoutProfile("emulator_400x652", min_ratio=1.61, max_ratio=1.65)

_KNOWN_PROFILES = (PHONE_PROFILE, EMULATOR_PROFILE)


class UnsupportedAspectRatioError(ValueError):
    """Raised when the source image's aspect ratio matches no known layout profile."""


def detect_layout_profile(w: int, h: int) -> LayoutProfile:
    """Return the LayoutProfile matching this source's aspect ratio.

    Raises UnsupportedAspectRatioError listing every profile checked — a
    source outside all known bands isn't a smaller/larger version of a known
    layout, so a parser's fixed pixel positions and row pitch would silently
    drift against it instead of raising, corrupting data quietly (see
    aoz-alliance-starter#91). Reject explicitly instead.
    """
    aspect_ratio = h / w
    for profile in _KNOWN_PROFILES:
        if profile.min_ratio <= aspect_ratio <= profile.max_ratio:
            return profile
    checked = ", ".join(f"{p.name} ({p.min_ratio:.2f}-{p.max_ratio:.2f})" for p in _KNOWN_PROFILES)
    raise UnsupportedAspectRatioError(
        f"source is {w}x{h} (ratio {aspect_ratio:.2f}); "
        f"matches no known profile — checked {checked}"
    )


def require_profile(image: np.ndarray, profile: LayoutProfile) -> None:
    """Raise UnsupportedAspectRatioError if `image` wasn't produced by `profile`.

    preprocess() accepts every known profile globally (aspect ratio alone
    can't tell it which event screen a capture shows), but a parser with
    crop constants for only one profile must not silently apply them to a
    different one — see aoz-alliance-starter#91's contribution_ranking /
    player_stats gap: those parsers only have phone-calibrated positions, so
    an emulator-sourced donation screenshot would otherwise be parsed with
    the wrong crops instead of failing loudly. Call this at the top of a
    single-profile parser's parse() once its input is already the
    TARGET_WIDTH-normalized image (width is fixed, so the ratio check here
    reduces to height alone).
    """
    h, w = image.shape[:2]
    actual = detect_layout_profile(w, h)
    if actual is not profile:
        raise UnsupportedAspectRatioError(
            f"this parser only supports the {profile.name!r} profile, "
            f"but the image is {w}x{h} ({actual.name!r})"
        )


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
    detect_layout_profile(w, h)

    if w != TARGET_WIDTH:
        scale = TARGET_WIDTH / w
        interp = cv2.INTER_AREA if w > TARGET_WIDTH else cv2.INTER_LINEAR
        image = cv2.resize(image, (TARGET_WIDTH, int(h * scale)), interpolation=interp)

    gray: np.ndarray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Mobile game screenshots have bright text on dark backgrounds
    if float(np.mean(gray)) < 128:
        gray = cv2.bitwise_not(gray)

    return gray
