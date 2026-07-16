"""Tests for the player_stats_chat_v1 parser.

Tests are split into:
1. Unit tests for helper functions (_parse_float, _parse_stat_line, _is_noise_line)
2. State-machine integration tests (_run_state_machine with mocked Tesseract)
3. Full parser test (PlayerStatsChatV1Parser.parse with mocked pytesseract)
"""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pytest

from app.parsers.base import PlayerStatsParseResult
from app.parsers.player_stats_chat_v1 import (
    PlayerStatsChatV1Parser,
    _is_noise_line,
    _is_player_name,
    _parse_float,
    _parse_stat_line,
    _run_state_machine,
)

_OCR_FN = "app.parsers.player_stats_chat_v1.pytesseract.image_to_string"

# ── _parse_float ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("412", 412.0),
        ("1183.4", 1183.4),
        ("498 5", 498.5),  # OCR space-for-decimal-dot
        ("408.5", 408.5),
        ("363", 363.0),
        ("1049,3", 1049.3),  # comma decimal separator
        ("327.6", 327.6),
        ("abc", None),
        ("", None),
    ],
)
def test_parse_float(raw: str, expected: float | None) -> None:
    result = _parse_float(raw)
    if expected is None:
        assert result is None
    else:
        assert result == pytest.approx(expected, rel=1e-4)


# ── _parse_stat_line ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "line,position,expected_slot,expected_val,expected_kind",
    [
        # --- Attack variants ---
        ("LRA-412", 0, "attack", 412.0, "lra"),
        ("lra 409", 0, "attack", 409.0, "lra"),
        ("Lra 339", 0, "attack", 339.0, "lra"),
        ("mra 938", 0, "attack", 938.0, "mra"),
        ("MRA 938", 0, "attack", 938.0, "mra"),
        ("1) LRA - 1183.4", 0, "attack", 1183.4, "lra"),
        ("1) LRA - 498 5%", 0, "attack", 498.5, "lra"),
        ("LRA : 502.9%", 0, "attack", 502.9, "lra"),
        ("Wrath 774", 0, "attack", 774.0, "lra"),
        ("Ira 474", 0, "attack", 474.0, "lra"),  # OCR l→i
        ("1. LRA 596.9", 0, "attack", 596.9, "lra"),
        ("1. LRA 620", 0, "attack", 620.0, "lra"),
        # --- HP variants ---
        ("MHP-319", 1, "hp", 319.0, None),
        ("mhp 293", 1, "hp", 293.0, None),
        ("2) MHP - 1049.3", 1, "hp", 1049.3, None),
        ("MAP 277.7", 1, "hp", 277.7, None),
        ("Pv 551", 1, "hp", 551.0, None),
        ("2)370", 1, "hp", 370.0, None),
        # --- Defense variants ---
        ("MGD-260", 2, "defense", 260.0, None),
        ("3) MHD - 653.5", 2, "defense", 653.5, None),
        ("md 251", 2, "defense", 251.0, None),
        ("MD 379", 2, "defense", 379.0, None),
        ("Defense 339", 2, "defense", 339.0, None),
        ("Mdf 315", 2, "defense", 315.0, None),
        ("3)269", 2, "defense", 269.0, None),
        ("MHD 388", 2, "defense", 388.0, None),
        # --- Plain numbers (positional) ---
        ("363", 0, "attack", 363.0, None),
        ("407", 1, "hp", 407.0, None),
        ("269", 2, "defense", 269.0, None),
        ("408.5", 1, "hp", 408.5, None),
        ("482.5", 0, "attack", 482.5, None),
    ],
)
def test_parse_stat_line(
    line: str,
    position: int,
    expected_slot: str,
    expected_val: float,
    expected_kind: str | None,
) -> None:
    slot, val, kind = _parse_stat_line(line, position)
    assert slot == expected_slot
    assert val == pytest.approx(expected_val, rel=1e-4)
    if expected_kind is not None:
        assert kind == expected_kind


def test_parse_stat_line_returns_none_for_unparseable() -> None:
    slot, val, kind = _parse_stat_line("Hello everyone", 0)
    assert slot is None
    assert val is None


# ── _is_noise_line ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "line,expected",
    [
        ("05-02 13:20", True),
        ("2026-05-02 13:20", True),
        ("13:20", True),
        ("google", True),
        ("auto", True),
        ("Tap to Chat", True),
        ("send", True),
        ("A", True),
        ("AA", True),
        ("", True),
        # Long instruction lines (> 80 chars)
        (
            "Hello everyone JR will be working on a project for me and the alliance",
            True,
        ),
        # Valid lines (NOT noise)
        ("PlayerName", False),
        ("LRA-412", False),
        ("408.5", False),
        ("Метью", False),
        ("ZEROHERO", False),
    ],
)
def test_is_noise_line(line: str, expected: bool) -> None:
    assert _is_noise_line(line) == expected


# ── _is_player_name ───────────────────────────────────────────────────────────


