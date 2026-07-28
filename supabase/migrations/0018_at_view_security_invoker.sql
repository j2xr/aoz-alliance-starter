-- 0018_at_view_security_invoker.sql
-- 1) All at_v_* views switch to security_invoker: they now run with the
--    calling user's privileges, so the per-alliance RLS isolation (0017)
--    also applies to reads made through the views. Without this, a view
--    runs with its owner's privileges and bypasses the underlying tables'
--    policies (cross-alliance leak). The bot is unaffected: service_role
--    bypasses RLS in every case.
-- 2) Redefines at_v_player_participation_rate to expose the columns
--    actually consumed by the dashboard (player_name, eligible_events,
--    participation_rate_pct, avg_points), missing from 0002's definition.

alter view at_v_event_leaderboard      set (security_invoker = true);
alter view at_v_donation_leaderboard   set (security_invoker = true);
alter view at_v_donation_player_totals set (security_invoker = true);
alter view at_v_player_stats_latest    set (security_invoker = true);
alter view at_v_player_stats_history   set (security_invoker = true);
alter view at_v_probable_leavers       set (security_invoker = true);

-- ─── at_v_player_participation_rate ──────────────────────────────────────────
-- eligible_events = number of the alliance's events that occurred since the
-- player's first appearance (earliest of their first known membership or
-- first participation).
-- participation_rate_pct = events_participated / eligible_events * 100.

drop view at_v_player_participation_rate;

create view at_v_player_participation_rate
with (security_invoker = true) as
with base as (
  select
    p.alliance_id,
    p.id                        as player_id,
    p.name,
    p.last_power,
    count(distinct pa.event_id) as events_participated,
    sum(pa.points)              as total_points,
    avg(pa.points)::int         as avg_points_per_event,
    max(pa.points)              as best_score,
    min(e.event_datetime)       as first_seen,
    max(e.event_datetime)       as last_participation
  from at_players p
  left join at_participations pa on pa.player_id = p.id
  left join at_events e          on e.id = pa.event_id
  group by p.alliance_id, p.id, p.name, p.last_power
),
first_join as (
  select player_id, min(joined_at) as first_joined
  from at_alliance_memberships
  group by player_id
)
select
  b.alliance_id,
  b.player_id,
  b.name,
  b.name                  as player_name,
  b.last_power,
  b.events_participated,
  b.total_points,
  b.avg_points_per_event,
  b.avg_points_per_event  as avg_points,
  b.best_score,
  b.first_seen,
  b.last_participation,
  el.eligible_events,
  case
    when el.eligible_events > 0
    then round(b.events_participated::numeric * 100 / el.eligible_events, 1)
  end as participation_rate_pct
from base b
left join first_join fj on fj.player_id = b.player_id
cross join lateral (
  select count(*)::int as eligible_events
  from at_events e2
  where e2.alliance_id = b.alliance_id
    -- least() ignores NULLs; NULL only if the player has neither a
    -- membership nor a participation → 0 eligible events.
    and e2.event_datetime >= least(b.first_seen, fj.first_joined)
) el;
