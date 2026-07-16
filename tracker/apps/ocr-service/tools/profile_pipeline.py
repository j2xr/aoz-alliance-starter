#!/usr/bin/env python3
"""Timing breakdown of the OCR pipeline on a single polar_invasion fixture.

Usage (from apps/ocr-service/):
    uv run python tools/profile_pipeline.py [path/to/fixture.jpg]

Instruments every Tesseract call and every named pipeline stage.
Produces a per-stage breakdown in ms and %.

The OCR call sites go through ``app.tess_engine`` (which dispatches to either
the tesserocr in-process backend or the pytesseract subprocess backend per
OCR_BACKEND env var); we patch the wrapper, not pytesseract directly, so the
breakdown reflects whichever backend is active.
"""

import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app import tess_engine

# ── Monkeypatch tess_engine to count and time every call ─────────────────────

_tess_calls: list[tuple[str, float]] = []  # (function, elapsed_s)
_orig_image_to_string = tess_engine.image_to_string
_orig_image_to_data = tess_engine.image_to_data


def _timed_image_to_string(image, *args, **kwargs):  # type: ignore[no-untyped-def]
    t0 = time.perf_counter()
    result = _orig_image_to_string(image, *args, **kwargs)
    _tess_calls.append(("image_to_string", time.perf_counter() - t0))
    return result


def _timed_image_to_data(image, *args, **kwargs):  # type: ignore[no-untyped-def]
    t0 = time.perf_counter()
    result = _orig_image_to_data(image, *args, **kwargs)
    _tess_calls.append(("image_to_data", time.perf_counter() - t0))
    return result


tess_engine.image_to_string = _timed_image_to_string  # type: ignore[assignment]
tess_engine.image_to_data = _timed_image_to_data  # type: ignore[assignment]

# The parsers and dispatcher import the wrapper as ``pytesseract`` (alias) so
# their module-level binding already points at ``tess_engine`` — patching the
# wrapper module attributes is enough.
import app.dispatcher as _dispatcher  # noqa: E402, F401
import app.parsers.polar_invasion_v1 as _piv1  # noqa: E402, F401
from app.preprocess import preprocess_image  # noqa: E402

# ── Stage timer context manager ───────────────────────────────────────────────

_stage_times: dict[str, float] = {}


class _Stage:
    def __init__(self, name: str) -> None:
        self.name = name
        self._t0 = 0.0
        # Track Tesseract call index at entry so we can attribute calls to stages
        self._call_idx = 0

    def __enter__(self) -> "_Stage":
        self._t0 = time.perf_counter()
        self._call_idx = len(_tess_calls)
        return self

    def __exit__(self, *_: object) -> None:
        elapsed = time.perf_counter() - self._t0
        _stage_times[self.name] = _stage_times.get(self.name, 0.0) + elapsed
        calls_in_stage = len(_tess_calls) - self._call_idx
        _stage_call_counts[self.name] = _stage_call_counts.get(self.name, 0) + calls_in_stage


_stage_call_counts: dict[str, int] = {}

# ── Instrument the parser ─────────────────────────────────────────────────────

from app.parsers.polar_invasion_v1 import PolarInvasionV1Parser  # noqa: E402

_orig_parse_header = PolarInvasionV1Parser._parse_header  # type: ignore[attr-defined]
_orig_detect_list_top = PolarInvasionV1Parser._detect_list_top  # type: ignore[attr-defined]
_orig_detect_rank = PolarInvasionV1Parser._detect_rank  # type: ignore[attr-defined]
_orig_detect_power = PolarInvasionV1Parser._detect_power  # type: ignore[attr-defined]
_orig_parse_row = PolarInvasionV1Parser._parse_row  # type: ignore[attr-defined]

_rank_call_count = [0]
_power_call_count = [0]
_name_call_count = [0]
_points_call_count = [0]


def _timed_parse_header(self, image):  # type: ignore[no-untyped-def]
    with _Stage("header_ocr"):
        return _orig_parse_header(self, image)


def _timed_detect_list_top(self, image):  # type: ignore[no-untyped-def]
    with _Stage("detect_list_top"):
        return _orig_detect_list_top(self, image)


def _timed_detect_rank(self, image, y, **kwargs):  # type: ignore[no-untyped-def]
    _rank_call_count[0] += 1
    with _Stage("rank_detection"):
        return _orig_detect_rank(self, image, y, **kwargs)


def _timed_detect_power(self, image, y, **kwargs):  # type: ignore[no-untyped-def]
    _power_call_count[0] += 1
    with _Stage("power_detection"):
        return _orig_detect_power(self, image, y, **kwargs)


# Instrument name + points inside _parse_row via a wrapper
def _timed_parse_row(self, image, y, row_h, **kwargs):  # type: ignore[no-untyped-def]
    # We split the row timing manually: rank and power are already wrapped,
    # so we only need to capture name and points from within _parse_row.
    # Strategy: snapshot call count before and after key sub-sections.
    # Because _parse_row calls rank and power via their wrapped methods,
    # and then does name + points inline, we instrument at the row level
    # and subtract rank+power time.
    t0 = time.perf_counter()
    calls_before = len(_tess_calls)
    result = _orig_parse_row(self, image, y, row_h, **kwargs)
    elapsed = time.perf_counter() - t0
    _stage_times["row_total"] = _stage_times.get("row_total", 0.0) + elapsed
    new_calls = len(_tess_calls) - calls_before
    _stage_call_counts["row_total"] = _stage_call_counts.get("row_total", 0) + new_calls
    return result


