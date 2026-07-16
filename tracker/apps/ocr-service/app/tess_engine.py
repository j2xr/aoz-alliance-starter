"""Thin wrapper around Tesseract with pluggable in-process / subprocess backends.

Drop-in replacement for the subset of pytesseract used by this service:

    image_to_string(image, lang=..., config=...) -> str
    image_to_data(image, lang=..., config=..., output_type=Output.DICT) -> dict
    Output.DICT / Output.STRING

Backends
========

Selected via the OCR_BACKEND environment variable:

    tesserocr   (default) — in-process C API. Each call adds ~5 ms of overhead
                instead of the ~100 ms subprocess spawn that pytesseract pays.
    pytesseract — legacy subprocess backend, kept for one-flag rollback.

If OCR_BACKEND=tesserocr but the tesserocr extension is not importable, we log
a warning and fall back to pytesseract.

Pool of PyTessBaseAPI instances
===============================

Each tesserocr backend call needs a PyTessBaseAPI initialised for the right
language(s) and PSM. Creating one is expensive (loads the LSTM models, ~50 MB
per language), so we keep a small LRU pool keyed by
``(lang, psm, frozenset(init_vars))``.

``init_vars`` only carries variables that must be set *before* the C++ Init()
call (DAWG flags — Tesseract loads or skips DAWG files at language-load time,
so SetVariable("load_system_dawg", "0") after Init has no effect on already
loaded data). Runtime-mutable variables (whitelist, blacklist…) are applied
per-call via SetVariable and reset on the next call when absent — otherwise
the previous call's whitelist would mute the next.

Thread safety
=============

PyTessBaseAPI is **not** thread-safe: a single instance must not be used
concurrently. Each pool entry carries its own ``threading.Lock``; callers take
the lock for the duration of one SetImage + Recognize + GetText cycle. This
serialises requests that hit the same ``(lang, psm, init_vars)`` triplet.

FastAPI's BackgroundTasks runs sync workers in uvicorn's threadpool, so two
extractions can overlap on the same instance — the lock is required for
correctness. The expected concurrency is low (Discord uploads are sequential
most of the time) so the contention cost is negligible.

Lifecycle
=========

Call :func:`shutdown_pool` from the FastAPI lifespan shutdown to release the
native PyTessBaseAPI handles and the LSTM weights they pin. Skipping this
leaks native memory at every reload (uvicorn --reload, container restart).
"""

from __future__ import annotations

import logging
import os
import re
import threading
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# ── Output enum mirror ──────────────────────────────────────────────────────


class Output:
    """Mirrors :class:`pytesseract.Output` for the subset we use."""

    STRING: str = "string"
    DICT: str = "dict"
    BYTES: str = "bytes"
    DATAFRAME: str = "dataframe"


# ── Backend selection ───────────────────────────────────────────────────────

_BACKEND_ENV = os.getenv("OCR_BACKEND", "tesserocr").strip().lower()
_POOL_SIZE = int(os.getenv("OCR_TESS_POOL_SIZE", "16"))

# Import the legacy backend unconditionally — both for the rollback path and
# so that test suites mocking ``pytesseract.image_to_string`` keep finding a
# real attribute to patch.
import pytesseract as _pytesseract  # noqa: E402


def _try_import_tesserocr() -> tuple[bool, Any, Any, Any, Any]:
    try:
        from tesserocr import PSM, RIL, PyTessBaseAPI, iterate_level

        return True, PSM, RIL, PyTessBaseAPI, iterate_level
    except ImportError as exc:
        if _BACKEND_ENV == "tesserocr":
            logger.warning(
                "OCR_BACKEND=tesserocr but tesserocr is not importable (%s); "
                "falling back to pytesseract subprocess backend",
                exc,
            )
        return False, None, None, None, None


_tesserocr_available, _PSM, _RIL, _PyTessBaseAPI, _iterate_level = _try_import_tesserocr()

if _BACKEND_ENV == "tesserocr" and not _tesserocr_available:
    _BACKEND = "pytesseract"
