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
    _RANK_CROPS,
    CANONICAL_HEIGHT,
    PolarInvasionV1Parser,
    _layout_for_image,
)
from app.preprocess import preprocess

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "polar_invasion"
OUT_DIR = Path("/tmp")


def annotate(image_path: Path) -> Path:
    raw = cv2.imread(str(image_path))
    gray = preprocess(raw)
    h, w = gray.shape[:2]
    scale = h / CANONICAL_HEIGHT

    # Resolved per image rather than hardwired to _PHONE_LAYOUT, so this tool
    # draws the right crop rectangles if ever pointed at the emulator
    # fixtures (tests/fixtures/polar_invasion_emulator/) instead of just the
    # phone ones FIXTURES_DIR defaults to.
    layout = _layout_for_image(gray)

    parser = PolarInvasionV1Parser()
    list_top = parser._detect_list_top(gray, layout)
    row_h = layout.row_height

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
        ny1 = y + layout.name_y_off[0]
        ny2 = y + layout.name_y_off[1]
        cv2.rectangle(vis, (layout.name_x[0], ny1), (layout.name_x[1], ny2), (0, 0, 255), 2)

        # NAME_WIDE fallback (orange)
        nyw1 = y + layout.name_y_off_wide[0]
        nyw2 = y + layout.name_y_off_wide[1]
        cv2.rectangle(
            vis, (layout.name_x[0] + 2, nyw1), (layout.name_x[1] - 2, nyw2), (0, 128, 255), 1
        )

        # POWER (blue) — y range shown uses the "fallback" constants but
        # primary power detection scans the full row. Draw the typical power zone.
        py1 = y + layout.power_y_off[0]
        py2 = y + layout.power_y_off[1]
        cv2.rectangle(vis, (layout.power_x[0], py1), (layout.power_x[1], py2), (255, 0, 0), 2)

        # POINTS (green) — full row y, specific x
        cv2.rectangle(
            vis,
            (layout.points_x[0], y),
            (layout.points_x[1], min(y + row_h, h - 1)),
            (0, 200, 0),
            2,
        )

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
