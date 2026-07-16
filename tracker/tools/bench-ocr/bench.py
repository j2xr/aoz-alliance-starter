#!/usr/bin/env python3
"""Benchmark OCR accuracy across all event-type fixture sets.

Usage (from repo root):
    python tools/bench-ocr/bench.py
    python tools/bench-ocr/bench.py --event-type polar_invasion
    python tools/bench-ocr/bench.py --event-type ironblood_battlefield --verbose
    python tools/bench-ocr/bench.py --verbose --dump-crops /tmp/bench-crops
    python tools/bench-ocr/bench.py --write-baseline

Name accuracy is reported two ways so a green run can't hide misreads:
- ``name``       : fuzzy match, ``SequenceMatcher.ratio() >= 0.70`` (case-insensitive).
                   This is the gated metric (Target column), kept for continuity.
- ``name_exact`` : strict ``got.name == want["name"]``. Informational only
                   (Target ``—``, Status ``INFO``) — it is NOT gated, so adding
                   the metric can't turn CI red on its own. Its purpose is
                   visibility, plus a baseline entry (see below) that makes any
                   *new* misread a blocking REGRESSION even when the fuzzy check
                   still passes.

Verbose output: one line per anomaly, printed BELOW the per-fixture table.
    FAIL      <fixture>  row=NN  field=<name>  expected=<v>  got=<v>  conf=<f>
    MISMATCH  <fixture>  row=NN  field=name    expected=<v>  got=<v>  conf=<f>  sim=<f>
    WARN      <fixture>  row=NN  field=name    expected=<v>  got=<v>  conf=<f>  sim=<f>
- FAIL: got != expected on that field (name: below the fuzzy threshold).
- MISMATCH: name passed the fuzzy threshold but is NOT byte-exact — a real
  misread the fuzzy metric would otherwise silently absorb (e.g.
  ``BigSteelCurtain`` → ``Rig§teelCurtain``, ``Mjölnir`` → ``Mjolnir``).
- WARN: row matched on all fields but member confidence is < CONFIDENCE_THRESHOLD.
- Name anomaly lines (FAIL/MISMATCH/WARN) also print ``sim=<ratio>`` so a
  correct-but-low-confidence WARN reads ``sim=1.00`` at a glance while a misread
  shows its true similarity.

Dump crops: ``--dump-crops <dir>`` enables ``emit_trace=True`` on the parser
so each MemberResult carries the exact (y1, y2, x1, x2) box Tesseract saw for
every field. For each FAIL/WARN row the bench writes:

  - ``<fixture>_row<NN>_full.png``                       full row crop
  - ``<fixture>_row<NN>_name_y<y1>-<y2>_x<x1>-<x2>.png`` strict name crop
  - ``<fixture>_row<NN>_rank_y<y1>-<y2>_x<x1>-<x2>.png`` strict rank crop
  - (event)    ``..._power_...png``  ``..._points_...png``
  - (donation) ``..._alliance_honor_...png``

This shows exactly what bytes were passed to Tesseract, eliminating the
few-pixel drift between the parser's dynamic ``_detect_list_top`` and the
post-hoc reconstruction from canonical layout constants used by the
previous --dump-crops implementation.

Advisory scenes: a fixture directory containing an ``ADVISORY`` marker file is
benched and printed like any other, but its accuracy misses do NOT fail the run
and it is excluded from baseline.json. This lands coverage for a parser that is
still below its quality targets without turning CI red; delete the marker and
re-run ``--write-baseline`` to promote the scene to blocking once it is ready.

Exit codes:
    0  all checks passed (accuracy targets, baseline non-regression, latency budgets)
    1  accuracy target missed, baseline regression, latency budget exceeded,
       no fixtures processed, or error
"""

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
OCR_SERVICE_PATH = REPO_ROOT / "apps" / "ocr-service"
sys.path.insert(0, str(OCR_SERVICE_PATH))

import cv2  # noqa: E402

