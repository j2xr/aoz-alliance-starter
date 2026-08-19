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
| `rank` | ≥98% | 96.9% (31/32) | one badge short — see below |

Numbers measured in the CI-equivalent Docker environment (`tracker-ocr-service:latest`
with the full tessdata language set) — a bare local `.venv` without `tesserocr`
and the extra language packs measures meaningfully different numbers and
should not be trusted for these targets.

`rank` was 78.1% (25/32) when this profile shared the phone parser's
threshold/psm sweep. Retuned to 96.9% (31/32) via `_Layout.rank_ocr_order`,
which gives each profile its own combo list while the vote logic stays
shared and unchanged. The retune needed no new captures — the cause was
visible in these 32 rows:

- The phone list steps thresholds by 20 (`60, 80, … 180`). Of the 7 badges
  it missed, **not one** produced a single strong `R[1-5]` hit at any of
  those thresholds, while 5 read correctly at **110, 150 or 170** — exactly
  the midpoints that grid steps over. The badge carries 30×20 source pixels
  against phone's 52×47 (4.2× less ink), which narrows the usable threshold
  window rather than shifting it.
- **psm 6** is added (never tried on phone; here it reads badges psm 11/7
  return nothing for) and **psm 8** dropped (0 strong hits in 416 attempts —
  32 badges × 13 thresholds — so at this glyph size it is pure cost).
- The crop box is unchanged. Padding it by −6…+6 px was measured too: −4
  raises per-combo precision but loses evidence overall and scores 28/32
  end-to-end, worse than leaving it alone.

The one remaining miss (`20260721T1500_001` row 2) is a **legibility floor,
not a tuning gap**: its true rank is produced by no combo of a 114-combo
grid, at any of those paddings. Reaching ≥98% on 32 rows would require a
clean sweep, so lifting it needs a different mechanism — the LLM vision
fallback already used for unreadable names — rather than more sweep tuning.

See `_EMULATOR_RANK_OCR_ORDER` in `polar_invasion_v1.py` for the full
measurement, and `test_polar_invasion_emulator_parser.py`'s module docstring
for the test-floor rationale.

`power` was previously 87.5% (28/32): the widest detection stage (a PSM-11
scan of the full row) includes the avatar on this profile, and
`Madara⁶⁹Uchiha`'s decorative frame was read as a leading `"1"` fused onto
the value on all 3 of its rows. This also accounted for a `.AL3X.` power
misread an earlier version of this README described as a separate,
undiagnosed miss: same root cause, and it did not reproduce once measured
in the CI-equivalent environment.

Fixed via `_Layout.power_stages`, which lists per profile *which* detection
stages run rather than only their order. The emulator layout lists exactly
one, the narrow, avatar-excluding contrast-normalized crop, and that stage
alone reads all 32 rows correctly. The two omissions are measured, not
stylistic:

- **`row_scan`** (full-row PSM-11 sweep) is the stage that produced the
  `Madara⁶⁹Uchiha` corruption above. Kept as a last-resort fallback it would
  still corrupt those rows whenever the first stage came up empty, so it is
  not listed at all — a dropped row is visible (`possible_truncation`),
  a plausible wrong value is not.
- **`psm8`** (fixed crop, PSM 8) returned **0 correct values out of 32** at
  its own x-band and at three narrower candidates. At `(160, 650)` it
  produced `18,200,959` and `1,980,082` — both above `MIN_POWER`, so both
  would have passed `validate_member`. It has no measured value on this
  profile at any band, only a measured failure mode. `_EMULATOR_LAYOUT`
  therefore also carries `power_fallback_x=None`, and the stage raises if a
  future layout lists it without measuring a real band first.
