# Fixtures — Wasteland Showdown

Ground truth for the `wasteland_showdown` OCR parser tests.

Wasteland Showdown uses the same layout as Polar Invasion (`PolarInvasionV1Parser`).

## Title detected by the dispatcher

```
"wasteland showdown"   → wasteland_showdown
```

## Naming convention

```
<YYYYMMDDTHHMM>_<NNN>.jpg    raw Android screenshot (~1080×2400 portrait)
<YYYYMMDDTHHMM>_<NNN>.json   expected parser output
```

## Expected JSON format

```json
{
  "event_type": "polar_invasion",
  "event_datetime": "2026-04-21T15:00:00+02:00",
  "alliance_rank": 1,
  "total_battlers": 40,
  "total_points": 18500,
  "source_file": "original_filename.jpg",
  "members": [
    {"name": "Bulleit", "rank": "R1", "power": 21067465, "points": 55000},
    ...
  ]
}
```

Note: `event_type` is `"polar_invasion"` in the JSON (value returned directly
by the parser). The code `"wasteland_showdown"` is assigned by the dispatcher upstream.

## Quality targets

| Field | Target |
|-------|----------|
| `event_datetime` | First 16 chars exact |
| `total_battlers`, `alliance_rank`, `total_points` | Exact |
| `power`, `points` | Exact |
| `rank` | Exact |
| `name` | Similarity ≥ 0.66 (SequenceMatcher) |

## Adding screenshots

1. Take several screenshots at different scroll positions (5–10 screenshots per event)
2. Manually note the values visible on screen
3. Create the reference JSON with the exact values read from the screen
4. Place the `.jpg` + `.json` in this folder (same filename, different extension)
5. Run `uv run pytest tests/test_v1_event_parsers.py -v` to verify