PolarInvasionV1Parser._parse_header = _timed_parse_header  # type: ignore[method-assign]
PolarInvasionV1Parser._detect_list_top = _timed_detect_list_top  # type: ignore[method-assign]
PolarInvasionV1Parser._detect_rank = _timed_detect_rank  # type: ignore[method-assign]
PolarInvasionV1Parser._detect_power = _timed_detect_power  # type: ignore[method-assign]
PolarInvasionV1Parser._parse_row = _timed_parse_row  # type: ignore[method-assign]

# ── Run ───────────────────────────────────────────────────────────────────────

fixture = (
    sys.argv[1]
    if len(sys.argv) > 1
    else str(Path(__file__).parent.parent / "tests/fixtures/polar_invasion/20260407T1500_001.jpg")
)

print(f"Fixture : {Path(fixture).name}")
print()

t_preprocess_start = time.perf_counter()
image = preprocess_image(fixture)
t_preprocess = time.perf_counter() - t_preprocess_start

parser = PolarInvasionV1Parser()

t_parse_start = time.perf_counter()
with _Stage("dispatcher_header"):
    # Simulate dispatcher header OCR (1 call) through the wrapper, so it gets
    # timed by our monkeypatch.
    header = image[:200, :]
    _timed_image_to_string(header, config="--psm 6 -l eng")

result = parser.parse(image)
t_parse_total = time.perf_counter() - t_parse_start

t_total = t_preprocess + t_parse_total

# ── Compute name+points times (row_total minus rank minus power) ──────────────

rank_t = _stage_times.get("rank_detection", 0.0)
power_t = _stage_times.get("power_detection", 0.0)
row_t = _stage_times.get("row_total", 0.0)
name_points_t = max(0.0, row_t - rank_t - power_t)

rank_calls = _stage_call_counts.get("rank_detection", 0)
power_calls = _stage_call_counts.get("power_detection", 0)
row_calls = _stage_call_counts.get("row_total", 0)
name_points_calls = max(0, row_calls - rank_calls - power_calls)

header_ocr_t = _stage_times.get("header_ocr", 0.0)
header_ocr_calls = _stage_call_counts.get("header_ocr", 0)
dispatcher_t = _stage_times.get("dispatcher_header", 0.0)
dispatcher_calls = _stage_call_counts.get("dispatcher_header", 0)
list_top_t = _stage_times.get("detect_list_top", 0.0)

# ── Report ────────────────────────────────────────────────────────────────────

n_members = len(result.members)
n_rows_tried = _rank_call_count[0]

total_tess_t = sum(e for _, e in _tess_calls)
total_tess_calls = len(_tess_calls)


def pct(v: float, total: float) -> str:
    return f"{100 * v / total:.1f}%" if total > 0 else "—"


def ms(v: float) -> str:
    return f"{v * 1000:.0f} ms"


print(f"{'Stage':<30}  {'Time':>8}  {'% total':>8}  {'Tess calls':>10}")
print("─" * 62)

stages = [
    ("preprocess (cv2)", t_preprocess, 0, "—"),
    ("dispatcher header OCR", dispatcher_t, dispatcher_calls, ""),
    ("header_ocr (date+stats)", header_ocr_t, header_ocr_calls, ""),
    ("detect_list_top (python)", list_top_t, 0, "—"),
    (f"rank detection ×{n_rows_tried}", rank_t, rank_calls, ""),
    (f"power detection ×{n_rows_tried}", power_t, power_calls, ""),
    ("name + points OCR", name_points_t, name_points_calls, ""),
]

for label, t, calls, call_str in stages:
    c = call_str if call_str == "—" else str(calls)
    print(f"  {label:<28}  {ms(t):>8}  {pct(t, t_total):>8}  {c:>10}")

print("─" * 62)
print(f"  {'TOTAL':28}  {ms(t_total):>8}  {'100%':>8}  {total_tess_calls:>10}")
print()
print(f"Fixture stats : {n_rows_tried} rows tried, {n_members} members extracted")
print(
    f"Tesseract     : {total_tess_calls} calls, {ms(total_tess_t)} cumulative"
    f" ({pct(total_tess_t, t_total)} of wall time)"
)
print()

# ── Per-call distribution ─────────────────────────────────────────────────────
by_fn: dict[str, list[float]] = defaultdict(list)
for fn, t in _tess_calls:
    by_fn[fn].append(t)

print("Tesseract call distribution:")
for fn, times in sorted(by_fn.items()):
    avg = sum(times) / len(times)
    mn = min(times)
    mx = max(times)
    print(f"  {fn:<20}  n={len(times):>3}  avg={ms(avg):>7}  min={ms(mn):>7}  max={ms(mx):>7}")

print()
print("Top 3 hotspots (by wall-clock share):")
hotspots = sorted(
    [
        ("rank_detection", rank_t),
        ("power_detection", power_t),
        ("name+points OCR", name_points_t),
        ("header_ocr", header_ocr_t),
        ("dispatcher_header", dispatcher_t),
        ("preprocess", t_preprocess),
        ("detect_list_top", list_top_t),
    ],
    key=lambda x: x[1],
    reverse=True,
)
for i, (name, t) in enumerate(hotspots[:3], 1):
    print(f"  #{i}  {name:<25}  {ms(t):>8}  ({pct(t, t_total)})")