from app.parsers import REGISTRY  # noqa: E402
from app.parsers._trace import FieldBox, RowTrace  # noqa: E402
from app.parsers.base import DonationParseResult  # noqa: E402
from app.preprocess import preprocess_image  # noqa: E402

FIXTURES_ROOT = OCR_SERVICE_PATH / "tests" / "fixtures"
BASELINE_PATH = Path(__file__).resolve().parent / "baseline.json"
CONFIDENCE_THRESHOLD = 0.75

_DEFAULT_MAX_AVG_SECONDS = 3.5
_DEFAULT_MAX_FIXTURE_SECONDS = 5.0

# A scene directory containing this marker file is benched in "advisory" mode:
# results are printed but excluded from the pass/fail verdict and the baseline.
_ADVISORY_MARKER = "ADVISORY"

logger = logging.getLogger(__name__)

_EVENT_TARGETS: dict[str, float] = {
    "name": 0.90,
    "rank": 0.98,
    "power": 0.95,
    "points": 0.95,
}

_DONATION_TARGETS: dict[str, float] = {
    "name": 0.90,
    "rank": 0.95,
    "alliance_honor": 0.95,
}


@dataclass
class Anomaly:
    level: str  # "FAIL", "MISMATCH", or "WARN"
    fixture: str
    row: int
    field: str
    expected: Any
    got: Any
    conf: float


@dataclass
class BenchResult:
    all_pass: bool
    fixtures_processed: int
    anomalies: list[Anomaly]
    correct: dict[str, int]
    totals: dict[str, int]
    latencies: list[float]
    # Advisory scenes are benched and reported but never gate CI: their accuracy
    # misses don't fail the run and they're kept out of the baseline. Used while
    # a parser is still below its quality targets — coverage lands without
    # turning CI red; flip the scene to blocking (remove its ADVISORY marker,
    # then --write-baseline) once the parser reaches target.
    advisory: bool = False


def _sim(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _pct(num: int, den: int) -> str:
    return f"{num / den:.1%}" if den else "N/A"


def _col_widths(headers: list[str], rows: list[list[str]]) -> list[int]:
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))
    return widths


def _fmt_row(cells: list[str], widths: list[int]) -> str:
    return "  ".join(c.ljust(widths[i]) for i, c in enumerate(cells))


def _print_table(headers: list[str], rows: list[list[str]]) -> None:
    widths = _col_widths(headers, rows)
    print(_fmt_row(headers, widths))
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print(_fmt_row(row, widths))


def _emit_anomaly(a: Anomaly) -> None:
    """Print one FAIL/MISMATCH/WARN line in the structured diagnostic format.

    Name anomalies also carry ``sim=<ratio>`` — the same fuzzy ratio the
    comparators gate on — so a correct-but-low-confidence WARN reads
    ``sim=1.00`` while a misread shows its true (< 1.00) similarity.
    """
    sim = ""
    if a.field == "name":
        sim = f"  sim={_sim(str(a.got), str(a.expected)):.2f}"
    print(
        f"{a.level:<8}  {a.fixture}  row={a.row:02d}  "
        f"field={a.field:<14}  expected={a.expected!r}  got={a.got!r}  conf={a.conf:.2f}{sim}"
    )


def _save_field_crop(
    out_dir: Path,
    fixture: str,
    row_idx: int,
    field_name: str,
    image: Any,
    box: FieldBox,
) -> Path | None:
    """Write ``<fixture>_row<NN>_<field>_y<y1>-<y2>_x<x1>-<x2>.png``."""
    h, w = image.shape[:2]
    y1 = max(0, box.y1)
    y2 = min(h, box.y2)
    x1 = max(0, box.x1)
    x2 = min(w, box.x2)
    if y2 <= y1 or x2 <= x1:
        logger.warning(
            "field crop out of bounds for %s row %d field %s: box=%r",
            fixture,
            row_idx,
            field_name,
            box,
        )
        return None
    crop = image[y1:y2, x1:x2]
    out_path = out_dir / f"{fixture}_row{row_idx:02d}_{field_name}{box.coord_suffix()}.png"
    cv2.imwrite(str(out_path), crop)
    return out_path


