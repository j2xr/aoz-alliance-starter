-- reset-ocr-data.sql
-- Cleans up all OCR-derived data (events, participations, players,
-- donations, stats, upload history) to start from a clean slate before a
-- `/reprocess-channel`.
--
-- Usage:
--   supabase db query --linked -f supabase/scripts/reset-ocr-data.sql
--
-- If `supabase db query --linked` isn't usable (no CLI login token,
-- no psql/DATABASE_URL fallback), use reset-ocr-data.sh instead, which
-- does the same cleanup via the REST API with the service-role key.
--
-- Preserved (do NOT touch):
--   - at_alliances           : alliance configuration
--   - at_alliance_members    : Auth user ↔ alliance join (dashboard access)
--   - at_event_types         : event type catalog + title_aliases
--                              (OCR corrections seeded via migration, e.g. 0019)
--   - events                 : the frontend's public calendar table, a
--                              separate domain, never touched by the bot
--
-- Cleaned:
--   - at_screenshot_uploads  : MANDATORY. reprocess-channel's dedup is done
--                              on (file_hash, alliance_id) in this table
--                              (see findExistingUpload in
--                              tracker/apps/discord-bot/src/lib/upsert.ts).
--                              If it isn't emptied, EVERY screenshot comes
--                              back as a "duplicate" and nothing is reprocessed.
--   - at_events, at_participations
--   - at_players, at_alliance_memberships
--   - at_player_aliases      : WARNING — cascades from at_players (FK
--                              on delete cascade). Emptying at_players also
--                              deletes manually curated OCR aliases. If
--                              aliases exist and must be preserved,
--                              export the table before running this script.
--   - at_donation_periods, at_donations
--   - at_player_stats
--   - at_corrections         : /correct audit history (migration 0022,
--                              added after this script's first version).
--                              References at_players (FK on delete
--                              cascade) — must be emptied in the same
--                              command, otherwise Postgres refuses the
--                              TRUNCATE of at_players (0A000: cannot
--                              truncate a table referenced in a foreign
--                              key constraint).
--
-- Every table referenced by FK from the tables below is included in the
-- same TRUNCATE command (required by Postgres, otherwise the operation is
-- rejected). No CASCADE needed: the list is complete — but it must be
-- updated whenever a new table references one of these (see at_corrections
-- above, which was missed when it was added in migration 0022).

TRUNCATE TABLE
  at_screenshot_uploads,
  at_participations,
  at_alliance_memberships,
  at_player_aliases,
  at_donations,
  at_donation_periods,
  at_player_stats,
  at_corrections,
  at_events,
  at_players;
