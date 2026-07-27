# "Row 11" honor-monotonicity audit-case verification — 2026-07-27

**Question this answers** (P2.3, deferred from the 2026-07-26 `/reprocess-channel` audits): three
audits found the same signature — a donation capture's honor-monotonicity guard always fires on
"row 11" (the last of `_MAX_ROWS=12` slots, the geometrically worst-aligned one). PR #29 (already
merged) fixed the honor↔LLM circularity for rows the guard flags as suspect. **Are the five concrete
cases the audits documented actually fixed today, or does PR #29 only mask some of them?** Rather
than deduce this from reading the code (a first pass at that reasoning, recorded below, turned out
to be wrong on two of the five cases), this was verified empirically with the new
`tools/verify_honor_audit_cases.py`, reprocessing the exact real screenshots that produced each case
through the current production pipeline.

## Answer: all five are fixed today — including two this session's own code-reading got wrong

```
$ docker compose run --rm --no-deps -e JOBS_DB_PATH=/tmp/jobs.db \
    -v "$PWD/apps/ocr-service/tools:/app/tools:ro" -v "$PWD/data/inbox:/inbox:ro" \
    ocr-service python tools/verify_honor_audit_cases.py --root /inbox --mode full --include-unconfirmed

=== row-11 honor-monotonicity audit-case verification ===
root: /inbox   mode: full
cases: 5 (4 confirmed)
...
summary:
  Somethin_kool (92256->2385): hits=2  parser pass/fail=1/1  full pass/fail=2/0  reached_llm=1
  StoKaizer (9044->2944): hits=2  parser pass/fail=1/1  full pass/fail=2/0  reached_llm=1
  Somethin_kool (955->255): hits=29  parser pass/fail=24/2  full pass/fail=25/1  reached_llm=6
  ran (970->270): hits=5  parser pass/fail=1/1  full pass/fail=2/0  reached_llm=1
  nuna (51325->5135): hits=2  parser pass/fail=1/1  full pass/fail=2/0  reached_llm=1
```

Model: `qwen3-vl:2b-instruct-q4_K_M` (production Ollama, `LLM_FALLBACK_ENABLED=true`), run 2026-07-27.

The five per-hit rows that actually matter — the genuine "row 11" instance for each case (name
matches, `parser_honor` equals the historically-stored wrong value):

| case | image | row_index | period_type | parser_honor | suspect_window | final_honor | final_confidence |
|---|---|---|---|---|---|---|---|
| Somethin_kool (Test Alliance) | `1527351181750440036/Screenshot_20260516_221949` | 11 | weekly | 92256 [fail] | (0, 2458) | **2385 [pass]** | 0.45 |
| StoKaizer | `1527351181750440036/Screenshot_20260516_221943` | 11 | weekly | 9044 [fail] | (0, 3102) | **2944 [pass]** | 0.45 |
| Somethin_kool (SOD) | `1502785513839530146/Screenshot_20260509_232946` | 11 | daily | 955 [fail] | (0, 255) | **255 [pass]** | 0.45 |
| ran (SOD) | `1502785513839530146/Screenshot_20260509_232939` | 11 | daily | 970 [fail] | (0, 275) | **270 [pass]** | 0.45 |
| nuna (LOL, unconfirmed) | `1500244014480228402/Screenshot_20260502_231146` | 11 | weekly | 51325 [fail] | (0, 5525) | **5135 [pass]** | 0.45 |

All five: `parser`-only (no LLM) still reads the historically-wrong value — confirming the root
cause (`_ocr_honor_candidates` re-OCR sweep still can't recover it, see Part 2 of the implementation
plan) is unchanged — but the **full production pipeline** now stores the correct value, via PR #29's
`suspect_honor_window` → LLM-replacement path (`final_confidence=0.45` = `_LLM_HONOR_REPLACED_CONFIDENCE`
on every one of them, confirming the same mechanism fixed all five).

