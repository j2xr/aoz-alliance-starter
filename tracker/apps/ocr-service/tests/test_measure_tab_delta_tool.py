"""Unit tests for tools/measure_tab_delta.py.

Pure functions only — no image, no disk I/O. Behavior on real images is
already covered by test_contribution_ranking_parser.py (which exercises
tab_zone_stats/_detect_selected_tab directly); this module only tests the
tool's own classification/aggregation logic.
"""

from pathlib import Path

from tools.measure_tab_delta import (
    NOISE_CEILING,
    SIGNAL_FLOOR,
    TabMeasurement,
    _default_inbox_root,
    classify_delta,
    format_report,
    summarize,
)

_THRESHOLD = 15.0  # default value of _TAB_DETECT_MIN_DELTA at the time of writing


def _measurement(delta: float, detected: str = "weekly") -> TabMeasurement:
    return TabMeasurement(
        path=Path("dummy.jpg"),
        width=1080,
        height=2400,
        means=(0.0, 0.0, 0.0),
        delta=delta,
        detected=detected,
    )


# ── classify_delta: bornes semi-ouvertes ────────────────────────────────────


def test_classify_delta_below_noise_ceiling_is_noise() -> None:
    assert classify_delta(9.9, threshold=_THRESHOLD) == "noise"


def test_classify_delta_at_noise_ceiling_is_below_threshold() -> None:
    assert classify_delta(NOISE_CEILING, threshold=_THRESHOLD) == "below_threshold"


def test_classify_delta_just_under_threshold_is_below_threshold() -> None:
    assert classify_delta(14.9, threshold=_THRESHOLD) == "below_threshold"


def test_classify_delta_at_threshold_is_dead_band() -> None:
    """The pivot this whole tool exists to watch: exactly at the effective
    threshold, a capture is ACCEPTED even though this is the weak edge of the
    dead band — no real capture has ever measured this low a signal."""
    assert classify_delta(_THRESHOLD, threshold=_THRESHOLD) == "dead_band"


def test_classify_delta_just_under_signal_floor_is_dead_band() -> None:
    assert classify_delta(25.0, threshold=_THRESHOLD) == "dead_band"


def test_classify_delta_at_signal_floor_is_signal() -> None:
    assert classify_delta(SIGNAL_FLOOR, threshold=_THRESHOLD) == "signal"


def test_classify_delta_well_above_signal_floor_is_signal() -> None:
    assert classify_delta(29.9, threshold=_THRESHOLD) == "signal"


def test_classify_delta_honours_a_non_default_threshold() -> None:
    """The threshold is env-overridable in production (OCR_TAB_DETECT_MIN_DELTA);
    the tool must classify against whatever value is actually effective, not a
    hardcoded 15.0."""
    assert classify_delta(28.0, threshold=30.0) == "below_threshold"


def test_classify_delta_dead_band_is_structurally_empty_above_signal_floor() -> None:
    """When threshold >= signal_floor, [threshold, signal_floor) is empty by
    construction — pins the invariant the tool is built to watch for."""
    assert classify_delta(SIGNAL_FLOOR, threshold=SIGNAL_FLOOR) != "dead_band"
    assert classify_delta(SIGNAL_FLOOR + 1.0, threshold=SIGNAL_FLOOR) == "signal"


# ── summarize ────────────────────────────────────────────────────────────────


def test_summarize_histogram_counts_each_band() -> None:
    measurements = [
        _measurement(5.0, "unknown"),  # noise
        _measurement(12.0, "unknown"),  # below_threshold
        _measurement(20.0, "weekly"),  # dead_band
        _measurement(27.0, "weekly"),  # signal
        _measurement(26.0, "daily"),  # signal
    ]
    histogram, _ = summarize(measurements, threshold=_THRESHOLD)
    assert histogram == {"noise": 1, "below_threshold": 1, "dead_band": 1, "signal": 2}


def test_summarize_per_tab_min_max_mean() -> None:
    measurements = [
        _measurement(26.0, "weekly"),
        _measurement(28.0, "weekly"),
        _measurement(27.0, "daily"),
    ]
    _, per_tab = summarize(measurements, threshold=_THRESHOLD)
    assert per_tab["weekly"] == {"n": 2, "min": 26.0, "max": 28.0, "mean": 27.0}
    assert per_tab["daily"] == {"n": 1, "min": 27.0, "max": 27.0, "mean": 27.0}
    assert "history" not in per_tab


# ── _default_inbox_root ──────────────────────────────────────────────────────


def test_default_inbox_root_never_raises() -> None:
    """Regression guard: this used to be a bare Path(__file__).resolve().parents[3],
    which raised IndexError when this file has fewer than 4 ancestors — exactly
    what happens when only apps/ocr-service (not the full monorepo) is copied
    into the Docker image, i.e. the container invocation the docstring itself
    documents. Must return a Path either way, never crash argparse setup."""
    assert isinstance(_default_inbox_root(), Path)


# ── format_report ────────────────────────────────────────────────────────────


def test_format_report_empty_list_does_not_divide_by_zero() -> None:
    report = format_report([], root=Path("data/inbox"), threshold=_THRESHOLD, total_scanned=0)
    assert "no sampleable Contribution Ranking capture found" in report


def test_format_report_reports_dead_band_count_and_margins() -> None:
    measurements = [_measurement(20.0, "weekly")]  # lands in the dead band
    report = format_report(
        measurements, root=Path("data/inbox"), threshold=_THRESHOLD, total_scanned=1
    )
    assert "dead-band captures: 1" in report


def test_format_report_separates_unsampleable_from_sampleable_counts() -> None:
    measurements = [
        _measurement(27.0, "weekly"),
        TabMeasurement(
            path=Path("too_short.jpg"),
            width=1080,
            height=50,
            means=(),
            delta=0.0,
            detected="unsampleable",
        ),
    ]
    report = format_report(
        measurements, root=Path("data/inbox"), threshold=_THRESHOLD, total_scanned=2
    )
    assert "2 contribution-ranking capture(s)" in report
    assert "1 of those could not be sampled" in report
