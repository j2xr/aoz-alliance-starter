# Contribution Ranking fixtures

Screenshots of the mobile game's "Contribution Ranking" screen (Alliance Honor /
resource donations), provided by the user during the initial delivery of
donation tracking.

## Naming convention

```
weekly_<NNN>.jpg    raw screenshot (Android, ~1080×2400 portrait)
weekly_<NNN>.json   expected parser output (DonationParseResult)
daily_<NNN>.jpg     raw screenshot, Daily tab — see §5, NO associated .json
```

The `<NNN>` number reflects scroll order **within a capture session**:
`weekly_001` shows the top of the list (ranks 1 to 12), `weekly_009` the
bottom (ranks 75 to 86). Overlaps of 1 to 3 lines exist between consecutive
screenshots — the parser doesn't need to handle them (that's the bot-side
UPSERT, on `(donation_period_id, player_id)`, that merges them).

`<NNN>` is **not** a globally monotonic rank index: `weekly_001..011` are
the original `(SOD)` session; `weekly_012..019` are a **second session from a
different alliance, `(L0L)`** (ranks 12 to 98) — see "Second capture set"
below. The filename prefix (`weekly_`) is still the tab ground truth for all
of them.

## Expected JSON format

```json
{
  "kind": "donation",
  "period_type": "weekly",
  "members": [
    {
      "name": "Аня",
      "alliance_tag": "SOD",
      "rank": "R1",
      "alliance_honor": 8291
    }
  ]
}
```

The `confidence` field is not fixed in the fixtures (it varies with Tesseract
settings). It's ignored by the bench as long as the value is above 0.

## Special cases to know about

1. **Top-3 trophies**: ranks 1, 2, and 3 show a gold/silver/bronze icon
   instead of a number in the Rank column. The parser ignores this column
   (row order already encodes the ranking) — so a numeric position distinct
   from the R-badge must never be annotated.
2. **Oversized viewer row**: the logged-in player's row is visually
   highlighted (no R-badge frame around the avatar, larger rank number).
   The parser then defaults to `rank = "R1"`. Document this row as `R1` in
   the expected JSON to avoid failing the bench.
3. **Alliance prefix `(SOD)`**: stripped by the parser via the regex
   `^\s*\(([A-Za-z0-9]{1,5})\)\s*` then stored in `alliance_tag`. The name
   stored in `name` must NOT contain the prefix.
4. **Multilingual screenshots**: Cyrillic (`Аня`), Japanese (`焼鳥_Yakitori`,
   `ばななヨーグルト`, `中本`, `幸恵丸ボーター`), Vietnamese (`TôiyêuViệtNam`),
   ASCII art (`ÐÃŘĶ§ĮĐĒ•築`). The bench compares similarity ≥ 0.7.
5. **Daily / Weekly / History tab**: the `period_type` field is the ground
   truth for tab detection (`_detect_selected_tab`). Detection relies on
   intensity (the selected pill stands out in grayscale), not color, so the
   original color image isn't needed.

   `daily_001.jpg` (real screenshot, Daily tab visually confirmed — see
   `docs/maintenance/2026-07-26-reprocess-channel-sod-data-quality-report.md`,
   finding 1, which documents how an undetected Daily screenshot corrupted a
   weekly period in production) covers the reverse positive case. **This
   fixture deliberately has NO associated `.json`**:
   - `tools/bench-ocr/bench.py` enumerates fixtures via `glob("*.json")` — a
     `.jpg` without a `.json` is invisible to it (no baseline entry, no
     latency added to the CI budget). This is already how `sprites/` works,
     a fixtures folder ignored by the bench for lack of a registered
     event_type.
   - **Pitfall**: `bench.py` infers `is_donation` from the **first** `.json`
     in alphabetical order (`fixtures[0]`). A `daily_001.json` would sort
     *before* `weekly_001.json` — if it were ever missing `"kind": "donation"`,
     the whole scan would be scored against event criteria (`power`/`points`)
     instead of donation criteria. Never add a `daily_*` or `history_*`
     `.json` without checking this risk.

   The ground truth therefore comes from the **filename prefix** (`daily_`
   vs `weekly_`), already the convention documented above — not a separate
   file. `tests/test_contribution_ranking_parser.py` derives the expected
   value this way for each `.jpg` in the folder and checks that at least two
   distinct `period_type` values are covered (otherwise the accidental
   deletion of `daily_001.jpg` would go unnoticed). No `history_<NNN>`
   screenshot is available to date.

