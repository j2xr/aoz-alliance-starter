"""Tests for the optional RowTrace populated by event/donation parsers.

The trace is debug-only: it must be ``None`` by default (production path) and
populated with strict per-field crop coordinates when ``emit_trace=True``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.parsers._trace import FieldBox, RowTrace
from app.parsers.contribution_ranking_v1 import ContributionRankingV1Parser
from app.parsers.polar_invasion_v1 import (
    _NAME_X,
    _NAME_Y_OFF,
    _NAME_Y_OFF_WIDE,
    _ROW_HEIGHT,
    PolarInvasionV1Parser,
)
from app.preprocess import preprocess_image

FIXTURES_DIR = Path(__file__).parent / "fixtures"
POLAR_FIXTURES = FIXTURES_DIR / "polar_invasion"
DONATION_FIXTURES = FIXTURES_DIR / "contribution_ranking"


def _pick_image(dir_: Path) -> Path | None:
    # Prefer a JPG paired with a JSON ground truth when available, else fall
    # back to any JPG in the directory (donation fixtures ship without JSON).
    for json_path in sorted(dir_.glob("*.json")):
        jpg = json_path.with_suffix(".jpg")
        if jpg.exists():
            return jpg
    jpgs = sorted(dir_.glob("*.jpg"))
    return jpgs[0] if jpgs else None


def _box_inside(inner: FieldBox, outer_y1: int, outer_y2: int) -> bool:
    return outer_y1 <= inner.y1 and inner.y2 <= outer_y2 and inner.y2 > inner.y1


def test_fieldbox_coord_suffix() -> None:
    box = FieldBox(y1=123, y2=145, x1=40, x2=220)
    assert box.coord_suffix() == "_y123-145_x40-220"


def test_fieldbox_serialization_excludes_nothing() -> None:
    # FieldBox itself is part of the trace; trace as a whole is excluded
    # from MemberResult JSON. FieldBox should serialize normally on its own
    # so debug tooling can dump it.
    box = FieldBox(y1=1, y2=2, x1=3, x2=4)
    assert box.model_dump() == {"y1": 1, "y2": 2, "x1": 3, "x2": 4}


def test_polar_parser_default_trace_is_none() -> None:
    """emit_trace=False (default) → no allocation, trace stays None."""
    image_path = _pick_image(POLAR_FIXTURES)
    if image_path is None:
        pytest.skip("no polar_invasion fixture image available")

    image = preprocess_image(str(image_path))
    parser = PolarInvasionV1Parser()
    result = parser.parse(image)
    assert result.members, "fixture should yield at least one member"
    for m in result.members:
        assert m.trace is None


def test_polar_parser_emits_trace_when_requested() -> None:
    image_path = _pick_image(POLAR_FIXTURES)
    if image_path is None:
        pytest.skip("no polar_invasion fixture image available")

    image = preprocess_image(str(image_path))
    parser = PolarInvasionV1Parser()
    result = parser.parse(image, emit_trace=True)
    assert result.members, "fixture should yield at least one member"

    # list_top from the parser's runtime _detect_list_top, identical across rows.
    detected_top = parser._detect_list_top(image)
    seen_list_tops: set[int] = set()
    seen_row_indices: list[int] = []

    for m in result.members:
        trace = m.trace
        assert isinstance(trace, RowTrace), "trace must be populated when emit_trace=True"
        assert trace.row_height == _ROW_HEIGHT
        assert trace.list_top == detected_top
        seen_list_tops.add(trace.list_top)
        seen_row_indices.append(trace.row_index)

        # Row bounding box derived from list_top + row_index * row_height.
        row_y1 = trace.list_top + trace.row_index * trace.row_height
        row_y2 = row_y1 + trace.row_height

        # Name box: y-extent must match either the primary or wide layout.
        name_h = trace.name.y2 - trace.name.y1
        expected_primary = _NAME_Y_OFF[1] - _NAME_Y_OFF[0]
        expected_wide = _NAME_Y_OFF_WIDE[1] - _NAME_Y_OFF_WIDE[0]
        assert name_h in (expected_primary, expected_wide), (
            f"name height {name_h} matches neither primary ({expected_primary}) "
            f"nor wide ({expected_wide})"
        )
        assert trace.name.x1 == _NAME_X[0]
        assert trace.name.x2 == _NAME_X[1]

        # All 4 field boxes must sit strictly inside the row band.
        assert _box_inside(trace.name, row_y1, row_y2)
        assert _box_inside(trace.rank, row_y1, row_y2)
        assert trace.power is not None and _box_inside(trace.power, row_y1, row_y2)
        assert trace.points is not None and _box_inside(trace.points, row_y1, row_y2)
        # Donation-only field stays None on the event parser.
        assert trace.alliance_honor is None

    # row_index must be strictly increasing for the kept members.
    assert seen_row_indices == sorted(seen_row_indices)
    assert len(seen_list_tops) == 1, "list_top must be identical across all rows"


def test_polar_member_result_excludes_trace_from_json() -> None:
    """trace must never appear in MemberResult JSON output (API contract)."""
    image_path = _pick_image(POLAR_FIXTURES)
    if image_path is None:
        pytest.skip("no polar_invasion fixture image available")

    image = preprocess_image(str(image_path))
    parser = PolarInvasionV1Parser()
    result = parser.parse(image, emit_trace=True)
    assert result.members

    payload = result.model_dump()
    for member in payload["members"]:
        assert "trace" not in member, (
            "trace field leaked into JSON — must be excluded for production parity"
        )

    # Round-trip JSON: trace remains absent.
    raw_json = result.model_dump_json()
    parsed = json.loads(raw_json)
    for member in parsed["members"]:
        assert "trace" not in member


def test_donation_parser_default_trace_is_none() -> None:
    image_path = _pick_image(DONATION_FIXTURES)
    if image_path is None:
        pytest.skip("no contribution_ranking fixture image available")

    image = preprocess_image(str(image_path))
    parser = ContributionRankingV1Parser()
    result = parser.parse(image)
    assert result.members
    for m in result.members:
        assert m.trace is None


def test_donation_parser_emits_trace_when_requested() -> None:
    image_path = _pick_image(DONATION_FIXTURES)
    if image_path is None:
        pytest.skip("no contribution_ranking fixture image available")

    image = preprocess_image(str(image_path))
    parser = ContributionRankingV1Parser()
    result = parser.parse(image, emit_trace=True)
    assert result.members

    detected_top = parser._detect_list_top(image, image.shape[0] / 2400)
    for m in result.members:
        trace = m.trace
        assert isinstance(trace, RowTrace)
        assert trace.list_top == detected_top
        # Donation parser exposes name/rank/alliance_honor; no power/points.
        assert trace.power is None
        assert trace.points is None
        assert trace.alliance_honor is not None

        row_y1 = trace.list_top + trace.row_index * trace.row_height
        row_y2 = row_y1 + trace.row_height
        assert _box_inside(trace.name, row_y1, row_y2)
        assert _box_inside(trace.alliance_honor, row_y1, row_y2)
        # Rank badge sits in the upper portion of the row.
        assert _box_inside(trace.rank, row_y1, row_y2)
