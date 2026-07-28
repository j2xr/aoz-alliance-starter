import logging
import os
from difflib import SequenceMatcher
from typing import Literal

import httpx
import numpy as np

from app import tess_engine as pytesseract

logger = logging.getLogger(__name__)

HEADER_HEIGHT = 200

# Static title → event code fallback, used when the database is unreachable
# (no SUPABASE_URL/key: hermetic tests, DB-less deployment) or until
# refresh_title_patterns_from_supabase has succeeded. The source of truth is
# at_event_types.title_aliases (migrations 0004/0007, OCR-misread aliases
# seeded by 0019): a new event type or a new alias is added in the database,
# without redeploying the service.
_FALLBACK_TITLE_PATTERNS: list[tuple[str, str]] = [
    ("polar invasion", "polar_invasion"),
    ("invasion polaire", "polar_invasion"),
    ("elite wars", "elite_wars"),
    ("wasteland showdown", "wasteland_showdown"),
    ("battle frenzy", "battle_frenzy"),
    ("void war", "void_war"),
    ("ironblood battlefield", "ironblood_battlefield"),
    # Tesseract misreads the capital I as lowercase l on the game font.
    ("lronblood battlefield", "ironblood_battlefield"),
]

_title_patterns: list[tuple[str, str]] = list(_FALLBACK_TITLE_PATTERNS)


def reset_title_patterns() -> None:
    """Restores the static list (test teardown)."""
    global _title_patterns
    _title_patterns = list(_FALLBACK_TITLE_PATTERNS)


def refresh_title_patterns_from_supabase(timeout: float = 5.0) -> bool:
    """Loads title → code from at_event_types.title_aliases (PostgREST).

    Silent no-op without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY (tests,
    DB-less deployment); the service key is required because at_event_types'
    RLS (0003) only grants read access to the authenticated role.
    Returns True if the list was replaced with data from the database.
    """
    global _title_patterns
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        return False

    resp = httpx.get(
        f"{url}/rest/v1/at_event_types",
        params={"select": "code,title_aliases"},
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        timeout=timeout,
    )
    resp.raise_for_status()
    rows = resp.json()
    patterns = [
        (str(alias).lower(), str(row["code"]))
        for row in rows
        for alias in (row.get("title_aliases") or [])
    ]
    if not patterns:
        logger.warning("at_event_types.title_aliases is empty — keeping fallback title patterns")
        return False

    _title_patterns = patterns
    logger.info("Loaded %d title aliases from Supabase", len(patterns))
    return True


# Donation screens are recognised by the title "Contribution Ranking" — same
# layout regardless of selected tab (Daily / Weekly / History). The parser
# itself decides which tab is active.
DONATION_CODE = "contribution_ranking"

# Player stats chat: in-game chat channel where members post their military stats.
# The channel name contains "city stats" regardless of the alliance tag prefix.
PLAYER_STATS_CODE = "player_stats_chat"


class UnknownEventError(ValueError):
    pass


# A misread header still routes to an event if it is at least this similar to a
# known title. Exact fragment matching runs first; this fuzzy pass is a last
# resort for OCR glyph confusions the seeded aliases don't cover (I→l, O→0,
# i→1…). 0.82 comfortably clears same-length single-glyph substitutions
# (≈0.93) while staying above the best cross-title collision among the seeded
# patterns (well below 0.7), so it never reroutes one event to another.
_FUZZY_TITLE_THRESHOLD = float(os.getenv("OCR_FUZZY_TITLE_THRESHOLD", "0.82"))
# Short titles are prone to spurious substring hits (e.g. "void war" inside
# "avoid warfare"); the word-window ratio below already penalises length
# mismatch, and this floor drops fragments too short to fuzzy-match safely.
_FUZZY_TITLE_MIN_LEN = 6


def _ocr_header(image: np.ndarray) -> str:
    header: np.ndarray = image[:HEADER_HEIGHT, :]
    return str(pytesseract.image_to_string(header, config="--psm 6 -l eng")).lower()


def _best_title_ratio(fragment: str, words: list[str]) -> float:
    """Max SequenceMatcher ratio of `fragment` against contiguous word windows.

    Comparing against windows (rather than the whole header) keeps extra tokens
    — timestamps, "Rank", column labels — from diluting the score, while the
    ratio's own length penalty stops a short title from matching a longer
    phrase that merely contains it. Windows are capped near the fragment's
    length since a title spanning far more characters is not the same title.
    """
    best = 0.0
    max_window_len = len(fragment) + 6
    for i in range(len(words)):
        window = ""
        for j in range(i, len(words)):
            window = words[j] if not window else f"{window} {words[j]}"
            if len(window) > max_window_len:
                break
            ratio = SequenceMatcher(None, fragment, window).ratio()
            if ratio > best:
                best = ratio
    return best


def _fuzzy_event_from_text(text: str) -> str | None:
    """Best-effort event code for a header whose title was misread, else None."""
    words = text.split()
    if not words:
        return None
    best_code: str | None = None
    best_score = _FUZZY_TITLE_THRESHOLD
    for fragment, code in _title_patterns:
        if len(fragment) < _FUZZY_TITLE_MIN_LEN:
            continue
        score = _best_title_ratio(fragment, words)
        if score > best_score:
            best_score = score
            best_code = code
    if best_code is not None:
        logger.info("Fuzzy-matched event type %r from header (score %.2f)", best_code, best_score)
    return best_code


def detect_screen_kind(
    image: np.ndarray,
) -> tuple[Literal["event", "donation", "player_stats"], str]:
    """OCR the top header band and return (kind, code).

    Raises UnknownEventError when no registered title matches — the bot
    should then ask the user to retry with `/upload kind:<event|donation|player_stats> ...`.
    """
    text = _ocr_header(image)

    for fragment, code in _title_patterns:
        if fragment in text:
            logger.info("Detected event type %r from header", code)
            return ("event", code)

    if "contribution" in text and "ranking" in text:
        logger.info("Detected donation screen (contribution ranking) from header")
        return ("donation", DONATION_CODE)

    if "city" in text and "stat" in text:
        logger.info("Detected player stats chat screen from header")
        return ("player_stats", PLAYER_STATS_CODE)

    # Last resort: the exact fragment checks above all missed, but a badly
    # misread event title may still be close enough to a known one.
    fuzzy_code = _fuzzy_event_from_text(text)
    if fuzzy_code is not None:
        return ("event", fuzzy_code)

    logger.warning("Could not detect screen kind; header text: %r", text[:120])
    raise UnknownEventError("unknown_event")
