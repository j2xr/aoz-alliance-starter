"""Optional retention of the per-row crops the LLM fallback inspects.

Off by default (``OCR_KEEP_CROPS``). When enabled, every row the LLM fallback
treats as a candidate — a misread-looking / low-confidence / suspect-honor row,
i.e. the small fraction the fallback already singles out — has its exact row
crop written under ``OCR_CROP_DIR/<job_id>/`` next to a ``manifest.jsonl`` line,
so a doubtful read can be inspected after the fact, re-fed to a line-level
reprocess, or replayed offline against the LLM cascade.

Two things bound the volume, because ``/data`` shares the host disk: a TTL
(``OCR_CROP_TTL_DAYS``) and a total-size cap (``OCR_CROP_MAX_MB``, oldest job
dirs deleted first). Both are enforced by :func:`sweep`, which is throttled and
a no-op when retention is disabled.

Scope: crops only exist when the fallback pass runs (``LLM_FALLBACK_ENABLED`` or
``force_llm``) — that pass is where the candidate rows and their crops live.
player_stats uses a single full-image LLM call with no per-row crop and is not
covered here. Nothing in this module may ever raise into the extraction path:
every public function swallows its own errors.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from pathlib import Path

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_MANIFEST_NAME = "manifest.jsonl"

# Throttle: `sweep()` walks the crop tree, so don't repeat it on every job.
_last_sweep_ts = 0.0


def crops_enabled() -> bool:
    """True when OCR_KEEP_CROPS is set truthy (read live so tests can toggle it)."""
    return os.getenv("OCR_KEEP_CROPS", "false").lower() == "true"


def _crop_dir() -> Path:
    return Path(os.getenv("OCR_CROP_DIR", "/data/crops"))


def _ttl_seconds() -> float:
    return float(os.getenv("OCR_CROP_TTL_DAYS", "7")) * 86400.0


def _max_bytes() -> int:
    return int(float(os.getenv("OCR_CROP_MAX_MB", "200")) * 1024 * 1024)


def _sweep_interval() -> float:
    return float(os.getenv("OCR_CROP_SWEEP_INTERVAL_SECONDS", "3600"))


def dump_row_crop(
    job_id: str | None,
    row: int,
    crop: np.ndarray,
    *,
    kind: str,
    name: str,
    confidence: float,
    reason: str,
    alliance_honor: int | None = None,
    points: int | None = None,
) -> None:
    """Persist one candidate row crop + a manifest line. No-op unless enabled.

    ``job_id`` keys the subdirectory (a fresh one is generated when the caller
    has none, e.g. a direct unit-test call). Only fields the OCR service itself
    knows are recorded — the Discord message id / filename live bot-side and are
    deliberately not threaded down here.
    """
    if not crops_enabled():
        return
    try:
        job = job_id or f"nojob-{uuid.uuid4().hex[:12]}"
        out_dir = _crop_dir() / job
        out_dir.mkdir(parents=True, exist_ok=True)
        crop_name = f"row_{row:02d}.png"
        cv2.imwrite(str(out_dir / crop_name), crop)
        entry = {
            "ts": time.time(),
            "job_id": job,
            "row": row,
            "crop": crop_name,
            "kind": kind,
            "name": name,
            "confidence": confidence,
            "reason": reason,
            "alliance_honor": alliance_honor,
            "points": points,
        }
        with (out_dir / _MANIFEST_NAME).open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        # Retention is a diagnostic aid; never let it break an extraction.
        logger.debug("crop retention: dump failed for row %d (job %s)", row, job_id, exc_info=True)


def sweep(*, force: bool = False) -> None:
    """Delete crops past the TTL, then oldest-first until under the size cap.

    Throttled to at most once per OCR_CROP_SWEEP_INTERVAL_SECONDS unless
    ``force`` (used at startup). No-op when retention is disabled or the crop
    directory does not exist. Never raises.
    """
    global _last_sweep_ts
    if not crops_enabled():
        return
    now = time.time()
    if not force and now - _last_sweep_ts < _sweep_interval():
        return
    _last_sweep_ts = now
    try:
        root = _crop_dir()
        if not root.is_dir():
            return
        job_dirs = [d for d in root.iterdir() if d.is_dir()]

        # 1) TTL: drop whole job dirs older than the cutoff.
        ttl_cutoff = now - _ttl_seconds()
        survivors: list[tuple[float, Path, int]] = []
        for d in job_dirs:
            try:
                mtime = d.stat().st_mtime
            except OSError:
                continue
            if mtime < ttl_cutoff:
                _remove_dir(d)
                continue
            survivors.append((mtime, d, _dir_size(d)))

        # 2) Size cap: while over budget, delete the oldest surviving dir.
        max_bytes = _max_bytes()
        total = sum(size for _, _, size in survivors)
        if total <= max_bytes:
            return
        survivors.sort(key=lambda t: t[0])  # oldest first
        for _mtime, d, size in survivors:
            if total <= max_bytes:
                break
            _remove_dir(d)
            total -= size
        logger.info(
            "crop retention: swept crops down to %.1f MB (cap %.1f MB)",
            total / 1024 / 1024,
            max_bytes / 1024 / 1024,
        )
    except Exception:
        logger.debug("crop retention: sweep failed", exc_info=True)


def _dir_size(d: Path) -> int:
    total = 0
    for f in d.iterdir():
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            continue
    return total


def _remove_dir(d: Path) -> None:
    try:
        for f in d.iterdir():
            try:
                f.unlink()
            except OSError:
                pass
        d.rmdir()
    except OSError:
        logger.debug("crop retention: could not remove %s", d, exc_info=True)
