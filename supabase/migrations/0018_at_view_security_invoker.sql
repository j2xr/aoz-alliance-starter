-- 0018_at_view_security_invoker.sql
-- 1) Toutes les vues at_v_* passent en security_invoker : elles s'exécutent
--    avec les droits de l'utilisateur appelant, donc l'isolation RLS par
--    alliance (0017) s'applique aussi aux lectures faites via les vues.
--    Sans cela, une vue s'exécute avec les droits de son propriétaire et
--    contourne les policies des tables sous-jacentes (fuite inter-alliances).
--    Le bot n'est pas impacté : service_role bypasse RLS dans tous les cas.
-- 2) Redéfinit at_v_player_participation_rate pour exposer les colonnes
--    réellement consommées par le dashboard (player_name, eligible_events,
--    participation_rate_pct, avg_points), absentes de la définition de 0002.

alter view at_v_event_leaderboard      set (security_invoker = true);
alter view at_v_donation_leaderboard   set (security_invoker = true);
alter view at_v_donation_player_totals set (security_invoker = true);
alter view at_v_player_stats_latest    set (security_invoker = true);
alter view at_v_player_stats_history   set (security_invoker = true);
alter view at_v_probable_leavers       set (security_invoker = true);

-- ─── at_v_player_participation_rate ──────────────────────────────────────────
-- eligible_events = nombre d'événements de l'alliance survenus depuis la
-- première apparition du joueur (premier membership connu ou première
-- participation, le plus ancien des deux).
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
    -- least() ignore les NULL ; NULL seulement si le joueur n'a ni
    -- membership ni participation → 0 événement éligible.
    and e2.event_datetime >= least(b.first_seen, fj.first_joined)
) el;
