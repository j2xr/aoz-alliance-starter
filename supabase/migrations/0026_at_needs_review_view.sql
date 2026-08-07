-- 0026_at_needs_review_view.sql
-- Gives the `needs_review` flag (0021) a read surface.
--
-- 0021 added the flag to at_participations and at_donations and the bot has
-- been writing it ever since (upsert.ts, true when 0 <= ocr_confidence < 0.5),
-- but nothing ever read it back: no view, no page, no command. That migration
-- said as much — "surfacing this in the frontend is out of scope for this
-- migration (backlog item)". This is that backlog item, and the rows have been
-- accumulating in the meantime.
--
-- The two tables are unioned into one shape so the dashboard can present a
-- single worklist ordered by confidence, rather than making the reviewer check
-- two places. Columns that only apply to one side (event_id,
-- donation_period_id) are NULL on the other.
--
-- Deliberately NOT filtered by confidence here: the view returns exactly what
-- the pipeline flagged. The -1 sentinel (LLM correction accepted) never sets
-- needs_review in the first place, so it cannot appear.

-- Idempotent: this view was created ahead of the migration-history record
-- (its PR was developed off a branch that didn't yet carry 0025), so a later
-- `supabase db push` must be able to replay it without failing.
drop view if exists at_v_needs_review;

create view at_v_needs_review
with (security_invoker = true) as
select
  'participation'::text                   as kind,
  pa.id                                   as row_id,
  e.alliance_id,
  p.id                                    as player_id,
  p.name                                  as player_name,
  pa.player_rank,
  pa.ocr_confidence,
  e.event_datetime                        as occurred_at,
  et.display_name                         as context_label,
  e.id                                    as event_id,
  null::uuid                              as donation_period_id,
  pa.points::bigint                       as value,
  'points'::text                          as value_label
from at_participations pa
join at_events        e  on e.id  = pa.event_id
join at_event_types   et on et.id = e.event_type_id
join at_players       p  on p.id  = pa.player_id
where pa.needs_review

union all

select
  'donation'::text,
  d.id,
  dp.alliance_id,
  p.id,
  p.name,
  d.player_rank,
  d.ocr_confidence,
  -- Donations are keyed by an ISO week (a date), not an instant. Cast through
  -- UTC explicitly so the ordering doesn't depend on the server timezone.
  (dp.period_start::timestamp at time zone 'UTC'),
  'Week of ' || to_char(dp.period_start, 'YYYY-MM-DD'),
  null::uuid,
  dp.id,
  d.alliance_honor,
  'honor'::text
from at_donations         d
join at_donation_periods dp on dp.id = d.donation_period_id
join at_players           p on p.id  = d.player_id
where d.needs_review;

comment on view at_v_needs_review is
  'Unified worklist of rows the OCR pipeline flagged as low-confidence (needs_review, added in 0021). Participations and donations share one shape; event_id / donation_period_id is NULL on the side it does not apply to. Fix a row with the /correct Discord command.';
