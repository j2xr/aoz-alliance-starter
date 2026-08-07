-- 0025_at_event_import_delta.sql
-- Compares what the game's own header declared for an event against what the
-- OCR import actually landed in at_participations.
--
-- Why a view: at_events already stores the header values read off the
-- screenshot (alliance_rank, total_battlers, total_points, 0001_at_init.sql),
-- but nothing ever compared them to the imported rows. That comparison needs
-- no hand-built ground truth — the game states the totals itself — so it is
-- the cheapest objective completeness signal available.
--
-- ─── IMPORTANT: only the ROW COUNT is comparable ────────────────────────────
--
-- `total_battlers` and the imported row count are the same quantity, so their
-- difference is meaningful for every event type. Verified against the live
-- data: most events match exactly (29/29, 37/37, 20/20), and the mismatches
-- are real missing pages (43 declared vs 17 imported).
--
-- `total_points` is NOT universally the sum of the members' points. Measured
-- on the hand-transcribed fixtures (tests/fixtures/*/*.json), header total vs.
-- the largest single-page member sum:
--
--     battle_frenzy       33,040,670 vs 33,030,668   ratio 1.0   same unit
--     void_war            42,156,563 vs 42,137,040   ratio 1.0   same unit
--     polar_invasion          21,955 vs    433,459   ratio 19.7  DIFFERENT
--     wasteland_showdown       1,805 vs     44,080   ratio 24.4  DIFFERENT
--     elite_wars              16,865 vs  4,372,556   ratio 259.3 DIFFERENT
--
-- For those three types the header figure is a different metric altogether
-- (an alliance-level score, not a sum of individual contributions). Computing
-- a "points delta" there produced coverage figures like 167,490% — alarming
-- and meaningless. So this view exposes both point totals as raw numbers for
-- context, but deliberately computes NO points delta or coverage: the
-- completeness verdict is driven by the row count alone.
--
-- If points coverage is ever wanted for the two comparable types, the clean
-- way is a per-type flag on at_event_types (the property belongs to the event
-- type, not to the individual event) — not a magnitude heuristic.
--
-- Sign convention: delta = official - imported, so a POSITIVE delta means the
-- import is MISSING rows. Derived columns are NULL when the official figure is
-- unknown, so a missing header never looks like a perfect import.

drop view if exists at_v_event_import_delta;

create view at_v_event_import_delta
with (security_invoker = true) as
select
  e.id                                as event_id,
  e.alliance_id,
  e.event_datetime,
  et.code                             as event_type_code,
  et.display_name                     as event_type,
  e.alliance_rank,

  -- ── Completeness signal: row counts (comparable for every event type) ──
  e.total_battlers                    as official_battlers,
  count(pa.id)::int                   as imported_players,
  case when e.total_battlers is not null
       then e.total_battlers - count(pa.id)::int
  end                                 as battlers_delta,
  case when e.total_battlers is not null and e.total_battlers > 0
       then round(count(pa.id)::numeric * 100 / e.total_battlers, 1)
  end                                 as battlers_coverage_pct,

  -- ── Context only: see the header note above, these are NOT comparable ──
  e.total_points                      as official_points,
  coalesce(sum(pa.points), 0)::bigint as imported_points,
  count(pa.id) filter (where pa.points > 0)::int as scoring_players,

  -- Rows the OCR pipeline itself flagged as low-confidence (0021), so
  -- "data is missing" can be told apart from "everything landed, unsurely".
  count(pa.id) filter (where pa.needs_review)::int as needs_review_rows
from at_events e
join at_event_types et on et.id = e.event_type_id
left join at_participations pa on pa.event_id = e.id
group by
  e.id, e.alliance_id, e.event_datetime, et.code, et.display_name,
  e.alliance_rank, e.total_battlers, e.total_points;

comment on view at_v_event_import_delta is
  'Per-event import completeness. The verdict comes from the ROW COUNT (total_battlers vs imported rows), which is comparable for every event type; delta = official - imported, so positive means missing rows. The two point totals are exposed for context only and must NOT be compared — for elite_wars/polar_invasion/wasteland_showdown the header points figure is a different metric than the sum of member points (see the migration file for measured ratios).';
