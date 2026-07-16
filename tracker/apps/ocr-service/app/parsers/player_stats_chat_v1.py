"""Parser for in-game alliance chat screenshots where players post their military stats.

Screen type: "(LOL) City stats" — players manually type LRA/MHP/MHD percentages
in free-form messages. The format is highly variable (labeled, unlabeled, mixed order).

Approach: full-image OCR with PSM 3 (auto layout), then a state-machine parser
on the resulting text lines. No coordinate-based cropping (unlike structured-UI parsers).
"""

from __future__ import annotations

import logging
import re

import numpy as np

from app import tess_engine as pytesseract
from app.parsers.base import BaseParser, PlayerStatsMember, PlayerStatsParseResult
from app.parsers.name_ocr import normalize_name

logger = logging.getLogger(__name__)

# ── Label → stat slot mapping ─────────────────────────────────────────────────
# All observed labels, normalised to lowercase.

_ATTACK_LABELS: frozenset[str] = frozenset(
    {
        "lra",  # Long Range Attack
        "mra",  # Mid Range Attack
        "wrath",  # alternative label seen in-game
        "ira",  # OCR misread: lowercase l → i
        "tra",  # OCR misread: L → T
    }
)
_HP_LABELS: frozenset[str] = frozenset(
    {
        "mhp",  # Melee HP
        "map",  # observed alternative
        "pv",  # French "Points de Vie"
        "hp",
    }
)
_DEFENSE_LABELS: frozenset[str] = frozenset(
    {
        "mgd",  # Melee Guard Defense
        "mhd",  # Melee HP Defense (game uses both)
        "md",
        "mdf",
        "defense",
        "defence",
        "def",
    }
)

# MRA labels specifically (attack_kind = "mra")
_MRA_LABELS: frozenset[str] = frozenset({"mra"})

# ── Regex patterns ────────────────────────────────────────────────────────────

# Labeled stat (optional leading position marker):
#   "LRA-412"  "1) LRA - 1183.4"  "LRA : 502.9%"  "Wrath 774"  "2) MHP - 319"
_RE_LABELED = re.compile(
    r"^\s*(?:[1-3]\s*[).]\s*)?(?P<label>[A-Za-z]{2,8})\s*[-–:).]?\s*(?P<val>\d{2,4}(?:[.,\s]\d{1,2})?)\s*%?",
    re.IGNORECASE,
)

# Explicitly positioned plain number (no label): "2)370"  "1) 498"
_RE_POS_PLAIN = re.compile(r"^\s*(?P<pos>[1-3])\s*[).]\s*(?P<val>\d{2,4}(?:[.,]\d{1,2})?)\s*%?\s*$")

# Plain number with nothing else: "363"  "408.5"  "1049,3"
_RE_PLAIN = re.compile(r"^\s*(?P<val>\d{2,4}(?:[.,]\d{1,2})?)\s*%?\s*$")

# Timestamp lines: "05-02 13:20"  "2026-05-02"  "13:20"
_RE_TIMESTAMP = re.compile(
    r"^\s*(?:\d{2,4}[-/]\d{2}(?:[-/]\d{2})?(?:\s+\d{2}:\d{2})?|\d{2}:\d{2})\s*$"
)

# Short OCR artifacts and translation indicators (single-word or empty)
_NOISE_WORDS: frozenset[str] = frozenset(
    {
        "google",
        "auto",
        "translated",
        "traduction",
        "send",
        "tap",
        "chat",
        "a",
        "aa",
        "aaa",
        "aa a",  # translator badge artefacts
    }
)

# Multi-word UI chrome (game bottom bar, etc.)
_RE_UI_CHROME = re.compile(r"^\s*(?:tap\s+to\s+chat|send)\s*$", re.IGNORECASE)

_MAX_NAME_LEN = 30
_MAX_WORDS_NOISE = 6  # lines with more than this many words are leader instructions


# ── Helper functions ──────────────────────────────────────────────────────────


