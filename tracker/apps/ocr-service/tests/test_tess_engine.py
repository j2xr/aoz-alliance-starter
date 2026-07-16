"""Tests for the tesseract backend wrapper (app/tess_engine.py).

Split into three groups:

1. Pure-Python unit tests — config parser, image conversion, sticky-variable
   reset. Run on any host (no Tesseract required).

2. tesserocr-backed tests — equivalence with pytesseract, concurrency, pool
   eviction & shutdown. Skipped automatically when tesserocr or the Tesseract
   binary is not available on the host (typically the case outside the
   Docker/CI image).
"""

from __future__ import annotations

import os
import shutil
import threading

import numpy as np
import pytest
from PIL import Image

from app import tess_engine
from app.tess_engine import (
    Output,
    _apply_runtime_variables,
    _parse_config,
    _to_pil,
)

# ── Skip marker for tests that need the actual Tesseract install ─────────────

_HAS_TESSERACT = shutil.which("tesseract") is not None
_HAS_TESSEROCR = tess_engine._tesserocr_available
# These tests exercise the tesserocr in-process backend's pool behaviour. When
# OCR_BACKEND is forced to pytesseract (rollback), no pool entries are created
# so the assertions below would always fail — skip rather than spuriously fail.
_BACKEND_IS_TESSEROCR = tess_engine.current_backend() == "tesserocr"

_requires_tesserocr = pytest.mark.skipif(
    not (_HAS_TESSEROCR and _HAS_TESSERACT and _BACKEND_IS_TESSEROCR),
    reason=(
        "tesserocr backend not active (need tesserocr + tesseract binary + OCR_BACKEND=tesserocr)"
    ),
)


# ── Config parsing ──────────────────────────────────────────────────────────


def test_parse_config_defaults() -> None:
    cfg = _parse_config("", default_lang="eng")
    assert cfg.psm == 3  # tesseract default
    assert cfg.lang == "eng"
    assert cfg.init_vars == frozenset()
    assert cfg.runtime_vars == ()


def test_parse_config_psm_only() -> None:
    cfg = _parse_config("--psm 7", default_lang="eng")
    assert cfg.psm == 7
    assert cfg.lang == "eng"


def test_parse_config_lang_override() -> None:
    cfg = _parse_config("--psm 6 -l eng+rus", default_lang="eng")
    assert cfg.psm == 6
    assert cfg.lang == "eng+rus"


def test_parse_config_whitelist_is_runtime_var() -> None:
    cfg = _parse_config("--psm 11 -c tessedit_char_whitelist=0123456789,", default_lang="eng")
    assert cfg.psm == 11
    assert cfg.init_vars == frozenset()
    assert cfg.runtime_vars == (("tessedit_char_whitelist", "0123456789,"),)


def test_parse_config_dawg_flags_are_init_vars() -> None:
    """load_*_dawg variables must land in init_vars (effect only at Init)."""
    cfg = _parse_config(
        "--psm 7 -l eng+rus -c load_system_dawg=0 -c load_freq_dawg=0",
        default_lang="eng",
    )
    assert cfg.psm == 7
    assert cfg.lang == "eng+rus"
    assert cfg.init_vars == frozenset({("load_system_dawg", "0"), ("load_freq_dawg", "0")})
    assert cfg.runtime_vars == ()


def test_parse_config_mixed_init_and_runtime() -> None:
    cfg = _parse_config(
        "--psm 7 -c load_system_dawg=0 -c tessedit_char_whitelist=R12345",
        default_lang="eng",
    )
    assert ("load_system_dawg", "0") in cfg.init_vars
    assert ("tessedit_char_whitelist", "R12345") in cfg.runtime_vars
    assert len(cfg.init_vars) == 1
    assert len(cfg.runtime_vars) == 1


# ── Image conversion ───────────────────────────────────────────────────────


def test_to_pil_grayscale_2d() -> None:
    arr = np.full((20, 30), 128, dtype=np.uint8)
    img = _to_pil(arr)
    assert img.mode == "L"
    assert img.size == (30, 20)