elif _BACKEND_ENV in ("tesserocr", "pytesseract"):
    _BACKEND = _BACKEND_ENV
else:
    logger.warning("Unknown OCR_BACKEND=%r, defaulting to tesserocr", _BACKEND_ENV)
    _BACKEND = "tesserocr" if _tesserocr_available else "pytesseract"


def current_backend() -> str:
    """Return the active backend name ('tesserocr' or 'pytesseract')."""
    return _BACKEND


# ── Config string parser ────────────────────────────────────────────────────

_PSM_RE = re.compile(r"--psm\s+(\d+)")
_LANG_RE = re.compile(r"-l\s+(\S+)")
# A -c flag carries one key=value pair. Values are space-delimited tokens — we
# never see quoted values with embedded spaces in the call sites, so a simple
# non-whitespace match suffices.
_VAR_RE = re.compile(r"-c\s+([^=\s]+)=(\S+)")

# Variables that must be applied BEFORE PyTessBaseAPI.Init() because they
# control which DAWG files get loaded at language-load time. Setting them
# after Init() has no effect on already-loaded data — so we treat them as
# part of the pool key and bake them into the C++ instance at creation.
_INIT_TIME_VARIABLES: frozenset[str] = frozenset(
    {
        "load_system_dawg",
        "load_freq_dawg",
        "load_punc_dawg",
        "load_number_dawg",
        "load_unambig_dawg",
        "load_bigram_dawg",
        "load_fixed_length_dawgs",
    }
)

# Runtime variables that persist on the instance once set and would otherwise
# silently bleed into subsequent calls. We reset each of these to its Tesseract
# default at the start of every call where the new config doesn't override it.
_STICKY_RUNTIME_DEFAULTS: dict[str, str] = {
    "tessedit_char_whitelist": "",
    "tessedit_char_blacklist": "",
}


@dataclass(frozen=True)
class _ParsedConfig:
    psm: int
    lang: str
    init_vars: frozenset[tuple[str, str]]
    runtime_vars: tuple[tuple[str, str], ...]


def _parse_config(config: str, default_lang: str) -> _ParsedConfig:
    """Extract --psm / -l / -c flags from a pytesseract-style config string."""
    psm_match = _PSM_RE.search(config) if config else None
    # Tesseract's default PSM is 3 (AUTO); pytesseract honours the same default.
    psm = int(psm_match.group(1)) if psm_match else 3

    lang_match = _LANG_RE.search(config) if config else None
    lang = lang_match.group(1) if lang_match else default_lang

    init_pairs: list[tuple[str, str]] = []
    runtime_pairs: list[tuple[str, str]] = []
    for name, value in _VAR_RE.findall(config or ""):
        if name in _INIT_TIME_VARIABLES:
            init_pairs.append((name, value))
        else:
            runtime_pairs.append((name, value))

    return _ParsedConfig(
        psm=psm,
        lang=lang,
        init_vars=frozenset(init_pairs),
        runtime_vars=tuple(runtime_pairs),
    )


# ── Image conversion ────────────────────────────────────────────────────────


def _to_pil(image: Any) -> Image.Image:
    """Convert the input to a PIL.Image without changing channel semantics.

    - 2D numpy array → mode 'L' (grayscale).
    - 3-channel numpy array → mode 'RGB' (assumes OpenCV BGR ordering).
    - 4-channel numpy array → mode 'RGBA' (assumes BGRA ordering).
    - PIL.Image → returned unchanged.
    """
    if isinstance(image, Image.Image):
        return image
    if isinstance(image, np.ndarray):
        if image.ndim == 2:
            return Image.fromarray(image, mode="L")
        if image.ndim == 3:
            if image.shape[2] == 3:
                rgb = image[:, :, ::-1]
                return Image.fromarray(np.ascontiguousarray(rgb), mode="RGB")
            if image.shape[2] == 4:
                rgba = image[:, :, [2, 1, 0, 3]]
                return Image.fromarray(np.ascontiguousarray(rgba), mode="RGBA")
        raise ValueError(f"Unsupported numpy image shape: {image.shape}")
    raise TypeError(f"Unsupported image type: {type(image).__name__}")