def _parse_float(raw: str) -> float | None:
    """Convert raw OCR number string to float.

    Handles: comma decimals ("1049,3"), space-for-dot OCR ("498 5" → 498.5).
    """
    s = raw.strip().replace(",", ".").replace(" ", ".")
    # Collapse double dots produced by the replacements above
    while ".." in s:
        s = s.replace("..", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _slot_from_label(label: str) -> str | None:
    low = label.lower()
    if low in _ATTACK_LABELS:
        return "attack"
    if low in _HP_LABELS:
        return "hp"
    if low in _DEFENSE_LABELS:
        return "defense"
    return None


def _slot_from_position(pos: int) -> str | None:
    return ("attack", "hp", "defense")[pos] if 0 <= pos <= 2 else None


def _is_noise_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    if _RE_TIMESTAMP.match(stripped):
        return True
    if stripped.lower() in _NOISE_WORDS:
        return True
    if _RE_UI_CHROME.match(stripped):
        return True
    # Single/double non-word characters (OCR artefacts)
    if re.match(r"^[\W_]{0,3}$", stripped):
        return True
    # Lines with too many words are leader instructions, not names or stats
    if len(stripped.split()) > _MAX_WORDS_NOISE:
        return True
    return False


def _is_stat_line(line: str) -> bool:
    """Return True if the line looks like a stat value (labeled or plain number)."""
    s = line.strip()
    if _RE_POS_PLAIN.match(s) or _RE_PLAIN.match(s):
        return True
    m = _RE_LABELED.match(s)
    if m:
        # Require a recognised label — prevents "FATCAT29" (label=FATCAT, val=29) from matching
        return _slot_from_label(m.group("label").lower()) is not None
    return False


def _parse_stat_line(line: str, position: int) -> tuple[str | None, float | None, str | None]:
    """Parse a single stat line.

    Returns (slot, value, attack_kind) where:
    - slot = "attack" | "hp" | "defense" | None
    - attack_kind = "lra" | "mra" | None (only set for attack slot)
    """
    s = line.strip()

    # Try explicitly positioned plain number first: "2)370"
    m = _RE_POS_PLAIN.match(s)
    if m:
        pos = int(m.group("pos")) - 1  # 0-indexed
        val = _parse_float(m.group("val"))
        return _slot_from_position(pos), val, None

    # Try labeled pattern: "LRA-412", "1) MHP - 319", "Wrath 774"
    m = _RE_LABELED.match(s)
    if m:
        label = m.group("label").lower()
        val = _parse_float(m.group("val"))
        slot = _slot_from_label(label)
        if slot is None:
            # Unknown label — try positional fallback
            slot = _slot_from_position(position)
        kind: str | None = "mra" if label in _MRA_LABELS else ("lra" if slot == "attack" else None)
        return slot, val, kind

    # Plain number, no label — use position
    m = _RE_PLAIN.match(s)
    if m:
        val = _parse_float(m.group("val"))
        return _slot_from_position(position), val, None

    return None, None, None


def _slot_is_explicit(line: str) -> bool:
    """True si la ligne désigne son slot explicitement (label reconnu ou "2)370").

    Les nombres nus, eux, ne sont attribués à un slot que par leur position —
    une simple supposition qui ne doit jamais l'emporter sur une valeur
    étiquetée.
    """
    s = line.strip()
    if _RE_POS_PLAIN.match(s):
        return True
    m = _RE_LABELED.match(s)
    return m is not None and _slot_from_label(m.group("label").lower()) is not None


def _is_player_name(line: str) -> bool:
    """Heuristic: True if the line looks like a player name."""
    s = line.strip()
    if not s:
        return False
    if _is_noise_line(s):
        return False
    # Must contain at least one letter
    if not any(c.isalpha() for c in s):
        return False
    # Must not be purely a stat line
    if _is_stat_line(s):
        return False
    # Player names are short
    if len(s) > _MAX_NAME_LEN:
        return False
    # Must not look like a sentence (leader instructions have many words)
    words = s.split()
    if len(words) > 5:
        return False
    return True


# ── State machine ─────────────────────────────────────────────────────────────


def _build_block(name: str, stat_lines: list[str]) -> PlayerStatsMember | None:
    """Combine a player name and its associated stat lines into a PlayerStatsMember."""
    attack: float | None = None
    attack_kind: str = "lra"
    hp: float | None = None
    defense: float | None = None
    plain_values: list[float] = []

    parsed = [
        (*_parse_stat_line(line, i), _slot_is_explicit(line)) for i, line in enumerate(stat_lines)
    ]

    # Passe 1 : lignes à slot explicite (label reconnu ou position "2)370").
    # Elles priment sur les nombres nus : sans cela, un nombre nu en ligne 0
    # occupait "attack" et la valeur étiquetée "LRA 412" qui suivait était
    # silencieusement perdue.
    for slot, val, kind, explicit in parsed:
        if val is None or not explicit:
            continue
        if slot == "attack" and attack is None:
            attack = val
            if kind:
                attack_kind = kind
        elif slot == "hp" and hp is None:
            hp = val
        elif slot == "defense" and defense is None:
            defense = val

    # Passe 2 : nombres nus (slot déduit de la position) et labels inconnus.
    # Si le slot positionnel est déjà pris, la valeur rejoint la réserve pour
    # le remplissage ordonné ci-dessous au lieu d'être perdue.
    for slot, val, kind, explicit in parsed:
        if val is None or explicit:
            continue
        if slot == "attack" and attack is None:
            attack = val
            if kind:
                attack_kind = kind
        elif slot == "hp" and hp is None:
            hp = val
        elif slot == "defense" and defense is None:
            defense = val
        else:
            plain_values.append(val)

    # Fill remaining slots from plain values (in order: attack → hp → defense)
    for plain_val in plain_values:
        if attack is None:
            attack = plain_val
        elif hp is None:
            hp = plain_val
        elif defense is None:
            defense = plain_val

    filled = sum(1 for v in (attack, hp, defense) if v is not None)
    if filled == 0:
        return None  # nothing parsed

    confidence = filled / 3.0
    return PlayerStatsMember(
        name=normalize_name(name),
        attack_pct=attack,
        attack_kind=attack_kind,  # type: ignore[arg-type]
        hp_pct=hp,
        defense_pct=defense,
        confidence=confidence,
        raw_lines="\n".join([name] + stat_lines),
    )


def _run_state_machine(lines: list[str]) -> list[PlayerStatsMember]:
    """Run the state-machine parser on a list of OCR text lines.

    State transitions:
    - SEEKING_NAME → IN_PLAYER_BLOCK : when a candidate player name is found
    - IN_PLAYER_BLOCK → IN_PLAYER_BLOCK : when a stat line is accumulated
    - IN_PLAYER_BLOCK → SEEKING_NAME : when a new candidate name is found
      (commits the current block first)
    """
    members: list[PlayerStatsMember] = []
    current_name: str | None = None
    current_stat_lines: list[str] = []

    def _commit() -> None:
        if current_name is not None and current_stat_lines:
            entry = _build_block(current_name, current_stat_lines)
            if entry is not None:
                members.append(entry)

    for raw_line in lines:
        line = raw_line.strip()

        if _is_noise_line(line):
            continue

        if _is_stat_line(line):
            if current_name is not None:
                current_stat_lines.append(line)
            # else: orphan stat line before any player name → ignore
            continue

        # Non-stat, non-noise line: potential player name or long text
        if _is_player_name(line):
            _commit()
            current_name = line
            current_stat_lines = []
        else:
            # Long text (leader instruction) or unrecognised line: commit and reset
            _commit()
            current_name = None
            current_stat_lines = []

    # Commit the final block
    _commit()
    return members


# ── Parser class ──────────────────────────────────────────────────────────────


class PlayerStatsChatV1Parser(BaseParser):
    """Parse alliance chat screenshots where players report military stats.

    Unlike structured-UI parsers, this parser runs full-image Tesseract OCR
    (PSM 3 = auto layout) and uses a text-based state machine rather than
    coordinate-based image crops.
    """

    def parse(
        self,
        image: np.ndarray,
        emit_trace: bool = False,
        event_code: str | None = None,
    ) -> PlayerStatsParseResult:
        # emit_trace and event_code are no-ops here: this parser runs
        # full-image OCR with no per-row coordinate crops and has a single
        # layout, so there's nothing to trace or select.
        del emit_trace
        # The game chat has a mostly light background (white/golden bubbles on
        # a textured stone background). PSM 3 handles variable-layout pages.
        # Lang "eng" is sufficient for the player name heuristic; we do not
        # need multilingual OCR here because the stats are numbers regardless
        # of script, and player names that can't be read will resolve via
        # at_player_aliases later.
        text = pytesseract.image_to_string(image, config="--psm 3 -l eng")
        logger.debug("PlayerStatsChat OCR raw text (%d chars)", len(text))

        lines = text.splitlines()
        members = _run_state_machine(lines)

        logger.info(
            "PlayerStatsChat parser extracted %d members (full confidence avg %.2f)",
            len(members),
            sum(m.confidence for m in members) / len(members) if members else 0.0,
        )
        return PlayerStatsParseResult(members=members)
