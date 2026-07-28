-- 0016_at_player_stats_views.sql
-- Utility views for player military stats.

-- Latest stats per player per alliance (one row per player).
-- Used by the dashboard to display the current state.
create view at_v_player_stats_latest as
select distinct on (ps.alliance_id, ps.player_id)
  ps.alliance_id,
  a.name                  as alliance_name,
  ps.player_id,
  p.name                  as player_name,
  p.last_rank,
  ps.attack_pct,
  ps.attack_kind,
  ps.hp_pct,
  ps.defense_pct,
  ps.ocr_confidence,
  ps.recorded_date,
  ps.updated_at
from at_player_stats ps
join at_alliances a on a.id = ps.alliance_id
join at_players   p on p.id = ps.player_id
order by ps.alliance_id, ps.player_id, ps.recorded_date desc;

-- Full history per player (for evolution charts).
-- The dashboard filters by alliance_id + player_id and sorts by recorded_date.
create view at_v_player_stats_history as
select
  ps.id,
  ps.alliance_id,
  a.name                  as alliance_name,
  ps.player_id,
  p.name                  as player_name,
  ps.attack_pct,
  ps.attack_kind,
  ps.hp_pct,
  ps.defense_pct,
  ps.ocr_confidence,
  ps.recorded_date,
  ps.updated_at
from at_player_stats ps
join at_alliances a on a.id = ps.alliance_id
join at_players   p on p.id = ps.player_id
order by ps.recorded_date desc;
