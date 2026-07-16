-- 0020_at_donations_leaderboard_position.sql
-- Ajoute la position affichée à l'écran (1-81) sur at_donations, en colonne
-- purement informative — PAS une clé d'identité/dédup (la contrainte unique
-- (donation_period_id, player_id) ne change pas).
--
-- Contexte : une calibration de l'OCR de cette colonne sur une vraie capture
-- a montré que le chiffre peut être mal lu de façon *confiante* (ex. la
-- médaille du rang 1 lue "2" avec 2 votes contre 0 pour "1"), contrairement à
-- un nom mal lu qui se voit à l'œil nu. En faire une clé UPSERT ferait courir
-- le risque d'écraser silencieusement la ligne d'un autre joueur. Elle sert
-- donc uniquement de signal de diagnostic (repérer un trou dans la séquence,
-- recouper avec l'ordre de tri par alliance_honor) — le nom (via at_players)
-- reste l'identité du joueur.

alter table at_donations
  add column leaderboard_position int;

comment on column at_donations.leaderboard_position is
  'Position affichée à l''écran (1-81), OCR best-effort. Informative uniquement : NULL si le vote multi-config n''a pas atteint une majorité forte. Ne pas utiliser comme clé d''identité (voir DonationMember.leaderboard_position côté ocr-service).';

-- Redéfinition de la vue pour exposer la colonne, à côté de `position`
-- (calculée par rank() over (...), inchangée) — pour que le bot/dashboard
-- puisse comparer les deux et repérer les écarts.
drop view at_v_donation_leaderboard;

create view at_v_donation_leaderboard
with (security_invoker = true) as
select
  dp.id                    as donation_period_id,
  dp.alliance_id,
  dp.period_type,
  dp.period_start,
  dp.period_end,
  a.name                   as alliance_name,
  p.id                     as player_id,
  p.name                   as player_name,
  d.player_rank,
  d.alliance_honor,
  d.leaderboard_position,
  d.updated_at,
  rank() over (partition by dp.id order by d.alliance_honor desc) as position
from at_donation_periods dp
join at_alliances  a on a.id = dp.alliance_id
join at_donations  d on d.donation_period_id = dp.id
join at_players    p on p.id = d.player_id;