def test_to_pil_bgr_3d() -> None:
    arr = np.zeros((20, 30, 3), dtype=np.uint8)
    # OpenCV BGR red pixel at (0,0)
    arr[0, 0] = [0, 0, 255]
    img = _to_pil(arr)
    assert img.mode == "RGB"
    assert img.size == (30, 20)
    assert img.getpixel((0, 0)) == (255, 0, 0)  # converted to PIL RGB


def test_to_pil_bgra_4d() -> None:
    arr = np.zeros((10, 10, 4), dtype=np.uint8)
    arr[0, 0] = [0, 0, 255, 128]  # BGRA red, half-alpha
    img = _to_pil(arr)
    assert img.mode == "RGBA"
    assert img.getpixel((0, 0)) == (255, 0, 0, 128)


def test_to_pil_passthrough_pil() -> None:
    src = Image.new("L", (5, 5), color=200)
    assert _to_pil(src) is src


def test_to_pil_rejects_unsupported_shape() -> None:
    with pytest.raises(ValueError):
        _to_pil(np.zeros((10, 10, 2), dtype=np.uint8))


def test_to_pil_rejects_unsupported_type() -> None:
    with pytest.raises(TypeError):
        _to_pil("not an image")


# ── Sticky-variable reset ──────────────────────────────────────────────────


class _RecordingApi:
    """Fake PyTessBaseAPI that records SetVariable calls."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def SetVariable(self, name: str, value: str) -> None:
        self.calls.append((name, value))


def test_apply_runtime_resets_whitelist_when_absent() -> None:
    api = _RecordingApi()
    _apply_runtime_variables(api, ())
    # All sticky defaults must be reset.
    names = [call[0] for call in api.calls]
    assert "tessedit_char_whitelist" in names
    assert "tessedit_char_blacklist" in names
    # Reset values are the documented Tesseract defaults (empty string).
    for name, value in api.calls:
        if name in ("tessedit_char_whitelist", "tessedit_char_blacklist"):
            assert value == ""


def test_apply_runtime_does_not_reset_when_present() -> None:
    api = _RecordingApi()
    _apply_runtime_variables(api, (("tessedit_char_whitelist", "R12345"),))
    # The reset-to-default call must be skipped for the incoming variable.
    whitelist_calls = [c for c in api.calls if c[0] == "tessedit_char_whitelist"]
    assert whitelist_calls == [("tessedit_char_whitelist", "R12345")]


def test_apply_runtime_blacklist_still_reset_when_only_whitelist_present() -> None:
    api = _RecordingApi()
    _apply_runtime_variables(api, (("tessedit_char_whitelist", "0123456789"),))
    # Whitelist applied without reset; blacklist still reset to empty.
    assert ("tessedit_char_whitelist", "0123456789") in api.calls
    assert ("tessedit_char_blacklist", "") in api.calls


# ── Backend introspection ─────────────────────────────────────────────────


def test_current_backend_returns_known_string() -> None:
    assert tess_engine.current_backend() in ("tesserocr", "pytesseract")


# ── tesserocr-backed integration tests ─────────────────────────────────────


def _render_text_image(text: str, size: tuple[int, int] = (320, 80)) -> np.ndarray:
    """Render `text` onto a white grayscale array using PIL's default font."""
    from PIL import ImageDraw, ImageFont

    img = Image.new("L", size, color=255)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36)
    except OSError:
        font = ImageFont.load_default()
    draw.text((10, 10), text, fill=0, font=font)
    return np.array(img)


@_requires_tesserocr
def test_tesserocr_image_to_string_round_trip() -> None:
    """Smoke test: OCR a synthetic image and recover the source text."""
    tess_engine.shutdown_pool()
    os.environ.pop("OCR_BACKEND", None)
    img = _render_text_image("HELLO 1234")
    result = tess_engine.image_to_string(img, config="--psm 7 -l eng").strip()
    assert "HELLO" in result.upper() or "1234" in result
    tess_engine.shutdown_pool()


