import base64
import json
import logging
import os
import time
from typing import Any

import cv2
import httpx
import numpy as np

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "http://localhost:11434"
_DEFAULT_MODEL = "moondream"
# CPU-only Ollama hosts running a small vision model can take well over a minute
# per row. Default to 5 minutes; override via OLLAMA_TIMEOUT_SECONDS.
_DEFAULT_TIMEOUT_SECONDS = 300.0
# keep_alive prevents Ollama from unloading the model after inactivity.
# Without it, each row incurs a cold-load (seconds to tens of seconds).
# Default: 30 minutes. Use "-1" to keep indefinitely, "0" to unload immediately.
_DEFAULT_KEEP_ALIVE = "30m"
# Vision embeddings for a row crop consume hundreds of tokens; with the prompt
# and JSON response we need ~2048 to leave any budget for generation.
_NUM_CTX = 2048
# JSON responses are short. Keep the generation budget low so a slow host does
# not spend minutes on one row when the model drifts.
_NUM_PREDICT = 256
# Some reasoning-oriented models expose `think` and respond better to a
# matching `/no_think` prompt suffix when we want a direct JSON answer.
_THINK = False
_THINKING_MODEL_HINTS = ("qwen3", "deepseek-r1")

# `format: json` is intentionally NOT sent by default: with some vision models
# + image input, Ollama can drop the entire generation instead of returning the
# raw text. We ask for JSON in the prompt and extract the first balanced `{...}`
# block from the free-form response.
# Exception: small models like moondream emit an immediate stop token *without*
# `format: json`, so we re-enable it for them via _JSON_FORMAT_MODEL_HINTS.
_PROMPT = (
    "Extract the player name from this mobile game screenshot row. "
    "The name appears above the power number and may use any script: "
    "Latin, Cyrillic (Russian), CJK (Chinese or Japanese kanji/kana), "
    "Korean (Hangul), Vietnamese (accented Latin), emoji, or a mix. "
    "Copy it exactly as displayed, preserving every character. "
    'Return ONLY a JSON object: {"name": "<exact name, or null if unreadable>"}.'
)

# Simplified prompt for small vision models (e.g. moondream) that struggle with
# complex instruction templates. The inline JSON schema in _PROMPT can cause these
# models to treat it as the answer and immediately emit a stop token.
_PROMPT_SIMPLE = (
    "Look at this game screenshot row. "
    "Output a JSON object with one field: "
    "name (the player name — may be Russian, Chinese, Japanese, Korean, Vietnamese, or English). "
    "Copy the name exactly as shown. Use null if unreadable."
)

# Donation-row prompt: asks for the name AND the Alliance Honor score in the same
# call. The caller (extract._apply_llm_fallback) accepts the corrected name ONLY
# when this score matches the independently-OCR'd honor — a self-consistency
# check that the model actually read *this* row rather than a notification
# banner overlaid on it or a neighbouring row. See llm_fallback_donation.
_PROMPT_DONATION = (
    "This is one row of a mobile game contribution leaderboard. Left to right it shows: "
    "a rank number, an avatar, the player name, and the player's score (Alliance Honor) "
    "as a number on the far right. Copy the name exactly, in any script. "
    'Return ONLY a JSON object: {"name": "<exact player name, or null if unreadable>", '
    '"score": <the Alliance Honor number on the far right, or null>}.'
)

# Prompt for full player stats chat screenshot extraction.
# Asks the model to return all members' military stats as a JSON array.
_PROMPT_PLAYER_STATS = (
    "This is an alliance game chat screenshot where players posted their military stats. "
    "Each player's message contains their name followed by three percentage values: "
    "attack (LRA/MRA), HP (MHP), and defense (MGD/MHD). "
    "Values are 2-4 digit numbers (e.g. 412, 1183). "
    'Return ONLY JSON: {"members": [{"name": "...", "attack_pct": <number or null>, '
    '"hp_pct": <number or null>, "defense_pct": <number or null>}]}'
)

_PROMPT_PLAYER_STATS_SIMPLE = (
    "Game alliance chat. Players posted name + 3 numbers: attack%, HP%, defense%. "
    'Output JSON: {"members": [{"name": "...", "attack_pct": null_or_number, '
    '"hp_pct": null_or_number, "defense_pct": null_or_number}]}'
)

# Models that use the simplified prompt because they cannot reliably follow the
# structured _PROMPT template.
_SIMPLE_PROMPT_MODEL_HINTS = ("moondream",)

