-- 0014_at_fix_player_duplicates.sql
--
-- NO-OP — one-off repair from the original deployment, removed from the
-- migration path. The file is kept (empty) so the original deployment's
-- Supabase migration history stays consistent: deleting it would force a
-- `supabase migration repair` over there.
--
-- Original content: merge of about thirty duplicate (mojibake) players
-- referenced by hardcoded UUIDs — moot on a fresh clone, where these UUIDs
-- don't exist. Day-to-day merges go through the bot's /merge and
-- /player-alias commands (at_player_aliases table).
--
-- Original SQL archived as a runbook:
-- docs/maintenance/0014-player-duplicates-merge.md

select 1;
