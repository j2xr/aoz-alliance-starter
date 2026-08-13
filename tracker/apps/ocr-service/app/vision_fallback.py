"""Google Cloud Vision fallback — an opt-in alternative engine for the hard rows.

When ``OCR_VISION_FALLBACK_ENABLED`` is true, ``extract._apply_llm_fallback`` routes
the rows it would send to Ollama to Google Cloud Vision instead. The public
functions mirror ``llm_fallback`` exactly — ``vision_fallback(row) -> str | None``
and ``vision_fallback_donation(row) -> (name, score)`` — so every downstream guard
(the honor self-consistency gate, ``_rewrite_name``, the needs_review sentinels, the
consecutive-failure breaker) works unchanged.

Why this engine (measured 2026-08-13, see gcv-vision-bench-2026-08-13.md): on the
homoglyph / Cyrillic class that nothing else catches (`Axa`→`Аня`, `Mj6Inir`→`Mjölnir`)
Vision reads the true name deterministically in ~0.25 s (vs 15-90 s for the local VLM),
never hallucinates a foreign script, and returns the alliance tag as its own token so
the `(TAG)`-as-name failure is structurally impossible.

The image (a single row crop, never a full screenshot) is sent to the SYNCHRONOUS
``images:annotate`` endpoint, which Google processes in memory without persisting it.
A monthly unit counter caps usage so a runaway ``/reprocess-channel`` cannot burn
through the free tier.
"""

import base64
import json
import logging
import os
import re
import threading
import time
from datetime import UTC, datetime
from typing import Any

import cv2
import httpx
import numpy as np

logger = logging.getLogger(__name__)

_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"
_TIMEOUT_SECONDS = float(os.getenv("OCR_VISION_TIMEOUT_SECONDS", "30"))
# 1 unit per call (single TEXT_DETECTION feature). The free tier is 1000 units/month;
# default the cap just under it. A row only reaches here on the ~4% that trigger the
# fallback, so normal operation stays far below this.
_MONTHLY_UNIT_CAP = int(os.getenv("OCR_VISION_MONTHLY_UNIT_CAP", "900"))
# Persisted on the /data volume (see docker-compose ocr-service) so the count
# survives container recreation; falls back to a local file if /data is absent.
_USAGE_FILE = os.getenv("OCR_VISION_USAGE_FILE", "/data/vision_usage.json")

_usage_lock = threading.Lock()

# A pure-number line (rank position, or the honor/power on the right).
_NUM_RE = re.compile(r"^[\d.,]+$")
# A rank *tier* badge: R1..R5, RN.
_RANK_RE = re.compile(r"^[Rr]\d{1,2}$|^R[Nn]$")
# A short bracketed/parenthesised alliance tag standing on its own line: (SOD), [VI.
_LONE_TAG_RE = re.compile(r"^[\[(][^\])]{0,8}[\])]?$")
# A leading tag prefix on the name line: "(SOD) name", "[VI] name".
_LEADING_TAG_RE = re.compile(r"^[\[(][^\])]{1,8}[\])]\s*")


def vision_enabled() -> bool:
    """True when OCR_VISION_FALLBACK_ENABLED is truthy (read live so tests toggle it)."""
    return os.getenv("OCR_VISION_FALLBACK_ENABLED", "false").lower() == "true"


def _api_key() -> str:
    """API key from OCR_VISION_API_KEY, or read once from OCR_VISION_API_KEY_FILE."""
    key = os.getenv("OCR_VISION_API_KEY", "")
    if key:
        return key
    key_file = os.getenv("OCR_VISION_API_KEY_FILE", "")
    if key_file and os.path.exists(key_file):
        with open(key_file) as f:
            return f.read().strip()
    return ""


def _month_key() -> str:
    return datetime.now(UTC).strftime("%Y-%m")