# ── PSM mapping ─────────────────────────────────────────────────────────────


def _psm_to_enum(psm: int) -> Any:
    """Map integer PSM (0–13) to the tesserocr PSM enum."""
    if _PSM is None:
        raise RuntimeError("tesserocr is not available")
    mapping = {
        0: _PSM.OSD_ONLY,
        1: _PSM.AUTO_OSD,
        2: _PSM.AUTO_ONLY,
        3: _PSM.AUTO,
        4: _PSM.SINGLE_COLUMN,
        5: _PSM.SINGLE_BLOCK_VERT_TEXT,
        6: _PSM.SINGLE_BLOCK,
        7: _PSM.SINGLE_LINE,
        8: _PSM.SINGLE_WORD,
        9: _PSM.CIRCLE_WORD,
        10: _PSM.SINGLE_CHAR,
        11: _PSM.SPARSE_TEXT,
        12: _PSM.SPARSE_TEXT_OSD,
        13: _PSM.RAW_LINE,
    }
    if psm not in mapping:
        raise ValueError(f"Unsupported PSM: {psm}")
    return mapping[psm]


# ── Pool ────────────────────────────────────────────────────────────────────


@dataclass
class _PoolEntry:
    api: Any
    lock: threading.Lock
    lang: str
    psm: int
    # Positionné (sous `lock`) quand l'instance a été évincée et End() appelé.
    # Un worker qui avait récupéré la référence via get() avant l'éviction doit
    # re-demander une instance au pool au lieu d'utiliser un handle détruit.
    ended: bool = False


@dataclass(frozen=True)
class _PoolKey:
    lang: str
    psm: int
    init_vars: frozenset[tuple[str, str]]


def _detect_tessdata_path() -> str | None:
    """Best-effort tessdata-prefix detection.

    Order:
      1. ``TESSDATA_PREFIX`` env var (the canonical Tesseract way).
      2. ``tesserocr.get_languages()`` — works only when libtesseract's compile-
         time default is correct (often not the case on Debian builds where
         the path defaults to ``./``).
      3. Common Debian/Ubuntu install paths, newest first.

    Returning ``None`` means "let tesserocr try its compile-time default" and
    will trigger a ``RuntimeError`` from ``PyTessBaseAPI.Init`` on systems
    where that default is wrong — preferable to silently OCR-ing garbage.
    """
    prefix = os.getenv("TESSDATA_PREFIX")
    if prefix:
        return prefix
    if _tesserocr_available:
        try:
            import tesserocr as _t

            path, langs = _t.get_languages()
            if langs and path and path != "./":
                return str(path)
        except Exception:  # pragma: no cover - best effort
            pass
    for candidate in (
        "/usr/share/tesseract-ocr/5/tessdata/",
        "/usr/share/tesseract-ocr/4.00/tessdata/",
        "/usr/share/tesseract-ocr/tessdata/",
        "/usr/share/tessdata/",
        "/usr/local/share/tessdata/",
    ):
        if os.path.isdir(candidate):
            return candidate
    return None


