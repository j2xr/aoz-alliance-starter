"""Tests for the extract.py LLM-fallback orchestration layer.

These cover the wiring that llm_fallback.py's own tests do not exercise: which
rows are sent to the LLM, how corrections are merged back, and the consecutive-
failure circuit breaker that stops calling a wedged Ollama mid-image.
"""

import logging
import unicodedata
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest

import app.extract as extract
from app.extract import (
    _apply_llm_fallback,
    _apply_llm_fallback_player_stats,
    _physical_row,
    _rewrite_name,
    looks_like_misread,
)
from app.parsers.base import (
    DonationMember,
    DonationParseResult,
    MemberResult,
    ParseResult,
    PlayerStatsMember,
    PlayerStatsParseResult,
)


class _StubParser:
    """Minimal stand-in exposing the row_height / member_list_top attributes."""

    row_height = 175
    member_list_top = 400


def _member(name: str, conf: float, row_y: int = 0) -> MemberResult:
    return MemberResult(
        name=name, rank="R1", power=1000, points=None, confidence=conf, row_y=row_y, row_h=175
    )


def _event_result(members: list[MemberResult]) -> ParseResult:
    return ParseResult(event_type="polar_invasion", members=members)


_IMG = np.zeros((2400, 1080), dtype=np.uint8)


# ── _apply_llm_fallback: row selection & merge ─────────────────────────────────


def test_low_confidence_row_is_corrected() -> None:
    result = _event_result([_member("Mjolnir", 0.20)])
    with patch("app.llm_fallback.llm_fallback", return_value="Mjölnir") as mock_llm:
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    mock_llm.assert_called_once()
    assert out.members[0].name == "Mjölnir"
    assert out.members[0].confidence == -1.0  # flagged as LLM-corrected


def test_high_confidence_row_is_skipped() -> None:
    """A confident, clean-looking row never reaches the LLM and is preserved."""
    result = _event_result([_member("Confident", 0.99)])
    with patch("app.llm_fallback.llm_fallback") as mock_llm:
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    mock_llm.assert_not_called()
    assert out.members[0].name == "Confident"
    assert out.members[0].confidence == 0.99


def test_high_confidence_garbage_name_is_corrected() -> None:
    """The P3 case the old confidence gate missed: a confident-but-garbage read
    (conf 0.99, but the output is frame debris) now reaches the LLM via
    looks_like_misread — orthogonal to the (useless-here) confidence score."""
    result = _event_result([_member("A > №", 0.99)])
    with patch("app.llm_fallback.llm_fallback", return_value="Bulleit") as mock_llm:
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    mock_llm.assert_called_once()
    assert out.members[0].name == "Bulleit"


# ── looks_like_misread ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name,expected",
    [
        # Garbage misreads (frame debris / low alnum ratio / out-of-script / near
        # empty) → worth an LLM look. These are the confident-garbage reads the
        # confidence gate structurally missed.
        ("¢ JE", True),  # علE
        ("A > №", True),  # Bulleit
        ("ĐÄRK§|ĐE s 3Š", True),  # ÐÃŘĶ§ĮĐĒ•築
        ("| (LOL)", True),  # Ṣímbα
        ('= "mm ..', True),  # LATAM.REYCOLIMAN
        ("Км&.", True),  # King.gerald
        ("x", True),  # near-empty read
        # Correct or legitimately decorated handles → must NOT waste a call.
        ("Аня", False),
        ("MHGYM7000", False),
        ("幸恵丸ポーター", False),  # CJK + kana
        ("TôiyêuViệtNam", False),  # Vietnamese
        ("焼鳥_Yakitori", False),  # CJK + underscore + Latin
        ("~Loki~", False),  # tilde decoration is legitimate
        ("BigSteelCurtain", False),
        ("Mjolnir", False),  # clean-but-wrong reads look valid → not flagged
    ],
)
def test_looks_like_misread(name: str, expected: bool) -> None:
    assert looks_like_misread(name) is expected