def test_is_player_name_valid_names() -> None:
    assert _is_player_name("RageX_")
    assert _is_player_name("Метью")
    assert _is_player_name("Герман")
    assert _is_player_name("ZEROHERO")
    assert _is_player_name("JasmınTソ")
    assert _is_player_name("FATCAT29")
    assert _is_player_name("King.gerald")
    assert _is_player_name("DuyMặtThẹo")


def test_is_player_name_rejects_stat_lines() -> None:
    assert not _is_player_name("LRA-412")
    assert not _is_player_name("MHP-319")
    assert not _is_player_name("363")


def test_is_player_name_rejects_long_sentences() -> None:
    assert not _is_player_name("Hello everyone JR will be working on this")


def test_is_player_name_rejects_noise() -> None:
    assert not _is_player_name("google")
    assert not _is_player_name("05-02 13:20")


# ── _run_state_machine ────────────────────────────────────────────────────────


def test_state_machine_standard_labeled_block() -> None:
    """Player name followed by 3 labeled stat lines."""
    lines = [
        "PlayerOne",
        "LRA-412",
        "MHP-319",
        "MGD-260",
    ]
    members = _run_state_machine(lines)
    assert len(members) == 1
    m = members[0]
    assert m.name == "PlayerOne"
    assert m.attack_pct == pytest.approx(412.0)
    assert m.attack_kind == "lra"
    assert m.hp_pct == pytest.approx(319.0)
    assert m.defense_pct == pytest.approx(260.0)
    assert m.confidence == pytest.approx(1.0)


def test_state_machine_plain_number_block() -> None:
    """Three plain numbers — positional assignment."""
    lines = ["SomeName", "363", "407", "269"]
    members = _run_state_machine(lines)
    assert len(members) == 1
    m = members[0]
    assert m.attack_pct == pytest.approx(363.0)
    assert m.hp_pct == pytest.approx(407.0)
    assert m.defense_pct == pytest.approx(269.0)
    assert m.confidence == pytest.approx(1.0)


def test_state_machine_mra_label() -> None:
    lines = ["DarKKnight", "mhp 730", "mra 938", "MD 430"]
    members = _run_state_machine(lines)
    assert len(members) == 1
    m = members[0]
    assert m.attack_kind == "mra"
    assert m.attack_pct == pytest.approx(938.0)
    assert m.hp_pct == pytest.approx(730.0)
    assert m.defense_pct == pytest.approx(430.0)


def test_state_machine_interleaved_noise() -> None:
    """Timestamps and translation badges between stat lines."""
    lines = [
        "05-02 13:20",
        "PlayerAlpha",
        "google",
        "1) LRA - 498 5%",
        "A",
        "2)370",
        "3)269",
        "05-02 13:21",
        "PlayerBeta",
        "LRA : 502.9%",
        "MAP 277.7",
        "Mdf 315",
    ]
    members = _run_state_machine(lines)
    assert len(members) == 2
    assert members[0].name == "PlayerAlpha"
    assert members[0].attack_pct == pytest.approx(498.5)
    assert members[0].hp_pct == pytest.approx(370.0)
    assert members[0].defense_pct == pytest.approx(269.0)
    assert members[1].name == "PlayerBeta"
    assert members[1].defense_pct == pytest.approx(315.0)


def test_state_machine_partial_stats() -> None:
    """Player with only 2 stats → confidence = 0.67."""
    lines = ["PartialPlayer", "LRA-412", "MHP-319"]
    members = _run_state_machine(lines)
    assert len(members) == 1
    assert members[0].confidence == pytest.approx(2 / 3, rel=1e-4)
    assert members[0].defense_pct is None


def test_state_machine_mixed_labeled_and_plain() -> None:
    """First stat labeled, rest plain (Ichigo_19 pattern)."""
    lines = ["Ichigo_19", "Lra 571", "362", "461"]
    members = _run_state_machine(lines)
    assert len(members) == 1
    m = members[0]
    assert m.attack_pct == pytest.approx(571.0)
    assert m.hp_pct == pytest.approx(362.0)
    assert m.defense_pct == pytest.approx(461.0)
    assert m.confidence == pytest.approx(1.0)


def test_state_machine_wrath_pv_defense() -> None:
    """King.gerald pattern: Wrath / Pv / Defense labels."""
    lines = ["King.gerald", "Wrath 774", "Pv 551", "Defense 339"]
    members = _run_state_machine(lines)
    assert len(members) == 1
    m = members[0]
    assert m.attack_pct == pytest.approx(774.0)
    assert m.hp_pct == pytest.approx(551.0)
    assert m.defense_pct == pytest.approx(339.0)


def test_state_machine_multiple_players() -> None:
    """Multiple consecutive players from the same screenshot."""
    lines = [
        "Метью",
        "1) Lra 339",
        "Mhp-240",
        "Mgd-233",
        "google",
        "Герман",
        "LRA-412",
        "MHP-319",
        "MGD-260",
        "google",
        "Bumbelbee",
        "1) 407",
        "2) 370",
        "3) 269",
    ]
    members = _run_state_machine(lines)
    assert len(members) == 3
    assert members[0].name == "Метью"
    assert members[0].attack_pct == pytest.approx(339.0)
    assert members[1].name == "Герман"
    assert members[1].attack_pct == pytest.approx(412.0)
    assert members[2].name == "Bumbelbee"
    assert members[2].attack_pct == pytest.approx(407.0)


