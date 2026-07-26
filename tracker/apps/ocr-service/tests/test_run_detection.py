"""Unit tests for the shared contiguous-run scan behind both list_top detectors."""

import numpy as np

from app.parsers.run_detection import find_runs


def test_finds_basic_runs() -> None:
    mask = np.array([0, 1, 1, 1, 0, 0, 1, 1, 0], dtype=bool)
    assert find_runs(mask) == [(1, 4), (6, 8)]


def test_no_runs_returns_empty() -> None:
    mask = np.array([0, 0, 0, 0], dtype=bool)
    assert find_runs(mask) == []


def test_min_len_excludes_short_runs() -> None:
    mask = np.array([1, 1, 0, 1, 1, 1, 1, 0], dtype=bool)
    assert find_runs(mask, min_len=3) == [(3, 7)]


def test_max_len_excludes_long_runs() -> None:
    mask = np.array([0, 1, 1, 0, 1, 1, 1, 1, 0], dtype=bool)
    assert find_runs(mask, max_len=3) == [(1, 3)]


def test_drop_clipped_start_default_excludes_run_touching_index_zero() -> None:
    # The run "on" at index 0 has no visible start — its true length is
    # unknown, so it's dropped by default (ContributionRankingV1Parser's
    # model: a window into a larger signal, not a scan from a fixed origin).
    mask = np.array([1, 1, 1, 0, 1, 1, 0], dtype=bool)
    assert find_runs(mask) == [(4, 6)]


def test_drop_clipped_start_false_keeps_run_touching_index_zero() -> None:
    # PolarInvasionV1Parser's model: the scan already starts at a fixed
    # absolute offset, so bright-at-offset is a legitimate start, not an
    # artifact of the window boundary.
    mask = np.array([1, 1, 1, 0, 1, 1, 0], dtype=bool)
    assert find_runs(mask, drop_clipped_start=False) == [(0, 3), (4, 6)]


def test_clipped_end_excluded_by_default() -> None:
    mask = np.array([0, 1, 1, 0, 1, 1, 1], dtype=bool)
    assert find_runs(mask) == [(1, 3)]


def test_include_clipped_end_keeps_it_when_within_length_bounds() -> None:
    mask = np.array([0, 1, 1, 0, 1, 1, 1], dtype=bool)
    assert find_runs(mask, include_clipped_end=True, max_len=3) == [(1, 3), (4, 7)]


def test_include_clipped_end_still_respects_length_bounds() -> None:
    # A trailing run that's already too long to qualify isn't rescued just
    # because it happens to run off the end of the mask.
    mask = np.array([0, 1, 1, 1, 1, 1], dtype=bool)
    assert find_runs(mask, include_clipped_end=True, max_len=3) == []


def test_run_clipped_at_both_start_and_end_dropped_by_default() -> None:
    mask = np.array([1, 1, 1, 1], dtype=bool)
    assert find_runs(mask) == []


def test_run_clipped_at_both_ends_kept_when_both_flags_set() -> None:
    mask = np.array([1, 1, 1, 1], dtype=bool)
    assert find_runs(mask, drop_clipped_start=False, include_clipped_end=True) == [(0, 4)]