def test_force_all_corrects_even_confident_rows() -> None:
    result = _event_result([_member("Confident", 0.99)])
    with patch("app.llm_fallback.llm_fallback", return_value="Corrected") as mock_llm:
        out = _apply_llm_fallback(_IMG, result, _StubParser(), force_all=True)

    mock_llm.assert_called_once()
    assert out.members[0].name == "Corrected"


def test_empty_llm_name_keeps_ocr_name() -> None:
    """When the LLM returns nothing usable, the OCR name is kept (not blanked)."""
    result = _event_result([_member("OcrName", 0.20)])
    with patch("app.llm_fallback.llm_fallback", return_value=None):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    assert out.members[0].name == "OcrName"


def test_donation_member_shape_only_name_rewritten() -> None:
    donor = DonationMember(
        name="DarKKnight", alliance_tag="SOD", rank="R2", alliance_honor=4200, confidence=0.2
    )
    result = DonationParseResult(period_type="weekly", members=[donor])
    # Donations go through llm_fallback_donation with a self-consistency gate:
    # the corrected name is accepted only when the returned score matches the
    # OCR'd honor (4200 here), proving the model read this row.
    with patch("app.llm_fallback.llm_fallback_donation", return_value=("DarkKnight", 4200)):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    m = out.members[0]
    assert isinstance(m, DonationMember)
    assert m.name == "DarkKnight"
    # Every non-name field survives the rewrite untouched.
    assert m.alliance_tag == "SOD"
    assert m.rank == "R2"
    assert m.alliance_honor == 4200


def test_donation_correction_rejected_when_score_mismatches_honor() -> None:
    """The overlay/hallucination guard: a corrected name whose LLM-read score
    does not match the OCR honor is rejected, keeping the OCR name. Only applies
    when the honor was never flagged suspect — see
    test_suspect_honor_replaced_by_llm_score_inside_window_real_production_cases
    for the suspect-honor case, where exact equality is no longer the standard."""
    donor = DonationMember(
        name="고", alliance_tag=None, rank="R1", alliance_honor=1946, confidence=0.2
    )
    assert donor.suspect_honor_window is None  # precondition for this exact-match gate
    result = DonationParseResult(period_type="weekly", members=[donor])
    # Model read a name off an overlaid toast and a score (52) that is not the
    # row's honor (1946) — reject the correction.
    with patch("app.llm_fallback.llm_fallback_donation", return_value=("CEKATOP_1000", 52)):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    m = out.members[0]
    assert m.name == "고"  # OCR result kept, hallucinated name not applied
    assert m.alliance_honor == 1946
    # Rejection itself is now traceable: confidence forced to 0.0 (distinct
    # from the -1.0 "LLM-corrected" sentinel) so the bot flags needs_review.
    assert m.confidence == 0.0


def test_donation_correction_rejected_when_score_missing() -> None:
    """No score to cross-check against → distrust the correction (conservative)."""
    donor = DonationMember(
        name="garbled", alliance_tag=None, rank="R1", alliance_honor=800, confidence=0.2
    )
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch("app.llm_fallback.llm_fallback_donation", return_value=("Plausible", None)):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    assert out.members[0].name == "garbled"
    assert out.members[0].confidence == 0.0


def test_donation_correction_strips_alliance_tag_from_llm_output() -> None:
    """A validated correction still runs through tag-stripping (the LLM returns
    the name verbatim, tag included)."""
    donor = DonationMember(
        name="rs", alliance_tag=None, rank="R1", alliance_honor=2235, confidence=0.2
    )
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch("app.llm_fallback.llm_fallback_donation", return_value=("(SOD) BenOVerbich", 2235)):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    m = out.members[0]
    assert m.name == "BenOVerbich"
    assert m.alliance_tag == "SOD"


def test_donation_none_name_keeps_ocr_result() -> None:
    """Model abstains (name=null) → keep the OCR member unchanged."""
    donor = DonationMember(
        name="Keeper", alliance_tag="SOD", rank="R1", alliance_honor=500, confidence=0.2
    )
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch("app.llm_fallback.llm_fallback_donation", return_value=(None, None)):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    assert out.members[0].name == "Keeper"


