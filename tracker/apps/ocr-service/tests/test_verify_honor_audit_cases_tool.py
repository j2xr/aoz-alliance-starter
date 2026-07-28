"""Unit tests for tools/verify_honor_audit_cases.py.

Pure functions only — no image, no disk I/O, no LLM call. Builds
DonationMember by hand rather than depending on a real screenshot; behavior
on real images is what the tool itself is meant to verify manually (see
docs/maintenance/2026-07-27-row11-honor-verification.md), not something
pytest can reliably re-evaluate ("full" mode calls a real Ollama, which is
non-deterministic by nature).
"""

from dataclasses import replace
from pathlib import Path

from app.parsers.base import DonationMember
from tools.verify_honor_audit_cases import (
    AuditCase,
    RowHit,
    classify,
    format_report,
    match_case,
    summarize,
    summary_key,
)


def _member(**overrides: object) -> DonationMember:
    defaults: dict[str, object] = {
        "name": "Somethin_kool",
        "alliance_tag": "SOD",
        "rank": "R1",
        "alliance_honor": 92256,
        "confidence": 0.0,
    }
    defaults.update(overrides)
    return DonationMember(**defaults)  # type: ignore[arg-type]


# The two real "Somethin_kool" cases: (92256/2385, a genuine monotonicity
# break, Test Alliance) and (955/255, a name-confidence rejection unrelated
# to monotonicity, SOD) — same label, two different players. The honor
# marker discriminates them in the common case (see
# test_match_case_discriminates_different_named_cases_by_honor for an
# example with different names) but NOT when both share the same name —
# see test_match_case_same_named_cases_can_still_cross_match, an accepted
# limitation, not a bug.
CASE_TEST_ALLIANCE = AuditCase(
    "Somethin_kool", 92256, 2385, "data-quality-report.md#1", message_id="msg-1"
)
CASE_SOD = AuditCase("Somethin_kool", 955, 255, "sod-data-quality-report.md#3")


# ── match_case ───────────────────────────────────────────────────────────────


def test_match_case_finds_row_by_stored_honor() -> None:
    members = [_member(alliance_honor=92256)]
    assert match_case(members, CASE_TEST_ALLIANCE) == members


def test_match_case_finds_row_by_true_honor() -> None:
    """A row that already reads the corrected value (e.g. an adjacent,
    non-failing capture of the same batch) must still be found."""
    members = [_member(alliance_honor=2385)]
    assert match_case(members, CASE_TEST_ALLIANCE) == members


def test_match_case_finds_row_by_garbled_name() -> None:
    """The real production log names are OCR-garbled ("Somethin kool", "ran")
    — a name-only match at the 0.70 threshold must still catch them even when
    neither honor value happens to be present verbatim."""
    members = [_member(name="Somethin kool", alliance_honor=999999)]
    assert match_case(members, CASE_TEST_ALLIANCE) == members


def test_match_case_returns_every_hit_not_just_the_best() -> None:
    """The same player legitimately appears across several overlapping
    captures (see weekly_010 vs. its row-11 sibling in the same message) —
    reporting every occurrence, not deduping to one, is the point."""
    a = _member(alliance_honor=92256)
    b = _member(alliance_honor=2385)
    assert match_case([a, b], CASE_TEST_ALLIANCE) == [a, b]


def test_match_case_ignores_unrelated_rows() -> None:
    members = [_member(name="CompletelyUnrelated", alliance_honor=1)]
    assert match_case(members, CASE_TEST_ALLIANCE) == []


def test_match_case_discriminates_different_named_cases_by_honor() -> None:
    """A row that matches neither this case's stored/true honor nor its name
    must never be reported — the common, well-behaved case."""
    stokaizer_case = AuditCase("StoKaizer", 9044, 2944, "data-quality-report.md#1")
    unrelated_row = _member(name="StoKaizer", alliance_honor=9044)

    assert match_case([unrelated_row], CASE_SOD) == []
    # Sanity: it does match its own case.
    assert match_case([unrelated_row], stokaizer_case) == [unrelated_row]


def test_match_case_same_named_cases_can_still_cross_match() -> None:
    """Documented limitation, not a silent bug: both real "Somethin_kool"
    cases (one per alliance) share the exact label, and CASE_SOD's
    message_id is unknown (the audit never recorded it) so it can't be
    scoped away by context either. A row belonging to one case is still
    reported as a hit for the other via the name fallback — but classify()
    resolves it to 'other' (neither this case's stored nor true honor),
    which is visible noise in the report, never a false PASS/FAIL."""
    test_alliance_row = _member(alliance_honor=92256)

    hits = match_case([test_alliance_row], CASE_SOD)

    assert hits == [test_alliance_row]
    assert classify(test_alliance_row.alliance_honor, CASE_SOD) == "other"