class _Pool:
    def __init__(self, max_size: int) -> None:
        self._max_size = max(1, max_size)
        self._entries: OrderedDict[_PoolKey, _PoolEntry] = OrderedDict()
        self._lock = threading.Lock()
        self._tessdata_path: str | None = _detect_tessdata_path()

    def get(self, key: _PoolKey) -> _PoolEntry:
        evicted: list[tuple[_PoolKey, _PoolEntry]] = []
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                self._entries.move_to_end(key)
                return entry
            entry = self._create(key)
            self._entries[key] = entry
            while len(self._entries) > self._max_size:
                evicted.append(self._entries.popitem(last=False))
        # End() hors du lock du pool (pour ne pas bloquer les autres workers
        # pendant un Recognize en cours) mais sous le lock de l'instance
        # évincée : End() sans ce lock détruisait le handle natif pendant
        # qu'un autre thread était en plein Recognize dessus (use-after-free).
        for evicted_key, evicted_entry in evicted:
            with evicted_entry.lock:
                evicted_entry.ended = True
                logger.debug(
                    "tess pool: evicting (lang=%s, psm=%d) — pool exceeded %d entries",
                    evicted_key.lang,
                    evicted_key.psm,
                    self._max_size,
                )
                try:
                    evicted_entry.api.End()
                except Exception:
                    logger.exception("tess pool: error ending evicted instance")
        return entry

    def _create(self, key: _PoolKey) -> _PoolEntry:
        if _PyTessBaseAPI is None:
            raise RuntimeError("tesserocr is not available")
        logger.debug(
            "tess pool: creating instance lang=%s psm=%d init_vars=%s",
            key.lang,
            key.psm,
            sorted(key.init_vars),
        )
        # init=False lets us set DAWG flags before the C++ Init() — once Init
        # runs they affect which dictionaries get loaded into memory.
        api = _PyTessBaseAPI(init=False)
        for name, value in key.init_vars:
            api.SetVariable(name, value)
        init_kwargs: dict[str, Any] = {"lang": key.lang}
        if self._tessdata_path is not None:
            init_kwargs["path"] = self._tessdata_path
        api.Init(**init_kwargs)
        api.SetPageSegMode(_psm_to_enum(key.psm))
        return _PoolEntry(api=api, lock=threading.Lock(), lang=key.lang, psm=key.psm)

    def shutdown(self) -> None:
        with self._lock:
            for key, entry in self._entries.items():
                with entry.lock:
                    entry.ended = True
                    try:
                        entry.api.End()
                    except Exception:
                        logger.exception(
                            "tess pool: error ending (lang=%s, psm=%d) on shutdown",
                            key.lang,
                            key.psm,
                        )
            self._entries.clear()

    def size(self) -> int:
        with self._lock:
            return len(self._entries)


_pool: _Pool | None = None
_pool_init_lock = threading.Lock()


def _get_pool() -> _Pool:
    global _pool
    if _pool is None:
        with _pool_init_lock:
            if _pool is None:
                _pool = _Pool(_POOL_SIZE)
    return _pool


def shutdown_pool() -> None:
    """Release every cached PyTessBaseAPI instance. Idempotent."""
    global _pool
    with _pool_init_lock:
        if _pool is not None:
            _pool.shutdown()
            _pool = None


def reset_pool() -> None:
    """Alias of :func:`shutdown_pool` — explicit name for the dev --reload case."""
    shutdown_pool()


# ── Variable application (runtime) ──────────────────────────────────────────


def _apply_runtime_variables(api: Any, runtime_vars: tuple[tuple[str, str], ...]) -> None:
    """Apply -c key=value pairs that take effect post-Init; reset stickies.

    Tesseract's SetVariable persists on the instance for the lifetime of the
    handle. A whitelist set on one call would silently mute the next call's
    OCR if not cleared. We restore every known sticky variable to its default
    before applying the incoming overrides.
    """
    incoming = {name for name, _ in runtime_vars}
    for name, default in _STICKY_RUNTIME_DEFAULTS.items():
        if name not in incoming:
            api.SetVariable(name, default)
    for name, value in runtime_vars:
        api.SetVariable(name, value)


# ── Public API ──────────────────────────────────────────────────────────────


@contextmanager
def _locked_entry(cfg: _ParsedConfig) -> Iterator[_PoolEntry]:
    """Yield une instance du pool avec son lock pris, garantie non-End()-ée.

    Une instance peut être évincée (et son handle natif détruit) entre le
    ``get()`` et la prise de son lock ; dans ce cas ``ended`` est positionné
    et on redemande une instance fraîche au pool au lieu d'utiliser le
    handle mort.
    """
    pool = _get_pool()
    key = _PoolKey(lang=cfg.lang, psm=cfg.psm, init_vars=cfg.init_vars)
    while True:
        entry = pool.get(key)
        with entry.lock:
            if entry.ended:
                continue
            yield entry
            return


