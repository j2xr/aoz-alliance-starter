# OCR data-quality audit — LOL alliance `/reprocess-channel` run, 2026-07-26

**For: analysis by a future Opus session.** Raw findings from a live production reprocess, no
code changes made as part of this audit. Companion to
`2026-07-26-reprocess-channel-data-quality-report.md` (the "Test Alliance" audit from earlier the
same day) — several of the same bug *classes* recur here, cross-referenced below.

## Operational incident (read before trusting completeness)

- **Alliance**: LOL (`discord_channel_id=1497861992675934308`, `at_alliances.id=da56bb82-…`).
- **First run** (`/reprocess-channel`, started 10:07:55 UTC): the `alliance-discord-bot`
  container was killed and restarted at 10:26:30–10:28:41 UTC, **mid-run** — no
  `"Channel reprocess completed"` log line was ever emitted. 87 uploads made it into Supabase
  before the interruption, all `processing_status=processed`, 0 failed/pending. Since
  `/reprocess-channel` does not resume a partial run, anything after the interruption point in
  Discord's message history may never have been attempted.
- **Second run** (retry, ~10:53–10:54 UTC): **all 103/103 attachments failed** with
  `TypeError: fetch failed` (Discord CDN fetch, not an OCR-service error) —
  `"successCount":0,"duplicateCount":0,"failedCount":103"`. This added **zero** new data.
- **Net result**: this report covers only the **87 uploads from the first, interrupted run**.
  The true total image count for this channel is unknown (the second run's `totalImages: 103`
  is the best available estimate, but that run may itself have seen a different/incomplete
  message set). **Treat this as a partial audit** — a clean, fully-completed reprocess of this
  channel has not yet happened.

## Scope of what was audited

- 87 processed uploads across 13 Discord messages.
- 21 events (`elite_wars`, `polar_invasion`, `wasteland_showdown`, `void_war`,
  `ironblood_battlefield`, `battle_frenzy` — one mixed capture reused from the same source as
  the Test Alliance audit, see finding #5) and 2 donation periods (88 members for the week
  starting 2026-04-27; 8 members for a much shorter, likely single-page 2026-05-04 capture).
- Verified a `elite_wars` event (2026-04-22, 50 raw rows) and 2 of the 8 donation screenshots
  (`Screenshot_20260502_231058`/`_231213`, message `1500244014480228402`) directly against the
  source images.

## Confirmed findings

### 1. Duplicate player exactly explains a member-count-vs-battlers mismatch

Event `ddee7f3c` (`elite_wars`, 2026-04-22): `total_battlers=49` but 50 `at_participations` rows
recorded. Two of those 50 rows have **identical points** (2556130):

| name | points | ocr_confidence |
|---|---|---|
| `зрух` | 2556130 | 0.90 |
| `SPyx` | 2556130 | 0.16 |

Same real player (very likely `spyx`, who also appears correctly in this alliance's donation
list), read as two different OCR outputs across what were evidently two overlapping screenshot
captures — one confidently wrong (`зрух`, Cyrillic-look garbage, *high* confidence despite being
wrong), one correctly low-confidence (`SPyx`, closer to the real name). Removing this one
duplicate makes 50 → 49, exactly matching `total_battlers`. This is the same failure class as
the Test Alliance audit's `Big§teelCurtain`/`RigSteelCurtain` finding, and this instance comes
with unusually clean arithmetic proof that duplicate-merging (not header-stat misreads) is the
root cause here — worth citing as the cleanest example of this bug class found so far.

### 2. A confidently-wrong name that no guardrail flagged

Donation rank 12 (screenshot `Screenshot_20260502_231058…`): true name is a heavily decorated
Japanese name, `᠅幸恵丸✝船長᠅` (kanji + decorative bullet/cross glyphs). Stored name:
**`40. | HOTS ~`** — completely unrelated garbage — at `ocr_confidence=0.542` and
**`needs_review=false`**. Unlike every wrong value found in the Test Alliance audit, this one
was *not* flagged by any existing guardrail (confidence was high enough to clear whatever
threshold gates `needs_review`/LLM fallback for names). Contrast with the *same real player*
appearing correctly in this alliance's `elite_wars` capture as `幸恵丸一船長` — there,
`ocr_confidence=-1.0` (the LLM-fallback-corrected marker), meaning the LLM fallback *did* trigger
and fix it in that capture, but evidently didn't trigger (or wasn't needed by the confidence
gate, and then wasn't right) for the donation capture of the same name. This suggests the
failure is capture-specific (crop/threshold luck) rather than a name that's unrecoverable in
general — but it also means **a moderately-confident, completely wrong name can currently slip
through with zero visibility**, which the flagged cases in the other audit did not.

