"""Find actual y-positions of text rows by scanning the pseudo/power column.

Uses DARKNESS detection on the preprocessed (inverted) image, where text is dark.
Scans the x=220-500 column (pseudo+power text live here).
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.preprocess import preprocess

FIXTURES = sorted(
    (Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "polar_invasion").glob("*.jpg")
)


def find_text_rows(gray: np.ndarray, x_start: int, x_end: int, y_from: int = 350) -> list[int]:
    """Return y-centres of text rows (runs of dark pixels)."""
    strip = gray[y_from:, x_start:x_end]
    # Invert so text becomes bright
    text_mask = 255 - strip
    # Threshold to isolate text (anything notably darker than background)
    _, bw = cv2.threshold(text_mask, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    row_score = bw.mean(axis=1)
    # Smooth
    k = 5
    kernel = np.ones(k, dtype=np.float32) / k
    smoothed = np.convolve(row_score, kernel, mode="same")

    # Find runs where smoothed > a small threshold
    threshold = max(smoothed.max() * 0.15, 8.0)
    above = smoothed > threshold
    # Group consecutive above-rows
    groups: list[tuple[int, int]] = []
    start = None
    for i, v in enumerate(above):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= 10:  # text row is at least 10px tall
                groups.append((start, i))
            start = None
    if start is not None:
        groups.append((start, len(above)))

    centres = [y_from + (s + e) // 2 for s, e in groups]
    return centres


def measure(image_path: Path) -> None:
    raw = cv2.imread(str(image_path))
    gray = preprocess(raw)
    h, w = gray.shape[:2]

    # Pseudo column is roughly x=240..480, power column roughly x=280..500
    # Using the overlap region to find text lines
    text_rows = find_text_rows(gray, 240, 480, y_from=400)

    print(f"\n=== {image_path.name} ({w}x{h}) ===")
    print(f"text row y-centres ({len(text_rows)} found):")
    for y in text_rows:
        print(f"   y={y}")
    if len(text_rows) >= 4:
        deltas = [text_rows[i + 1] - text_rows[i] for i in range(len(text_rows) - 1)]
        print(f"deltas: {deltas}")
        print(f"median delta: {int(np.median(deltas))}")


def main() -> None:
    for f in FIXTURES:
        measure(f)


if __name__ == "__main__":
    main()
