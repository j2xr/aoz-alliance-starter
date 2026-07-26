# OCR data-quality audit — `/reprocess-channel` run, 2026-07-26

**For: analysis by a future Opus session.** This is a raw findings report from a live
production reprocess, not a fix — no code changes were made as part of this audit.

## Scope

- **Command**: `/reprocess-channel`, run 2026-07-26 09:39–09:44 UTC.
- **Tracker alliance**: "Test Alliance" (`discord_channel_id=1496236679105876079`). **Naming
  note**: this is the tracker's alliance *record* name — the actual in-game alliance tag shown
  on every donation screenshot is `(SOD)`. This is unrelated to the "SOD" tracker-alliance record
  created earlier today (2026-07-26) pointing at a *different* Discord channel
  (`1497862042080772296`), which has not received any captures yet. Don't confuse the two when
  reading this report or the DB.
- **Input**: 45 screenshots across 16 Discord messages (confirmed via
  `find data/inbox -newermt "2026-07-26 09:00" -type f`, matching the bot's own
  `"totalImages":45` log line).
- **Ingestion result** (from `alliance-discord-bot` logs): 31 success, 14 duplicate, 0 unknown
  event type, 0 failed. Zero errors in `alliance-ocr-service` logs across all 38 scheduled jobs.
- **Database state**: Supabase was fully reset (`supabase/scripts/reset-ocr-data.sql`) immediately
  before this run, so every row currently in `at_events`, `at_participations`,
  `at_donation_periods`, `at_donations`, and `at_players` originates from this single run — no
  need to filter by timestamp.

## Method

Compared OCR-extracted rows in Supabase directly against the source screenshot images
(`tracker/data/inbox/<message_id>/*.jpg`) pixel-by-pixel for names, honor/points values, and
ranks. Two capture batches were audited in depth:

1. **Donation ranking** (`at_donation_periods` id `b6d37bd7-8e23-4591-83d2-ec0679c884d6`, weekly
   period starting 2026-07-13): 9 sequential, overlapping screenshots
   (`Screenshot_20260516_221930` … `_222030`, message `1527351181750440036`) of a scrolling
   "Contribution Ranking" leaderboard, aggregating to 83 distinct donor rows. Viewed 5 of the 9
   screenshots directly (covering ranks 1–21, 30–41, 40–51, 50–61, 70–81).
2. **Polar Invasion event** (`at_events` id `bd1d0331-f03c-4aa3-8c25-c5cf2f51e78a`,
   `event_datetime=2026-04-07 13:00`, `alliance_rank=1`): aggregated from **12 separate uploads**
   across 5 Discord messages spanning **3 different real-world capture dates** (screenshot
   filenames dated Apr 24, 25, and 26 — someone revisiting the same historical event's "History"
   leaderboard on different days, paging/scrolling further each time), reaching 54 distinct
   participant rows. Viewed the header of the message-`1497873062056558773` screenshot and the
   full `at_participations` list for this event.

