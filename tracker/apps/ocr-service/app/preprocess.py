import logging

import cv2
import numpy as np

logger = logging.getLogger(__name__)

TARGET_WIDTH = 1080


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
        image = cv2.resize(image, (TARGET_WIDTH, int(h * scale)), interpolation=interp)

    gray: np.ndarray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Mobile game screenshots have bright text on dark backgrounds
    if float(np.mean(gray)) < 128:
        gray = cv2.bitwise_not(gray)

    return gray
