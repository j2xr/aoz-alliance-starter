"""Parser for in-game alliance chat screenshots where players post their military stats.

Screen type: "(LOL) City stats" — players manually type LRA/MHP/MHD percentages
in free-form messages. The format is highly variable (labeled, unlabeled, mixed order).

Approach: full-image OCR with PSM 4 (single column of variable-size text), then
a state-machine parser on the resulting text lines. No coordinate-based
cropping (unlike structured-UI parsers).

OCR configuration was chosen by sweeping PSM x language over the bench fixtures
(``tests/fixtures/player_stats_chat``), scoring against their goldens:

    config                     rows    name  attack     hp  defense
    --psm 3 -l eng            11/11    3/11    4/11   3/11     3/11   (old)
    --psm 3 -l eng+rus        10/11    6/11    5/11   5/11     5/11
    --psm 4 -l eng            13/11    3/11    3/11   2/11     2/11
    --psm 4 -l eng+rus+jpn    11/11    9/11   10/11   9/11     9/11   (chosen)
    --psm 6 -l eng+rus+jpn    14/11    0/11    3/11   0/11     1/11

PSM 3 silently drops whole message blocks and PSM 6 invents them; only PSM 4
reproduces the true number of submissions. ``rus``/``jpn`` are not about
reading handles for their own sake — without them Tesseract also mangles the
*Latin* text around them (``MHD`` was read as Cyrillic ``МНО``, ``THOR,01`` as
``THOR,O1``). The cost is ~1.0s per screenshot instead of ~0.5s.

Known limits (why this scene is still benched ADVISORY):
- A handle OCR destroys is unrecoverable; the block is kept anyway, because its
  numbers are still worth importing and the dashboard resolves names through
  ``at_player_aliases``.
- A dropped ``)`` turns "2)713.2" into "2713.2", which is indistinguishable
  from a genuine 4-digit value and is imported as such.
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

# Same, but found anywhere in the line. Avatar frames and chat-bubble borders
# bleed into the text layer around the real content ("| 1)887.2", "$ || 2)340.7",
# "“we PS 3) 340.2 BR"), which defeats an anchored match.
# The lookbehind keeps the position marker from being read out of a longer
# number: in "482.5" the "2." must not parse as position 2.
_RE_POS_ANYWHERE = re.compile(
    r"(?<![\d.,])(?P<pos>[1-3])\s*[).]\s*(?P<val>\d{2,4}(?:[.,]\d{1,2})?)\s*%?"
)

# Known label + value anywhere in the line, for the same reason.
_RE_LABELED_ANYWHERE = re.compile(
    r"(?P<label>[A-Za-z]{2,8})\s*[-–:).]?\s*(?P<val>\d{2,4}(?:[.,\s]\d{1,2})?)\s*%?"
)

# Position marker separated from its value by OCR junk ("2) mae - 642.5 A",
# where "mae" is a mangled MHP label).
_RE_POS_THEN_VALUE = re.compile(
    r"(?<![\d.,])(?P<pos>[1-3])\s*[).]\s.*?(?P<val>\d{2,4}(?:[.,]\d{1,2})?)\s*%?"
)

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

# Characters emitted by OCR reading avatar frames, chat-bubble borders and the
# translator badge. A player handle never contains them.
_ART_CHARS = frozenset("|\\«»№<>^~—")

# Minimum share of alphanumeric characters for a line to be a plausible handle.
# "Q “= af" (0.43) and "J “ ay oe" (0.56) are frame debris; "THOR,01" (0.86),
# "Jasmin ツ" (0.88) and "幸恵丸⚓船長" (0.83) are real handles.
_MIN_NAME_ALNUM_RATIO = 0.75

# Longest token still considered a fragment in an all-lowercase candidate
# ("dy oi", "et", "oer" are split off avatar art; "scepter" is a real handle).
_MAX_FRAGMENT_TOKEN_LEN = 3

# Tesseract configuration for this scene, chosen by sweeping PSM x language on
# the bench fixtures (see the module docstring).
_OCR_CONFIG = "--psm 4 -l eng+rus+jpn"


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
    # Lines with too many words are leader instructions, not names or stats —
    # unless they carry a parseable stat. Avatar art and the translator badge
    # inflate the word count of a real submission ("MALY | 2) mae - 642.5 A"
    # is 7 "words" but holds MHP 642.5), and dropping it here would silently
    # cost that stat.
    if len(stripped.split()) > _MAX_WORDS_NOISE and not _is_stat_line(stripped):
        return True
    return False


def _strip_art(line: str) -> str:
    """Strip leading/trailing OCR decoration from a line.

    Only non-alphanumeric characters are removed. Stripping stray *letters*
    would turn the handle "FATCAT29" into the stat line "29", which is exactly
    the confusion the label whitelist exists to prevent.
    """
    return re.sub(r"^[^\w]+|[^\w]+$", "", line).strip()


def _labeled_slot_anywhere(s: str) -> tuple[str, float | None, str | None] | None:
    """First recognised label + value in the line, or None.

    Scans rather than anchors: OCR routinely prefixes the real text with frame
    debris. A label is only accepted if it is in the whitelist, so "FATCAT29"
    (label=FATCAT, val=29) is still not a stat line.
    """
    for m in _RE_LABELED_ANYWHERE.finditer(s):
        label = m.group("label").lower()
        slot = _slot_from_label(label)
        if slot is None:
            continue
        kind = "mra" if label in _MRA_LABELS else ("lra" if slot == "attack" else None)
        return slot, _parse_float(m.group("val")), kind
    return None


def _is_stat_line(line: str) -> bool:
    """Return True if the line looks like a stat value (labeled or plain number)."""
    s = line.strip()
    if _RE_POS_PLAIN.match(s) or _RE_PLAIN.match(s):
        return True
    if _labeled_slot_anywhere(s) is not None:
        return True
    if _RE_POS_ANYWHERE.search(s) or _RE_POS_THEN_VALUE.search(s):
        return True
    # Bare number wrapped in frame debris ("2713.2 №").
    return bool(_RE_PLAIN.match(_strip_art(s)))


def _is_decoration(line: str) -> bool:
    """True if the line looks like OCR frame debris rather than a player handle.

    Used only to protect a block whose stats have not arrived yet: debris
    landing between a handle and its stats would otherwise be taken for a new
    player and steal them.
    """
    s = line.strip()
    if not s:
        return True
    if any(ch in _ART_CHARS for ch in s):
        return True
    # A handle is at least three characters; shorter candidates arriving before
    # a player's stats are frame debris ("eT" between "Герман" and its stats).
    if len(s) <= 2:
        return True
    alnum = sum(1 for ch in s if ch.isalnum())
    if alnum / len(s) < _MIN_NAME_ALNUM_RATIO:
        return True
    # Short all-lowercase fragments split off avatar art.
    return s.islower() and all(len(tok) <= _MAX_FRAGMENT_TOKEN_LEN for tok in s.split())


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

    # Try labeled pattern: "LRA-412", "1) MHP - 319", "Wrath 774". Scanned
    # rather than anchored so frame debris around the label doesn't hide it.
    labeled = _labeled_slot_anywhere(s)
    if labeled is not None:
        return labeled

    # Unknown label in an otherwise anchored "label value" line — keep the old
    # positional fallback so a mangled label still lands in its slot.
    m = _RE_LABELED.match(s)
    if m and _RE_PLAIN.match(_strip_art(s)) is None:
        slot = _slot_from_position(position)
        val = _parse_float(m.group("val"))
        kind: str | None = "lra" if slot == "attack" else None
        return slot, val, kind

    # Position marker somewhere in the line: "| 1)887.2", "“we PS 3) 340.2 BR"
    m = _RE_POS_ANYWHERE.search(s)
    if m:
        pos = int(m.group("pos")) - 1
        return _slot_from_position(pos), _parse_float(m.group("val")), None

    # Plain number, no label — use position. Strip frame debris first.
    m = _RE_PLAIN.match(_strip_art(s))
    if m:
        val = _parse_float(m.group("val"))
        return _slot_from_position(position), val, None

    # Last resort: position marker separated from its value by junk.
    m = _RE_POS_THEN_VALUE.search(s)
    if m:
        pos = int(m.group("pos")) - 1
        return _slot_from_position(pos), _parse_float(m.group("val")), None

    return None, None, None


def _slot_is_explicit(line: str) -> bool:
    """True if the line names its slot explicitly (recognized label or "2)370").

    Bare numbers, on the other hand, are only assigned to a slot by their
    position — a mere guess that must never outweigh a labeled value.
    """
    s = line.strip()
    if _RE_POS_PLAIN.match(s) or _RE_POS_ANYWHERE.search(s) or _RE_POS_THEN_VALUE.search(s):
        return True
    return _labeled_slot_anywhere(s) is not None


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

    # Pass 1: lines with an explicit slot (recognized label or position
    # "2)370"). They take priority over bare numbers: without this, a bare
    # number on line 0 would occupy "attack" and the labeled "LRA 412" value
    # that followed would be silently lost.
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

    # Pass 2: bare numbers (slot inferred from position) and unknown labels.
    # If the positional slot is already taken, the value joins the reserve
    # for the ordered fill-in below instead of being lost.
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
            # Frame debris lands between a handle and its stats ("| oer" right
            # after "LEON"). Taken for a name it would steal those stats and
            # shift every following row. A weak candidate arriving while the
            # current player is still waiting for its stats is therefore
            # skipped; one arriving after a complete block is a real new player
            # (a garbled handle is still a handle, and its stats are worth
            # keeping).
            if current_name is not None and not current_stat_lines and _is_decoration(line):
                continue
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
        text = pytesseract.image_to_string(image, config=_OCR_CONFIG)
        logger.debug("PlayerStatsChat OCR raw text (%d chars)", len(text))

        lines = text.splitlines()
        members = _run_state_machine(lines)

        logger.info(
            "PlayerStatsChat parser extracted %d members (full confidence avg %.2f)",
            len(members),
            sum(m.confidence for m in members) / len(members) if members else 0.0,
        )
        return PlayerStatsParseResult(members=members)