# Models that need `format: "json"` to produce output at all when asked for JSON.
# Without it, these small models emit an immediate EOS token (eval_count=1,
# eval_duration≈0ms, done_reason=stop). Distinct from the general case where
# `format: "json"` causes *other* vision models to drop generation.
_JSON_FORMAT_MODEL_HINTS = ("moondream",)

# Retry once with a larger token budget when a model reaches the cap before it
# emits any visible response.
_NUM_PREDICT_MAX_MULTIPLIER = 4


def _uses_thinking_controls(model: str) -> bool:
    """Return True when the model likely supports Ollama's reasoning controls."""
    normalized = model.lower()
    return any(hint in normalized for hint in _THINKING_MODEL_HINTS)


def _uses_simple_prompt(model: str) -> bool:
    normalized = model.lower()
    return any(hint in normalized for hint in _SIMPLE_PROMPT_MODEL_HINTS)


def _uses_json_format(model: str) -> bool:
    normalized = model.lower()
    return any(hint in normalized for hint in _JSON_FORMAT_MODEL_HINTS)


def _build_prompt(model: str, think: bool) -> str:
    if _uses_simple_prompt(model):
        return _PROMPT_SIMPLE
    if _uses_thinking_controls(model) and not think:
        return f"{_PROMPT} /no_think"
    return _PROMPT


def _extract_json_object(text: str) -> str:
    """Return the first balanced ``{...}`` substring, ignoring braces inside strings."""
    start = text.find("{")
    if start == -1:
        raise ValueError(f"no JSON object found in response: {text!r}")
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise ValueError(f"unbalanced JSON object in response: {text!r}")


def _encode_image(image: np.ndarray) -> str:
    _, buffer = cv2.imencode(".png", image)
    return base64.b64encode(buffer.tobytes()).decode("utf-8")


def _call_ollama(
    base_url: str,
    model: str,
    prompt: str,
    encoded_image: str,
    num_ctx: int,
    num_predict: int,
    think: bool,
    keep_alive: str | int,
    headers: dict[str, str],
    timeout_seconds: float,
    image_shape: tuple[int, int],
) -> tuple[dict[str, Any], float]:
    """Issue one Ollama /api/generate request and return (body, elapsed_seconds)."""
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "images": [encoded_image],
        "stream": False,
        "keep_alive": keep_alive,
        "options": {
            "num_ctx": num_ctx,
            "num_predict": num_predict,
            "temperature": 0,
            "seed": 42,
        },
    }
    if _uses_json_format(model):
        payload["format"] = "json"
    if _uses_thinking_controls(model):
        payload["think"] = think

    w, h = image_shape
    logger.info(
        "Ollama request -> model=%s num_ctx=%d num_predict=%d image=%dx%d image_bytes=%d",
        model,
        num_ctx,
        num_predict,
        w,
        h,
        len(encoded_image),
    )

    t0 = time.monotonic()
    response = httpx.post(
        f"{base_url}/api/generate",
        json=payload,
        headers=headers,
        timeout=timeout_seconds,
    )
    elapsed = time.monotonic() - t0
    response.raise_for_status()

    body: dict[str, Any] = response.json()
    raw_response = body.get("response", "")
    thinking_response = body.get("thinking", "")
    eval_ms = round(body.get("eval_duration", 0) / 1_000_000)
    logger.info(
        "Ollama %s inference done in %.1fs: done_reason=%s prompt_eval_count=%s eval_count=%s "
        "eval_duration=%dms response_len=%d thinking_len=%d",
        model,
        elapsed,
        body.get("done_reason", "?"),
        body.get("prompt_eval_count", "?"),
        body.get("eval_count", "?"),
        eval_ms,
        len(raw_response),
        len(thinking_response),
    )
    logger.debug(
        "Ollama %s previews: response=%r thinking=%r",
        model,
        raw_response[:200],
        thinking_response[:200],
    )

    return body, elapsed