# ── classify ─────────────────────────────────────────────────────────────────


def test_classify_pass_when_honor_is_the_true_value() -> None:
    assert classify(2385, CASE_TEST_ALLIANCE) == "pass"


def test_classify_fail_when_honor_is_the_stored_wrong_value() -> None:
    assert classify(92256, CASE_TEST_ALLIANCE) == "fail"


def test_classify_other_for_a_third_value() -> None:
    """Never guess: a value that's neither the known-wrong nor the
    known-true reading is reported as its own category."""
    assert classify(4242, CASE_TEST_ALLIANCE) == "other"


# ── summarize ────────────────────────────────────────────────────────────────


def _hit(
    case: AuditCase, *, verdict_parser: str, verdict_full: str | None, reached_llm: bool
) -> RowHit:
    return RowHit(
        case=case,
        image=Path("dummy.jpg"),
        row_index=11,
        name=case.label,
        parser_honor=case.stored_honor if verdict_parser == "fail" else case.true_honor,
        verdict_parser=verdict_parser,
        suspect_window=(0, case.stored_honor),
        reached_llm=reached_llm,
        final_honor=case.true_honor if verdict_full == "pass" else case.stored_honor,
        final_confidence=0.4,
        verdict_full=verdict_full,
        period_type="weekly",
    )


def test_summarize_counts_pass_fail_per_case() -> None:
    hits = [
        _hit(CASE_TEST_ALLIANCE, verdict_parser="fail", verdict_full="pass", reached_llm=True),
        _hit(CASE_SOD, verdict_parser="fail", verdict_full="fail", reached_llm=False),
    ]
    summary = summarize(hits, cases=[CASE_TEST_ALLIANCE, CASE_SOD])

    ta_key = summary_key(CASE_TEST_ALLIANCE)
    sod_key = summary_key(CASE_SOD)

    assert summary[ta_key] == {
        "hits": 1,
        "parser_pass": 0,
        "parser_fail": 1,
        "full_pass": 1,
        "full_fail": 0,
        "reached_llm": 1,
    }
    assert summary[sod_key] == {
        "hits": 1,
        "parser_pass": 0,
        "parser_fail": 1,
        "full_pass": 0,
        "full_fail": 1,
        "reached_llm": 0,
    }


def test_summarize_reports_zero_hits_for_a_case_nothing_matched() -> None:
    summary = summarize([], cases=[CASE_TEST_ALLIANCE])
    key = summary_key(CASE_TEST_ALLIANCE)
    assert summary[key]["hits"] == 0


def test_summarize_does_not_itself_filter_unconfirmed_cases() -> None:
    """Filtering confirmed=False cases out of the summary is the caller's
    job (see main()'s --include-unconfirmed) — summarize() must stay a pure
    function of whatever `cases` it's given, not hardcode the exclusion."""
    unconfirmed = AuditCase("nuna", 51325, 5135, "lol-data-quality-report.md#4", confirmed=False)
    summary = summarize([], cases=[unconfirmed])
    assert len(summary) == 1


# ── format_report ────────────────────────────────────────────────────────────


def test_format_report_flags_a_hit_whose_name_does_not_match_the_case() -> None:
    """Real example from the first corpus run: an honor-only match (955) hit
    an entirely unrelated player ("KOR.morningstar") — the report must flag
    this visibly rather than let it look like confirmation of a real bug."""
    hit = replace(
        _hit(CASE_SOD, verdict_parser="fail", verdict_full="fail", reached_llm=False),
        name="KOR.morningstar",
    )

    report = format_report(
        [hit], all_cases=[CASE_SOD], summary_cases=[CASE_SOD], root=Path("."), mode="full"
    )

    assert "name='KOR.morningstar'" in report
    assert "likely unrelated" in report


def test_format_report_does_not_flag_a_hit_whose_name_matches_the_case() -> None:
    hit = replace(
        _hit(CASE_SOD, verdict_parser="fail", verdict_full="pass", reached_llm=True),
        name="Somethin_kool",
    )

    report = format_report(
        [hit], all_cases=[CASE_SOD], summary_cases=[CASE_SOD], root=Path("."), mode="full"
    )

    assert "likely unrelated" not in report
