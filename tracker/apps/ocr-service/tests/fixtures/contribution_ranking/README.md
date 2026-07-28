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

The `<NNN>` number reflects scroll order: `weekly_001` shows the top of the
list (ranks 1 to 12), `weekly_009` the bottom (ranks 75 to 86). Overlaps of
1 to 3 lines exist between consecutive screenshots — the parser doesn't need
to handle them (that's the bot-side UPSERT, on `(donation_period_id, player_id)`,
that merges them).

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

## Quality targets (to reach before merging to production)

- `alliance_honor`: ≥ 95% exact match.
- `name`           : ≥ 90% Levenshtein similarity.
- `rank`           : ≥ 95% exact match (except the viewer row, see above).

Measured via `uv run python ../../tools/bench-ocr/bench.py --event-type contribution_ranking` (from `apps/ocr-service/`).
