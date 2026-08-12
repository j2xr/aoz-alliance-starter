"""Tests for app.crop_retention — the optional LLM-fallback crop store (F3).

Covers the gate (OCR_KEEP_CROPS), the dump (file + manifest line), and the
sweep (TTL then size cap, oldest first). No tesseract needed: the module only
touches cv2 + the filesystem.
"""

import json
import os
import time
from pathlib import Path

import numpy as np
import pytest

import app.crop_retention as cr


@pytest.fixture
def crop_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Enable retention into a fresh temp dir; reset the sweep throttle."""
    monkeypatch.setenv("OCR_KEEP_CROPS", "true")
    monkeypatch.setenv("OCR_CROP_DIR", str(tmp_path))
    monkeypatch.setattr(cr, "_last_sweep_ts", 0.0)
    return tmp_path


def _crop() -> np.ndarray:
    return np.zeros((40, 200), dtype=np.uint8)


def test_disabled_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OCR_KEEP_CROPS", raising=False)
    monkeypatch.setenv("OCR_CROP_DIR", str(tmp_path))
    cr.dump_row_crop("job1", 3, _crop(), kind="event", name="Foo", confidence=0.2, reason="x")
    assert list(tmp_path.iterdir()) == []


def test_dump_writes_crop_and_manifest(crop_env: Path) -> None:
    cr.dump_row_crop(
        "job1",
        3,
        _crop(),
        kind="donation",
        name="Bar",
        confidence=-1.0,
        reason="forced",
        alliance_honor=530,
    )
    job_dir = crop_env / "job1"
    assert (job_dir / "row_03.png").is_file()

    lines = (job_dir / "manifest.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["row"] == 3
    assert entry["name"] == "Bar"
    assert entry["kind"] == "donation"
    assert entry["reason"] == "forced"
    assert entry["alliance_honor"] == 530
    assert entry["crop"] == "row_03.png"


def test_manifest_appends_across_rows(crop_env: Path) -> None:
    cr.dump_row_crop("job1", 1, _crop(), kind="event", name="A", confidence=0.1, reason="r")
    cr.dump_row_crop("job1", 2, _crop(), kind="event", name="B", confidence=0.1, reason="r")
    lines = (crop_env / "job1" / "manifest.jsonl").read_text().strip().splitlines()
    assert [json.loads(x)["name"] for x in lines] == ["A", "B"]


def test_generates_a_dir_when_job_id_is_none(crop_env: Path) -> None:
    cr.dump_row_crop(None, 0, _crop(), kind="event", name="A", confidence=0.1, reason="r")
    dirs = [d for d in crop_env.iterdir() if d.is_dir()]
    assert len(dirs) == 1
    assert dirs[0].name.startswith("nojob-")


def test_dump_never_raises_on_bad_crop(crop_env: Path) -> None:
    # An empty array makes cv2.imwrite fail; the error must be swallowed.
    cr.dump_row_crop(
        "job1",
        0,
        np.zeros((0, 0), dtype=np.uint8),
        kind="event",
        name="A",
        confidence=0.1,
        reason="r",
    )
    # No exception = pass; a manifest line may or may not exist, but no crash.


def test_sweep_removes_dirs_past_ttl(crop_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OCR_CROP_TTL_DAYS", "7")
    cr.dump_row_crop("old", 0, _crop(), kind="event", name="A", confidence=0.1, reason="r")
    cr.dump_row_crop("new", 0, _crop(), kind="event", name="B", confidence=0.1, reason="r")

    old_dir = crop_env / "old"
    stale = time.time() - 8 * 86400
    os.utime(old_dir, (stale, stale))

    cr.sweep(force=True)

    assert not old_dir.exists()
    assert (crop_env / "new").exists()


def test_sweep_enforces_size_cap_oldest_first(
    crop_env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OCR_CROP_TTL_DAYS", "3650")  # TTL out of the way
    # ~0.5 MB per job dir; cap at 1 MB so exactly one of three must go.
    monkeypatch.setenv("OCR_CROP_MAX_MB", "1")
    payload = np.zeros(512 * 1024, dtype=np.uint8)  # 0.5 MB

    for i, job in enumerate(["j0", "j1", "j2"]):
        d = crop_env / job
        d.mkdir()
        (d / "blob.bin").write_bytes(payload.tobytes())
        t = time.time() - (100 - i) * 60  # j0 oldest, j2 newest
        os.utime(d, (t, t))

    cr.sweep(force=True)

    survivors = sorted(d.name for d in crop_env.iterdir() if d.is_dir())
    # Total 1.5 MB over a 1 MB cap → the single oldest (j0) is dropped.
    assert survivors == ["j1", "j2"]


def test_sweep_is_throttled_without_force(crop_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OCR_CROP_TTL_DAYS", "0")  # everything is "expired"
    monkeypatch.setenv("OCR_CROP_SWEEP_INTERVAL_SECONDS", "3600")
    cr.dump_row_crop("j", 0, _crop(), kind="event", name="A", confidence=0.1, reason="r")

    monkeypatch.setattr(cr, "_last_sweep_ts", time.time())  # a sweep "just ran"
    cr.sweep()  # throttled → should not touch anything
    assert (crop_env / "j").exists()

    cr.sweep(force=True)  # bypass throttle → now it goes
    assert not (crop_env / "j").exists()


def test_sweep_noop_when_disabled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OCR_KEEP_CROPS", raising=False)
    monkeypatch.setenv("OCR_CROP_DIR", str(tmp_path))
    (tmp_path / "job").mkdir()
    monkeypatch.setattr(cr, "_last_sweep_ts", 0.0)
    cr.sweep(force=True)
    assert (tmp_path / "job").exists()  # disabled = untouched
