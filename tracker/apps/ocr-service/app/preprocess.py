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


# Phone screenshots. Both phone parsers are height-agnostic by construction:
# polar_invasion_v1 uses absolute pixel positions because "device aspect
# ratios change the visible bottom area, not the UI element pitch", and
# contribution_ranking_v1 scales every crop by h/CANONICAL_HEIGHT. So this
# band is NOT the range of heights the parsers can handle — it's the range of
# shapes that are plausibly a phone screenshot at all.
#
# Bounds are set from shipping-device reality, deliberately not from the
# fixture corpus (which holds only 1080x2400 and 1080x2340): a ceiling drawn
# at the corpus maximum, 2400/1080 = 2.2222, rejects real devices that this
# pipeline parsed correctly before the band existed — Pixel 9 (1080x2424 =
# 2.244), Pixel 8 Pro (1344x2992 = 2.226), 21:9 Xperia (1644x3840 = 2.336).
# 2.40 clears the tallest phone form factor sold (21:9) with headroom while
# still rejecting the shapes that genuinely break the parsers: Android
# scroll-capture stitches (ratio 3-5, several stacked headers and a list that
# continues past one screen), tablets (~1.33) and landscape.
PHONE_PROFILE = LayoutProfile("phone", min_ratio=1920 / 1080, max_ratio=2.40)

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
    different one — see aoz-alliance-starter#91's contribution_ranking gap:
    that parser only has phone-calibrated positions, so an emulator-sourced
    donation screenshot would otherwise be parsed with the wrong crops
    instead of failing loudly. Call this at the top of a single-profile
    parser's parse() once its input is already the TARGET_WIDTH-normalized
    image (width is fixed, so the ratio check here reduces to height alone).

    Only for parsers that crop by coordinate. player_stats_chat_v1 must NOT
    call this: it runs one full-image PSM-4 OCR and a text state machine,
    with no coordinate crops at all (see its module docstring), so it is
    already resolution-independent — adding a guard there would reject chat
    screenshots it parses correctly today.
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

    if w != TARGET_WIDTH:
        scale = TARGET_WIDTH / w
        interp = cv2.INTER_AREA if w > TARGET_WIDTH else cv2.INTER_LINEAR
        # round(), not int(): truncation always rounds the height DOWN, so it
        # can only lower the ratio, and a source sitting exactly on a band's
        # lower edge falls out of that band purely from resize quantization
        # (234x416 is ratio 1.777778 exactly, the phone floor, and truncates to
        # 1080x1919 = 1.776852). Measured over every w in [200, 2600): 661
        # in-band sources are pushed out by int(), zero by round().
        image = cv2.resize(image, (TARGET_WIDTH, round(h * scale)), interpolation=interp)

    # Classify AFTER the resize, on the exact array every downstream check
    # sees. Classifying the raw dimensions instead splits the decision across
    # two different values — preprocess() would accept an image that
    # require_profile()/_layout_for_image then reject, mid-parse, quoting
    # dimensions the user never uploaded. The source dimensions are appended to
    # the message here so the error still names the file they did upload.
    nh, nw = image.shape[:2]
    try:
        detect_layout_profile(nw, nh)
    except UnsupportedAspectRatioError as exc:
        raise UnsupportedAspectRatioError(f"{exc} (source: {w}x{h})") from exc

    gray: np.ndarray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Mobile game screenshots have bright text on dark backgrounds
    if float(np.mean(gray)) < 128:
        gray = cv2.bitwise_not(gray)

    return gray
