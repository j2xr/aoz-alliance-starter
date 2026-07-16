"""Visualise parser crop zones on fixture images.

For each fixture in tests/fixtures/polar_invasion/*.jpg:
  - Load raw image and apply preprocess()
  - Compute list_top via the parser's detection
  - Draw the crop rectangles (NAME red, NAME_WIDE orange, POWER blue,
    POINTS green, RANK yellow) on top of a BGR version of the gray image
  - Save to /tmp/debug_crops_<stem>.png

Run:
    uv run python tools/debug_crops.py
"""

from __future__ import annotations

from pathlib import Path

import cv2

from app.parsers.polar_invasion_v1 import (
    _MAX_ROWS,
    _NAME_X,
    _NAME_Y_OFF,
    _NAME_Y_OFF_WIDE,
    _POINTS_X,
    _POWER_X,
    _POWER_Y_OFF,
    _RANK_CROPS,
    _ROW_HEIGHT,
    CANONICAL_HEIGHT,
    PolarInvasionV1Parser,
)
from app.preprocess import preprocess

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "polar_invasion"
OUT_DIR = Path("/tmp")


def annotate(image_path: Path) -> Path:
    raw = cv2.imread(str(image_path))
    gray = preprocess(raw)
    h, w = gray.shape[:2]
    scale = h / CANONICAL_HEIGHT

    parser = PolarInvasionV1Parser()
    list_top = parser._detect_list_top(gray)
    row_h = _ROW_HEIGHT

    # Convert to BGR for drawing
    vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    # Draw the detected list top as a horizontal line
    cv2.line(vis, (0, list_top), (w, list_top), (0, 255, 255), 2)
    cv2.putText(
        vis,
        f"list_top={list_top} row_h={row_h} scale={scale:.3f}",
        (20, max(20, list_top - 10)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (0, 255, 255),
        2,
    )

    for i in range(_MAX_ROWS):
        y = list_top + i * row_h
        if y >= h:
            break

        # Row boundary
        cv2.rectangle(vis, (0, y), (w - 1, min(y + row_h, h - 1)), (80, 80, 80), 1)
        cv2.putText(vis, f"row {i}", (5, y + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

        # NAME (red)
        ny1 = y + _NAME_Y_OFF[0]
        ny2 = y + _NAME_Y_OFF[1]
        cv2.rectangle(vis, (_NAME_X[0], ny1), (_NAME_X[1], ny2), (0, 0, 255), 2)

        # NAME_WIDE fallback (orange)
        nyw1 = y + _NAME_Y_OFF_WIDE[0]
        nyw2 = y + _NAME_Y_OFF_WIDE[1]
        cv2.rectangle(vis, (_NAME_X[0] + 2, nyw1), (_NAME_X[1] - 2, nyw2), (0, 128, 255), 1)

        # POWER (blue) — y range shown uses the "fallback" constants 85..175
        # but primary power detection scans the full row. Draw the typical power zone.
        py1 = y + _POWER_Y_OFF[0]
        py2 = y + _POWER_Y_OFF[1]
        cv2.rectangle(vis, (_POWER_X[0], py1), (_POWER_X[1], py2), (255, 0, 0), 2)

        # POINTS (green) — full row y, specific x
        cv2.rectangle(vis, (_POINTS_X[0], y), (_POINTS_X[1], min(y + row_h, h - 1)), (0, 200, 0), 2)

        # RANK (yellow) — primary crop only
        yo1, yo2, xo1, xo2 = _RANK_CROPS[0]
        cv2.rectangle(vis, (xo1, y + yo1), (xo2, y + yo2), (0, 255, 255), 2)

    out_path = OUT_DIR / f"debug_crops_{image_path.stem}.png"
    cv2.imwrite(str(out_path), vis)
    return out_path


def main() -> None:
    images = sorted(FIXTURES_DIR.glob("*.jpg"))
    for img_path in images:
        out = annotate(img_path)
        print(f"{img_path.name}  ->  {out}")


if __name__ == "__main__":
    main()
