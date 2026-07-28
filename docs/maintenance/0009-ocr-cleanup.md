# Runbook — OCR error cleanup (ex-migration 0009)

Original SQL from `supabase/migrations/0009_at_cleanup_ocr_errors.sql`,
removed from the migration path: it was a one-off repair for the original
deployment (magic thresholds, named players), wrongly replayed by every new
clone. The power ↔ points swap fix now lives at ingestion time
(`apps/ocr-service/app/validators.py`, `maybe_swap_power_points`). Kept here
as a manual-repair template — run only after the diagnostics in section A.

```sql
-- 0009_at_cleanup_ocr_errors.sql
-- OCR error cleanup: power ↔ points inversion and misrecognized players
--
-- ⚠️  BEFORE RUNNING:
--   1. Run the diagnostic queries (section A) to check the thresholds
--   2. Adjust the thresholds if needed based on your data
--   3. Run section B (swap) — it's safe and transactional
--   4. Run section C (suspect players) only after manual review

-- ─── A. DIAGNOSTIC (read-only) ───────────────────────────────────────────────
--
-- power ↔ points inversion: suspect values
--   SELECT
--     p.id,
--     pl.name,
--     p.power,
--     p.points,
--     p.raw_ocr->>'power'  AS raw_power,
--     p.raw_ocr->>'points' AS raw_points,
--     p.created_at
--   FROM at_participations p
--   JOIN at_players pl ON pl.id = p.player_id
--   WHERE p.power < 10000 AND p.points > 100000
--   ORDER BY p.created_at;
--
-- Players with names that are too short (likely OCR artifacts):
--   SELECT
--     pl.id,
--     pl.name,
--     pl.last_power,
--     pl.last_seen_at,
--     count(p.id) AS nb_participations
--   FROM at_players pl
--   LEFT JOIN at_participations p ON p.player_id = pl.id
--   WHERE length(pl.name) <= 3
--   GROUP BY pl.id
--   ORDER BY nb_participations, pl.name;
--
-- Players named "Ye" specifically:
--   SELECT * FROM at_players WHERE name = 'Ye';

-- ─── B. FIX power ↔ points INVERSION ──────────────────────────────────────────
--
-- Heuristic: power (combat strength) is typically > 100,000.
-- If power < 10,000 and points > 100,000, the columns are probably swapped.
--
-- Adjust the thresholds if your data shows otherwise in diagnostic A.
-- The swap is done in a single transaction; at_players.last_power is fixed
-- at the same time for the affected players.

BEGIN;

WITH swapped AS (
  UPDATE at_participations
  SET
    power  = points::bigint,
    points = power::int
  WHERE power < 10000
    AND points > 100000
  RETURNING player_id
)
UPDATE at_players pl
SET last_power = (
  SELECT power
  FROM at_participations p
  WHERE p.player_id = pl.id
  ORDER BY p.created_at DESC
  LIMIT 1
)
FROM (SELECT DISTINCT player_id FROM swapped) s
WHERE pl.id = s.player_id;

COMMIT;

-- ─── C. DELETE SUSPECT PLAYERS (manual review required) ───────────────────────
--
-- Uncomment and adapt after examining the diagnostic A results.
-- Deleting a player cascades to at_participations and at_alliance_memberships.
--
-- Option 1: delete one specific player by exact name
--   BEGIN;
--   DELETE FROM at_players
--   WHERE name = 'Ye'            -- ← adjust the name
--     AND alliance_id = (SELECT id FROM at_alliances WHERE name = 'MyAlliance');
--   COMMIT;
--
-- Option 2: delete every player with 0 participations and a short name
--   BEGIN;
--   DELETE FROM at_players pl
--   WHERE length(pl.name) <= 2
--     AND NOT EXISTS (
--       SELECT 1 FROM at_participations p WHERE p.player_id = pl.id
--     );
--   COMMIT;
--
-- Option 3: delete a player and reassign their participations to another
--   (if "Ye" is actually "YeKaterina", already in the database)
--   BEGIN;
--   UPDATE at_participations
--   SET player_id = (SELECT id FROM at_players WHERE name = 'YeKaterina' AND alliance_id = ...)
--   WHERE player_id = (SELECT id FROM at_players WHERE name = 'Ye' AND alliance_id = ...);
--
--   UPDATE at_alliance_memberships
--   SET player_id = (SELECT id FROM at_players WHERE name = 'YeKaterina' AND alliance_id = ...)
--   WHERE player_id = (SELECT id FROM at_players WHERE name = 'Ye' AND alliance_id = ...);
--
--   DELETE FROM at_players WHERE name = 'Ye' AND alliance_id = ...;
--   COMMIT;
```