def _get_ollama_params() -> tuple[str, str, int, int, bool, float, str | int, dict[str, str]]:
    """Return common Ollama connection parameters from environment."""
    base_url = os.getenv("OLLAMA_BASE_URL", _DEFAULT_BASE_URL).rstrip("/")
    model = os.getenv("OLLAMA_MODEL", _DEFAULT_MODEL)
    num_ctx = int(os.getenv("OLLAMA_NUM_CTX", _NUM_CTX))
    num_predict = int(os.getenv("OLLAMA_NUM_PREDICT", _NUM_PREDICT))
    think = os.getenv("OLLAMA_THINK", str(_THINK)).lower() == "true"
    timeout_seconds = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", _DEFAULT_TIMEOUT_SECONDS))
    keep_alive_raw = os.getenv("OLLAMA_KEEP_ALIVE", _DEFAULT_KEEP_ALIVE)
    keep_alive: str | int = (
        int(keep_alive_raw) if keep_alive_raw.lstrip("-").isdigit() else keep_alive_raw
    )
    api_key = os.getenv("OLLAMA_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    return base_url, model, num_ctx, num_predict, think, timeout_seconds, keep_alive, headers


def _call_with_retry(
    base_url: str,
    model: str,
    prompt: str,
    encoded_image: str,
    num_ctx: int,
    num_predict: int,
    think: bool,
    keep_alive: str | int,
    headers: dict[str, str],
    timeout_seconds: float,
    image_shape: tuple[int, int],
) -> str:
    """Call Ollama with automatic num_predict doubling on empty+length response."""
    max_num_predict = num_predict * _NUM_PREDICT_MAX_MULTIPLIER
    attempt = 0

    while True:
        body, _ = _call_ollama(
            base_url,
            model,
            prompt,
            encoded_image,
            num_ctx,
            num_predict,
            think,
            keep_alive,
            headers,
            timeout_seconds,
            image_shape,
        )
        raw_response: str = body.get("response", "")
        done_reason = body.get("done_reason", "")
        thinking_response: str = body.get("thinking", "")

        if raw_response.strip():
            return raw_response

        if done_reason == "length" and num_predict < max_num_predict:
            attempt += 1
            num_predict = min(num_predict * 2, max_num_predict)
            logger.warning(
                "Ollama returned empty response with done_reason='length' "
                "(thinking_len=%d) -> retrying with num_predict=%d (attempt %d)",
                len(thinking_response),
                num_predict,
                attempt,
            )
            continue

        raise ValueError(
            f"Ollama returned empty response (done_reason={done_reason!r}, "
            f"eval_count={body.get('eval_count')}, "
            f"prompt_eval_count={body.get('prompt_eval_count')}, "
            f"num_ctx={num_ctx}, num_predict={num_predict}, think={think}, "
            f"thinking_len={len(thinking_response)}); "
            "model generated tokens but produced no visible answer; inspect the "
            "`thinking` field and lower OCR_CONFIDENCE_THRESHOLD or switch models"
        )


# Maximum width (px) for the image sent to the LLM during player stats fallback.
# Full-resolution chat screenshots (1080×2400+) exceed inference budgets on
# CPU-only Ollama hosts; 720px is sufficient to read chat text reliably.
# Override with OLLAMA_PLAYER_STATS_MAX_WIDTH.
_PLAYER_STATS_MAX_WIDTH = int(os.getenv("OLLAMA_PLAYER_STATS_MAX_WIDTH", "720"))
# Maximum height (px) for player stats full-image calls. A 720×1600 screenshot
# generates more vision patch tokens than a 4096-ctx model can handle, causing
# Ollama to stall until the request timeout. Cap at 960px (≈ 720×960 = 691 200
# pixels) which covers ~4 player rows with enough context.
# Override with OLLAMA_PLAYER_STATS_MAX_HEIGHT.
_PLAYER_STATS_MAX_HEIGHT = int(os.getenv("OLLAMA_PLAYER_STATS_MAX_HEIGHT", "960"))
# Dedicated timeout for the player_stats full-image call. Unlike the per-row
# fallback (which stops after LLM_MAX_CONSECUTIVE_FAILURES), this path issues
# a single blocking request; 90 s is ample for a 2B model on a CPU host while
# still failing fast enough that the Discord bot does not drop the connection.
# Override with OLLAMA_PLAYER_STATS_TIMEOUT_SECONDS.
_PLAYER_STATS_TIMEOUT_SECONDS = float(os.getenv("OLLAMA_PLAYER_STATS_TIMEOUT_SECONDS", "90"))


def _resize_for_llm(
    image: np.ndarray,
    max_width: int,
    max_height: int | None = None,
) -> np.ndarray:
    """Scale image down so width ≤ max_width and height ≤ max_height, preserving aspect ratio."""
    h, w = image.shape[:2]
    scale = 1.0
    if w > max_width:
        scale = min(scale, max_width / w)
    if max_height is not None and h > max_height:
        scale = min(scale, max_height / h)
    if scale >= 1.0:
        return image
    new_w, new_h = int(w * scale), int(h * scale)
    return cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)


