-- 0012_at_donation_views.sql
-- Vues utilitaires pour le suivi des dons (consommées par le bot et le dashboard).

-- Classement des dons à l'intérieur d'une période (rank window function).
create view at_v_donation_leaderboard as
select
  dp.id              as donation_period_id,
  dp.alliance_id,
  dp.period_type,
  dp.period_start,
  dp.period_end,
  a.name             as alliance_name,
  p.id               as player_id,
  p.name             as player_name,
  d.player_rank,
  d.alliance_honor,
  d.updated_at,
  rank() over (partition by dp.id order by d.alliance_honor desc) as position
from at_donation_periods dp
join at_alliances  a on a.id = dp.alliance_id
join at_donations  d on d.donation_period_id = dp.id
join at_players    p on p.id = d.player_id;

-- Totaux par joueur sur l'ensemble des périodes connues.
create view at_v_donation_player_totals as
select
  p.alliance_id,
  p.id                          as player_id,
  p.name,
  count(distinct dp.id)         as periods_contributed,
  coalesce(sum(d.alliance_honor), 0)::bigint as total_alliance_honor,
  max(d.alliance_honor)         as best_period_honor,
  coalesce(avg(d.alliance_honor), 0)::bigint as avg_per_period,
  max(dp.period_start)          as last_period_start
from at_players p
left join at_donations d         on d.player_id = p.id
left join at_donation_periods dp on dp.id = d.donation_period_id
group by p.alliance_id, p.id, p.name;
