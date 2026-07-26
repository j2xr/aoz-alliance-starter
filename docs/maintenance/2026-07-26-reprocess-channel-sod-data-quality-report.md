# OCR data-quality audit — SOD alliance `/reprocess-channel` run, 2026-07-26

**For: analysis by a future Opus session.** Raw findings from a live production reprocess, no
code changes made as part of this audit. Third in this series — see also
`2026-07-26-reprocess-channel-data-quality-report.md` ("Test Alliance") and
`2026-07-26-reprocess-channel-lol-data-quality-report.md` ("LOL"). **This report's headline
finding (#1) is new and more serious than anything found in the first two audits.**

## Scope

- **Alliance**: SOD (`discord_channel_id=1497862042080772296`, `at_alliances.id=1069edaa-…`).
- **Run**: `/reprocess-channel`, started 12:15:29 UTC, completed 12:30:22 UTC. Clean this time:
  `"messages":6,"totalImages":38,"successCount":38,"duplicateCount":0,"failedCount":0"`.
- **Database state**: 13 events, 1 donation period (106 members, `period_start=2026-05-04`).
- Verified 3 screenshots directly against the DB (2 donation, covering the tab-mixing bug below;
  1 `elite_wars`).

## Confirmed findings

### 1. ⚠️ A "Daily" contribution-ranking capture was silently merged into the "Weekly" period

**This is a new bug class, not seen in the first two audits.**

The donation period `period_start=2026-05-04` contains rows from **two different messages**:

- `1502770964281167902` (8 screenshots, `213215`–`213539`): confirmed via screenshot — **"Weekly"
  tab is selected** (red highlight). Values here are correctly weekly-scale (e.g. `Аня`=9794,
  `MHGYM7000`=9252).
- `1502785513839530146` (5 screenshots, `223714`, `232939`–`233039`): confirmed via screenshot
  (`Screenshot_20260509_233039…`) — **"Daily" tab is selected**, not Weekly. Its rows (ranks
  50–61+ of that daily view) were nonetheless upserted into the *same* weekly donation period as
  the first message.

This is directly provable by comparing the same real player across reports: `Lucky.lucciano`
appears in the Test Alliance audit's *weekly* data at honor **1457**; here, in what is
demonstrably a **Daily**-tab capture, the same player shows honor **255** — consistent with a
daily reset value, not a weekly cumulative one. At least a dozen rows in this donation period
carry suspiciously-identical low values (255 appears for **12 different players**: `First3pm`,
`Natasha`, `Satana`, `Dark3pm`, `Maria*`, `doradora12`, `XxDFSTRIICTORxX`, `Lucky.lucciano`,
`Indira.IsaLATAM`, plus 3 garbage-named/flagged rows) — this is very likely the *entire Daily-tab
screenshot's row range* landing at whatever the Daily equivalent of those ranks happened to be,
not 12 independent OCR coincidences.

**Root cause hypothesis**: `_detect_selected_tab` (in `contribution_ranking_v1.py`) either
misdetected "Daily" as "Weekly", or fell through to the documented safe-default fallback (see the
module comment: *"Weekly is the safe default: every shipped capture is a Weekly leaderboard...
an undetectable band degrades to the historically-correct value"*). That fallback's designed-for
scenario is "the tab band is ambiguous/undetectable" — but the screenshot evidence here shows an
*unambiguous*, clearly-red-highlighted "Daily" tab, which should have been easy to detect. Either
the detection heuristic has a real bug on this specific image (different rendering/exposure?), or
the assumption baked into the fallback comment ("every shipped capture is a Weekly leaderboard")
is simply false in practice — someone *did* upload a Daily-tab screenshot, whether by mistake or
intentionally, and the safety net meant to catch "can't tell which tab" silently mis-routed
"clearly the wrong tab" instead of rejecting it via `upsertDonationResult`'s existing
`period_type !== 'weekly'` guard (which only works if `_detect_selected_tab` correctly reports
`'daily'` in the first place — it evidently didn't, here).

**Impact**: this doesn't just add a few wrong numbers — it corrupts the *meaning* of the weekly
leaderboard for every row that came from the Daily capture, mixing two different time-scales of
the same metric into one ranking. None of these rows are flagged `needs_review` (the OCR itself
read the Daily numbers "correctly" — confidence is fine, e.g. `doradora12` conf=0.893 — the
values are just measuring the wrong thing).

**Suggested follow-up**: verify `_detect_selected_tab` against this exact screenshot
(`Screenshot_20260509_233039_Age_of_Origins.jpg`, message `1502785513839530146`) to find why a
visually-unambiguous "Daily" selection wasn't detected as such; consider whether the
"undetectable → default to weekly" fallback should instead reject/flag rather than silently
proceed, now that this repo has direct proof the "every capture is Weekly" assumption doesn't
always hold.

### 2. Recurring duplicate-player pattern, cleanly proven again

`elite_wars` event (2026-04-06, `total_battlers=15`, 17 raw `at_participations` rows) has **two**
same-points duplicate pairs:

| name | points | conf |
|---|---|---|
| `ГАШВУХMARKHOR` | 1555956 | 0.69 |
| `ZAIBYXMARKHOR` | 1555956 | 0.72 |
| `Аня` | 768152 | 0.95 |
| `AHA` | 768152 | 0.96 |

17 − 2 duplicates = 15, exactly matching `total_battlers`. Same failure class as both prior
audits' findings (cross-screenshot name-matching not merging the same real player read twice
across overlapping captures). A second `elite_wars` event (2026-04-20, battlers=15,
members=16) shows the same 1-over pattern; not individually re-verified in this pass but almost
certainly the same cause given how consistently it's now been confirmed elsewhere.

### 3. The "row 11" honor-monotonicity pattern, now confirmed across all three alliances

The OCR service logs for this run show the same signature seen in both prior audits — honor
monotonicity breaking specifically around row 11 (the highlighted/viewer row, or the row
immediately adjacent to it), with the LLM fallback independently reading a plausible correct
value and getting rejected for not matching the already-wrong OCR honor:

```
donation row 11: alliance_honor=9719 breaks monotonicity (previous row=2779)
donation row 11: no re-OCR candidate for alliance_honor fits [0, 2779] — keeping 9719, lowering confidence for visibility
LLM correction rejected for 'Somethin kool' → '(SOD) Somethin_kool' (row 11): read score 255 ≠ OCR honor 955 — likely a misaligned/overlaid read, keeping OCR
LLM correction rejected for 'ran' → '(SOD) ran' (row 11): read score 270 ≠ OCR honor 970 — likely a misaligned/overlaid read, keeping OCR
```

This is now a **three-for-three** pattern across every alliance audited today. Combined with the
Test Alliance report's finding that the highlighted "viewer" row (green, distinct styling) had
the only confirmed *name* misread on a non-standard-styled row, this is worth elevating from
"noted pattern" to "worth a dedicated look": something about row 11 / the viewer-highlighted row
specifically seems more failure-prone than an average row, across multiple different real
captures and alliances. (Root-cause fix idea unchanged from the Test Alliance report: let the
honor-monotonicity rescue path trust the LLM's independently-read value instead of requiring it
to match the already-flagged-wrong OCR value.)

### 4. Same-honor pairs that are NOT duplicates (confirmed clean in this dataset too)

Consistent with both prior reports' warnings: don't assume same-value ⇒ duplicate.
`kotarou`/`Pluto` (both 120), `Blake`/`moco`/`Moud` (all 360 in earlier tiers) were not
individually screenshot-verified this round, but given the established pattern from the other
two audits (several confirmed-legitimate coincidental matches), treat low-value same-honor pairs
here with the same caution — verify against source images before assuming a bug.

## What looked clean

- The `Weekly`-tab donation screenshots (message `1502770964281167902`) matched the DB accurately
  for every row spot-checked (`Аня`=9794, `MHGYM7000`=9252, `2jr`=7071 — including the correctly-
  colored highlighted "viewer" row for `2jr`).
- 38/38 uploads processed successfully this run, 0 duplicates, 0 failures — a clean ingestion run
  operationally, even though finding #1 shows the *data* has a real classification bug.

## Open questions for further analysis

1. **Priority**: reproduce and fix `_detect_selected_tab`'s failure on the Daily-tab screenshot
   in message `1502785513839530146` (finding #1) — this is the most impactful bug found across
   all three audits today, since it silently corrupts an entire leaderboard's meaning rather than
   a handful of individual rows.
2. Should `upsertDonationResult`/the parser cross-check period_type consistency *within* a single
   `/reprocess-channel` batch (e.g., flag if some uploads in the same run resolve to daily and
   others to weekly for what looks like the same recurring capture), as a second line of defense
   against tab-misdetection?
3. Is "row 11" / the viewer-highlighted row specifically worth a dedicated OCR-quality
   investigation, given it's now shown a problem in 3/3 audited alliances today?
4. Same standing questions from the prior two reports (LLM-rescue circularity, post-hoc
   duplicate-merge heuristic, persisting `possible_truncation`) apply equally here.

## Appendix — raw counts at time of audit

| event_type | event_datetime | alliance_rank | total_battlers | total_points | member_count |
|---|---|---|---|---|---|
| elite_wars | 2026-04-01 15:00 | 109 | 18 | 17870 | 11 |
| wasteland_showdown | 2026-04-03 13:00 | – | 17 | 3015 | 17 |
| elite_wars | 2026-04-05 17:30 | 105 | 9 | 18146 | 9 |
| **elite_wars** | **2026-04-06 13:30** | **110** | **15** | **17784** | **17 ⚠️ (finding #2)** |
| polar_invasion | 2026-04-07 13:00 | 4 | 20 | 4450 | 20 |
| elite_wars | 2026-04-12 17:00 | 110 | 26 | 18069 | 24 |
| polar_invasion | 2026-04-14 13:00 | 5 | – | 4275 | 11 |
| elite_wars | 2026-04-17 11:00 | 114 | 17 | 17728 | 17 |
| elite_wars | 2026-04-19 14:30 | 118 | 12 | 17445 | 12 |
| elite_wars | 2026-04-20 16:30 | 122 | 15 | 17115 | 16 ⚠️ (not individually re-verified) |
| polar_invasion | 2026-04-21 13:00 | 6 | 17 | 4870 | 17 |
| elite_wars | 2026-04-27 15:00 | 116 | 15 | 17523 | 15 |
| polar_invasion | 2026-04-28 13:00 | 5 | 20 | 2955 | 20 |

**Donations**: 1 period, `period_start=2026-05-04`, 106 rows — **mixes a Weekly-tab capture and a
Daily-tab capture**, see finding #1.