def _check_and_reserve_quota() -> None:
    """Raise RuntimeError if this month's unit count is at the cap; else reserve one.

    Approximate by design: a soft safety cap, not billing. The lock makes it
    correct within one process; multiple worker processes could race slightly,
    which is fine for a guard whose only job is to stop a runaway before the free
    tier is exhausted.
    """
    with _usage_lock:
        month = _month_key()
        units = 0
        try:
            with open(_USAGE_FILE) as f:
                stored = json.load(f)
            if stored.get("month") == month:
                units = int(stored.get("units", 0))
        except (FileNotFoundError, ValueError, OSError):
            pass  # missing or corrupt -> start this month at 0

        if units >= _MONTHLY_UNIT_CAP:
            raise RuntimeError(
                f"Cloud Vision monthly cap reached ({units}/{_MONTHLY_UNIT_CAP} "
                f"units for {month}); keeping OCR. Raise OCR_VISION_MONTHLY_UNIT_CAP to allow more."
            )

        try:
            tmp = f"{_USAGE_FILE}.tmp"
            os.makedirs(os.path.dirname(_USAGE_FILE) or ".", exist_ok=True)
            with open(tmp, "w") as f:
                json.dump({"month": month, "units": units + 1}, f)
            os.replace(tmp, _USAGE_FILE)
        except OSError:
            logger.warning("could not persist Cloud Vision usage counter to %s", _USAGE_FILE)


def _encode_png(image: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("cv2.imencode failed for Cloud Vision request")
    return base64.b64encode(buf.tobytes()).decode()


def _detect_text(image: np.ndarray) -> str:
    """One synchronous TEXT_DETECTION call (1 unit); returns the full text block."""
    key = _api_key()
    if not key:
        raise RuntimeError(
            "OCR_VISION_FALLBACK_ENABLED is on but no key: set OCR_VISION_API_KEY "
            "or OCR_VISION_API_KEY_FILE"
        )
    _check_and_reserve_quota()
    payload = {
        "requests": [
            {
                "image": {"content": _encode_png(image)},
                "features": [{"type": "TEXT_DETECTION"}],
            }
        ]
    }
    t0 = time.monotonic()
    resp = httpx.post(f"{_ENDPOINT}?key={key}", json=payload, timeout=_TIMEOUT_SECONDS)
    resp.raise_for_status()
    body: dict[str, Any] = resp.json()
    r0 = (body.get("responses") or [{}])[0]
    if "error" in r0:
        raise RuntimeError(f"Cloud Vision API error: {r0['error'].get('message')}")
    text: str = r0.get("fullTextAnnotation", {}).get("text", "")
    logger.info(
        "Cloud Vision read row in %dms: %r",
        round((time.monotonic() - t0) * 1000),
        text.replace("\n", " / "),
    )
    return text


def _parse_row(text: str) -> tuple[str | None, int | None]:
    """Pull (name, score) out of the stacked row text Vision returns.

    Layout is ``rank / R-badge / (TAG) name / score`` in reading order. The score
    is the last pure-number line (honor on donation rows, power on event rows). The
    name is the longest remaining line once ranks, numbers and lone tags are
    dropped, with any leading ``(TAG)`` stripped.
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    nums = [ln for ln in lines if _NUM_RE.match(ln)]
    score: int | None = None
    if nums:
        digits = nums[-1].replace(",", "").replace(".", "")
        if digits.isdigit():
            score = int(digits)

    cands: list[str] = []
    for ln in lines:
        if _NUM_RE.match(ln) or _RANK_RE.match(ln) or _LONE_TAG_RE.match(ln):
            continue
        cands.append(ln)
    name: str | None = None
    if cands:
        raw = max(cands, key=len)
        raw = _LEADING_TAG_RE.sub("", raw).strip()
        name = raw or None
    return name, score


def vision_fallback(row_image: np.ndarray) -> str | None:
    """Event-row read: return the player name (no score needed on this path)."""
    name, _ = _parse_row(_detect_text(row_image))
    return name


def vision_fallback_donation(row_image: np.ndarray) -> tuple[str | None, int | None]:
    """Donation-row read: return (name, score).

    ``score`` is the far-right Alliance Honor; the caller cross-checks it against
    the OCR'd honor and only trusts the name when they agree — the same
    self-consistency gate the LLM path uses, so a misaligned read is caught.
    """
    return _parse_row(_detect_text(row_image))
