"""Integration tests for contribution_ranking (donations) on the 400x652
emulator source.

Ground truth: tests/fixtures/contribution_ranking_emulator/ (see its
README for provenance, the excluded week1_10 known-gap capture, and the
list-top/rank-badge geometry bugs this corpus caught and fixed).

Floors below are set from these 5 fixtures specifically (44 member rows
total: 9+9+9+9+8 — the excluded week1_10/jasmin cases are already reflected
in each fixture's own member count, not subtracted separately), measured
in the CI-equivalent Docker environment (tracker-ocr-service:latest) — a
bare local .venv gives meaningfully different OCR numbers (see the sibling
polar_invasion_emulator README for why). Each floor sits below its
measured rate with margin, same convention as the sibling emulator
suites — not "loosened until green":

| Field           | Measured (44 rows) | Floor |
|------------------|---------------------|-------|
| name (fuzzy ≥0.85) | 95.5% (42/44)     | 0.90  |
| rank              | 77.3% (34/44)      | 0.70  |
| alliance_honor    | 97.7% (43/44)      | 0.95  |
| alliance_tag (ci) | 90.9% (40/44)      | 0.85  |

`rank` is the weakest field, measured *after* the badge-crop geometry fix
documented in the fixtures README — the crop is now correctly positioned,
but the badge itself renders as low-contrast, small (~20px) text, which is
a legibility floor similar to the sibling polar_invasion_emulator
suite's `Madara⁶⁹Uchiha` case, not a further tuning gap already ruled out.
`alliance_honor`'s one miss (`week1_13`'s `ahmed`, `575` read as `975`) is
a plain 5-vs-9 digit confusion, not a geometry issue — it also appears in
`week1_14` (not part of this fixture set), so it is a real, repeatable
recognition limit on this specific value, not sampling noise.
"""

import json
from difflib import SequenceMatcher
from pathlib import Path

import pytest

from app.dispatcher import DONATION_CODE, detect_screen_kind
from app.parsers.contribution_ranking_v1 import ContributionRankingV1Parser
from app.preprocess import preprocess_image

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "contribution_ranking_emulator"
_parser = ContributionRankingV1Parser()

_NAME_SIMILARITY_MIN = 0.85  # a near-miss (e.g. a dropped diacritic) still counts
_NAME_FLOOR = 0.90
_RANK_FLOOR = 0.70
_HONOR_FLOOR = 0.95
_TAG_FLOOR = 0.85


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _load_fixtures() -> list[Path]:
    return sorted(FIXTURES_DIR.glob("week1_*.json"))


def _image_path(fixture_path: Path) -> Path:
    return fixture_path.with_suffix(".png")


@pytest.mark.parametrize("fixture_path", _load_fixtures(), ids=lambda p: p.stem)
def test_header_matches_fixture(fixture_path: Path) -> None:
    with fixture_path.open(encoding="utf-8") as fh:
        expected = json.load(fh)

    image = preprocess_image(str(_image_path(fixture_path)))
    result = _parser.parse(image)

    assert result.kind == "donation"
    assert result.period_type == expected["period_type"]
    assert len(result.members) == len(expected["members"]), (
        f"member count: got {len(result.members)}, expected {len(expected['members'])}\n"
        f"Got names: {[m.name for m in result.members]}\n"
        f"Expected:  {[m['name'] for m in expected['members']]}"
    )


@pytest.mark.parametrize("fixture_path", _load_fixtures(), ids=lambda p: p.stem)
def test_dispatcher_routes_emulator_captures_to_this_parser(fixture_path: Path) -> None:
    """Same guard as the sibling polar_invasion_emulator/wasteland_showdown_emulator
    suites: dispatcher's header text match (tuned/verified on phone captures)
    must still resolve correctly on this profile's chrome."""
    with fixture_path.open(encoding="utf-8") as fh:
        expected = json.load(fh)
    image = preprocess_image(str(_image_path(fixture_path)))

    assert detect_screen_kind(image) == ("donation", DONATION_CODE)
    assert expected["period_type"] == "weekly"


def test_member_field_accuracy_meets_floor() -> None:
    """Aggregate per-field accuracy across all 5 fixtures, positional
    (member i in the parsed result vs. member i in the fixture) — the
    fixtures were built directly from this parser's own row alignment
    against independently-verified ground truth, so a positional mismatch
    here would mean the parser's row order changed, not just a field
    misread; see test_header_matches_fixture for the member-count guard
    that would normally catch that first.
    """
    name_total = name_ok = 0
    rank_total = rank_ok = 0
    honor_total = honor_ok = 0
    tag_total = tag_ok = 0

    for fixture_path in _load_fixtures():
        with fixture_path.open(encoding="utf-8") as fh:
            expected = json.load(fh)
        image = preprocess_image(str(_image_path(fixture_path)))
        result = _parser.parse(image)

        for got, want in zip(result.members, expected["members"], strict=False):
            name_total += 1
            if _similar(got.name, want["name"]) >= _NAME_SIMILARITY_MIN:
                name_ok += 1

            rank_total += 1
            if got.rank == want["rank"]:
                rank_ok += 1

            honor_total += 1
            if got.alliance_honor == want["alliance_honor"]:
                honor_ok += 1

            tag_total += 1
            if (got.alliance_tag or "").upper() == (want["alliance_tag"] or "").upper():
                tag_ok += 1

    assert name_total > 0, "fixture set is empty"
    name_rate = name_ok / name_total
    rank_rate = rank_ok / rank_total
    honor_rate = honor_ok / honor_total
    tag_rate = tag_ok / tag_total

    assert name_rate >= _NAME_FLOOR, f"name accuracy {name_rate:.1%} ({name_ok}/{name_total})"
    assert rank_rate >= _RANK_FLOOR, f"rank accuracy {rank_rate:.1%} ({rank_ok}/{rank_total})"
    assert honor_rate >= _HONOR_FLOOR, f"honor accuracy {honor_rate:.1%} ({honor_ok}/{honor_total})"
    assert tag_rate >= _TAG_FLOOR, f"tag accuracy {tag_rate:.1%} ({tag_ok}/{tag_total})"
