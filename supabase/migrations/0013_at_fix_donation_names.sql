-- 0013_at_fix_donation_names.sql
-- Fix for player names misrecorded by the donation (OCR) parser.
--
-- Two forms of incorrect names fixed:
--   (a) ranking prefix + tag: "6 (LOL) CATFIGHT"  → name="CATFIGHT",  tag="LOL"
--   (b) unstripped tag alone: "(LOL) RageX_"       → name="RageX_",    tag="LOL"
--
-- NOTE: a third rule (numeric prefix alone, e.g. "9 Медвежонок") was
-- removed: a legitimate name starting with 1-2 digits + a space (e.g.
-- "12 Monkeys") would have been truncated then merged/deleted. These
-- residual cases are handled via /player-alias or /merge, with human
-- validation.
--
-- For each defective name:
--   • If no canonical player exists under the correct name → in-place rename.
--   • If a canonical player already exists              → merge: references
--     (participations, donations, memberships) are reassigned to the
--     canonical player, the old name is recorded as an alias, the duplicate
--     is deleted.
--
-- The regex patterns exactly reproduce contribution_ranking_v1.py's logic
-- after the OCR fix.

-- ─── Step 1: computing the corrections ───────────────────────────────────────

create temp table _at_name_fixes as
select
  p.id            as player_id,
  p.alliance_id,
  p.name          as old_name,
  case
    -- (a)+(b): the name contains an alliance tag "(TAG)" (with possible
    -- stray characters before the parenthesis, or a space inside)
    when p.name ~ '[^A-Za-z(]*\(\s*[A-Za-z0-9]{1,5}\s*\)\s+\S'
    then trim(
           (regexp_match(p.name, '\(\s*[A-Za-z0-9]{1,5}\s*\)\s+(.+)$'))[1]
         )
  end             as new_name,
  (regexp_match(p.name, '\(\s*([A-Za-z0-9]{1,5})\s*\)'))[1] as extracted_tag
from at_players p
where
  p.name ~ '[^A-Za-z(]*\(\s*[A-Za-z0-9]{1,5}\s*\)\s+\S';

-- Remove rows where extraction would have produced an empty result
delete from _at_name_fixes
where new_name is null or trim(new_name) = '';

-- ─── Step 2: merging duplicates (conflict with an existing canonical player) ─

-- 2a. Participations: reassign to the canonical player, skip if already present
insert into at_participations
  (event_id, player_id, player_rank, power, points, ocr_confidence, raw_ocr, created_at)
select
  ap.event_id,
  p2.id,
  ap.player_rank,
  ap.power,
  ap.points,
  ap.ocr_confidence,
  ap.raw_ocr,
  ap.created_at
from _at_name_fixes f
join at_players p2
  on  p2.alliance_id = f.alliance_id
  and p2.name        = f.new_name
  and p2.id         <> f.player_id
join at_participations ap on ap.player_id = f.player_id
on conflict (event_id, player_id) do nothing;

delete from at_participations ap
using _at_name_fixes f
join at_players p2
  on  p2.alliance_id = f.alliance_id
  and p2.name        = f.new_name
  and p2.id         <> f.player_id
where ap.player_id = f.player_id;

-- 2b. Donations: reassign to the canonical player, latest-wins on a period conflict
insert into at_donations
  (donation_period_id, player_id, alliance_honor, player_rank, alliance_tag,
   ocr_confidence, raw_ocr, source_message_id, source_upload_id, updated_at, created_at)
select
  ad.donation_period_id,
  p2.id,
  ad.alliance_honor,
  ad.player_rank,
  coalesce(f.extracted_tag, ad.alliance_tag),
  ad.ocr_confidence,
  ad.raw_ocr,
  ad.source_message_id,
  ad.source_upload_id,
  ad.updated_at,
  ad.created_at
from _at_name_fixes f
join at_players p2
  on  p2.alliance_id = f.alliance_id
  and p2.name        = f.new_name
  and p2.id         <> f.player_id
join at_donations ad on ad.player_id = f.player_id
on conflict (donation_period_id, player_id) do update
  set alliance_honor = excluded.alliance_honor,
      alliance_tag   = coalesce(excluded.alliance_tag, at_donations.alliance_tag),
      updated_at     = excluded.updated_at;

delete from at_donations ad
using _at_name_fixes f
join at_players p2
  on  p2.alliance_id = f.alliance_id
  and p2.name        = f.new_name
  and p2.id         <> f.player_id
where ad.player_id = f.player_id;

-- 2c. Memberships: reassign, skip join-date conflicts
insert into at_alliance_memberships (alliance_id, player_id, joined_at, left_at)
select am.alliance_id, p2.id, am.joined_at, am.left_at
from _at_name_fixes f
join at_players p2
  on  p2.alliance_id = f.alliance_id
  and p2.name        = f.new_name
  and p2.id         <> f.player_id
join at_alliance_memberships am on am.player_id = f.player_id
on conflict (alliance_id, player_id, joined_at) do nothing;

delete from at_alliance_memberships am
using _at_name_fixes f
join at_players p2
  on  p2.alliance_id = f.alliance_id
  and p2.name        = f.new_name
  and p2.id         <> f.player_id
where am.player_id   = f.player_id
  and am.alliance_id = f.alliance_id;

-- 2d. Record the old defective name as an alias of the canonical player
--     (safety net in case old screenshots get reprocessed)
insert into at_player_aliases (alliance_id, raw_name, player_id, created_by)
select f.alliance_id, f.old_name, p2.id, 'migration_0013'
from _at_name_fixes f
join at_players p2
  on  p2.alliance_id = f.alliance_id
  and p2.name        = f.new_name
  and p2.id         <> f.player_id
on conflict (alliance_id, raw_name) do nothing;

-- 2e. Delete the duplicate player (CASCADE handles any remaining children)
delete from at_players p
using _at_name_fixes f
join at_players p2
  on  p2.alliance_id = f.alliance_id
  and p2.name        = f.new_name
  and p2.id         <> f.player_id
where p.id = f.player_id;

-- ─── Step 3: simple rename (no existing canonical player) ────────────────────

update at_players p
set    name = f.new_name
from   _at_name_fixes f
where  p.id = f.player_id
  and  not exists (
    select 1 from at_players p2
    where p2.alliance_id = f.alliance_id
      and p2.name        = f.new_name
      and p2.id         <> f.player_id
  );

-- ─── Step 4: backfilling alliance_tag in at_donations ─────────────────────────
-- Only simple renames remain here (merge cases were handled in 2b). The
-- player_id is unchanged for simple renames.

update at_donations d
set    alliance_tag = f.extracted_tag
from   _at_name_fixes f
where  d.player_id     = f.player_id
  and  f.extracted_tag is not null
  and  (d.alliance_tag is null or d.alliance_tag <> f.extracted_tag);

drop table _at_name_fixes;
