# Fixtures — Polar Invasion (emulator source)

Ground truth for `polar_invasion_v1`'s emulator layout profile
(`_EMULATOR_LAYOUT`, see [aoz-alliance-starter#91](https://github.com/j2xr/aoz-alliance-starter/issues/91)).

## Source

Android emulator captures at a fixed native resolution of **400×652**
(ratio 1.63), driven by an external automation pipeline — not a real
device, and the resolution can't be changed on that side. `preprocess()`
recognizes this as the `emulator_400x652` layout profile (see
`app/preprocess.py`) and upscales it to the same `TARGET_WIDTH=1080` as
phone captures; `polar_invasion_v1.parse()` then selects
`_EMULATOR_LAYOUT` instead of `_PHONE_LAYOUT` based on the resulting
image height.

Unlike the `polar_invasion/` fixtures (real phone screenshots, genuine
device variation), this source has exactly one native resolution, so
these 4 captures are single scrolls of 4 different events rather than a
family of devices — there's no equivalent of "verify every device size in
the 1920-2400 band" here.

## Ground truth provenance

Each JSON's `members` list was transcribed **by direct visual inspection**
of the source image at 3-4x crop zoom — not derived from any OCR pass, and
not cross-checked against Tesseract output. Only the 8 fully-visible member
rows in each screenshot are included; every screenshot has a 9th row
partially cut off at the bottom edge, which is intentionally excluded
(no ground truth exists for it).

Two names carry a genuine transcription uncertainty, flagged here rather
than silently guessed:

- **`.AL3X.`** (`20260707T1500_001`, `20260714T1500_001`) — the in-game
  name is flanked by decorative arrow glyphs whose exact Unicode codepoints
  aren't recoverable with confidence from a screenshot alone. The ground
  truth uses the plain `.AL3X.` core.
- **`Ben0Verbich`** (`20260707T1500_001`) — at this glyph size, a capital
  `O` and the digit `0` are visually indistinguishable. The ground truth
  guesses `0` (digit); if OCR/LLM fallback consistently disagrees on a real
  future capture of this player, treat the ground truth as the one to
  revisit, not the OCR.

## Edge cases represented

| Fixture | Name | What it tests |
|---|---|---|
| `20260721T1500_001` | `Madara⁶⁹Uchiha` | Superscript digits (~3-4px glyphs) |
| `20260707T1500_001` | `中本` | CJK name (needs `chi_sim`) |
| `20260707T1500_001` | `.AL3X.` | Decorative flanking glyphs |
| `20260714T1500_001` | `Sa†ana` | Dagger glyph replacing a letter |
| `20260811T2300_001` | `3jr` | "This is you" row — rank badge, name, and power all render in green; points stays white |

## Quality: measured vs. phone-parity targets

Targets are the same ones the phone fixtures use (see
`../polar_invasion/README.md`). Measured by the real parser against these
4 fixtures (32 member rows) in `tests/test_polar_invasion_emulator_parser.py`:

| Field | Target | Measured | Status |
|-------|--------|----------|--------|
| `total_battlers`, `total_points`, `alliance_rank`, `event_datetime` | 100% | 100% (16/16) | met |
| `points` | ≥95% | 100% (32/32) | met |
| `name` (fuzzy, Latin-only — `中本` excluded, see phone convention) | ≥90% | 90.3% (28/31) | met |
| `power` | ≥95% | 100% (32/32) | met |
| `rank` | ≥98% | 78.1% (25/32) | **below target** |

Numbers measured in the CI-equivalent Docker environment (`tracker-ocr-service:latest`
with the full tessdata language set) — a bare local `.venv` without `tesserocr`
and the extra language packs measures meaningfully different numbers and
should not be trusted for these targets.

`rank` is not a crop-position bug — it has a specific, understood cause
(see `test_polar_invasion_emulator_parser.py`'s module docstring for the
full breakdown and the exact test-floor rationale):

- **rank**: `_RANK_OCR_ORDER` (the threshold/psm sweep in
  `polar_invasion_v1.py`) was tuned on phone-resolution badges; several
  emulator badges that are clearly legible to a human still miss. Needs
  its own resolution-specific re-tuning pass with a larger badge corpus —
  this 4-image set is too small to retune safely without overfitting.

`power` was previously 87.5% (28/32): the primary detection stage (a
PSM-11 scan of the full row) includes the avatar on this profile, and
`Madara⁶⁹Uchiha`'s decorative frame was read as a leading `"1"` fused onto
the value on all 3 of its rows. Fixed by `_Layout.power_narrow_crop_first`
— the emulator layout now tries the narrow, avatar-excluding
contrast-normalized crop first. This also resolved a `.AL3X.` power
misread an earlier version of this README described as a separate,
undiagnosed miss: it shared the same root cause and did not reproduce once
measured in the CI-equivalent environment.
