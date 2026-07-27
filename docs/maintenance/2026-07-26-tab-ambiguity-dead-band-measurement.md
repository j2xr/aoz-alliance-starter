# Tab-ambiguity dead-band measurement — 2026-07-26

**Question this answers** (deferred from the tab-misdetection fix, PR #27): with
`_TAB_DETECT_MIN_DELTA = 15.0` sitting between the measured noise ceiling (10.1) and signal floor
(25.1), how often does a *legitimate* Weekly (or Daily) capture land in the resulting
`[15.0, 25.1)` "dead band" and get falsely rejected as `"unknown"`?

**Answer: zero, across the full corpus available today.** Measured with the rerunnable tool this
PR adds (`tools/measure_tab_delta.py`), which reuses the exact production function
(`tab_zone_stats`) rather than a re-derivation — replacing the throwaway probe script the original
10.1/25.1 numbers came from.

```
$ uv run python tools/measure_tab_delta.py --root tracker/data/inbox --include-fixtures

=== tab-detection delta sweep ===
_TAB_DETECT_MIN_DELTA (effective): 15.0
band edges:                        noise_ceiling=10.1  signal_floor=25.1
scanned:                           197 image(s) -> 57 contribution-ranking capture(s)

band histogram:
  < 10.1        noise / no signal          :   0
  10.1 - 15.0   below threshold (rejected) :   0
  15.0 - 25.1   DEAD BAND                  :   0   <-- must stay 0
  >= 25.1      real signal                :  57

per-detected-tab deviation:
  daily  : n=9    min=27.7  max=27.7  mean=27.7
  weekly : n=48   min=29.3  max=29.4  mean=29.3
  history: n=0
  unknown: n=0

dead-band captures: 0   (threshold 15.0 has 4.9 of noise margin below and 10.1 of signal margin above)
```

57 = 46 real captures (8 Daily + 38 Weekly, matching the original calibration count) + 11 fixtures
(1 `daily_001.jpg` + 10 `weekly_*.jpg`). The raw image count (197) is higher than the 186 cited
during the original fix because more screenshots (non-Contribution-Ranking ones) have since been
added to `data/inbox` — the screen-kind filter correctly excludes them from this measurement.

**Every single measured capture, real or fixture, lands at 27.7–29.4** — comfortably inside the
`>= 25.1` signal band, nowhere near the `[15.0, 25.1)` dead band. The threshold currently has 4.9
of margin below (to the noise ceiling) and 10.1 of margin above (to the observed signal floor).

**Caveat, stated honestly**: this is a retrospective measurement over the corpus that exists today,
not a guarantee about every possible future capture (different phone models, display scaling, or
game UI updates could shift the ink density). That's exactly why this tool is checked into the repo
rather than being a one-off: re-run it periodically as `data/inbox` grows
(`uv run python tools/measure_tab_delta.py --fail-on-dead-band` for a scriptable pass/fail check),
and if the dead band ever stops being empty, that's the signal to revisit the threshold — not a
hypothetical worth pre-optimizing for now.
