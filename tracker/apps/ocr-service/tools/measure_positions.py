"""Measure row y-positions and extent by analysing brightness profiles.

For each fixture:
  - Preprocess to canonical 1080x2400 grayscale (inverted, so text is bright)
  - Build a horizontal brightness profile (mean per row) in the pseudo column (x=240..480)
    and in the power column (x=280..520), over y in [350 .. 2400]
  - Detect bright rows (where text lives) and compute peaks
  - Print: peak y-centres, inferred row_height, first peak (list_top approx)
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.preprocess import preprocess

FIXTURES = sorted(
    (Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "polar_invasion").glob("*.jpg")
)


def detect_peaks(
    profile: np.ndarray, min_gap: int = 100, threshold_ratio: float = 0.5
) -> list[int]:
    """Return y-indices of local maxima separated by at least min_gap."""
    threshold = profile.max() * threshold_ratio
    candidates = np.where(profile > threshold)[0]
    if candidates.size == 0:
        return []

    # Cluster contiguous candidate rows into groups, then pick the argmax of each
    groups: list[list[int]] = [[int(candidates[0])]]
    for idx in candidates[1:]:
        if int(idx) - groups[-1][-1] <= 10:
            groups[-1].append(int(idx))
        else:
            groups.append([int(idx)])

    # For each group, y-centre = mean idx
    centres = [int(np.mean(g)) for g in groups]

    # Merge centres that are too close
    merged: list[int] = []
    for c in centres:
        if not merged or c - merged[-1] >= min_gap:
            merged.append(c)
    return merged


def measure(image_path: Path) -> None:
    raw = cv2.imread(str(image_path))
    gray = preprocess(raw)
    h, w = gray.shape[:2]

    # Pseudo text is between x=240..500 approx; power between x=280..520
    pseudo_strip = gray[300:, 240:500].astype(np.float32)
    power_strip = gray[300:, 280:520].astype(np.float32)

    pseudo_profile = pseudo_strip.mean(axis=1)
    power_profile = power_strip.mean(axis=1)

    # Normalise relative to local baseline (row separator pixels are darker)
    # A simple approach: subtract a running min.
    def bandpass(p: np.ndarray, smooth_k: int = 9) -> np.ndarray:
        kernel = np.ones(smooth_k, dtype=np.float32) / smooth_k
        smoothed = np.convolve(p, kernel, mode="same")
        return smoothed - smoothed.min()

    ps = bandpass(pseudo_profile)
    pw = bandpass(power_profile)

    # Find rising edges of peaks — each member row has a text line.
    # Use a simple threshold + min gap detector.
    pseudo_peaks = detect_peaks(ps, min_gap=120, threshold_ratio=0.55)
    power_peaks = detect_peaks(pw, min_gap=120, threshold_ratio=0.55)

    # Adjust to absolute y (we started at 300)
    pseudo_peaks = [p + 300 for p in pseudo_peaks]
    power_peaks = [p + 300 for p in power_peaks]

    print(f"\n=== {image_path.name} ({w}x{h}) ===")
    print(f"pseudo peaks (y, n={len(pseudo_peaks)}): {pseudo_peaks}")
    print(f"power  peaks (y, n={len(power_peaks)}): {power_peaks}")

    if len(pseudo_peaks) >= 2:
        deltas = [pseudo_peaks[i + 1] - pseudo_peaks[i] for i in range(len(pseudo_peaks) - 1)]
        print(f"pseudo peak deltas: {deltas} (median={int(np.median(deltas))})")

    # Pair each pseudo peak with the nearest power peak below it, print the gap
    if pseudo_peaks and power_peaks:
        pairs = []
        for pp in pseudo_peaks:
            # nearest power peak with y > pp
            after = [q for q in power_peaks if q > pp and q - pp < 120]
            if after:
                pairs.append((pp, after[0], after[0] - pp))
        print(f"pseudo→power pairs (pseudo_y, power_y, gap): {pairs[:5]}")


def main() -> None:
    for f in FIXTURES:
        measure(f)


if __name__ == "__main__":
    main()
