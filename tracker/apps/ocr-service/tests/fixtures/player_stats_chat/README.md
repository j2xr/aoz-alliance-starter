# Fixtures — Player Stats Chat

Ground truth for the `player_stats_chat` OCR parser (`PlayerStatsChatV1Parser`).

Screenshots of the in-game alliance chat (`(LOL) City stats`) where members
manually type their military stats — Long/Mid Range Attack, Melee HP, Melee
Defense — in free-form messages. Unlike the structured-UI parsers, this one runs
**full-image OCR (PSM 3) + a text state machine**, with no coordinate crops.

## ADVISORY scene

This directory carries an `ADVISORY` marker: bench.py reports its accuracy but
does **not** gate CI on it, and it is excluded from `baseline.json`. See the
`ADVISORY` file for why (free-form human input, exotic handles read with
`-l eng`) and how to promote it to blocking.

## Naming convention

```
citystats_<NNN>.jpg     raw screenshot (Android, ~1080×2400 portrait)
citystats_<NNN>.json    expected parser output (PlayerStatsParseResult)
```

`<NNN>` reflects scroll order. Consecutive screenshots may overlap by a row or
two (e.g. a name whose stats are cut off at the bottom of one shot continue at
the top of the next); the golden for each file only lists members whose full
submission is visible **in that file**.

## Expected JSON format

```json
{
  "kind": "player_stats",
  "scene": "player_stats_chat",
  "members": [
    {"name": "Герман", "attack_pct": 412, "attack_kind": "lra", "hp_pct": 319, "defense_pct": 260},
    ...
  ]
}
```

Numbers are floats when the message used a decimal (`887.2`), plain integers
otherwise (`412`). `attack_kind` is `"lra"` unless the member explicitly used
MRA; bench.py does not gate on it.

## What counts as a member (transcription rules)

A member is one player's own stat submission. **Not** members, and excluded from
the golden:

- Leader instruction bubbles (e.g. `RageX_`: "The 3 things we need…",
  "For example here is mine: …", "…use your MRA %").
- Timestamps (`05-02 13:20`), translator badges (`google`), and UI chrome
  (`Tap to Chat`, `Send`).
- Non-stat commentary (e.g. `FATCAT29`: "im still using VIP buff").
- Free-text corrections in prose (e.g. `Bulleit`: "Lra 893 * sorry i guess im a
  little dyslexic") — the golden keeps the value from the **structured** bubble
  the parser is built to read, and the prose line is expected to drop as noise.

These are exactly the lines the parser's noise filter must reject, so keeping
them in the screenshots (but out of the golden) is deliberate.

## Quality targets (advisory)

| Field | Target |
|-------|--------|
| `name` | Similarity ≥ 0.90 (SequenceMatcher) — *advisory* |
| `attack_pct`, `hp_pct`, `defense_pct` | Exact (±0.05) — *advisory* |

## Adding screenshots

1. Take screenshots of the City-stats chat at several scroll positions.
2. Read each member's typed stats and transcribe them (rules above).
3. Create the reference JSON with the exact values read from the screen.
4. Place `citystats_<NNN>.jpg` + `.json` in this folder.
5. Verify with `uv run python ../../tools/bench-ocr/bench.py --event-type player_stats_chat`
   from `tracker/apps/ocr-service`.