# ── _apply_llm_fallback: suspect_honor_window (P1 — the circular gate) ─────────
#
# When suspect_honor_window is set, _enforce_honor_monotonicity has already
# proven the OCR'd alliance_honor suspect (its own re-OCR either fixed it or
# gave up). Demanding the LLM's score exactly match that already-suspect value
# — the pre-fix behaviour, still exercised above for the window-is-None case —
# can therefore never help. These tests hold the LLM to the SAME [lower,upper]
# window the monotonicity re-OCR used instead.


def _suspect_donor(
    *,
    alliance_honor: int,
    window: tuple[int, int],
    confidence: float = 0.0,
    row_index: int | None = None,
) -> DonationMember:
    return DonationMember(
        name="OcrName",
        alliance_tag="SOD",
        rank="R1",
        alliance_honor=alliance_honor,
        confidence=confidence,
        suspect_honor_window=window,
        row_index=row_index,
    )


@pytest.mark.parametrize(
    ("stored_honor", "window", "llm_score"),
    [
        # The four real production rows from the 2026-07-26 SOD audit: the LLM
        # read the correct score on the very first pass, every time, and the
        # old exact-equality gate rejected every one of them.
        (92256, (0, 2458), 2385),  # Somethin_kool
        (9044, (0, 3102), 2944),  # StoKaizer
        (970, (0, 275), 270),  # ran (SOD)
        (955, (0, 255), 255),  # Somethin_kool (SOD)
    ],
)
def test_suspect_honor_replaced_by_llm_score_inside_window_real_production_cases(
    stored_honor: int, window: tuple[int, int], llm_score: int
) -> None:
    donor = _suspect_donor(alliance_honor=stored_honor, window=window)
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch("app.llm_fallback.llm_fallback_donation", return_value=("OcrName", llm_score)):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    m = out.members[0]
    assert isinstance(m, DonationMember)
    assert m.alliance_honor == llm_score
    assert m.suspect_honor_window is None  # resolved: no longer suspect
    assert m.confidence == extract._LLM_HONOR_REPLACED_CONFIDENCE


def test_suspect_honor_rejected_when_llm_score_outside_window() -> None:
    """A score outside the monotonicity window is no more trustworthy than the
    OCR value it would replace — reject, keep BOTH the OCR name and honor,
    and stay flagged (the window is not cleared: still suspect, just
    unresolved by this attempt)."""
    donor = _suspect_donor(alliance_honor=9044, window=(0, 3102))
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch("app.llm_fallback.llm_fallback_donation", return_value=("SomeoneElse", 5000)):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    m = out.members[0]
    assert m.alliance_honor == 9044
    assert m.name == "OcrName"
    assert m.confidence == 0.0
    assert m.suspect_honor_window == (0, 3102)


def test_suspect_honor_rejected_when_llm_score_missing() -> None:
    donor = _suspect_donor(alliance_honor=9044, window=(0, 3102))
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch("app.llm_fallback.llm_fallback_donation", return_value=("SomeName", None)):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    m = out.members[0]
    assert m.alliance_honor == 9044
    assert m.confidence == 0.0
    assert m.suspect_honor_window == (0, 3102)


def test_suspect_honor_replaced_even_when_llm_returns_no_name() -> None:
    """The short-circuit that made this gate circular discarded a usable score
    whenever the returned name was empty — the exact defect this PR fixes. A
    usable, in-window score must be applied regardless of whether a name came
    back with it."""
    donor = _suspect_donor(alliance_honor=9044, window=(0, 3102))
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch("app.llm_fallback.llm_fallback_donation", return_value=(None, 2944)):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    m = out.members[0]
    assert m.alliance_honor == 2944
    assert m.name == "OcrName"  # no name to apply — name unchanged, honor still fixed
    assert m.confidence == extract._LLM_HONOR_REPLACED_CONFIDENCE
    assert m.suspect_honor_window is None