def llm_fallback(row_image: np.ndarray) -> str | None:
    """Send a cropped row image to a vision model via Ollama and return the player name."""
    base_url, model, num_ctx, num_predict, think, timeout_seconds, keep_alive, headers = (
        _get_ollama_params()
    )
    prompt = _build_prompt(model, think)

    h, w = row_image.shape[:2]
    encoded_image = _encode_image(row_image)

    raw_response = _call_with_retry(
        base_url,
        model,
        prompt,
        encoded_image,
        num_ctx,
        num_predict,
        think,
        keep_alive,
        headers,
        timeout_seconds,
        (w, h),
    )

    raw: Any = json.loads(_extract_json_object(raw_response))
    name: str | None = raw.get("name") if isinstance(raw, dict) else None
    logger.debug("Ollama %s parsed name: %r", model, name)
    return name


def _coerce_int(value: Any) -> int | None:
    """Best-effort int from an LLM-returned score (int, or string with commas)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        digits = value.replace(",", "").strip()
        if digits.lstrip("-").isdigit():
            return int(digits)
    return None


def llm_fallback_donation(row_image: np.ndarray) -> tuple[str | None, int | None]:
    """Donation-row LLM read: returns (name, score) from a single Ollama call.

    ``score`` is the Alliance Honor value the model reads on the far right of the
    row. The caller cross-checks it against the OCR'd honor and only trusts the
    name when they agree — so a confident-but-wrong read (e.g. a notification
    banner overlaying the row, which the model happily transcribes as a player
    name) is caught: a model whose attention drifted off the real row reports a
    score that does not match. Uses the full-width crop on purpose — the model
    must pick the honor out among the row's numbers, and a drifted read betrays
    itself by returning the wrong one.
    """
    base_url, model, num_ctx, num_predict, think, timeout_seconds, keep_alive, headers = (
        _get_ollama_params()
    )
    if _uses_simple_prompt(model):
        prompt = _PROMPT_DONATION  # small models get the same schema; it is already terse
    elif _uses_thinking_controls(model) and not think:
        prompt = f"{_PROMPT_DONATION} /no_think"
    else:
        prompt = _PROMPT_DONATION

    h, w = row_image.shape[:2]
    encoded_image = _encode_image(row_image)

    raw_response = _call_with_retry(
        base_url,
        model,
        prompt,
        encoded_image,
        num_ctx,
        num_predict,
        think,
        keep_alive,
        headers,
        timeout_seconds,
        (w, h),
    )

    raw: Any = json.loads(_extract_json_object(raw_response))
    if not isinstance(raw, dict):
        return None, None
    name: str | None = raw.get("name")
    score: int | None = _coerce_int(raw.get("score"))
    logger.debug("Ollama %s parsed donation row: name=%r score=%r", model, name, score)
    return name, score


def llm_fallback_player_stats(image: np.ndarray) -> list[dict[str, Any]] | None:
    """Send the full player stats chat image to Ollama and return extracted stats for all members.

    Returns a list of dicts with keys: name (str), attack_pct (float|None),
    hp_pct (float|None), defense_pct (float|None).  Returns None on failure.
    """
    base_url, model, num_ctx, num_predict, think, timeout_seconds, keep_alive, headers = (
        _get_ollama_params()
    )

    if _uses_simple_prompt(model):
        prompt = _PROMPT_PLAYER_STATS_SIMPLE
    elif _uses_thinking_controls(model) and not think:
        prompt = f"{_PROMPT_PLAYER_STATS} /no_think"
    else:
        prompt = _PROMPT_PLAYER_STATS

    image = _resize_for_llm(image, _PLAYER_STATS_MAX_WIDTH, _PLAYER_STATS_MAX_HEIGHT)
    h, w = image.shape[:2]
    encoded_image = _encode_image(image)

    logger.info("LLM fallback player_stats: full-image call model=%s image=%dx%d", model, w, h)

    raw_response = _call_with_retry(
        base_url,
        model,
        prompt,
        encoded_image,
        num_ctx,
        num_predict,
        think,
        keep_alive,
        headers,
        _PLAYER_STATS_TIMEOUT_SECONDS,
        (w, h),
    )

    parsed: Any = json.loads(_extract_json_object(raw_response))

    members_raw: list[Any] | None = None
    if isinstance(parsed, dict) and "members" in parsed:
        members_raw = parsed["members"]
    elif isinstance(parsed, list):
        members_raw = parsed

    if not isinstance(members_raw, list):
        logger.warning("LLM player_stats response has unexpected shape: %r", parsed)
        return None

    result: list[dict[str, Any]] = []
    for entry in members_raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue

        def _to_float(v: Any) -> float | None:
            if v is None:
                return None
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        result.append(
            {
                "name": name.strip(),
                "attack_pct": _to_float(entry.get("attack_pct")),
                "hp_pct": _to_float(entry.get("hp_pct")),
                "defense_pct": _to_float(entry.get("defense_pct")),
            }
        )

    logger.info("LLM player_stats extracted %d members", len(result))
    return result
