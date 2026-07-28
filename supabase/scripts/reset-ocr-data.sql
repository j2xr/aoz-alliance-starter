-- reset-ocr-data.sql
-- Nettoie toutes les données dérivées de l'OCR (events, participations,
-- joueurs, dons, stats, historique d'upload) pour repartir sur une base
-- saine avant un `/reprocess-channel`.
--
-- Usage :
--   supabase db query --linked -f supabase/scripts/reset-ocr-data.sql
--
-- Si `supabase db query --linked` n'est pas utilisable (pas de token CLI
-- login, pas de psql/DATABASE_URL en fallback), utiliser à la place
-- reset-ocr-data.sh, qui fait le même nettoyage via l'API REST avec la
-- service-role key.
--
-- Conservé (ne PAS toucher) :
--   - at_alliances           : config des alliances
--   - at_alliance_members    : jonction user Auth ↔ alliance (accès dashboard)
--   - at_event_types         : référentiel des types d'événements + title_aliases
--                              (corrections OCR seedées en migration, ex: 0019)
--   - events                 : table du calendrier public frontend, domaine
--                              séparé, jamais touchée par le bot
--
-- Nettoyé :
--   - at_screenshot_uploads  : OBLIGATOIRE. La dédup de reprocess-channel se
--                              fait sur (file_hash, alliance_id) dans cette
--                              table (voir findExistingUpload dans
--                              tracker/apps/discord-bot/src/lib/upsert.ts).
--                              Si elle n'est pas vidée, TOUTES les captures
--                              ressortent en "doublon" et rien n'est retraité.
--   - at_events, at_participations
--   - at_players, at_alliance_memberships
--   - at_player_aliases      : ATTENTION — cascade depuis at_players (FK
--                              on delete cascade). Vider at_players supprime
--                              aussi les alias OCR curés manuellement. Si des
--                              alias existent et doivent être préservés,
--                              exporter la table avant d'exécuter ce script.
--   - at_donation_periods, at_donations
--   - at_player_stats
--   - at_corrections         : historique d'audit de /correct (migration 0022,
--                              postérieure à la première version de ce
--                              script). Référence at_players (FK on delete
--                              cascade) — doit être vidée dans la même
--                              commande, sinon Postgres refuse le TRUNCATE
--                              de at_players (0A000: cannot truncate a table
--                              referenced in a foreign key constraint).
--
-- Toutes les tables référencées par FK depuis les tables ci-dessous sont
-- incluses dans la même commande TRUNCATE (requis par Postgres, sinon
-- l'opération est rejetée). Aucun CASCADE nécessaire : la liste est complète
-- — mais elle doit être mise à jour à chaque nouvelle table qui référence
-- l'une de celles-ci (voir at_corrections ci-dessus, oubliée lors de son
-- ajout en migration 0022).

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