def test_suspect_honor_row_reaches_llm_even_at_high_name_confidence() -> None:
    """A suspect honor must reach the LLM regardless of the name signals: at
    confidence 0.99 with a clean-looking name, neither the confidence floor nor
    looks_like_misread would fire, so only the explicit honor_suspect override
    gets this row to the LLM — the secondary P1 bug this pins."""
    donor = _suspect_donor(alliance_honor=9044, window=(0, 3102), confidence=0.99)
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch(
        "app.llm_fallback.llm_fallback_donation", return_value=("OcrName", 2944)
    ) as mock_llm:
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    mock_llm.assert_called_once()
    assert out.members[0].alliance_honor == 2944


def test_confident_non_suspect_donation_row_is_skipped() -> None:
    """A donation row with neither a low name confidence nor a suspect honor
    never reaches the LLM at all — the honor_suspect override must not widen
    the gate beyond suspect rows."""
    donor = DonationMember(
        name="Confident", alliance_tag="SOD", rank="R1", alliance_honor=500, confidence=0.99
    )
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch("app.llm_fallback.llm_fallback_donation") as mock_llm:
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    mock_llm.assert_not_called()
    assert out.members[0].name == "Confident"


def test_rewrite_name_preserves_suspect_honor_window() -> None:
    """The manually-copies-every-field hazard: without an explicit pass-through,
    a DonationMember field _rewrite_name doesn't know about is silently
    dropped on every LLM-corrected row, not just suspect-honor ones."""
    donor = DonationMember(
        name="Old",
        alliance_tag=None,
        rank="R1",
        alliance_honor=100,
        confidence=0.2,
        suspect_honor_window=(50, 150),
    )
    rewritten = _rewrite_name(donor, "New")
    assert isinstance(rewritten, DonationMember)
    assert rewritten.suspect_honor_window == (50, 150)


def test_llm_honor_replaced_confidence_trips_needs_review() -> None:
    """Mirrors test_monotonicity_fix_confidence_trips_needs_review in
    test_contribution_ranking_parser.py: _LLM_HONOR_REPLACED_CONFIDENCE must
    also land inside needsReview()'s exclusive [0, 0.5) bound
    (apps/discord-bot/src/lib/upsert.ts)."""
    assert 0.0 <= extract._LLM_HONOR_REPLACED_CONFIDENCE < 0.5


