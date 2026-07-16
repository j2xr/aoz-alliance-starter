"""Tests for the extract.py LLM-fallback orchestration layer.

These cover the wiring that llm_fallback.py's own tests do not exercise: which
rows are sent to the LLM, how corrections are merged back, and the consecutive-
failure circuit breaker that stops calling a wedged Ollama mid-image.
"""

import unicodedata
from typing import Any
from unittest.mock import patch

import numpy as np

import app.extract as extract
from app.extract import _apply_llm_fallback, _apply_llm_fallback_player_stats
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
    """A confident row never reaches the LLM and is preserved verbatim."""
    result = _event_result([_member("Confident", 0.99)])
    with patch("app.llm_fallback.llm_fallback") as mock_llm:
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    mock_llm.assert_not_called()
    assert out.members[0].name == "Confident"
    assert out.members[0].confidence == 0.99


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
    with patch("app.llm_fallback.llm_fallback", return_value="DarkKnight"):
        out = _apply_llm_fallback(_IMG, result, _StubParser())

    m = out.members[0]
    assert isinstance(m, DonationMember)
    assert m.name == "DarkKnight"
    # Every non-name field survives the rewrite untouched.
    assert m.alliance_tag == "SOD"
    assert m.rank == "R2"
    assert m.alliance_honor == 4200


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
