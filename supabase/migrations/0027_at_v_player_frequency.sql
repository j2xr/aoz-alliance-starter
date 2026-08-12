-- 0027_at_v_player_frequency.sql
-- Per-player capture frequency: how many DISTINCT captures a player has been
-- credited in. This is the "frequency prior" behind Q3 — a spelling seen many
-- times is a trusted reading; a spelling seen once that closely resembles an
-- often-seen one is very likely a misread of it.
--
-- "Occurrence" = a distinct capture, not a raw row: an event is one occurrence
-- however many screenshots it spanned, a donation week likewise. So we count
-- DISTINCT event_id in at_participations and DISTINCT donation_period_id in
-- at_donations, then sum. Aliased OCR spellings already redirect to the
-- canonical player_id at write time (upsert.ts name-resolve), so counting by
-- player_id inherently aggregates a player's variants — no alias join needed.
--
-- Left joins keep every roster player present with occurrences 0 (a player that
-- exists but was never credited), so the bot can read this in place of the bare
-- at_players roster at credit time without losing anyone.
--
-- Consumers: the credit path (upsert.ts) reads occurrences to decide whether a
-- roster entry a new name resembles is "established" enough to flag the new
-- name for review; /find-duplicates shows each side's count so a human keeps
-- the most-seen spelling as canonical during /merge. Neither ever rewrites a
-- canonical automatically — frequency only raises a review/merge priority.

drop view if exists at_v_player_frequency;

create view at_v_player_frequency
with (security_invoker = true) as
select
  p.id                                as player_id,
  p.alliance_id,
  p.name,
  coalesce(ev.n, 0) + coalesce(dn.n, 0) as occurrences,
  coalesce(ev.n, 0)                   as event_occurrences,
  coalesce(dn.n, 0)                   as donation_occurrences
from at_players p
left join (
  select player_id, count(distinct event_id) as n
  from at_participations
  group by player_id
) ev on ev.player_id = p.id
left join (
  select player_id, count(distinct donation_period_id) as n
  from at_donations
  group by player_id
) dn on dn.player_id = p.id;

comment on view at_v_player_frequency is
  'Per-player capture frequency (Q3 frequency prior). occurrences = distinct events (at_participations) + distinct donation weeks (at_donations) the player was credited in; aliased spellings already fold into the canonical player_id at write time, so no alias join is needed. Every roster player appears (occurrences 0 if never credited). Read by the credit path and /find-duplicates to raise review/merge priority — never to rewrite a canonical automatically.';
