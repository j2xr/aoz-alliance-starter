"""Optional per-row debug trace produced by event/donation parsers.

When a parser is invoked with ``emit_trace=True``, every returned
``MemberResult`` / ``DonationMember`` carries a :class:`RowTrace` describing
the exact bounding boxes that were passed to Tesseract for each field.

This lets the bench-ocr tool dump the strict crops Tesseract actually saw
for failing rows, instead of recomputing approximate boxes after the fact
from canonical layout constants × image scale — which can drift by a few
pixels from the parser's runtime ``_detect_list_top`` result and produce
misleading visual debug.

In production, parsers are called with ``emit_trace=False`` (the default),
``trace`` stays ``None`` on every result, and the field is excluded from
JSON serialization so the API contract is unchanged.
"""

from __future__ import annotations

from pydantic import BaseModel


class FieldBox(BaseModel):
    """Absolute pixel bounding box (in the preprocessed image coordinate system)."""

    y1: int
    y2: int
    x1: int
    x2: int

    def coord_suffix(self) -> str:
        """Return the ``_y<y1>-<y2>_x<x1>-<x2>`` filename suffix used by the bench."""
        return f"_y{self.y1}-{self.y2}_x{self.x1}-{self.x2}"


class RowTrace(BaseModel):
    """Per-row crop coordinates that Tesseract saw for each field.

    ``list_top`` is the y-start returned by ``_detect_list_top`` for the
    image, ``row_index`` is the parser's 0-based row counter, and
    ``row_height`` is the effective per-row pitch used by the parser.
    Field boxes are only populated when the parser actually performed an
    OCR pass for that field: donation rows have no power/points,
    event rows have no alliance_honor.
    """

    list_top: int
    row_index: int
    row_height: int
    name: FieldBox
    rank: FieldBox
    power: FieldBox | None = None
    points: FieldBox | None = None
    alliance_honor: FieldBox | None = None
