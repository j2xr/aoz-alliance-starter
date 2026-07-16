"""Replicate parser._detect_list_top() math for each fixture and print results."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.parsers.polar_invasion_v1 import _MEMBER_LIST_TOP, _NAME_Y_OFF, _POWER_Y_OFF, _ROW_HEIGHT
from app.preprocess import preprocess

FIXTURES = sorted(
    (Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "polar_invasion").glob("*.jpg")
)


def show(image_path: Path) -> None:
    raw = cv2.imread(str(image_path))
    gray = preprocess(raw)
    h, w = gray.shape[:2]
    scale = h / 2400
    canonical_top = int(_MEMBER_LIST_TOP * scale)
    search_start = max(0, canonical_top - 120)
    search_end = min(h, canonical_top + 120)
    row_h = int(_ROW_HEIGHT * scale)

    strip = gray[search_start:search_end, 45:115]
    row_means = strip.mean(axis=1)
    max_v = row_means.max()
    threshold = max_v * 0.6
    bright_rows = np.where(row_means > threshold)[0]
    detected = search_start + int(bright_rows[0]) if bright_rows.size else canonical_top

    # Print a mini text-plot of the strip brightness profile
    print(f"\n=== {image_path.name} scale={scale:.3f} canonical_top={canonical_top} ===")
    print(f"search window: y=[{search_start}, {search_end})")
    print(f"detected list_top: {detected}")
    print(f"row_h: {row_h}")

    # Print brightness of strip every 5 px
    print("brightness profile (y, mean):")
    for i in range(0, len(row_means), 5):
        y = search_start + i
        m = row_means[i]
        mark = "<=" if m > threshold else ""
        print(f"  y={y:4d}  mean={m:6.1f}  {mark}")

    # Compute expected positions for first 11 rows and the name/power y ranges
    print("\nPer-row expected crops (list_top, name_y1..y2, power_y1..y2):")
    for i in range(11):
        y = detected + i * row_h
        ny1 = y + int(_NAME_Y_OFF[0] * scale)
        ny2 = y + int(_NAME_Y_OFF[1] * scale)
        py1 = y + int(_POWER_Y_OFF[0] * scale)
        py2 = y + int(_POWER_Y_OFF[1] * scale)
        print(f"  row {i}: y={y} name_y=[{ny1},{ny2}] power_y=[{py1},{py2}]")


def main() -> None:
    for f in FIXTURES[:3]:
        show(f)


if __name__ == "__main__":
    main()
