# Fixtures — Contribution Ranking / donations (emulator source)

Ground truth for `contribution_ranking_v1`'s emulator layout profile
(`_EMULATOR_LAYOUT`, see [aoz-alliance-starter#91](https://github.com/j2xr/aoz-alliance-starter/issues/91)).
Before this, this parser accepted only `PHONE_PROFILE` and rejected an
emulator-sourced donation screenshot outright — no capture of this screen
existed on this source at all.

## Source

Same 400×652 native-resolution emulator source as the sibling
`polar_invasion_emulator/`/`wasteland_showdown_emulator/` fixtures (see
those directories' READMEs for the capture pipeline). Captured 2026-08-22
via a remote-agent mission targeting Alliance → Alliance Management →
Contribution Ranking → Weekly, sweeping the full 64-member leaderboard
across 14 screens (`week1_01.png`-`week1_14.png`, only 11 of which carry
unique coverage — `_12`/`_13`/`_14` are redundant tail re-checks of the
same rows). The alliance turned out to have 64 donors, above the capture
prompt's 40-participant threshold for a full per-screen transcription, so
only a light, bounded transcription was collected per screen (see
provenance below) rather than the heavier full-detail pass used for the
sibling event fixtures.

## Ground truth provenance

Different from both siblings' provenance: neither a full visual
transcription (`polar_invasion_emulator`'s first 4 fixtures) nor a
remote-agent-then-corrected pass (`polar_invasion_emulator`'s 2026-08-22
addition, `wasteland_showdown_emulator`). Here, the remote agent captured
PNGs only (per the capture prompt's >40-participant rule, no
per-screen transcription was requested at all); the full 64-row ground
truth was built afterward by direct visual inspection of all 14 raw
captures, cross-validating the overlapping tail (ranks 56-64) against
three redundant screens that matched exactly. That master 64-row list
(kept in session notes, not versioned here) is the source each fixture's
`members` list was drawn from — see the "corrected against a name
already in the master list" convention below for how a JSON row and its
capture were kept consistent.

Two low-confidence entries in the master list, flagged there rather than
silently guessed, are worth carrying over here even though neither landed
in the 5 committed fixtures below: a rank-26 name with stacked Vietnamese
diacritics uncertain at this glyph size, and a rank-10 row whose commander
name renders genuinely blank on screen (avatar and alliance tag visible,
no name text at all — a real game-UI state, not a transcription gap).

## Selected fixtures

5 of the 14 captures, chosen to cover distinct scroll depths and failure
classes rather than the full redundant set:

| Fixture | Ranks shown | Why included |
|---|---|---|
| `week1_01` | 1-9 | Top of list — the only capture showing rank-1's oversized decorative medal graphic (see the list-top detection section below) |
| `week1_04` | 12-20 | Mid-list, clean |
| `week1_08` | 37-44 | Mid-list, clean, disjoint scroll offset from `week1_04` |
| `week1_09` | 40-48 | Overlaps `week1_08` by 5 rows (40-44) — deliberately kept rather than trimmed, since the overlap is itself evidence `_detect_list_top` finds the *correct* row regardless of exactly where in the row's own pixel range the topmost visible content starts (see below) |
| `week1_13` | 56-64 minus 61 | Near the end of the list; exercises the bottom-of-image row-count guard, and includes 4 members with `alliance_honor=0` (ties — the honor-monotonicity guard's `> 0` truncation exemption) |

Rank 61 (`jasmin`, decorated name `ω|ĵαʂɱιη|ω` in the master list, `0`
honor) is visible in `week1_13`'s raw capture but the parser produces no
row for it — same core-name-decoration difficulty documented in the
sibling `polar_invasion_emulator` fixtures for the same player. Excluded
from `week1_13.json`'s `members`, not silently padded in.

**`week1_10` (ranks ~46-51) was captured but is deliberately not
committed.** It covers the alliance's own account row (`3jr`, rank 49,
green-highlighted — same UI class documented as hostile-to-OCR in the
sibling `polar_invasion_emulator`/`wasteland_showdown_emulator` fixtures)
immediately followed by the alliance leader's R5 row (`Lucid_Air_Rules`,
rank 50). Measured: every one of this capture's 6 parsed rows has an
`alliance_honor` value that matches no entry in the master ground truth
at all — not a misread of a nearby plausible value, but confidently wrong
across the board, consistent with the highlight degrading contrast for
the whole neighborhood, not just its own row. Including it would gate this
suite's accuracy floors on a single already-known failure class rather
than measuring the general case. Left as a known, documented gap; the
original PNG is retained at the capture source (session notes, not
versioned in this repo), should this need revisiting.

## A real geometry bug this corpus caught and fixed

`_RANK_BADGE_X_EMULATOR`/`_RANK_BADGE_Y_OFF_EMULATOR` shipped their first
measured values — `(215, 320)` / `(0, 62)` — from an eyeballed pixel-grid
overlay, the same method used successfully for `_NAME_X_EMULATOR` etc.
Cross-checking early parser output against this fixture set's own ground
truth (built independently of the OCR) showed rank badly under-performing
name/honor on the exact same rows — e.g. `week1_04`'s `CEKATOP_1000` (true
`R1`) read as `R4`, `CumStang` (true `R2`) read as `R3` — while every one
of those rows' name and honor were already correct, which rules out a
list-top/row-index misalignment (that would have broken all three fields
identically). Re-measured directly via tesseract OCR bounding boxes for
literal `"R1".."R5"` text (the badge is real, if low-contrast, text — not
a pure icon) across 16 rows spanning 2 captures: the true left edge was
`x=198`, not `215` — every crop was clipping the first ~17px of the badge,
including part of the digit glyph on some rows — and the text top sat
consistently ~20-24px below the row anchor, not ~0px. `(180, 300)` /
`(10, 58)` are the corrected values, with margin on every side of the
re-measurement. See `_RANK_BADGE_X_EMULATOR`'s docstring in
`contribution_ranking_v1.py` for the full measurement.

## List-top detection: two more false positives this corpus caught

Reusing `_detect_list_top`'s existing periodicity-based algorithm (see
`polar_invasion_v1`'s and this module's own docstrings) needed two
additional, donation-screen-specific fixes beyond the usual per-profile
geometry — both found by running the full 14-capture sweep and comparing
row-by-row against ground truth, not by inspecting the algorithm in the
abstract:

- **The sticky column-header casts a full-width drop-shadow/divider
  gradient** immediately below it (`y≈280-310`), which is *also* sticky
  (present at the identical position on every capture regardless of
  scroll — verified via tesseract bboxes on `"Commander"`/`"Name"` text
  landing at the identical `top=232` on captures spanning ranks 1 through
  64). The gradient is tall enough to clear the periodicity check's
  minimum band height and, on 5 of the 14 captures, coincidentally had
  *something* a row-pitch below it, so it got accepted as row 0 — reading
  gradient noise as a name. Position alone can't separate it from real
  text: one capture's genuine row-0 text starts at `y=290`, inside the
  gradient's own range. Fixed with a content check, not a position one —
  `_Layout.list_top_dark_pixel_value` — measured on the gradient
  (min=196, std=7.5, 0% of pixels below 100) vs. real text (min=2-10,
  std=38-50, 5-10% of pixels below 100) on 4 sampled bands.
- **The R-badge column aliases against itself.** Badge discs repeat at the
  row pitch exactly like real text (row 0's badge is one `row_h` above row
  1's), and a badge candidate is found *before* the real name band because
  the badge sits higher in the row. An `x`-band starting before ~350
  therefore lets the periodicity check validate a badge against the next
  row's badge instead of a name against the next row's name — worst case
  `week1_01`, where rank-1's oversized medal graphic (~115px tall) is an
  especially strong false candidate. Fixed by scanning a narrower `x`-band
  (`list_top_scan_x=(380, 900)`) that excludes the avatar/badge column
  entirely.

Both fixes are measured against this same corpus in
`tests/test_contribution_ranking_emulator_parser.py`. A wide,
nearly-full-frame search window was tried as a third fix (reasoning: the
capture pipeline scrolls deliberately, so row 0 could in principle be
anywhere) and reverted — the sticky header (see above) makes the topmost
visible row always render at the same canonical `y`, so the wide window
only made the badge-aliasing false positive easier to trigger, without
fixing anything a narrow, phone-style window didn't already handle.

## Quality: measured

Scored against the master 64-row ground truth (not just the 5 committed
fixtures) by matching each parsed row to its ground-truth row via exact
`alliance_honor` + best name-similarity match, across all 14 captures —
118 total parsed rows, 111 honor-matched (the 7 unmatched are `week1_10`'s
5 rows plus 2 occurrences of a `5`→`9` digit misread on `ahmed`'s honor,
575 misread as 975). Measured in the CI-equivalent Docker environment
(`tracker-ocr-service:latest`) — see the sibling `polar_invasion_emulator/`
README for why a bare local `.venv` gives different numbers.

| Field | Measured (of 111 honor-matched rows) |
|---|---|
| `alliance_honor` | 111/118 (94.1%) — see the 7 misses above |
| `name` (similarity ≥0.85) | 103/111 (92.8%) |
| `rank` | 93/111 (83.8%) |
| `alliance_tag` (case-insensitive) | 94/111 (84.7%) |

`rank` and `alliance_tag` are the two weakest fields, both measured *after*
the badge-geometry fix above — this is the corrected number, not the
pre-fix one. Per-fixture floors in the test suite are set from the 5
committed fixtures specifically (a smaller, cleaner sample than the full
118-row corpus, since 3 of the excluded 9 captures are pure redundant
re-checks and a 4th is `week1_10`'s known gap) — see the test file's
module docstring for the exact per-fixture counts these floors were
derived from.