def _dump_row_crops(
    out_dir: Path,
    fixture: str,
    trace: RowTrace,
    image: Any,
) -> None:
    """Dump the full row crop and every field sub-crop recorded in ``trace``.

    Uses the parser's runtime ``list_top``/``row_height`` rather than the
    canonical layout constants, so the dumped crops are exactly what
    Tesseract saw — no few-pixel drift on rows where ``_detect_list_top``
    deviated from the canonical value.
    """
    h = image.shape[0]
    y1 = max(0, trace.list_top + trace.row_index * trace.row_height)
    y2 = min(h, y1 + trace.row_height)
    row_idx = trace.row_index
    if y2 > y1:
        full = image[y1:y2, :]
        full_path = out_dir / f"{fixture}_row{row_idx:02d}_full.png"
        cv2.imwrite(str(full_path), full)
    else:
        logger.warning("full row crop out of bounds for %s row %d", fixture, row_idx)

    _save_field_crop(out_dir, fixture, row_idx, "name", image, trace.name)
    _save_field_crop(out_dir, fixture, row_idx, "rank", image, trace.rank)
    if trace.power is not None:
        _save_field_crop(out_dir, fixture, row_idx, "power", image, trace.power)
    if trace.points is not None:
        _save_field_crop(out_dir, fixture, row_idx, "points", image, trace.points)
    if trace.alliance_honor is not None:
        _save_field_crop(out_dir, fixture, row_idx, "alliance_honor", image, trace.alliance_honor)


def _compare_name(
    fixture: str,
    row_idx: int,
    want: dict,
    got: Any,
    conf: float,
    matches: dict[str, bool],
    anomalies: list[Anomaly],
) -> None:
    """Score the name field two ways and record any anomaly.

    - ``matches["name"]``       : fuzzy pass (gated metric).
    - ``matches["name_exact"]`` : byte-exact pass (informational metric).

    Emits at most one name anomaly per row:
    - FAIL      when the fuzzy check fails (got is unrecognisably wrong);
    - MISMATCH  when fuzzy passes but the name is not byte-exact — a real
      misread the fuzzy metric would otherwise silently absorb.
    A correct-but-low-confidence row emits its WARN in the caller instead.
    """
    name_fuzzy = _sim(got.name, want["name"]) >= 0.7
    name_exact = got.name == want["name"]
    matches["name"] = name_fuzzy
    matches["name_exact"] = name_exact
    if not name_fuzzy:
        anomalies.append(Anomaly("FAIL", fixture, row_idx, "name", want["name"], got.name, conf))
    elif not name_exact:
        anomalies.append(
            Anomaly("MISMATCH", fixture, row_idx, "name", want["name"], got.name, conf)
        )


def _compare_event_row(
    fixture: str, row_idx: int, want: dict, got: Any
) -> tuple[dict[str, bool], list[Anomaly]]:
    """Compare one event row. Returns (per-field correctness, anomalies)."""
    conf = float(got.confidence)
    matches: dict[str, bool] = {}
    anomalies: list[Anomaly] = []

    _compare_name(fixture, row_idx, want, got, conf, matches, anomalies)

    rank_match = got.rank == want["rank"]
    matches["rank"] = rank_match
    if not rank_match:
        anomalies.append(Anomaly("FAIL", fixture, row_idx, "rank", want["rank"], got.rank, conf))

    power_match = got.power == want["power"]
    matches["power"] = power_match
    if not power_match:
        anomalies.append(Anomaly("FAIL", fixture, row_idx, "power", want["power"], got.power, conf))

    points_match = got.points == want.get("points")
    matches["points"] = points_match
    if not points_match:
        anomalies.append(
            Anomaly("FAIL", fixture, row_idx, "points", want.get("points"), got.points, conf)
        )

    return matches, anomalies


