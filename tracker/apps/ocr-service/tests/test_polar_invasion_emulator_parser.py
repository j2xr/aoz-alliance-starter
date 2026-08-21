"""Integration tests: parser output vs. ground-truth JSON fixtures, for the
400x652 emulator source (aoz-alliance-starter#91).

Ground truth: tests/fixtures/polar_invasion_emulator/ (see its README for
provenance and known transcription uncertainties).

Unlike test_polar_invasion_parser.py's per-row strict-equality style, the
member-field assertions here are AGGREGATE accuracy floors, not per-row
exact matches. Rationale: this profile's crop constants were calibrated
against only 4 real captures (32 member rows total), and one badge in that
set is not legible at this resolution by any sweep. Per-row strict
assertions would turn this suite red for that known, understood gap
instead of tracking real regressions.

The floors below are set a few points BELOW what this implementation
currently measures (documented per field, in a CI-equivalent environment —
see the `tracker-ocr-service:latest` Docker recipe in this repo's session
notes; a bare `.venv` without tesserocr and the extra language packs
measures meaningfully different numbers and must not be used to set these
floors), both to leave margin against Tesseract version drift between
environments (see the sibling polar_invasion fixtures' README for a
documented case of exactly this) and, for rank, because current accuracy
is honestly below the phone parser's target — not papered over by
lowering the target, but reported as a known gap with its cause:

Measured on these 4 fixtures (32 member rows), vs. the phone parser's own
targets (see ../polar_invasion/README.md):

  - header (battlers/rank/points/datetime): 100% (16/16) — meets 100%
  - points: 100% (32/32) — meets >=95%
  - name, Latin-only: 90.3% (28/31) — meets >=90%
  - power: 100% (32/32) — meets >=95%. Previously 87.5% (28/32): the
    primary detection stage (a PSM-11 scan of the full row, x=0 up to the
    points column) includes the avatar on this profile, and
    `Madara⁶⁹Uchiha`'s decorative frame was read as a leading "1" fused
    onto the value on all 3 of its rows (e.g. 116927699 vs. 16927699).
    Fixed by `_Layout.power_stages`, which lists per profile which
    detection stages run at all: the emulator layout lists only the narrow,
    avatar-excluding contrast-normalized crop, which reads all 32 rows on
    its own. The full-row sweep is omitted rather than demoted (as a
    fallback it would still corrupt those rows), and the PSM-8 stage is
    omitted because it returned 0 correct values out of 32 at every x-band
    tried while producing two plausible-but-wrong values above MIN_POWER.
    See the field's docstring in polar_invasion_v1.py for the measurements.
    This also resolved a `.AL3X.` power misread noted in an earlier version
    of this docstring as a separate, undiagnosed miss — it shared the same
    root cause and did not reproduce once measured in a CI-equivalent
    environment.
  - rank: 96.9% (31/32) — just short of >=98%, which on 32 rows would
    require a clean sweep. Previously 78.1% (25/32) using the phone
    parser's `_RANK_OCR_ORDER`, whose threshold/psm sweep was tuned on
    badges carrying 52x47 source pixels against this profile's 30x20.
    Retuned via `_Layout.rank_ocr_order`, which gives each profile its own
    sweep while sharing the vote logic unchanged: the threshold step goes
    20 -> 10 (the misses read correctly at 110/150/170, the midpoints the
    phone grid steps over), psm 6 is added, and psm 8 is dropped (0 strong
    hits in 416 attempts at this glyph size). The remaining miss
    (20260721T1500_001 row 2) is a legibility floor, not a tuning gap: its
    true rank is produced by no combo of a 114-combo grid at any crop
    padding from -6 to +6 px. Lifting it needs a different mechanism (the
    LLM vision fallback already used for names), not more sweep tuning.
    See `_EMULATOR_RANK_OCR_ORDER` in polar_invasion_v1.py for the
    measurements.

`中本` (the one non-Latin name in the fixture set) is intentionally excluded
from the name floor, matching the phone README's own split target
(Latin >=90%, Cyrillic/Japanese >=75% OR LLM fallback) — production already
routes low-confidence names through LLM fallback (see extract.py), which
this test doesn't exercise (it calls the parser directly, same as the
phone parser's own test suite).
"""

import json
from difflib import SequenceMatcher
from pathlib import Path

import pytest

from app.dispatcher import detect_screen_kind
from app.parsers.base import MemberResult
from app.parsers.polar_invasion_v1 import PolarInvasionV1Parser
from app.preprocess import UnsupportedAspectRatioError, preprocess_image

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "polar_invasion_emulator"
_parser = PolarInvasionV1Parser()

# Production always supplies an event code (extract.py resolves it via
# REGISTRY), which selects _parse_header's deterministic 3-column branch.
# Calling parse() without one takes a heuristic fallback branch that only
# exists for direct dev-tool/test calls, so measuring the accuracy floors
# through it would grade a path production never runs.
_EVENT_CODE = "polar_invasion"

# Names outside the Latin-alphabet accuracy floor (see module docstring).
_NON_LATIN_NAMES = {"中本"}


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def _load_fixtures() -> list[Path]:
    return sorted(FIXTURES_DIR.glob("*.json"))


