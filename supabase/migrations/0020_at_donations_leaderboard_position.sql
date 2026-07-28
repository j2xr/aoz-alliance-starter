-- 0020_at_donations_leaderboard_position.sql
-- Adds the on-screen displayed position (1-81) to at_donations, as a
-- purely informational column — NOT an identity/dedup key (the unique
-- constraint (donation_period_id, player_id) doesn't change).
--
-- Context: a calibration of this column's OCR on a real screenshot showed
-- the digit can be misread *confidently* (e.g. rank 1's medal read as "2"
-- with 2 votes against 0 for "1"), unlike a misread name which is visible
-- to the naked eye. Making it an UPSERT key would risk silently
-- overwriting another player's row. It therefore only serves as a
-- diagnostic signal (spotting a gap in the sequence, cross-checking
-- against the alliance_honor sort order) — the name (via at_players)
-- remains the player's identity.

alter table at_donations
  add column leaderboard_position int;

comment on column at_donations.leaderboard_position is
  'On-screen displayed position (1-81), OCR best-effort. Informational only: NULL if the multi-config vote didn''t reach a strong majority. Do not use as an identity key (see DonationMember.leaderboard_position on the ocr-service side).';

-- Redefines the view to expose the column, alongside `position`
-- (computed by rank() over (...), unchanged) — so the bot/dashboard can
-- compare the two and spot discrepancies.
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