def _compare_donation_row(
    fixture: str, row_idx: int, want: dict, got: Any
) -> tuple[dict[str, bool], list[Anomaly]]:
    """Compare one donation row. Returns (per-field correctness, anomalies)."""
    conf = float(got.confidence)
    matches: dict[str, bool] = {}
    anomalies: list[Anomaly] = []

    _compare_name(fixture, row_idx, want, got, conf, matches, anomalies)

    rank_match = got.rank == want["rank"]
    matches["rank"] = rank_match
    if not rank_match:
        anomalies.append(Anomaly("FAIL", fixture, row_idx, "rank", want["rank"], got.rank, conf))

    honor_match = got.alliance_honor == want["alliance_honor"]
    matches["alliance_honor"] = honor_match
    if not honor_match:
        anomalies.append(
            Anomaly(
                "FAIL",
                fixture,
                row_idx,
                "alliance_honor",
                want["alliance_honor"],
                got.alliance_honor,
                conf,
            )
        )

    return matches, anomalies


def _bench_event_type(
    event_type: str,
    fixtures_dir: Path,
    verbose: bool,
    dump_crops_dir: Path | None,
) -> BenchResult:
    """Run benchmark for one event type."""
    _empty = BenchResult(
        all_pass=True,
        fixtures_processed=0,
        anomalies=[],
        correct={},
        totals={},
        latencies=[],
    )

    parser = REGISTRY.get(event_type)
    if parser is None:
        return _empty

    fixtures = sorted(fixtures_dir.glob("*.json"))
    if not fixtures:
        print(f"\n[{event_type}] No JSON ground-truth fixtures — skipped.")
        return _empty

    with fixtures[0].open(encoding="utf-8") as fh:
        is_donation = json.load(fh).get("kind") == "donation"

    advisory = (fixtures_dir / _ADVISORY_MARKER).exists()

    targets = _DONATION_TARGETS if is_donation else _EVENT_TARGETS
    fields = list(targets.keys())
    # name_exact is tracked alongside the gated fields but never gated: it feeds
    # the informational summary row and a baseline entry (blocking on *new*
    # misreads), not the accuracy targets.
    tracked = fields + ["name_exact"]

    correct: dict[str, int] = {f: 0 for f in tracked}
    totals: dict[str, int] = {f: 0 for f in tracked}
    low_conf_count = 0
    total_members_got = 0
    latencies: list[float] = []
    fixture_rows: list[list[str]] = []
    skipped = 0
    anomalies: list[Anomaly] = []
    rowcount_notes: list[str] = []

    emit_trace = dump_crops_dir is not None

    for fixture_path in fixtures:
        with fixture_path.open(encoding="utf-8") as fh:
            expected = json.load(fh)

        image_path = fixture_path.with_suffix(".jpg")
        if not image_path.exists():
            print(f"  SKIP {fixture_path.stem}: image not found", file=sys.stderr)
            skipped += 1
            continue

        t0 = time.perf_counter()
        image = preprocess_image(str(image_path))
        # event_code aligne le bench sur la production : le layout de header
        # est choisi par code événement, pas deviné à l'OCR.
        result = parser.parse(image, emit_trace=emit_trace, event_code=event_type)
        latency = time.perf_counter() - t0
        latencies.append(latency)

        exp_members = expected.get("members", [])
        got_members = result.members
        total_members_got += len(got_members)
        paired = min(len(exp_members), len(got_members))

        # Rows are compared positionally (zip), so a dropped/extra parser row
        # doesn't just cost that row — it shifts every row after it, cascading
        # into a wall of unrelated mismatches. Flag the count gap explicitly so
        # that cascade is legible as one alignment fault, not N OCR faults.
        if len(exp_members) != len(got_members):
            rowcount_notes.append(
                f"  ROWCOUNT  {fixture_path.stem}: expected {len(exp_members)} rows,"
                f" got {len(got_members)} — positional comparison misaligns after"
                " the first missing/extra row"
            )

        fx: dict[str, int] = {f: 0 for f in tracked}
        fixture_anomalies: list[Anomaly] = []

        for i, (want, got) in enumerate(zip(exp_members, got_members, strict=False)):
            if isinstance(result, DonationParseResult):
                matches, row_anomalies = _compare_donation_row(fixture_path.stem, i, want, got)
            else:
                matches, row_anomalies = _compare_event_row(fixture_path.stem, i, want, got)

            for fname, ok in matches.items():
                if ok:
                    correct[fname] += 1
                    fx[fname] += 1

            fixture_anomalies.extend(row_anomalies)

            row_conf = float(got.confidence)
            row_low_conf = row_conf < CONFIDENCE_THRESHOLD
            if row_low_conf:
                low_conf_count += 1
                # Emit a WARN only when no FAIL/MISMATCH fired on this row's
                # name — otherwise that line already carries the confidence
                # (and similarity), and a second WARN would be redundant.
                name_flagged = any(
                    ra.field == "name" and ra.level in ("FAIL", "MISMATCH") for ra in row_anomalies
                )
                if not name_flagged:
                    fixture_anomalies.append(
                        Anomaly(
                            "WARN",
                            fixture_path.stem,
                            i,
                            "name",
                            want["name"],
                            got.name,
                            row_conf,
                        )
                    )

        anomalies.extend(fixture_anomalies)

        # Dump row + field crops, once per unique anomaly row, using the
        # trace coordinates the parser actually OCR'd (not a post-hoc
        # reconstruction from canonical constants).
        if dump_crops_dir is not None:
            dumped_rows: set[int] = set()
            for a in fixture_anomalies:
                if a.row in dumped_rows:
                    continue
                if a.row >= len(got_members):
                    continue
                trace = getattr(got_members[a.row], "trace", None)
                if trace is None:
                    logger.warning(
                        "no trace on %s row %d — skipping crop dump",
                        a.fixture,
                        a.row,
                    )
                    continue
                _dump_row_crops(dump_crops_dir, a.fixture, trace, image)
                dumped_rows.add(a.row)

        for field_name in tracked:
            totals[field_name] += len(exp_members)

        cells = [fixture_path.stem, str(len(exp_members)), str(len(got_members))]
        cells += [f"{fx[f]}/{paired}" for f in fields]
        cells.append(f"{latency:.1f}s")
        fixture_rows.append(cells)

    if not latencies:
        print(f"\n[{event_type}] All images missing — skipped.", file=sys.stderr)
        return _empty

    field_headers = [f.replace("_", " ").title() for f in fields]
    print(f"\n── [{event_type}] per-fixture " + "─" * 44)
    _print_table(["Fixture", "Exp", "Got"] + field_headers + ["Latency"], fixture_rows)

    if rowcount_notes:
        print(f"\n── [{event_type}] row-count mismatches " + "─" * 33)
        for note in rowcount_notes:
            print(note)

    if verbose and anomalies:
        print(f"\n── [{event_type}] anomalies " + "─" * 46)
        for a in anomalies:
            _emit_anomaly(a)

    all_pass = True
    summary_rows: list[list[str]] = []
    for field_name in fields:
        c, t = correct[field_name], totals[field_name]
        acc = c / t if t else 0.0
        tgt = targets[field_name]
        passed = acc >= tgt
        if not passed:
            all_pass = False
        summary_rows.append(
            [
                field_name,
                str(c),
                str(t),
                _pct(c, t),
                f"{tgt:.0%}",
                "PASS" if passed else "FAIL",
            ]
        )

    # Informational name_exact row: byte-exact name accuracy, never gated
    # (Target —, Status INFO). Makes fuzzy-absorbed misreads visible and is
    # persisted to the baseline so a *new* misread trips a REGRESSION.
    ce, te = correct["name_exact"], totals["name_exact"]
    summary_rows.append(["name_exact", str(ce), str(te), _pct(ce, te), "—", "INFO"])

    advisory_tag = "(ADVISORY — not gating) " if advisory else ""
    print(f"\n── [{event_type}] accuracy summary {advisory_tag}" + "─" * 37)
    _print_table(["Field", "Correct", "Total", "Accuracy", "Target", "Status"], summary_rows)
    if advisory:
        gated = "PASS" if all_pass else "FAIL"
        print(
            f"\n  ADVISORY scene: targets would {gated} but do not gate CI, and this"
            "\n  scene is kept out of baseline.json. Remove the"
            f" tests/fixtures/{event_type}/{_ADVISORY_MARKER}"
            "\n  marker (then --write-baseline) to promote it to blocking."
        )

    avg_lat = sum(latencies) / len(latencies)
    print(f"\n  Fixtures : {len(latencies)} processed, {skipped} skipped")
    print(f"  Avg latency per fixture  : {avg_lat:.2f}s")
    print(f"  Low-confidence rows      : {low_conf_count}/{total_members_got}")

    return BenchResult(
        all_pass=all_pass,
        fixtures_processed=len(latencies),
        anomalies=anomalies,
        correct=correct,
        totals=totals,
        latencies=latencies,
        advisory=advisory,
    )