## Second capture set — alliance `(L0L)`, `weekly_012`–`weekly_019`

Eight captures of a *different* alliance's Weekly leaderboard (ranks 12 to 98,
contiguous), added to widen coverage beyond the single `(SOD)` session. They
were transcribed by hand and then reconciled against the real parser output
(dump the parsed rows, compare line by line — the same discipline that caught
a 2-line divergence in `weekly_010`). What they add, and the gotchas they
introduced:

1. **Homoglyph alliance tag `(L0L)`** — that middle character is a **digit
   zero**, not a capital `O`. Verified by comparing it, on the same row, to
   the capital `O` in `(L0L) Onepunch` (`weekly_018`): the tag glyph is
   distinctly narrower. Tesseract reads it inconsistently (usually `LOL`,
   occasionally `L0L`) — that very inconsistency is evidence it's a digit.
   `alliance_tag` is recorded as `L0L` (the truth on screen); the bench does
   not score `alliance_tag`, so the OCR's `LOL`/`L0L` wobble doesn't matter,
   but the fixture pins the ground truth against any future "0→O
   normalisation" that would corrupt it.
2. **Enlarged "focus" row *with* a visible R-badge** — one row per capture
   (ranks 28, 51, 62, 73, 83) is rendered larger, full-width, with a bigger
   rank number. This is **not** the badge-less "viewer" row of §2 above: the
   R-badge is present, so annotate the badge actually shown (e.g. rank 83
   `GOLF` = `R3`), never a blanket `R1`.
3. **Name wrapped onto two lines** — rank 31 (`weekly_013`) is a decorated
   Japanese name whose `(L0L)` tag sits on line 1 and the name on line 2;
   exercises the parser's `wrap_crop` path with a real capture.
4. **Names OCR cannot recover**, recorded faithfully and expected to miss the
   0.7 similarity bar: decorated/foreign strings (`幸恵丸船長`, `Ṣímbα`,
   `Jαʂɱιŋツ`, `おーしあ`) and, notably, the Arabic `علE` — the production
   Dockerfile installs `rus/jpn/chi-sim/vie/kor` tessdata but **not `ara`**,
   so that row is a known, deliberate miss (adding `tesseract-ocr-ara` is a
   production-image change, out of scope for a fixture PR).

### Parser fixes these captures drove (same PR)

Reconciliation surfaced two real defects, both fixed in
`contribution_ranking_v1.py` and validated against every fixture with no
baseline regression:

- **`weekly_018` collapsed to 1 row of 12** (silent data loss). Root cause:
  the true row pitch is ~178px (autocorrelation, *all* fixtures) but the
  parser nominal is 175, and `_has_periodic_followup`'s symmetric ±17px
  window rejected `weekly_018`'s real row-0 band as non-periodic because its
  follow-up landed ~4px past the window. Fix: widen only the follow-up
  window's *far* edge, by a constant (not scaled by band height, preserving
  the anti-`weekly_010`-header property).
- **Garbled `(L0L)` tag bleeding into the name** (`nuna` → `я Л ОГ) nuna`,
  `HEAVYMETAL` → `_= | (LOU HEAVYMETAL`). The strict `(TAG)` strip is
  `^`-anchored and can't match a tag whose paren was dropped or whose glyphs
  OCR'd as Cyrillic. Fix: a lenient prefix strip (`_GARBLED_TAG_PREFIX_RE`)
  that fires **only when the strict match fails**, so the clean `(SOD)` rows
  are untouched.

## Quality targets (to reach before merging to production)

- `alliance_honor`: ≥ 95% exact match.
- `name`           : ≥ 90% Levenshtein similarity.
- `rank`           : ≥ 95% exact match (except the viewer row, see above).

Measured via `uv run python ../../tools/bench-ocr/bench.py --event-type contribution_ranking` (from `apps/ocr-service/`).