@_requires_tesserocr
def test_tesserocr_image_to_data_returns_pytesseract_dict_shape() -> None:
    tess_engine.shutdown_pool()
    img = _render_text_image("ALPHA")
    data = tess_engine.image_to_data(img, config="--psm 7 -l eng", output_type=Output.DICT)
    # Pytesseract guarantees these parallel-list keys; downstream code reads
    # at least text/conf/left.
    for key in (
        "level",
        "page_num",
        "block_num",
        "par_num",
        "line_num",
        "word_num",
        "left",
        "top",
        "width",
        "height",
        "conf",
        "text",
    ):
        assert key in data, f"missing key: {key}"
        assert isinstance(data[key], list)
    # All lists same length.
    lengths = {len(v) for v in data.values()}
    assert len(lengths) == 1
    tess_engine.shutdown_pool()


@_requires_tesserocr
def test_tesserocr_whitelist_does_not_leak_between_calls() -> None:
    """A whitelist set on one call must not mute the next call's OCR."""
    tess_engine.shutdown_pool()
    img_digits = _render_text_image("123")
    img_letters = _render_text_image("ABC")

    # First call: numeric whitelist — should return digits only.
    res_digits = tess_engine.image_to_string(
        img_digits, config="--psm 7 -l eng -c tessedit_char_whitelist=0123456789"
    ).strip()
    assert any(c.isdigit() for c in res_digits)

    # Second call on the same (lang, psm) entry: no whitelist — should see
    # letters again. If the previous whitelist leaked, this would return "".
    res_letters = tess_engine.image_to_string(img_letters, config="--psm 7 -l eng").strip()
    assert any(c.isalpha() for c in res_letters), (
        f"whitelist leaked between calls: got {res_letters!r}"
    )
    tess_engine.shutdown_pool()


@_requires_tesserocr
def test_tesserocr_pool_evicts_lru_above_max_size() -> None:
    """When the pool grows beyond OCR_TESS_POOL_SIZE, the LRU entry is dropped."""
    tess_engine.shutdown_pool()
    # Force a tiny pool so we can observe eviction with few PSM variants.
    pool = tess_engine._Pool(max_size=2)
    img = _render_text_image("X")
    # The first three (lang, psm) variants create three entries; the LRU one
    # is evicted because max_size=2.
    pool.get(tess_engine._PoolKey(lang="eng", psm=7, init_vars=frozenset()))
    pool.get(tess_engine._PoolKey(lang="eng", psm=6, init_vars=frozenset()))
    pool.get(tess_engine._PoolKey(lang="eng", psm=11, init_vars=frozenset()))
    assert pool.size() == 2
    pool.shutdown()
    del img


@_requires_tesserocr
def test_tesserocr_concurrent_calls_dont_corrupt() -> None:
    """Two threads OCR'ing in parallel must not crash or return garbage."""
    tess_engine.shutdown_pool()
    img1 = _render_text_image("ONE")
    img2 = _render_text_image("TWO")
    results: dict[int, str] = {}
    errors: list[BaseException] = []

    def worker(idx: int, img: np.ndarray) -> None:
        try:
            for _ in range(3):
                out = tess_engine.image_to_string(img, config="--psm 7 -l eng").strip()
                results[idx] = out
        except BaseException as exc:  # capture for re-raise in the main thread
            errors.append(exc)

    t1 = threading.Thread(target=worker, args=(1, img1))
    t2 = threading.Thread(target=worker, args=(2, img2))
    t1.start()
    t2.start()
    t1.join(timeout=30)
    t2.join(timeout=30)
    assert not errors, f"concurrent OCR raised: {errors!r}"
    assert 1 in results and 2 in results
    tess_engine.shutdown_pool()


@_requires_tesserocr
def test_shutdown_pool_releases_instances() -> None:
    tess_engine.shutdown_pool()
    img = _render_text_image("Z")
    tess_engine.image_to_string(img, config="--psm 7 -l eng")
    assert tess_engine._get_pool().size() >= 1
    tess_engine.shutdown_pool()
    # _get_pool() recreates a fresh empty pool after shutdown.
    assert tess_engine._get_pool().size() == 0
    tess_engine.shutdown_pool()
