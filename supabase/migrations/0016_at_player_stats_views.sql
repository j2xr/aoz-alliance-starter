-- 0016_at_player_stats_views.sql
-- Vues utilitaires pour les stats militaires des joueurs.

-- Dernières stats par joueur par alliance (une ligne par joueur).
-- Utilisée par le dashboard pour afficher l'état actuel.
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

-- Historique complet par joueur (pour graphiques d'évolution).
-- Le dashboard filtre par alliance_id + player_id et trie par recorded_date.
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
