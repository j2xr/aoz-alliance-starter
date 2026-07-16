"""Integration tests: parser output vs. ground-truth JSON fixtures for Ironblood Battlefield.

Ironblood Battlefield uses the same v1 layout as Polar Invasion. The parser
returns event_type="polar_invasion" directly; extract() overrides it to
"ironblood_battlefield" via the dispatcher (tested in test_contribution_ranking_parser.py).

Passing criterion (per fixture):
  - header (battlers, alliance_rank, total_points): exact match
  - event_datetime: first 16 chars match ("YYYY-MM-DDTHH:MM")
  - member count: exact match
  - per member: rank exact, power exact, points exact, name similarity >= 0.66
"""

import json
from difflib import SequenceMatcher
from pathlib import Path

import pytest

from app.parsers.polar_invasion_v1 import PolarInvasionV1Parser
from app.preprocess import preprocess_image

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "ironblood_battlefield"
_parser = PolarInvasionV1Parser()


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def _load_fixtures() -> list[Path]:
    return sorted(FIXTURES_DIR.glob("*.json"))


@pytest.mark.parametrize("fixture_path", _load_fixtures(), ids=lambda p: p.stem)
def test_ironblood_parser_matches_fixture(fixture_path: Path) -> None:
    with fixture_path.open(encoding="utf-8") as fh:
        expected = json.load(fh)

    image_path = fixture_path.with_suffix(".jpg")
    if not image_path.exists():
        pytest.skip(f"Image not found: {image_path}")

    image = preprocess_image(str(image_path))
    result = _parser.parse(image)

    exp_dt = expected.get("event_datetime", "")
    got_dt = result.event_datetime or ""
    assert got_dt[:16] == exp_dt[:16], f"datetime mismatch: {got_dt!r} vs {exp_dt!r}"

    assert result.total_battlers == expected["total_battlers"], (
        f"battlers: got {result.total_battlers}, expected {expected['total_battlers']}"
    )
    assert result.alliance_rank == expected["alliance_rank"], (
        f"alliance_rank: got {result.alliance_rank}, expected {expected['alliance_rank']}"
    )
    assert result.total_points == expected["total_points"], (
        f"total_points: got {result.total_points}, expected {expected['total_points']}"
    )

    assert len(result.members) == len(expected["members"]), (
        f"member count: got {len(result.members)}, expected {len(expected['members'])}\n"
        f"Got names: {[m.name for m in result.members]}\n"
        f"Expected:  {[m['name'] for m in expected['members']]}"
    )

    for i, (got, want) in enumerate(zip(result.members, expected["members"], strict=False)):
        assert got.rank == want["rank"], f"row {i} rank: {got.rank!r} != {want['rank']!r}"
        assert got.power == want["power"], f"row {i} power: {got.power} != {want['power']}"
        assert got.points == want["points"], f"row {i} points: {got.points} != {want['points']}"
        sim = _similar(got.name, want["name"])
        assert sim >= 0.66, (
            f"row {i} name too different: {got.name!r} vs {want['name']!r} (similarity={sim:.2f})"
        )