## Correction to this plan's own pre-verification reasoning

The implementation plan assumed the two SOD cases (`Somethin_kool`/955→255, `ran`/970→270) were
**still broken** — reasoning that their log line format ("read score X ≠ OCR honor Y — likely a
misaligned/overlaid read") matched `extract.py`'s `window is None` self-consistency branch, not the
`suspect_honor_window` branch PR #29 fixed, and that a smaller honor value can't break an ascending
monotonicity check. **This was wrong.** The verification above shows both rows genuinely do have a
`suspect_honor_window` set (`(0, 255)` and `(0, 275)`) — they broke monotonicity in their real
capture's context, and PR #29's fix applies to them exactly as it does to the two originally-cited
Test Alliance cases. The old report's log line format most likely predates PR #29 splitting the
rejection message into two branches, so matching today's message text against yesterday's log
output was not a valid way to infer which branch a pre-fix log line came from. Lesson already baked
into how this plan was sequenced (verify first, code second) — this is exactly the case that
justified it.

## A real false-positive the tool itself surfaced, and fixed its own report to flag

The SOD `Somethin_kool` (955→255) case matched **29 rows**, not one — because `stored_honor=955`
alone (no name match) is not a reliable locator: honor 255 is the exact value the SOD report's
*separate* Daily/Weekly tab-misdetection bug (finding #1, fixed by PR #27) produced for **12
different, unrelated players** in the same contaminated period (`First3pm`, `Natasha`, `Satana`,
`Dark3pm`, `Maria*`, `doradora12`, `XxDFSTRIICTORxX`, `Lucky.lucciano`, `Indira.IsaLATAM`, plus
garbage-named rows — all reproduced verbatim by this run). The tool's honor-only matching correctly
found the genuine row (`name='Somethin kool'`, no mismatch flag) among this noise, but the other 28
hits are unrelated players who happen to share the coincidental value — visible in the report via
the `[name differs — likely unrelated]` annotation added after this run first surfaced the ambiguity
(a real player, `KOR.morningstar`, honor 955 for a legitimate, unrelated reason, was the first one
found). All 28 are `period_type=daily`, meaning post-PR #27 they're rejected by
`upsertDonationResult`'s `period_type !== 'weekly'` guard before ever reaching the DB regardless of
their honor value — belt-and-suspenders with the fix confirmed above.

## What this means for Part 2 (the tall-crop fallback)

Since the full pipeline already stores the correct value for all five documented cases, the planned
`_ocr_honor_candidates` tall-crop fix (Part 2) is **defense-in-depth, not a live-bug fix** for these
specific cases — it only matters when `LLM_FALLBACK_ENABLED=false` (the documented default, though
production overrides it to `true`) or when Ollama is unavailable (the circuit breaker at
`extract.py:296-302`). Still worth shipping: relying on an LLM call to fix a mechanical OCR crop
problem is a soft dependency this repo shouldn't need, and the fix is cheap, safe, and additive.

Per the plan's fixture-promotion gate: since `--mode parser` still **fails** on the row-11 image
today (`parser_honor=92256`, not `2385`), `weekly_011.jpg` should **not** be promoted to a fixture
yet — only after Part 2 ships and a rerun of `--mode parser` on
`data/inbox/1527351181750440036/Screenshot_20260516_221949_Age_of_Origins.jpg` actually passes.

## Caveat, stated honestly

`--mode full` calls a real (if local) vision model — not deterministic by construction. This run's
`final_confidence=0.45` on every genuine hit is the accepted-replacement sentinel
(`_LLM_HONOR_REPLACED_CONFIDENCE`), not a coincidence, which is reassuring, but a future rerun could
in principle see the LLM misread one of these differently. Re-run
`tools/verify_honor_audit_cases.py --fail-on-regression` periodically (or before touching
`extract.py`/`contribution_ranking_v1.py`'s honor path again) rather than trusting this snapshot
indefinitely.
