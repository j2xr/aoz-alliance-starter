"""Shared contiguous-run scan behind both list_top detectors.

ContributionRankingV1Parser._detect_list_top (text-density bands) and
PolarInvasionV1Parser._detect_list_top (bright separator zones) both reduce
their signal to a boolean mask and then scan it for contiguous True-runs —
PR #22 made the two algorithmically identical. Kept as a plain Python loop
rather than a numpy vectorization: measured (see contribution_ranking_v1's
history) at 7.3x SLOWER than the loop, which breaks at the first qualifying
run instead of scanning the whole array unconditionally.
"""

from collections.abc import Sequence

import numpy as np


def find_runs(
    mask: Sequence[bool] | np.ndarray,
    *,
    min_len: int = 1,
    max_len: int | None = None,
    drop_clipped_start: bool = True,
    include_clipped_end: bool = False,
) -> list[tuple[int, int]]:
    """Contiguous True-runs in `mask`, as half-open (start, end) index pairs.

    Only runs whose length falls within [min_len, max_len] are returned
    (max_len=None means no upper bound).

    A run already "on" at index 0 has an unknown true start — `mask` may be
    a window into a larger signal, so nothing before index 0 was measured.
    Dropped by default (drop_clipped_start=True): a caller that would use
    this run's length in a decision can't trust a partial one. Set
    drop_clipped_start=False for a caller with no such concept of "before
    the window" (e.g. one that already scans from a fixed absolute offset
    and treats bright-at-offset as a legitimate start).

    A run still "on" when the scan ends is symmetrically unmeasurable —
    excluded unless include_clipped_end=True, in which case it's kept
    PROVIDED its visible length already satisfies [min_len, max_len]
    (mirrors PolarInvasionV1Parser._detect_list_top's separator-zone scan,
    which accepts a trailing zone this way rather than assuming it would
    have stayed narrow enough had the scan continued).
    """
    runs: list[tuple[int, int]] = []
    run_start: int | None = None
    n = len(mask)

    def _fits(start: int, end: int) -> bool:
        length = end - start
        return length >= min_len and (max_len is None or length <= max_len)

    for i, v in enumerate(mask):
        if v and run_start is None:
            run_start = i
        elif not v and run_start is not None:
            if (not drop_clipped_start or run_start > 0) and _fits(run_start, i):
                runs.append((run_start, i))
            run_start = None

    if (
        run_start is not None
        and (not drop_clipped_start or run_start > 0)
        and include_clipped_end
        and _fits(run_start, n)
    ):
        runs.append((run_start, n))

    return runs
