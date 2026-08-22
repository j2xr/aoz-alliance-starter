# Fixtures — Wasteland Showdown (emulator source, 2-column header)

Ground truth for `_EMULATOR_LAYOUT`'s 2-column header bands
(`_Layout.battlers_x_2col`/`total_points_x_2col`, measured 2026-08-22 — see
[aoz-alliance-starter#91](https://github.com/j2xr/aoz-alliance-starter/issues/91)).

Separate from `tests/fixtures/polar_invasion_emulator/`: that suite's
event codes (`polar_invasion`, `triangle_war`) are all 3-column
(`_THREE_COL_EVENTS`); `wasteland_showdown` is 2-column
(`_TWO_COL_EVENTS`), a different header crop entirely. Also separate from
`tests/fixtures/wasteland_showdown/` (the existing phone-source fixtures
for this same event): that directory's loader (`test_v1_event_parsers.py`)
hardcodes a `.jpg` sibling and calls `parse()` with no event code, neither
of which fits an emulator `.png` capture — a new directory avoided
retrofitting that loader for one source-format difference.

## Source

Same 400×652 native-resolution emulator source as the sibling
`polar_invasion_emulator/` fixtures (see that directory's README for the
capture pipeline and preprocessing details). `_007`/`_008` are the first
emulator captures of a 2-column event ever checked against ground truth —
before 2026-08-22, `parse()` refused these event codes on this profile
outright (no measured bands existed; see `_Layout.battlers_x_2col`'s
docstring in `polar_invasion_v1.py` for the corruption that guard exists
to prevent).

## Ground truth provenance

Same remote-agent-transcribed-then-corrected process as the 2026-08-22
addition to `polar_invasion_emulator/` (see that README): a first pass by
eye, corrected against an independently-verified name list (session notes,
not versioned in this repo) where a name overlapped it. One correction
applied: **`ŠigŠteelĈurtain`** (`_007`, flagged low-confidence by the
transcriber) → **`BigSteelCurtain`**, confirmed against the reference file.
All other names either match that reference exactly or are plain ASCII
with no plausible ambiguity at this resolution.

`_008` also contains the account that captured it ("this is you"),
highlighted with green text — same row class as `jjr` in the sibling
`polar_invasion_emulator/` fixtures (`_003`/`_004`/`_005`), and it fails
the same way here (see Quality below).

## Two occurrences, one purpose each

- **`_007`** (2026-03-20) and **`_008`** (2026-03-27) are two different
  dates of the same event type — the minimum needed to confirm the header
  bands aren't a one-off fit to a single capture's exact pixel layout.
- **`O1a`/`O1b`** are not accuracy fixtures (no JSON, no ground-truth
  claim) — they're the same on-screen list as `_008`, recaptured ~5
  minutes apart with no interaction in between, used by
  `test_determinism_across_recaptured_screens` in the test file. The two
  PNGs are **not** byte-identical: they differ by ~1300 pixels in a small
  region (a cosmetic avatar-frame animation) that overlaps the rank-badge
  crop x-band — measured, not assumed. The parser's output is identical
  between them regardless. Practical implication noted for production too:
  the bot's upload-dedup gate keys on `file_hash`, so two screenshots of an
  untouched screen a few minutes apart will not dedup against each other
  even though nothing meaningful changed.

## Quality: header, measured

| Field | `_007` | `_008` |
|---|---|---|
| `total_battlers` | 10 — exact | 14 — exact |
| `total_points` | 2565 — exact | 4110 — exact |
| `event_datetime` | exact | exact |
| member count | 8/8 | 8/8 |

Measured in the CI-equivalent Docker environment
(`tracker-ocr-service:latest`) — see the sibling `polar_invasion_emulator/`
README for why a bare local `.venv` gives different numbers.

Per-row name/rank accuracy is measured but **not** gated in CI here (16
rows is too few for a floor to mean anything — one miss moves the number
6+ points): `_007` and `_008` combined read 10/16 names correctly
(similarity ≥0.66) and 14/16 ranks correctly. Notably, the `jjr` row in
`_008` (green highlight, same "this is you" row class as `jjr` in the
sibling `polar_invasion_emulator/` fixtures) reads **correctly** here on
both fields — the highlight alone doesn't guarantee a miss, contradicting
what a first read of the sibling README's cases might suggest. The actual
misses are ordinary hard glyphs: `Mjölnir`'s umlaut (both occurrences),
`moco` (misread two different ways across the two captures), `焼鳥_Yakitori`
(CJK + underscore), `Floki` (`_008` row 5, also the source of one of the 2
rank misses). `NAPPA`'s rank misreads in `_007` (R1 read as R2) — the same
player also has a rank miss in the sibling `polar_invasion_emulator/`
corpus (`_002` row 2, R1 read as R4 there) — is the one recurring name
across both corpora, suggestive but not confirmed as a per-player badge
issue rather than coincidence with only 2 data points.