def test_state_machine_skips_instruction_messages() -> None:
    """Long leader messages don't create spurious player blocks."""
    lines = [
        "RageX_",
        "Hello everyone JR will be working on a project for me and the alliance",
        "The 3 things we need from you are 1 Long range attack percent",
        "Метью",
        "Lra 339",
        "Mhp-240",
        "Mgd-233",
    ]
    members = _run_state_machine(lines)
    # RageX_ has no stats (long message follows), only Метью is recorded
    assert len(members) == 1
    assert members[0].name == "Метью"


def test_state_machine_player_with_no_stats_skipped() -> None:
    """FATCAT29 'im still using VIP buff' → no stats → not in results."""
    lines = [
        "FATCAT29",
        "im still using VIP buff",
        "Bibble",
        "1) LRA: 712.3",
        "2) MHP: 514.1",
        "3) MD: 328.1",
    ]
    members = _run_state_machine(lines)
    # FATCAT29 should not appear (no stats)
    names = [m.name for m in members]
    assert "FATCAT29" not in names
    assert "Bibble" in names


def test_state_machine_cyrillic_name() -> None:
    lines = ["Толик", "650", "460", "310"]
    members = _run_state_machine(lines)
    assert len(members) == 1
    assert members[0].name == "Толик"


def test_state_machine_ocr_decimal_space() -> None:
    """OCR reads '498.5' as '498 5' — _parse_float must handle it."""
    lines = ["Yahoo", "1) LRA - 498 5%", "2) MHP - 327.6%", "3) MHD - 223.4%"]
    members = _run_state_machine(lines)
    assert len(members) == 1
    assert members[0].attack_pct == pytest.approx(498.5)


# ── Full parser integration ───────────────────────────────────────────────────


def test_parser_returns_player_stats_parse_result() -> None:
    ocr_text = (
        "05-02 13:20\n"
        "Joueur1\n"
        "google\n"
        "LRA-412\n"
        "MHP-319\n"
        "MGD-260\n"
        "Joueur2\n"
        "1) LRA - 1183.4\n"
        "2) MHP - 1049.3\n"
        "3) MHD - 653.5\n"
    )
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = PlayerStatsChatV1Parser()

    with patch(_OCR_FN, return_value=ocr_text):
        result = parser.parse(image)

    assert isinstance(result, PlayerStatsParseResult)
    assert result.kind == "player_stats"
    assert len(result.members) == 2

    j1 = result.members[0]
    assert j1.name == "Joueur1"
    assert j1.attack_pct == pytest.approx(412.0)
    assert j1.hp_pct == pytest.approx(319.0)
    assert j1.defense_pct == pytest.approx(260.0)
    assert j1.confidence == pytest.approx(1.0)

    j2 = result.members[1]
    assert j2.name == "Joueur2"
    assert j2.attack_pct == pytest.approx(1183.4)
    assert j2.hp_pct == pytest.approx(1049.3)
    assert j2.defense_pct == pytest.approx(653.5)
    assert j2.confidence == pytest.approx(1.0)


def test_parser_empty_image_returns_empty_result() -> None:
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = PlayerStatsChatV1Parser()

    with patch(_OCR_FN, return_value=""):
        result = parser.parse(image)

    assert isinstance(result, PlayerStatsParseResult)
    assert result.members == []


def test_parser_real_chat_excerpt() -> None:
    """Simulate a typical screenshot with multiple players and noise."""
    ocr_text = "\n".join(
        [
            "(LOL) City stats",
            "05-02 13:20",
            "RageX_",
            "Hello everyone JR will be working on a project for me and the alliance and we need",
            "The 3 things we need from you are 1 Long range attack percent"
            " 2 melee HP 3 Melee Defense",
            "05-02 14:06",
            "KlausRider",
            "363",
            "368",
            "318",
            "google",
            "LEON",
            "1 ) 645.7",
            "2 ) 405",
            "3 ) 272.6",
            "google",
            "05-02 14:55",
            "FATCAT29",
            "im still using VIP buff",
            "Bibble",
            "1) LRA: 712.3",
            "2) MHP: 514.1",
            "3) MD: 328.1",
        ]
    )
    image = np.zeros((2400, 1080), dtype=np.uint8)
    parser = PlayerStatsChatV1Parser()

    with patch(_OCR_FN, return_value=ocr_text):
        result = parser.parse(image)

    names = [m.name for m in result.members]
    assert "KlausRider" in names
    assert "LEON" in names
    assert "Bibble" in names
    assert "FATCAT29" not in names  # no stats submitted
    assert "RageX_" not in names  # only instructions

    bibble = next(m for m in result.members if m.name == "Bibble")
    assert bibble.attack_pct == pytest.approx(712.3)
    assert bibble.hp_pct == pytest.approx(514.1)
    assert bibble.defense_pct == pytest.approx(328.1)
