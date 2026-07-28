# Fixtures — Polar Invasion

Ground truth for the `polar_invasion_v1` OCR parser tests.

Each JSON represents the expected parser output for a given screenshot (`source_file` field).

## File structure

```
polar_invasion/
├── README.md                    # this file
├── 20260407T1500_001.json       # Event 1, highest scroll
├── 20260407T1500_002.json
├── 20260407T1500_003.json
├── 20260407T1500_004.json
├── 20260407T1500_005.json       # Event 1, lowest scroll
├── 20260414T2300_001.json       # Event 2, highest scroll
├── 20260414T2300_002.json
└── 20260414T2300_003.json       # Event 2, lowest scroll
```

The corresponding screenshots (`source_file`) must be placed in the same folder, under the names given in each JSON.

## Events covered

| Event | Date | Alliance rank | Battlers | Points | Screenshots |
|-------|------|---------------|----------|--------|----------|
| 1     | 2026-04-07 15:00 | 1 | 43 | 21 955 | 5 |
| 2     | 2026-04-14 23:00 | 2 | 26 | 11 630 | 3 |

## Verified consistency

The union of nicknames across all screenshots of a given event matches exactly the `total_battlers` shown in the header:

- Event 1: 43 distinct nicknames across 5 screenshots = 43 battlers ✓
- Event 2: 26 distinct nicknames across 3 screenshots = 26 battlers ✓

This guarantees the screenshots cover 100% of members (the deliberate overlaps between consecutive scrolls let the parser be tested on deduplication).

## Edge cases represented

The dataset was chosen to deliberately cover cases that challenge the parser.

### Non-Latin alphabets

| Nickname | Alphabet | Notes |
|--------|----------|-------|
| Медвежонок | Cyrillic | "Bear cub" in Russian |
| Метью      | Cyrillic | Transliterated "Matthew" |
| Герман     | Cyrillic | "German"/"Hermann" |
| Толик      | Cyrillic | Diminutive of "Anatoly" |
| おーしあ   | Japanese (hiragana + long-vowel mark) | "Oshia" |

→ Requires `tesseract-ocr-rus` and `tesseract-ocr-jpn`. If Tesseract fails, the LLM fallback is triggered.

### Accented characters

- `LEÓN` — acute accent on the capital O

### Punctuation in nicknames

| Nickname | Special character |
|--------|-------------------|
| KOR.Park | period |
| LATAM.REYCOLIMAN | period |
| kor,spark | comma |
| THOR,01 | comma |
| Ichigo_19 | underscore |
| KANHA_ | trailing underscore |
| RageX_ | trailing underscore |

→ Watch out for parsers that naively split on `,` or `.`. The character whitelist for nicknames must NOT be too restrictive.

### Digits in nicknames

Many nicknames mix letters and digits (Yuyuyu325, jc0n, 1jr, FATCAT29, Goldeneye21, Hardcore101, THOR,01, doradora12, Ichigo_19, BakersBakedd27, Duvan395). The parser must not confuse these digits with the adjacent `power` or `points` columns. Splitting by region (crop by coordinates) is crucial here.

### Zero values

Several players have `points: 0` (registered for the event but did nothing). This is NOT an absence — the row is present on screen, with a "0" right-aligned. Semantically this differs from a player who doesn't appear at all (who wasn't registered). The parser must keep them.

### Overlaps between screenshots

Screenshots of the same event deliberately overlap (successive scrolls). Examples:

- `20260407T1500_003.json` and `20260407T1500_004.json` share `Gattopardo` (same power and points values)
- `20260414T2300_002.json` and `20260414T2300_003.json` share 6 members

The parser extracts each screenshot independently. Deduplication is done downstream by the UPSERT on `(event_id, player_id)`. Tests can check that the values reported for the same player across two screenshots are identical — otherwise it's an extraction bug.

### Rank changes between events

Two players change rank between event 1 and event 2:

- `Bulleit`: R1 → R2
- `Yojimbo`: R4 → R5

This is not an OCR error, it's a legitimate promotion. The parser must not try to "normalize" the rank by comparing it to an earlier event. Each screenshot is the source of truth for the moment it was taken.

### Text color (UI variant)

Some nicknames and values are shown in green (e.g. `Xrage` in event 1, `1jr` in event 2). This is the "this is you" indicator in the game's UI. The parser must treat these rows like any other — ignore the color. Do not add an "is_self" field to the output (not relevant for this use case).

## Datetime convention

The screenshots show `2026-04-07 15:00` with no timezone information. We assume this is the user's local time (Strasbourg, CEST = UTC+2 on these dates). The fixtures therefore use `+02:00`.

**To verify**: if the game actually displays server time rather than local time, fix `event_datetime` in every file. If so, document the convention in `app/parsers/polar_invasion_v1.py`.

## Usage in tests

Example pytest usage (adapt to the parser's actual structure):

```python
import json
from pathlib import Path
import pytest
from app.parsers.polar_invasion_v1 import parse

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "polar_invasion"

@pytest.mark.parametrize("fixture_file", sorted(FIXTURES_DIR.glob("*.json")))
def test_parser_matches_fixture(fixture_file: Path):
    with fixture_file.open(encoding="utf-8") as f:
        expected = json.load(f)

    image_path = FIXTURES_DIR / expected["source_file"]
    result = parse(image_path)

    # Header
    assert result["event_type"] == expected["event_type"]
    assert result["event_datetime"] == expected["event_datetime"]
    assert result["alliance_rank"] == expected["alliance_rank"]
    assert result["total_battlers"] == expected["total_battlers"]
    assert result["total_points"] == expected["total_points"]

    # Members, by position
    assert len(result["members"]) == len(expected["members"])
    for i, (got, want) in enumerate(zip(result["members"], expected["members"])):
        assert got["name"] == want["name"], f"row {i}: name mismatch"
        assert got["rank"] == want["rank"], f"row {i}: rank mismatch"
        assert got["power"] == want["power"], f"row {i}: power mismatch"
        assert got["points"] == want["points"], f"row {i}: points mismatch"
```

For a more permissive test (accepting a tolerated error on exotic nicknames):

```python
from difflib import SequenceMatcher

def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()

# In the test
assert similar(got["name"], want["name"]) > 0.9, f"row {i}: name too different"
# But strict on numbers
assert got["power"] == want["power"]
assert got["points"] == want["points"]
```

## Quality targets

To consider the parser ready for Phase 2 (Discord bot):

| Field | Target | Strategy |
|-------|----------|-----------|
| `total_battlers`, `total_points`, `alliance_rank` | 100% | Fixed crop, digit whitelist |
| `event_datetime` | 100% | Fixed crop, whitelist `0-9-: ` |
| `power`, `points` | ≥ 95% | Crop per row, digit whitelist |
| `rank` | ≥ 98% | R1-R5 badge, whitelist `R12345` |
| `name` (Latin) | ≥ 90% | Tesseract eng |
| `name` (Cyrillic, Japanese) | ≥ 75% OR LLM fallback | Tesseract rus+jpn, fallback if conf < 0.75 |

If these thresholds aren't reached, enable the LLM fallback (cf PLAN.md §4.3) before moving to Phase 2.
