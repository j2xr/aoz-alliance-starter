# Runbook — nettoyage d'erreurs OCR (ex-migration 0009)

SQL d'origine de `supabase/migrations/0009_at_cleanup_ocr_errors.sql`,
retiré du chemin de migration : c'était une réparation ponctuelle du
déploiement d'origine (seuils magiques, joueurs nommés), rejouée à tort
par chaque nouveau clone. La correction de l'inversion power ↔ points
vit désormais à l'ingestion (`apps/ocr-service/app/validators.py`,
`maybe_swap_power_points`). Conservé ici comme modèle de réparation
manuelle — à exécuter uniquement après les diagnostics de la section A.

```sql
-- 0009_at_cleanup_ocr_errors.sql
-- Nettoyage des erreurs OCR : inversion power ↔ points et joueurs mal reconnus
--
-- ⚠️  AVANT D'EXÉCUTER :
--   1. Lancer les requêtes de diagnostic (section A) pour vérifier les seuils
--   2. Adapter les seuils si nécessaire selon tes données
--   3. Lancer la section B (swap) — elle est safe et transactionnelle
--   4. Lancer la section C (joueurs suspects) uniquement après review manuelle

-- ─── A. DIAGNOSTIC (read-only) ───────────────────────────────────────────────
--
-- Inversion power ↔ points : les valeurs suspectes
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
-- Joueurs aux noms trop courts (probables artefacts OCR) :
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
-- Joueurs "Ye" spécifiquement :
--   SELECT * FROM at_players WHERE name = 'Ye';

-- ─── B. CORRECTION INVERSION power ↔ points ──────────────────────────────────
--
-- Heuristique : power (force de combat) est typiquement > 100 000.
-- Si power < 10 000 et points > 100 000, les colonnes sont probablement inversées.
--
-- Adapte les seuils si tes données montrent autre chose dans le diagnostic A.
-- Le swap est fait en une seule transaction ; at_players.last_power est corrigé
-- en même temps pour les joueurs affectés.

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

-- ─── C. SUPPRESSION DES JOUEURS SUSPECTS (review manuelle requise) ────────────
--
-- À décommenter et adapter après avoir examiné les résultats du diagnostic A.
-- La suppression d'un joueur cascade sur at_participations et at_alliance_memberships.
--
-- Option 1 : supprimer un joueur précis par son nom exact
--   BEGIN;
--   DELETE FROM at_players
--   WHERE name = 'Ye'            -- ← adapter le nom
--     AND alliance_id = (SELECT id FROM at_alliances WHERE name = 'MonAlliance');
--   COMMIT;
--
-- Option 2 : supprimer tous les joueurs avec 0 participation et nom court
--   BEGIN;
--   DELETE FROM at_players pl
--   WHERE length(pl.name) <= 2
--     AND NOT EXISTS (
--       SELECT 1 FROM at_participations p WHERE p.player_id = pl.id
--     );
--   COMMIT;
--
-- Option 3 : supprimer un joueur et réattribuer ses participations à un autre
--   (si "Ye" est en réalité "YeKaterina" déjà dans la base)
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