### 3. Another instance of the "duplicate honor across overlapping pages" pattern

Donation rank 23 (screenshot `Screenshot_20260502_231058…`) is confirmed `(LOL) Герман`, honor
7507 — matches the DB's `Герман` row (conf 0.847) exactly. A second row, `GÀ cà.` (conf 0.253,
**flagged** `needs_review=true`), holds the *identical* honor value 7507. Same pattern as finding
#1 above and as the Test Alliance audit's `Big§teelCurtain`/`RigSteelCurtain`: this one **was**
correctly flagged (low confidence caught it), unlike finding #2.

### 4. Two honor values far outside their local neighborhood, both flagged

| Player | Stored `alliance_honor` | Neighbors (for scale) | Status |
|---|---|---|---|
| nuna | **51325** | next-highest in this donation list is 9608 | `needs_review=true`, conf=0 |
| Genesis | **9608** | between 51325(bad) and 8744 | `needs_review=true`, conf=0 |

Not directly screenshot-verified in this pass (ran out of scope budget — see Open questions), but
the raw OCR job log captured during the first run shows an *intermediate* read of `nuna` at
**5135** (confidence 0.71) in one capture — plausibly the true value, given it sits naturally
between this list's `Дмитриий` (5525) and `CHIANTI` (5105). If so, this is the *same* "honor
monotonicity flags it, but the wrong number is what's live" pattern documented in detail in the
Test Alliance audit (findings #1 there) — just not yet screenshot-confirmed for this alliance's
data. Flagging as **unconfirmed but high-probability**, consistent with a real, recurring pattern
rather than a one-off.

### 5. Cross-alliance data overlap (provenance note, not a bug)

The `battle_frenzy` event (2026-04-05 00:00, `total_battlers=99`,
`total_points=697182130`) appears in **both** this LOL audit and the earlier Test Alliance audit
with byte-identical header stats, differing only in `member_count` (60 here vs 11 there). This
is almost certainly the same underlying screenshot(s) uploaded to both test channels (both are
clearly demo/test setups), not a data-integrity bug — but worth knowing if cross-referencing the
two reports, since it means the two alliances' historical event data isn't fully independent.

### 6. Likely-partial capture, unrecoverable truncation signal

Event `151f51b3` (`polar_invasion`, 2026-04-28): `total_battlers=43` but only 17
`at_participations` rows. This looks like a short capture (1-2 pages of a scrollable ~43-row
leaderboard, rather than the full sequence) — but `possible_truncation` is **not persisted** to
the database (it's advisory-only, surfaced in the Discord message at ingestion time and then
lost), so there's no way to confirm after the fact whether the flag fired for this capture. This
is the same architectural gap noted as a "reste à couvrir" item in the original PR #22 review
(`~/.claude/plans/archive/donation-ocr-pr22-review-followup.md`) — this is a concrete instance of
it costing real diagnostic information here.

### 7. Minor character-level degradations (low severity)

- `Madara⁶⁹Uchiha` (superscript digits as a stylized separator) → stored as `Madara°°Uchiha`
  (superscript misread as degree signs) — confirmed via screenshot.
- `THOR,O1` / `kor,spark` — comma/period confusion, plausibly `THOR.01` / `kor.spark`.
- `| (LOL)` as a stored *name* (honor 6498) — the alliance-tag-strip logic's own documented
  fallback ("if the tag consumes the entire string, reject the split, keep raw text") firing as
  designed when the real name portion was apparently unreadable — by-design behavior, but still
  produces a garbage-looking roster entry worth being aware of.

## What looked clean

- The majority of the 50 `elite_wars` rows and the donation rows checked directly against
  screenshots matched exactly, including several stylized/accented names (`DuyMặtThẹo`,
  `ĐRACØNIAÑ`, `Дмитриий`, `Толик`).
- `Can` (donation rank 58, honor 3913) is flagged `needs_review=true` at conf=0.485 but is
  **actually correct** per the screenshot — a false-positive review flag, harmless (just asks a
  human to double-check something that was fine), unlike finding #2's false-negative.
- The LLM fallback correctly fixed a difficult decorative-Japanese name in the `elite_wars`
  capture (`幸恵丸一船長`, conf=-1.0 marker) — the *same* real player's name failed silently in
  the donation capture (finding #2), showing the fallback isn't uniformly reliable across
  captures of the same name, not that it never works.

## Open questions for further analysis

1. Screenshot-confirm `nuna` (51325 vs a suspected true value of ~5135) and `Genesis` (9608) —
   not done in this pass; would close out finding #4.
2. Finding #2 (a confidently-wrong, unflagged name) suggests the `needs_review`/LLM-fallback
   confidence gate has a blind spot around "moderate" confidence (~0.5) on names with unusual
   Unicode/decorative glyphs — worth checking whether the threshold or the fallback trigger
   condition needs adjustment, since this is the first *unflagged* wrong value found across both
   audits.
3. Same as the Test Alliance report: would a post-hoc same/near-honor + name-edit-distance merge
   pass safely catch findings #1 and #3 here without false-positiving (see that report's
   confirmed-legitimate same-honor counterexamples)?
4. Persisting `possible_truncation` (or at least an event/period-level "expected vs actual row
   count" note) would have let finding #6 be confirmed or ruled out here — currently impossible
   after the fact.
5. Given the operational incident: is there monitoring/alerting for the discord-bot container
   restarting mid-command, and for `/reprocess-channel`'s Discord-CDN-fetch failure mode? Neither
   surfaced as more than a log line during this run.

## Appendix — raw event counts at time of audit

| event_type | event_datetime | alliance_rank | total_battlers | total_points | member_count |
|---|---|---|---|---|---|
| wasteland_showdown | 2026-04-03 13:00 | – | 41 | 6715 | 41 |
| battle_frenzy | 2026-04-05 00:00 | – | 99 | 697182130 | 60 |
| elite_wars | 2026-04-05 15:30 | 76 | 50 | 19398 | 50 |
| polar_invasion | 2026-04-07 13:00 | 1 | 43 | 21955 | 43 |
| elite_wars | 2026-04-10 09:30 | 88 | 18 | 19093 | 18 |
| wasteland_showdown | 2026-04-10 13:00 | – | 40 | 2380 | 40 |
| polar_invasion | 2026-04-14 21:00 | 2 | 26 | 11630 | 26 |
| elite_wars | 2026-04-15 11:30 | 74 | 29 | 19470 | 29 |
| ironblood_battlefield | 2026-04-16 04:00 | 12 | – | – | 12 |
| ironblood_battlefield | 2026-04-16 13:00 | 18 | – | – | 18 |
| ironblood_battlefield | 2026-04-16 21:00 | 7 | – | – | 7 |
| elite_wars | 2026-04-17 10:30 | 72 | 22 | 19814 | 22 |
| wasteland_showdown | 2026-04-17 13:00 | – | 27 | 8470 | 27 |
| void_war | 2026-04-19 00:00 | – | 100 | 303078340 | 33 |
| elite_wars | 2026-04-19 13:00 | 63 | 21 | 20093 | 21 |
| polar_invasion | 2026-04-21 13:00 | 2 | 39 | 17415 | 39 |
| **elite_wars** | **2026-04-22 13:00** | **58** | **49** | **20407** | **50 ⚠️ (finding #1)** |
| wasteland_showdown | 2026-04-24 13:00 | – | 30 | 8910 | 30 |
| elite_wars | 2026-04-26 18:30 | 53 | 37 | 20754 | 37 |
| **polar_invasion** | **2026-04-28 13:00** | **3** | **43** | **15030** | **17 ⚠️ (finding #6)** |
| elite_wars | 2026-04-29 11:30 | 49 | 29 | 21075 | 29 |

**Donations**: 2 periods — 88 members (week of 2026-04-27), 8 members (week of 2026-05-04,
likely a short/single-page capture).
