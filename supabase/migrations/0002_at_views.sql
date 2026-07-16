-- 0002_at_views.sql
-- Vues utilitaires pour le dashboard et Grafana

-- Taux de participation par joueur (tous événements confondus)
create view at_v_player_participation_rate as
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
group by p.alliance_id, p.id, p.name, p.last_power;

-- Leaderboard par événement (classement par points décroissants)
create view at_v_event_leaderboard as
select
  e.id               as event_id,
  e.alliance_id,
  e.event_datetime,
  et.code            as event_type_code,
  et.display_name    as event_type,
  a.name             as alliance_name,
  p.id               as player_id,
  p.name             as player_name,
  pa.player_rank,
  pa.power,
  pa.points,
  pa.ocr_confidence,
  rank() over (partition by e.id order by pa.points desc) as position
from at_events e
join at_event_types  et on et.id = e.event_type_id
join at_alliances     a on a.id  = e.alliance_id
join at_participations pa on pa.event_id = e.id
join at_players       p on p.id  = pa.player_id;
