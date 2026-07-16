"""Integration tests for event types sharing the v1 member-list layout.

elite_wars, wasteland_showdown, battle_frenzy and void_war all route through
PolarInvasionV1Parser. Tests are collected dynamically: drop *.jpg + *.json
pairs in tests/fixtures/<event_type>/ and they run automatically.

Passing criterion (per fixture):
  - header (total_battlers, alliance_rank, total_points): exact match
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

FIXTURES_ROOT = Path(__file__).parent / "fixtures"

# Event types covered here (polar_invasion and ironblood_battlefield have
# dedicated test files and are excluded to avoid double-counting).
_V1_EVENT_TYPES = [
    "elite_wars",
    "wasteland_showdown",
    "battle_frenzy",
    "void_war",
]

_parser = PolarInvasionV1Parser()


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def _collect_fixtures() -> list[tuple[str, Path]]:
    result: list[tuple[str, Path]] = []
    for event_type in _V1_EVENT_TYPES:
        fixture_dir = FIXTURES_ROOT / event_type
        if fixture_dir.is_dir():
            for json_path in sorted(fixture_dir.glob("*.json")):
                result.append((event_type, json_path))
    return result


def _fixture_id(val: object) -> str:
    if isinstance(val, Path):
        return val.stem
    return str(val)


@pytest.mark.parametrize(
    "event_type,fixture_path",
    _collect_fixtures(),
    ids=_fixture_id,
)
def test_v1_parser_matches_fixture(event_type: str, fixture_path: Path) -> None:
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
        f"[{event_type}] member count: got {len(result.members)}, "
        f"expected {len(expected['members'])}\n"
        f"Got names:  {[m.name for m in result.members]}\n"
        f"Expected:   {[m['name'] for m in expected['members']]}"
    )

    for i, (got, want) in enumerate(zip(result.members, expected["members"], strict=False)):
        assert got.rank == want["rank"], (
            f"[{event_type}] row {i} rank: {got.rank!r} != {want['rank']!r}"
        )
        assert got.power == want["power"], (
            f"[{event_type}] row {i} power: {got.power} != {want['power']}"
        )
        assert got.points == want["points"], (
            f"[{event_type}] row {i} points: {got.points} != {want['points']}"
        )
        sim = _similar(got.name, want["name"])
        assert sim >= 0.66, (
            f"[{event_type}] row {i} name too different: "
            f"{got.name!r} vs {want['name']!r} (similarity={sim:.2f})"
        )
