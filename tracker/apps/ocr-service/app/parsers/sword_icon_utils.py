"""Mask the crossed-swords icon in Polar Invasion screenshots."""

import logging
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_SWORD_ICON_PATH = (
    Path(__file__).resolve().parent.parent / "assets" / "sprites" / "sprite_swords.png"
)


@lru_cache(maxsize=1)
def load_sword_icon() -> np.ndarray | None:
    if not _SWORD_ICON_PATH.exists():
        logger.warning(
            "Sword icon sprite not found at %s, disabling icon masking",
            _SWORD_ICON_PATH,
        )
        return None

    icon = cv2.imread(str(_SWORD_ICON_PATH), cv2.IMREAD_GRAYSCALE)
    if icon is None:
        logger.warning("Failed to load sword icon sprite, disabling icon masking")
        return None

    return icon


@lru_cache(maxsize=8)
def _resized_icon(scale: float) -> np.ndarray | None:
    """Sprite redimensionné, mémoïsé par échelle.

    Le resize LANCZOS était refait à chaque ligne de chaque capture alors que
    le résultat ne dépend que de `scale` (toujours 1.0 en pratique). Le sprite
    retourné est partagé : les appelants ne doivent PAS le muter — seul
    matchTemplate le lit.
    """
    icon = load_sword_icon()
    if icon is None:
        return None
    if scale == 1.0:
        return icon
    h, w = icon.shape
    return cv2.resize(icon, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_LANCZOS4)


def mask_sword_icon(line_img: np.ndarray, scale: float) -> np.ndarray:
    icon_resized = _resized_icon(scale)
    if icon_resized is None:
        return line_img

    th, tw = icon_resized.shape

    # Search inside the name/power area where the swords icon appears.
    search_y1, search_y2 = int(100 * scale), int(170 * scale)
    search_x1, search_x2 = int(180 * scale), int(320 * scale)
    search_band = line_img[search_y1:search_y2, search_x1:search_x2]
    if search_band.shape[0] < th or search_band.shape[1] < tw:
        logger.debug("Search band too small for template matching, skipping mask")
        return line_img

    res = cv2.matchTemplate(search_band, icon_resized, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(res)
    logger.debug("Sword icon match: score=%.3f, pos=%s", max_val, max_loc)

    if max_val > 0.6:
        top_left = (search_x1 + max_loc[0], search_y1 + max_loc[1])
        bottom_right = (top_left[0] + tw, top_left[1] + th)
        cv2.rectangle(line_img, top_left, bottom_right, (255, 255, 255), thickness=-1)
        logger.debug(
            "Sword icon masked at %s-%s (score=%.3f)",
            top_left,
            bottom_right,
            max_val,
        )

    return line_img