def _load_baseline() -> dict | None:
    if not BASELINE_PATH.exists():
        return None
    with BASELINE_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


def _write_baseline(results_by_event: dict[str, BenchResult]) -> None:
    baseline: dict = {}
    for event_type, result in sorted(results_by_event.items()):
        if result.fixtures_processed == 0 or result.advisory:
            continue
        baseline[event_type] = {
            field_name: {
                "correct": result.correct[field_name],
                "total": result.totals[field_name],
            }
            for field_name in sorted(result.correct)
        }
    with BASELINE_PATH.open("w", encoding="utf-8") as fh:
        json.dump(baseline, fh, indent=2)
        fh.write("\n")
    print(f"Baseline written → {BASELINE_PATH}")


def _check_baseline(
    results_by_event: dict[str, BenchResult],
    baseline: dict,
) -> tuple[bool, list[str], list[str], int]:
    """Check current results against baseline.

    Returns (ok, regression_messages, warning_messages, improvement_points).
    Regressions: correct decreased with same total → fail.
    Warnings: total increased (new fixtures added) → warn, don't fail.
    improvement_points: sum of extra correct across fields that improved.
    """
    regressions: list[str] = []
    warnings: list[str] = []
    improvement = 0

    for event_type, event_bl in baseline.items():
        result = results_by_event.get(event_type)
        if result is None or result.fixtures_processed == 0 or result.advisory:
            continue
        for field_name, bl in event_bl.items():
            bl_correct: int = bl["correct"]
            bl_total: int = bl["total"]
            run_correct = result.correct.get(field_name, 0)
            run_total = result.totals.get(field_name, 0)

            if run_total > bl_total:
                warnings.append(
                    f"  WARN  {event_type}.{field_name}:"
                    f" total {bl_total}→{run_total} (new fixtures?)"
                    " — run --write-baseline to refresh"
                )
            elif run_total == bl_total:
                if run_correct < bl_correct:
                    regressions.append(
                        f"  REGRESSION  {event_type}.{field_name}:"
                        f" correct {bl_correct}→{run_correct} / {run_total}"
                    )
                elif run_correct > bl_correct:
                    improvement += run_correct - bl_correct

    return len(regressions) == 0, regressions, warnings, improvement


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--event-type", metavar="TYPE", help="Benchmark only this event type")
    ap.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Print one FAIL/WARN line per row anomaly",
    )
    ap.add_argument(
        "--dump-crops",
        metavar="DIR",
        help="Save row-crop PNGs for every FAIL/WARN entry into DIR",
    )
    ap.add_argument(
        "--write-baseline",
        action="store_true",
        help=(
            "Write current results to baseline.json and exit 0."
            " Use after a legitimate accuracy improvement."
        ),
    )
    args = ap.parse_args()

    if args.event_type:
        fixture_dirs = [FIXTURES_ROOT / args.event_type]
        if not fixture_dirs[0].is_dir():
            print(f"Fixture directory not found: {fixture_dirs[0]}", file=sys.stderr)
            return 1
    else:
        fixture_dirs = sorted(
            d for d in FIXTURES_ROOT.iterdir() if d.is_dir() and not d.name.startswith(".")
        )

    dump_crops_dir: Path | None = None
    if args.dump_crops:
        dump_crops_dir = Path(args.dump_crops)
        dump_crops_dir.mkdir(parents=True, exist_ok=True)

    results_by_event: dict[str, BenchResult] = {}
    all_accuracy_pass = True
    total_processed = 0
    total_anomalies = 0
    all_latencies: list[float] = []

    for fixture_dir in fixture_dirs:
        result = _bench_event_type(fixture_dir.name, fixture_dir, args.verbose, dump_crops_dir)
        results_by_event[fixture_dir.name] = result
        if not result.all_pass and not result.advisory:
            all_accuracy_pass = False
        total_processed += result.fixtures_processed
        total_anomalies += len(result.anomalies)
        all_latencies.extend(result.latencies)

    print("\n" + "═" * 72)
    if total_processed == 0:
        print("No fixtures were processed.", file=sys.stderr)
        return 1

    if args.write_baseline:
        _write_baseline(results_by_event)
        return 0

    if dump_crops_dir is not None:
        print(f"Crops written to {dump_crops_dir} ({total_anomalies} anomalies)")

    # --- latency budget ---
    latency_ok = True
    if all_latencies:
        max_avg = float(os.environ.get("OCR_BENCH_MAX_AVG_SECONDS", str(_DEFAULT_MAX_AVG_SECONDS)))
        max_fixture = float(
            os.environ.get("OCR_BENCH_MAX_FIXTURE_SECONDS", str(_DEFAULT_MAX_FIXTURE_SECONDS))
        )
        global_avg = sum(all_latencies) / len(all_latencies)
        global_max = max(all_latencies)
        print(
            f"\n  Global latency : avg={global_avg:.2f}s  max={global_max:.2f}s"
            f"  (budgets: avg≤{max_avg}s  max≤{max_fixture}s)"
        )
        if global_avg > max_avg:
            print(
                f"  LATENCY FAIL  avg {global_avg:.2f}s exceeds budget {max_avg}s",
                file=sys.stderr,
            )
            latency_ok = False
        if global_max > max_fixture:
            print(
                f"  LATENCY FAIL  max {global_max:.2f}s exceeds budget {max_fixture}s",
                file=sys.stderr,
            )
            latency_ok = False

    # --- baseline non-regression ---
    baseline_ok = True
    baseline = _load_baseline()
    if baseline is not None:
        baseline_ok, regressions, bl_warnings, improvement = _check_baseline(
            results_by_event, baseline
        )
        if bl_warnings:
            print()
            for w in bl_warnings:
                print(w)
        if not baseline_ok:
            print("\nBaseline regressions detected:", file=sys.stderr)
            for r in regressions:
                print(r, file=sys.stderr)
        if improvement > 0:
            print(
                f"\n  [baseline] +{improvement} correct point(s) ahead of baseline"
                " — run --write-baseline to refresh."
            )

    # --- final verdict ---
    overall_ok = all_accuracy_pass and baseline_ok and latency_ok
    if overall_ok:
        print(f"All checks passed  ({total_processed} fixtures).")
        return 0

    reasons: list[str] = []
    if not all_accuracy_pass:
        reasons.append("accuracy targets not met")
    if not baseline_ok:
        reasons.append("baseline regression")
    if not latency_ok:
        reasons.append("latency budget exceeded")
    print(
        f"FAIL : {', '.join(reasons)}  ({total_processed} fixtures).",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
