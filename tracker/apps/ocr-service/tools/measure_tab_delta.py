"""Measures the distribution of tab-detection deltas (_detect_selected_tab)
over a real corpus of screenshots, to empirically verify the current
ambiguity policy instead of redoing it by hand each time.

Context: contribution_ranking_v1.py now rejects a screenshot ("unknown")
when no tab pill stands out clearly (delta < OCR_TAB_DETECT_MIN_DELTA
= 15.0 by default), instead of silently assuming "weekly". This threshold
was chosen between a measured noise floor (10.1, poorly aimed band) and a
measured signal ceiling (25.1, correct band) over 56 images during the
2026-07-26 fix — but those two numbers came out of a throwaway probing
script that was never checked in. This tool reproduces the exact same
measurement (via tab_zone_stats, the function _detect_selected_tab itself
uses in production), in a replayable way, to answer the question left open:
"how often will a real Weekly screenshot land in the dead band
[threshold, 25.1) and be wrongly rejected?".

Usage (from apps/ocr-service/, host venv — data/inbox is NOT mounted in
the ocr-service container, see docker-compose.yml):

    uv run python tools/measure_tab_delta.py                     # data/inbox by default
    uv run python tools/measure_tab_delta.py --include-fixtures
    uv run python tools/measure_tab_delta.py --json > report.json
    # exit 1 if the dead band isn't empty:
    uv run python tools/measure_tab_delta.py --fail-on-dead-band

Via Docker — actually verified to work on this host (unlike an earlier
version of this docstring): the Dockerfile copies ONLY app/ into the
image (see Dockerfile), so tools/ must be mounted explicitly in addition
to data/inbox; --no-deps avoids starting discord-bot; JOBS_DB_PATH avoids
touching the ./data/ocr volume shared with the real production container
(see entrypoint.sh):

    cd tracker
    docker compose run --rm --no-deps \\
        -e JOBS_DB_PATH=/tmp/jobs.db \\
        -v "$PWD/apps/ocr-service/tools:/app/tools:ro" \\
        -v "$PWD/data/inbox:/inbox:ro" \\
        ocr-service python tools/measure_tab_delta.py --root /inbox
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from app.dispatcher import DONATION_CODE, UnknownEventError, detect_screen_kind
from app.parsers.contribution_ranking_v1 import _TAB_DETECT_MIN_DELTA, _TABS_ORDER, tab_zone_stats
from app.preprocess import preprocess_image

# Benchmarks measured on 2026-07-26 (see the calibration comment in
# contribution_ranking_v1.py): noise ceiling of the old poorly-aimed band,
# signal floor of the correct band. This tool exists to RE-VERIFY these two
# numbers, not to redefine them — if they drift with new screenshots, this
# is where it should be noticed, not in a frozen comment that will never be
# reread.
NOISE_CEILING = 10.1
SIGNAL_FLOOR = 25.1

IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png")


@dataclass(frozen=True)
class TabMeasurement:
    path: Path
    width: int
    height: int
    means: tuple[float, ...]
    delta: float
    detected: str  # "daily" | "weekly" | "history" | "unknown" | "unsampleable"


def classify_delta(
    delta: float,
    *,
    threshold: float,
    noise_ceiling: float = NOISE_CEILING,
    signal_floor: float = SIGNAL_FLOOR,
) -> str:
    """'noise' | 'below_threshold' | 'dead_band' | 'signal'.

    Half-open bounds (see test_measure_tab_delta_tool.py for each pivot
    value):
      noise           : delta <  noise_ceiling
      below_threshold : noise_ceiling <= delta < threshold
      dead_band       : threshold     <= delta < signal_floor  -- must stay empty
      signal          : delta >= signal_floor

    'dead_band' = accepted by the current threshold even though NO measured
    real screenshot ever produced a signal that weak. If this band fills
    up, the threshold or the tab band has drifted since calibration.
    """
    if delta < noise_ceiling:
        return "noise"
    if delta < threshold:
        return "below_threshold"
    if delta < signal_floor:
        return "dead_band"
    return "signal"


def is_contribution_ranking(image: object) -> bool:
    """detect_screen_kind() raises UnknownEventError on an unrecognized header
    — treated as "not a Contribution Ranking", not as an error."""
    try:
        kind, code = detect_screen_kind(image)  # type: ignore[arg-type]
    except UnknownEventError:
        return False
    return kind == "donation" and code == DONATION_CODE


def iter_images(roots: Sequence[Path]) -> Iterator[Path]:
    """*.jpg/*.jpeg/*.png, recursive, sorted (deterministic), deduplicated across roots."""
    seen: set[Path] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for suffix in IMAGE_SUFFIXES:
            for path in sorted(root.rglob(f"*{suffix}")):
                if path not in seen:
                    seen.add(path)
                    yield path


def measure_image(path: Path, *, screen_filter: bool) -> TabMeasurement | None:
    """None = image skipped (not a Contribution Ranking when screen_filter=True,
    or unreadable file). An image that's recognized but geometrically
    unsampleable (tab_zone_stats() -> None) is still reported, with
    detected='unsampleable', rather than silently disappearing."""
    try:
        image = preprocess_image(str(path))
    except Exception as exc:
        print(f"[skip] {path}: {exc}", file=sys.stderr)
        return None

    if screen_filter and not is_contribution_ranking(image):
        return None

    h, w = image.shape[:2]
    stats = tab_zone_stats(image)
    if stats is None:
        return TabMeasurement(
            path=path, width=w, height=h, means=(), delta=0.0, detected="unsampleable"
        )
    means, delta, idx = stats
    return TabMeasurement(
        path=path, width=w, height=h, means=tuple(means), delta=delta, detected=_TABS_ORDER[idx]
    )


def summarize(
    measurements: Sequence[TabMeasurement], *, threshold: float
) -> tuple[dict[str, int], dict[str, dict[str, float]]]:
    """(histogram per band, min/max/mean stats per detected tab).

    Only expects sampleable measurements (`detected != 'unsampleable'`) —
    filter before calling.
    """
    histogram = {"noise": 0, "below_threshold": 0, "dead_band": 0, "signal": 0}
    per_tab: dict[str, list[float]] = {}

    for m in measurements:
        band = classify_delta(m.delta, threshold=threshold)
        histogram[band] += 1
        per_tab.setdefault(m.detected, []).append(m.delta)

    per_tab_stats = {
        tab: {
            "n": len(deltas),
            "min": min(deltas),
            "max": max(deltas),
            "mean": sum(deltas) / len(deltas),
        }
        for tab, deltas in per_tab.items()
    }
    return histogram, per_tab_stats


def format_report(
    measurements: Sequence[TabMeasurement], *, root: Path, threshold: float, total_scanned: int
) -> str:
    sampleable = [m for m in measurements if m.detected != "unsampleable"]
    unsampleable_count = len(measurements) - len(sampleable)

    lines: list[str] = []
    lines.append("=== tab-detection delta sweep ===")
    lines.append(f"root:                              {root}")
    lines.append(f"_TAB_DETECT_MIN_DELTA (effective): {threshold}")
    lines.append(
        f"band edges:                        "
        f"noise_ceiling={NOISE_CEILING}  signal_floor={SIGNAL_FLOOR}"
    )
    lines.append(
        f"scanned:                           {total_scanned} image(s) -> "
        f"{len(measurements)} contribution-ranking capture(s)"
    )
    if unsampleable_count:
        lines.append(f"  ({unsampleable_count} of those could not be sampled — too short/narrow)")

    if not sampleable:
        lines.append("\n(no sampleable Contribution Ranking capture found)")
        return "\n".join(lines)

    lines.append("\nper-image (sorted by delta asc):")
    for m in sorted(sampleable, key=lambda m: m.delta):
        means_str = "[" + ", ".join(f"{v:.1f}" for v in m.means) + "]"
        lines.append(
            f"  delta={m.delta:5.1f}  {m.detected:<8} means={means_str}  "
            f"{m.width}x{m.height}  {m.path}"
        )

    histogram, per_tab = summarize(sampleable, threshold=threshold)
    lines.append("\nband histogram:")
    lines.append(f"  < {NOISE_CEILING:<10}  noise / no signal          : {histogram['noise']:>3}")
    lines.append(
        f"  {NOISE_CEILING} - {threshold:<7}below threshold (rejected) : "
        f"{histogram['below_threshold']:>3}"
    )
    lines.append(
        f"  {threshold} - {SIGNAL_FLOOR:<7}DEAD BAND                  : "
        f"{histogram['dead_band']:>3}   <-- must stay 0"
    )
    lines.append(f"  >= {SIGNAL_FLOOR:<9} real signal                : {histogram['signal']:>3}")

    lines.append("\nper-detected-tab deviation:")
    for tab in (*_TABS_ORDER, "unknown"):
        stats = per_tab.get(tab)
        if stats is None:
            lines.append(f"  {tab:<7}: n=0")
        else:
            lines.append(
                f"  {tab:<7}: n={stats['n']:<4} min={stats['min']:.1f}  "
                f"max={stats['max']:.1f}  mean={stats['mean']:.1f}"
            )

    dead_band = histogram["dead_band"]
    margin_below = threshold - NOISE_CEILING
    margin_above = SIGNAL_FLOOR - threshold
    lines.append(
        f"\ndead-band captures: {dead_band}   "
        f"(threshold {threshold} has {margin_below:.1f} of noise margin below "
        f"and {margin_above:.1f} of signal margin above)"
    )
    return "\n".join(lines)


def _default_inbox_root() -> Path:
    """tools/measure_tab_delta.py -> tools -> ocr-service -> apps -> tracker
    (4 parents) in a full monorepo checkout. Inside the Docker image only
    apps/ocr-service is copied to /app, so there's no "tracker" ancestor to
    find there — fall back to a path that simply won't exist rather than
    raising IndexError; main() already handles a missing root by requiring
    --root explicitly (see the module docstring's Docker invocation)."""
    here = Path(__file__).resolve()
    if len(here.parents) > 3:
        return here.parents[3] / "data" / "inbox"
    return here.parent / "_no_default_inbox_root_pass_--root_explicitly"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    default_root = _default_inbox_root()
    fixtures_root = (
        Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "contribution_ranking"
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=default_root,
        help=f"Root to scan (default: {default_root})",
    )
    parser.add_argument(
        "--include-fixtures", action="store_true", help="Also include the test fixtures"
    )
    parser.add_argument(
        "--no-screen-filter",
        action="store_true",
        help=(
            "Don't filter by screen type (measures every image as if it were "
            "a Contribution Ranking) — faster (skips header OCR), "
            "reserved for an already-homogeneous folder (e.g. fixtures/), not data/inbox."
        ),
    )
    parser.add_argument(
        "--json", action="store_true", help="JSON output instead of the text report"
    )
    parser.add_argument(
        "--fail-on-dead-band",
        action="store_true",
        help="Exit code 1 if the dead band [threshold, signal_floor) isn't empty",
    )
    args = parser.parse_args()

    roots = [args.root]
    if args.include_fixtures:
        roots.append(fixtures_root)

    if not any(r.is_dir() for r in roots):
        print(f"No root found among: {[str(r) for r in roots]}", file=sys.stderr)
        return 2

    screen_filter = not args.no_screen_filter
    all_paths = list(iter_images(roots))
    measurements = [
        m
        for path in all_paths
        if (m := measure_image(path, screen_filter=screen_filter)) is not None
    ]

    if args.json:
        payload = {
            "root": str(args.root),
            "threshold": _TAB_DETECT_MIN_DELTA,
            "total_scanned": len(all_paths),
            "measurements": [{**asdict(m), "path": str(m.path)} for m in measurements],
        }
        print(json.dumps(payload, indent=2))
    else:
        print(
            format_report(
                measurements,
                root=args.root,
                threshold=_TAB_DETECT_MIN_DELTA,
                total_scanned=len(all_paths),
            )
        )

    if args.fail_on_dead_band:
        sampleable = [m for m in measurements if m.detected != "unsampleable"]
        histogram, _ = summarize(sampleable, threshold=_TAB_DETECT_MIN_DELTA)
        if histogram["dead_band"] > 0:
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