def test_logs_warning_when_still_non_monotone_after_llm_replacement(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Observability only, not a fix: two adjacent suspect rows can each satisfy
    a window computed against the OTHER's pre-replacement value. Row 0's window
    was computed while row 1 still held its own (also-suspect) original value,
    so row 0's replacement can end up lower than row 1's — non-monotone again."""
    row0 = _suspect_donor(alliance_honor=1000, window=(500, 2000))
    row1 = _suspect_donor(alliance_honor=1500, window=(0, 1000))
    result = DonationParseResult(period_type="weekly", members=[row0, row1])
    with patch(
        "app.llm_fallback.llm_fallback_donation",
        side_effect=[("OcrName", 600), ("OcrName", 900)],
    ):
        with caplog.at_level(logging.WARNING):
            out = _apply_llm_fallback(_IMG, result, _StubParser())

    assert out.members[0].alliance_honor == 600
    assert out.members[1].alliance_honor == 900
    assert out.members[1].alliance_honor > out.members[0].alliance_honor  # still broken
    assert any("still breaks monotonicity after LLM fallback" in r.message for r in caplog.records)


# ── _physical_row: log messages report the true on-screen slot ─────────────────
#
# `i` (the member's index in `members`) drifts away from the row a human sees
# in the screenshot as soon as an earlier row is dropped for being unreadable
# or failing validation — the same class of bug _repair_position_sequence
# already guards against for leaderboard_position (see its docstring).
# _physical_row prefers DonationMember.row_index (the true physical slot,
# assigned by the parser before any row is dropped) and only falls back to
# the list index `i` when that isn't available (MemberResult/event rows,
# which have no row_index concept at all).


def test_physical_row_prefers_row_index_when_present() -> None:
    donor = _suspect_donor(alliance_honor=100, window=(0, 200), row_index=7)
    assert _physical_row(donor, i=2) == 7


def test_physical_row_falls_back_to_list_index_when_row_index_is_none() -> None:
    donor = _suspect_donor(alliance_honor=100, window=(0, 200), row_index=None)
    assert _physical_row(donor, i=2) == 2


def test_physical_row_uses_list_index_for_an_event_member() -> None:
    """MemberResult (event rows) has no row_index field at all — untouched
    by this change, exactly as before."""
    member = _member("Alpha", conf=0.9)
    assert _physical_row(member, i=3) == 3


def test_llm_triggered_log_reports_the_physical_row(caplog: pytest.LogCaptureFixture) -> None:
    """A suspect row dropped from an earlier position (row_index=5, but it's
    the first/only element of `members` here, list index 0) must log its
    true on-screen slot, not 0."""
    donor = _suspect_donor(alliance_honor=9044, window=(0, 3102), row_index=5)
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch("app.llm_fallback.llm_fallback_donation", return_value=("OcrName", 2944)):
        with caplog.at_level(logging.INFO):
            _apply_llm_fallback(_IMG, result, _StubParser())

    assert any(
        "LLM fallback triggered" in r.message and "row 5" in r.message for r in caplog.records
    )
    assert not any("row 0)" in r.message for r in caplog.records)


def test_llm_rejection_log_reports_the_physical_row(caplog: pytest.LogCaptureFixture) -> None:
    donor = _suspect_donor(alliance_honor=9044, window=(0, 3102), row_index=5)
    result = DonationParseResult(period_type="weekly", members=[donor])
    with patch("app.llm_fallback.llm_fallback_donation", return_value=("SomeoneElse", 5000)):
        with caplog.at_level(logging.WARNING):
            _apply_llm_fallback(_IMG, result, _StubParser())

    assert any("suspect-honor row 5" in r.message for r in caplog.records)


def test_post_llm_monotonicity_warning_reports_the_physical_row(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Same scenario as test_logs_warning_when_still_non_monotone_after_llm_
    replacement above, but with row_index values that differ from the list
    indices (row 2 was dropped upstream) — the physical slot must appear in
    the log, not the post-drop list position."""
    row0 = _suspect_donor(alliance_honor=1000, window=(500, 2000), row_index=0)
    row1 = _suspect_donor(alliance_honor=1500, window=(0, 1000), row_index=3)
    result = DonationParseResult(period_type="weekly", members=[row0, row1])
    with patch(
        "app.llm_fallback.llm_fallback_donation",
        side_effect=[("OcrName", 600), ("OcrName", 900)],
    ):
        with caplog.at_level(logging.WARNING):
            _apply_llm_fallback(_IMG, result, _StubParser())

    assert any("donation row 3:" in r.message for r in caplog.records)
    assert not any("donation row 1:" in r.message for r in caplog.records)


# ── _apply_llm_fallback: circuit breaker ───────────────────────────────────────


def test_circuit_breaker_disables_after_consecutive_failures() -> None:
    """After _LLM_MAX_CONSECUTIVE_FAILURES failures, remaining rows skip the LLM."""
    members = [_member(f"row{i}", 0.10, row_y=i * 175) for i in range(5)]
    result = _event_result(members)

    with patch.object(extract, "_LLM_MAX_CONSECUTIVE_FAILURES", 2):
        with patch("app.llm_fallback.llm_fallback", side_effect=RuntimeError("timeout")) as mock:
            out = _apply_llm_fallback(_IMG, result, _StubParser())

    # Two calls trip the breaker; rows 2-4 are never attempted.
    assert mock.call_count == 2
    # All names are preserved (every call failed, none corrected).
    assert [m.name for m in out.members] == ["row0", "row1", "row2", "row3", "row4"]


def test_success_resets_consecutive_failure_counter() -> None:
    """A success between failures resets the counter so the breaker never trips."""
    members = [_member(f"row{i}", 0.10, row_y=i * 175) for i in range(4)]
    result = _event_result(members)

    # fail, succeed, fail, succeed -> counter never reaches 2, all four attempted.
    with patch.object(extract, "_LLM_MAX_CONSECUTIVE_FAILURES", 2):
        with patch(
            "app.llm_fallback.llm_fallback",
            side_effect=[RuntimeError("x"), "ok1", RuntimeError("y"), "ok2"],
        ) as mock:
            out = _apply_llm_fallback(_IMG, result, _StubParser())

    assert mock.call_count == 4
    assert out.members[1].name == "ok1"
    assert out.members[3].name == "ok2"


# ── _apply_llm_fallback_player_stats ───────────────────────────────────────────


def _pmember(name: str, conf: float, **stats: Any) -> PlayerStatsMember:
    return PlayerStatsMember(name=name, confidence=conf, **stats)


def test_player_stats_no_candidates_below_threshold_skips_call() -> None:
    result = PlayerStatsParseResult(members=[_pmember("Full", 1.0, attack_pct=400)])
    with patch("app.llm_fallback.llm_fallback_player_stats") as mock_llm:
        out = _apply_llm_fallback_player_stats(_IMG, result)

    mock_llm.assert_not_called()
    assert out.members[0].attack_pct == 400


def test_player_stats_merges_llm_stats_by_name() -> None:
    result = PlayerStatsParseResult(
        members=[_pmember("Alice", 0.33, attack_pct=400, hp_pct=None, defense_pct=None)]
    )
    llm = [{"name": "Alice", "attack_pct": 412, "hp_pct": 1183, "defense_pct": 900}]
    with patch("app.llm_fallback.llm_fallback_player_stats", return_value=llm):
        out = _apply_llm_fallback_player_stats(_IMG, result)

    m = out.members[0]
    assert m.attack_pct == 412
    assert m.hp_pct == 1183  # filled in from the LLM
    assert m.defense_pct == 900
    assert m.confidence == -1.0


def test_player_stats_llm_failure_preserves_ocr() -> None:
    result = PlayerStatsParseResult(members=[_pmember("Alice", 0.33, attack_pct=400)])
    with patch("app.llm_fallback.llm_fallback_player_stats", side_effect=RuntimeError("down")):
        out = _apply_llm_fallback_player_stats(_IMG, result)

    assert out.members[0].attack_pct == 400
    assert out.members[0].confidence == 0.33


def test_player_stats_merges_when_llm_name_is_different_unicode_form() -> None:
    """The OCR name is normalize_name'd (NFC) by the parser; the LLM may return
    the same name in a different Unicode form (e.g. NFD). The merge key must
    normalize both sides, or a real match is missed."""
    nfc_name = "Mjölnir"
    nfd_name = unicodedata.normalize("NFD", nfc_name)
    assert nfd_name != nfc_name  # sanity: genuinely different code points

    result = PlayerStatsParseResult(
        members=[_pmember(nfc_name, 0.33, attack_pct=400, hp_pct=None, defense_pct=None)]
    )
    llm = [{"name": nfd_name, "attack_pct": 412, "hp_pct": 1183, "defense_pct": 900}]
    with patch("app.llm_fallback.llm_fallback_player_stats", return_value=llm):
        out = _apply_llm_fallback_player_stats(_IMG, result)

    m = out.members[0]
    assert m.attack_pct == 412
    assert m.hp_pct == 1183
    assert m.defense_pct == 900


def test_player_stats_unmatched_name_kept_as_is() -> None:
    """OCR-name that the LLM did not return is preserved (merge is exact-name)."""
    result = PlayerStatsParseResult(members=[_pmember("Alice", 0.33, attack_pct=400)])
    llm = [{"name": "SomeoneElse", "attack_pct": 999}]
    with patch("app.llm_fallback.llm_fallback_player_stats", return_value=llm):
        out = _apply_llm_fallback_player_stats(_IMG, result)

    assert out.members[0].attack_pct == 400
    assert out.members[0].confidence == 0.33