def test_emulator_source_is_not_rejected_by_preprocess() -> None:
    """Regression guard: Step 3's aspect-ratio gate must accept this profile."""
    fixtures = _load_fixtures()
    assert fixtures, "no emulator fixtures found"
    with fixtures[0].open(encoding="utf-8") as fh:
        expected = json.load(fh)
    image_path = FIXTURES_DIR / expected["source_file"]

    try:
        image = preprocess_image(str(image_path))
    except UnsupportedAspectRatioError as exc:
        pytest.fail(f"emulator source was rejected by preprocess(): {exc}")

    assert image.shape[1] == 1080


@pytest.mark.parametrize("fixture_path", _load_fixtures(), ids=lambda p: p.stem)
def test_header_matches_fixture(fixture_path: Path) -> None:
    with fixture_path.open(encoding="utf-8") as fh:
        expected = json.load(fh)

    image_path = FIXTURES_DIR / expected["source_file"]
    if not image_path.exists():
        pytest.skip(f"Image not found: {image_path}")

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


def test_member_field_accuracy_meets_floor() -> None:
    """Aggregate accuracy across all fixtures/rows — see module docstring for floors."""
    name_hits = name_total = 0
    rank_hits = rank_total = 0
    power_hits = power_total = 0
    points_hits = points_total = 0
    mismatches: list[str] = []

    for fixture_path in _load_fixtures():
        with fixture_path.open(encoding="utf-8") as fh:
            expected = json.load(fh)
        image_path = FIXTURES_DIR / expected["source_file"]
        if not image_path.exists():
            continue

        image = preprocess_image(str(image_path))
        result = _parser.parse(image, event_code=_EVENT_CODE)
        got_members: list[MemberResult] = result.members
        want_members = expected["members"]

        for i, want in enumerate(want_members):
            if i >= len(got_members):
                mismatches.append(f"{fixture_path.stem} row {i}: missing (want {want['name']!r})")
                continue
            got = got_members[i]

            if want["name"] not in _NON_LATIN_NAMES:
                name_total += 1
                sim = _similar(got.name, want["name"])
                ok = sim >= 0.66
                name_hits += ok
                if not ok:
                    mismatches.append(
                        f"{fixture_path.stem} row {i}: name {got.name!r} vs {want['name']!r} "
                        f"(sim={sim:.2f})"
                    )

            rank_total += 1
            rank_hits += got.rank == want["rank"]

            power_total += 1
            power_hits += got.power == want["power"]

            points_total += 1
            points_hits += got.points == want["points"]

    def _rate(hits: int, total: int) -> float:
        return hits / total if total else 0.0

    name_rate = _rate(name_hits, name_total)
    rank_rate = _rate(rank_hits, rank_total)
    power_rate = _rate(power_hits, power_total)
    points_rate = _rate(points_hits, points_total)

    report = (
        f"name(Latin) {name_hits}/{name_total}={name_rate:.1%}, "
        f"rank {rank_hits}/{rank_total}={rank_rate:.1%}, "
        f"power {power_hits}/{power_total}={power_rate:.1%}, "
        f"points {points_hits}/{points_total}={points_rate:.1%}\n" + "\n".join(mismatches)
    )

    # Floors are regression guards at today's measured accuracy (with margin
    # for Tesseract version drift across environments), not the aspirational
    # phone-parity targets documented in the module docstring — see there for
    # the one field still short of its target (rank, one illegible badge).
    assert name_rate >= 0.85, report
    assert points_rate >= 0.95, report
    assert power_rate >= 0.95, report
    assert rank_rate >= 0.90, report


@pytest.mark.parametrize("fixture_path", _load_fixtures(), ids=lambda p: p.stem)
def test_dispatcher_routes_emulator_captures_to_this_parser(fixture_path: Path) -> None:
    """End-to-end guard on the step production reaches before the parser.

    dispatcher._ocr_header reads image[:HEADER_HEIGHT] with HEADER_HEIGHT=200,
    a constant tuned on 1080x2400 phone captures — and this profile's UI chrome
    has different proportions, not just less screen. Nothing else in this file
    exercises it: every other test calls _parser.parse() directly, so a header
    band that stopped covering the emulator event title would leave the whole
    feature dead in production (every upload rejected as unknown_event) with a
    fully green suite.
    """
    with fixture_path.open(encoding="utf-8") as fh:
        expected = json.load(fh)
    image = preprocess_image(str(FIXTURES_DIR / expected["source_file"]))

    assert detect_screen_kind(image) == ("event", _EVENT_CODE)


@pytest.mark.parametrize("fixture_path", _load_fixtures(), ids=lambda p: p.stem)
def test_header_heuristic_agrees_with_the_production_branch(fixture_path: Path) -> None:
    """parse() without an event code must not silently diverge from production.

    The no-code path takes _parse_header's heuristic branch, which has extra
    plausibility gates and — when they fail — refuses the phone-only 2-column
    bands rather than applying them to this profile. Dev tools and ad-hoc
    debugging still use that path, so it is worth pinning that it reads the
    same header as the code-supplied branch on every fixture.
    """
    with fixture_path.open(encoding="utf-8") as fh:
        expected = json.load(fh)
    image = preprocess_image(str(FIXTURES_DIR / expected["source_file"]))

    heuristic = _parser.parse(image)
    production = _parser.parse(image, event_code=_EVENT_CODE)

    assert (
        heuristic.total_battlers,
        heuristic.alliance_rank,
        heuristic.total_points,
    ) == (
        production.total_battlers,
        production.alliance_rank,
        production.total_points,
    )