def image_to_string(
    image: Any,
    lang: str = "eng",
    config: str = "",
    nice: int = 0,
    timeout: int = 0,
) -> str:
    """Drop-in equivalent of :func:`pytesseract.image_to_string`."""
    if _BACKEND == "pytesseract":
        return str(
            _pytesseract.image_to_string(
                image, lang=lang, config=config, nice=nice, timeout=timeout
            )
        )

    cfg = _parse_config(config, default_lang=lang)
    pil = _to_pil(image)
    with _locked_entry(cfg) as entry:
        _apply_runtime_variables(entry.api, cfg.runtime_vars)
        entry.api.SetImage(pil)
        try:
            return str(entry.api.GetUTF8Text())
        finally:
            entry.api.Clear()


def image_to_data(
    image: Any,
    lang: str = "eng",
    config: str = "",
    nice: int = 0,
    timeout: int = 0,
    output_type: str = Output.DICT,
) -> dict[str, list[Any]]:
    """Drop-in equivalent of :func:`pytesseract.image_to_data` (DICT output).

    The returned dict mimics pytesseract's Output.DICT shape: parallel lists
    keyed by ``text``, ``conf``, ``left``, ``top``, ``width``, ``height``,
    ``level``, ``page_num``, ``block_num``, ``par_num``, ``line_num``,
    ``word_num``. Only the word-level entries are populated — pytesseract
    returns a row per page/block/paragraph/line/word, but the parsers in
    this service only consume word rows.
    """
    if _BACKEND == "pytesseract":
        pt_output = _pytesseract.Output.DICT if output_type == Output.DICT else output_type
        return _pytesseract.image_to_data(  # type: ignore[no-any-return]
            image,
            lang=lang,
            config=config,
            nice=nice,
            timeout=timeout,
            output_type=pt_output,
        )

    if output_type != Output.DICT:
        raise NotImplementedError(
            f"output_type={output_type!r} not supported by the tesserocr backend"
        )

    cfg = _parse_config(config, default_lang=lang)
    pil = _to_pil(image)

    data: dict[str, list[Any]] = {
        "level": [],
        "page_num": [],
        "block_num": [],
        "par_num": [],
        "line_num": [],
        "word_num": [],
        "left": [],
        "top": [],
        "width": [],
        "height": [],
        "conf": [],
        "text": [],
    }

    with _locked_entry(cfg) as entry:
        _apply_runtime_variables(entry.api, cfg.runtime_vars)
        entry.api.SetImage(pil)
        try:
            entry.api.Recognize()
            ri = entry.api.GetIterator()
            if ri is None:
                return data

            assert _RIL is not None
            assert _iterate_level is not None
            word_level = _RIL.WORD

            word_idx = 0
            for r in _iterate_level(ri, word_level):
                try:
                    text = r.GetUTF8Text(word_level)
                except RuntimeError:
                    continue
                if text is None:
                    text = ""
                # tesserocr returns trailing whitespace per word; pytesseract
                # strips it. Mirror that so downstream `text.strip()` checks
                # behave identically.
                text = text.rstrip("\n\r ")

                try:
                    conf_val = float(r.Confidence(word_level))
                except RuntimeError:
                    conf_val = -1.0

                try:
                    x1, y1, x2, y2 = r.BoundingBox(word_level)
                except RuntimeError:
                    x1 = y1 = x2 = y2 = 0

                data["text"].append(text)
                data["conf"].append(int(round(conf_val)))
                data["left"].append(int(x1))
                data["top"].append(int(y1))
                data["width"].append(int(x2 - x1))
                data["height"].append(int(y2 - y1))
                data["level"].append(int(word_level))
                data["page_num"].append(1)
                data["block_num"].append(1)
                data["par_num"].append(1)
                data["line_num"].append(1)
                data["word_num"].append(word_idx)
                word_idx += 1
        finally:
            entry.api.Clear()

    return data