Existing guardrail signals (`needs_review`, `possible_truncation` warnings, honor-monotonicity
warnings, LLM self-consistency rejections — all seen live in the OCR service logs during this
run) were used to prioritize which rows to check first, then broadened to a wider visual sweep
to check for false negatives (wrong data that *wasn't* flagged).

## Confirmed findings

### 1. Two rows hold confidently-wrong honor values — correctly flagged, but the wrong number is what's live

| Player | Stored `alliance_honor` | True value (screenshot) | Status |
|---|---|---|---|
| Somethin_kool | **92256** | **2385** (rank 41) | `needs_review=true`, `ocr_confidence=0` |
| StoKaizer | **9044** | **2944** (rank 31) | `needs_review=true`, `ocr_confidence=0` |

In both cases the OCR-service logs show the LLM fallback *independently read the correct value*
during the honor-monotonicity rescue path, but its correction was rejected:

```
donation row 11: alliance_honor=92256 breaks monotonicity (previous row=2458)
donation row 11: no re-OCR candidate for alliance_honor fits [0, 2458] — keeping 92256, lowering confidence for visibility
LLM correction rejected for 'Somethin kool' → '(SOD) Somethin_kool' (row 11): read score 2385 ≠ OCR honor 92256 — likely a misaligned/overlaid read, keeping OCR
```

**Root cause hypothesis**: the LLM self-consistency gate requires the model's independently-read
honor to match the *already-flagged-as-wrong* OCR honor before trusting a name correction. In the
specific rescue path where honor-monotonicity has *already* proven the stored OCR honor is
untrustworthy, that check is circular — it can never succeed in exactly the case it's meant to
help with. Worth a design review: should this path trust the LLM's independently-read honor
value directly (replacing the OCR honor, not just gating a name correction) instead of requiring
agreement with the value it's trying to fix?

**Impact**: both rows are visible as `needs_review` for a human to catch on a dashboard, but any
automated ranking/leaderboard built directly off `alliance_honor` is wrong until manually
corrected via `/correct`.

### 2. Reproduced the "2-line name wrap" corruption on live data (previously only seen in a fixture)

Rank 46 of the donation ranking is `LATAM.REYCOLIMAN` — long enough to wrap to 2 lines in the
game's UI. The stored name is `=3 500`; the honor value (2140) is correct, only the name is
garbled. This is the same failure signature previously characterized only via a hand-transcribed
test fixture (`weekly_010`, row 6) in this repo's OCR test history — this run confirms it also
occurs on real user data, not just the synthetic reproduction case.

### 3. A notification-toast overlay was correctly rejected (guardrail working as designed)

Rank 52 of the donation ranking is partially obscured by an in-game toast: "CEKATOP_1000 helped
you Heal Wounded" (a *different* player's name, unrelated to this row). OCR produced garbage
(`고`, a single stray character) for the hidden name. The LLM fallback read the toast text itself
(`CEKATOP_1000`) with an unrelated "score" of 52, which did not match this row's OCR honor (1946):

```
LLM correction rejected for '고' → 'CEKATOP_1000' (row 2): read score 52 ≠ OCR honor 1946 — likely a misaligned/overlaid read, keeping OCR
```

Had this been accepted, the row would have been silently mislabeled as `CEKATOP_1000` — an
*already-existing different player* elsewhere in the same donation list (honor 4106) — corrupting
two players' identities at once. The self-consistency gate is doing exactly the job it was
designed for here. **Open item**: the true name behind rank 52 is unrecoverable from this
specific screenshot; worth checking whether any of the other 8 overlapping captures in this batch
show that row without the toast present (toasts are transient, ~2-4s).

### 4. Duplicate player records from imperfect cross-screenshot name matching

- **Donation ranking**: `Big§teelCurtain` (honor 6095, conf 0.893) / `RigSteelCurtain` (honor
  6095, conf 0.777) — same real player (rank 11, true stylized name `ßig§łeelĊurłain`, confirmed
  in the screenshot), read differently by what were evidently two separate OCR passes over the
  same or an overlapping capture of this row. Identical honor value is strong evidence these are
  the same real donor, not merged by name-similarity alias resolution.
- **Polar Invasion event** (same alliance, different capture): `Big§teelCurtain` (points 9590,
  conf 0.41) / `SteelCurtain` (points 8161, conf 0.77) — likely the same recurring pattern, though
  points differ enough (~1400) that ongoing battle-score drift between two captures taken at
  different moments is a plausible alternative explanation here, unlike the donation case's exact
  honor match.

**Caution — do not assume same-value ⇒ duplicate.** Two other same-value pairs in the donation
data were checked against the screenshots and confirmed as genuinely **distinct real players**,
not merge failures:
- `jasmin` (honor 530, rank 78) and a heavily decorated `⽊|jαᔕᴎᴉᒥ|⽊`-style name stored as
  `m| jasmin|o` (honor 530, rank 79) — two different real accounts with similar in-game names at
  adjacent ranks, coincidentally equal honor this week.
- `kotarou` (honor 600, rank 75) / `Moud` (honor 600, rank 76) — same situation, two distinct
  players.

Any future de-duplication heuristic based on "same honor + similar name" needs to be weighed
against these confirmed-legitimate false-positive cases.

### 5. Minor character-level OCR degradations (low severity, cosmetic — listed for completeness)

| True name (screenshot) | Stored name | Notes |
|---|---|---|
| `⇐ .AL3X. ⇒` | `= .AL3X. >` | arrow glyphs → ASCII |
| `Mjölnir` | `Mjolnir` | diacritic dropped |
| `doradora12` | `doradorai2` | digit `1` misread as letter `i` |
| `LEÓN` | `LEON` | diacritic dropped |
| `3jr` (the green/highlighted "viewer" row) | `3][` | letter/bracket confusion — see below |
| `Momoa` | `Мотоа` | Latin→Cyrillic homoglyph substitution; `disambiguate_cyrillic` didn't reverse this mixed-script case |

The `3jr` → `3][` misread is on the **highlighted "this is you" row** (shown in green with
larger/different styling in the game's UI) — worth checking whether that row's distinct
rendering is systematically harder for the name-OCR path than a normal row; this is the only
misread observed on a highlighted row in the sample, so treat as a single data point, not a
confirmed pattern.

### 6. `total_battlers` looks wrong on a multi-day, multi-upload aggregated event

Event `bd1d0331` (Polar Invasion, 2026-04-07 13:00, alliance_rank=1): 54 distinct participant
rows recorded (aggregated from the 12-upload, 3-real-day capture batch described in Method),
but `total_battlers` is stored as **43** — fewer than the number of distinct battlers actually on
record (54, or ~53 net of the one confirmed duplicate above).

Since this is a **"History" tab event** — its stats should be a fixed historical snapshot, not
something that changes between re-visits — `total_battlers` should be internally consistent with
the participant count on every one of the 12 captures. The most likely explanation: each new
upload's `upsertEventResult` overwrites `alliance_rank`/`total_battlers`/`total_points` on the
shared event row (last-upload-wins), with no cross-check against earlier uploads' readings of
what should be the same static number — so whichever of the 12 screenshots was processed *last*
determined the value that stuck, and that particular header read (43) appears to simply be wrong
relative to the other 11 captures' worth of evidence.

**Suggested follow-up**: consider validating that `total_battlers`/`total_points`/`alliance_rank`
agree (or at least don't regress) across multiple uploads resolving to the same event, rather
than unconditional last-write-wins on the scalar header fields while participations correctly
accumulate.

## What looked clean

- The large majority of donation rows (confidence 0.6–0.97) matched their screenshots exactly on
  name and honor, including several correctly-read accented/stylized names (`Аня`, `KOR.Chawoo`,
  `rinshan5551`, `TôiyêuViệtNam`).
- Every row confirmed wrong in this audit was *already* surfaced by an existing signal
  (`needs_review`, a monotonicity warning, or an LLM-rejection log line) — with the single
  exception of the toast-obscured row, which is also flagged, just without a recoverable true
  value from this capture. No silent, unflagged wrong values were found in the sample checked.
- Name-alias resolution correctly avoided merging the two confirmed-legitimate same-honor
  distinct-player pairs (finding #4).
- `leaderboard_position` is `null` on every donation row — expected, not a bug:
  `_POSITION_OCR_ENABLED` defaults to `false` as of the 2026-07-26 latency fix (PR #23); this
  field is informational-only and intentionally disabled.

## Open questions for further analysis

1. Should the honor-monotonicity rescue path trust an LLM-read honor value directly (replacing
   the flagged-wrong OCR value) instead of gating on agreement with that same wrong value?
   (Finding #1)
2. Is there a reasonable post-hoc consistency check (same/near-identical honor + small
   name-edit-distance) that could catch and merge duplicates like `Big§teelCurtain` /
   `RigSteelCurtain` — while not false-positiving on confirmed-legitimate cases like
   `jasmin`/`jasmin`-variant or `kotarou`/`Moud`? (Finding #4)
3. Should scalar per-event header fields be reconciled across multiple uploads mapping to the
   same event, rather than last-upload-wins? (Finding #6)
4. Is it worth a small tool/query to recover a toast-obscured row's true name from an adjacent
   capture in the same upload batch, when one exists? (Finding #3)
5. Is the highlighted/"viewer" row (green, differently styled) systematically worse for name OCR
   than a normal row? Only one data point here (`3jr`→`3][`); would need more samples to confirm.

## Appendix — raw counts at time of audit

**Events** (`at_events`, alliance "Test Alliance"):

| event_type | event_datetime | alliance_rank | total_battlers | total_points | member_count |
|---|---|---|---|---|---|
| elite_wars | 2026-04-01 15:00 | 109 | 18 | 17870 | 18 |
| wasteland_showdown | 2026-04-03 13:00 | null | 41 | 6715 | 11 |
| battle_frenzy | 2026-04-05 00:00 | null | 99 | 697182130 | 11 |
| elite_wars | 2026-04-05 15:30 | 76 | 50 | 19398 | 11 |
| elite_wars | 2026-04-05 17:30 | 105 | 9 | 18146 | 9 |
| **polar_invasion** | **2026-04-07 13:00** | **1** | **43** | **21955** | **54 ⚠️ (see finding #6)** |
| elite_wars | 2026-04-12 17:00 | 110 | 26 | 18069 | 9 |
| polar_invasion | 2026-04-14 13:00 | 5 | null | 4275 | 11 |
| polar_invasion | 2026-04-21 13:00 | 6 | 17 | 4870 | 17 |

**Donations** (`at_donation_periods`): 1 period (weekly, starting 2026-07-13), 83 members.
