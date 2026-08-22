"""Integration tests for wasteland_showdown on the 400x652 emulator source.

Ground truth: tests/fixtures/wasteland_showdown_emulator/ (see its README).

Narrower in scope than test_polar_invasion_emulator_parser.py's floor tests
on purpose: this is the first ground-truth-verified emulator capture of a
2-column event at all (_Layout.battlers_x_2col/total_points_x_2col on
_EMULATOR_LAYOUT, measured 2026-08-22 — aoz-alliance-starter#91), so what's
provable today is that the header reads correctly and no row is lost, not
a name/rank accuracy floor — 16 rows across 2 fixtures is too few to set one
without it being mostly noise (a single miss moves the number by >6 points).
Per-row accuracy is measured and reported in the README instead, same
provenance and correction process as the 2026-08-22 addition to the
sibling polar_invasion_emulator fixtures.

The O1a/O1b pair is a determinism check, not an accuracy one: same on-screen
list, recaptured ~5 minutes apart with no interaction in between. The two
PNGs differ at the byte level (a cosmetic avatar-frame animation, ~1300
pixels in a small region overlapping the rank-badge crop — see the fixtures
README) but the parser's output must not.
"""

import json
from pathlib import Path

import pytest

from app.dispatcher import detect_screen_kind
from app.parsers.polar_invasion_v1 import PolarInvasionV1Parser
from app.preprocess import preprocess_image

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "wasteland_showdown_emulator"
_parser = PolarInvasionV1Parser()
_EVENT_CODE = "wasteland_showdown"


def _load_fixtures() -> list[Path]:
    return sorted(FIXTURES_DIR.glob("2026*.json"))


@pytest.mark.parametrize("fixture_path", _load_fixtures(), ids=lambda p: p.stem)
def test_header_matches_fixture(fixture_path: Path) -> None:
    with fixture_path.open(encoding="utf-8") as fh:
        expected = json.load(fh)

    image_path = FIXTURES_DIR / expected["source_file"]
    image = preprocess_image(str(image_path))
    result = _parser.parse(image, event_code=_EVENT_CODE)

    assert result.event_type == expected["event_type"]
    exp_dt = expected.get("event_datetime", "")
    got_dt = result.event_datetime or ""
    assert got_dt[:16] == exp_dt[:16], f"datetime mismatch: {got_dt!r} vs {exp_dt!r}"
    assert result.total_battlers == expected["total_battlers"]
    assert result.alliance_rank == expected["alliance_rank"]
    assert result.total_points == expected["total_points"]
    assert len(result.members) == len(expected["members"]), (
        f"member count: got {len(result.members)}, expected {len(expected['members'])}\n"
        f"Got names: {[m.name for m in result.members]}\n"
        f"Expected:  {[m['name'] for m in expected['members']]}"
    )


@pytest.mark.parametrize("fixture_path", _load_fixtures(), ids=lambda p: p.stem)
def test_dispatcher_routes_emulator_captures_to_this_parser(fixture_path: Path) -> None:
    """Same guard as the sibling polar_invasion_emulator suite: dispatcher's
    header OCR band (tuned on phone captures) must still resolve the correct
    event code on this profile's chrome, not just the parser's own crops."""
    with fixture_path.open(encoding="utf-8") as fh:
        expected = json.load(fh)
    image = preprocess_image(str(FIXTURES_DIR / expected["source_file"]))

    assert detect_screen_kind(image) == ("event", _EVENT_CODE)


def test_determinism_across_recaptured_screens() -> None:
    """O1a/O1b: the same on-screen list, recaptured ~5min apart untouched.

    The two PNGs are not byte-identical (see module docstring) — this test
    is the executable form of that finding: parser output must be immune to
    the difference regardless of whether the raw bytes are.
    """
    image_a = preprocess_image(str(FIXTURES_DIR / "20260822T0945_O1a.png"))
    image_b = preprocess_image(str(FIXTURES_DIR / "20260822T0950_O1b.png"))

    result_a = _parser.parse(image_a, event_code=_EVENT_CODE)
    result_b = _parser.parse(image_b, event_code=_EVENT_CODE)

    header_a = (result_a.total_battlers, result_a.alliance_rank, result_a.total_points)
    header_b = (result_b.total_battlers, result_b.alliance_rank, result_b.total_points)
    assert header_a == header_b

    members_a = [(m.rank, m.name, m.power, m.points) for m in result_a.members]
    members_b = [(m.rank, m.name, m.power, m.points) for m in result_b.members]
    assert members_a == members_b
