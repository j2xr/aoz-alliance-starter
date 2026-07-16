# Runbook — fusion de joueurs dupliqués (ex-migration 0014)

SQL d'origine de `supabase/migrations/0014_at_fix_player_duplicates.sql`,
retiré du chemin de migration : il fusionnait des joueurs précis (UUID en
dur) du déploiement d'origine et n'avait aucun sens dans un clone neuf.
Pour les besoins courants, utiliser les commandes `/merge` et
`/player-alias` du bot. Conservé ici comme modèle de fusion en masse
(la structure _merge_map → réaffectations → alias → delete est réutilisable).

```sql
-- 0014_at_fix_player_duplicates.sql
-- Fusion des entrées at_players en doublon dues à des erreurs OCR :
--   - mojibake UTF-8 (ï¼ˆLOLï¼‰ au lieu de （LOL）, Ã au lieu de Ä, etc.)
--   - balise d'alliance lue comme préfixe du pseudo ((LOL)Jrh)
--   - caractère parasite ou espace OCR inséré (j asmin, MGK 2219)
--   - confusion lettre/chiffre (THOR,O1 vs THOR,01)
--   - artefacts de rank lus comme pseudo (R1, R2)
--
-- Stratégie pour chaque paire (doublon → canonique) :
--   1. Mettre à jour les stats du canonique avec les meilleures valeurs
--   2. Réattribuer at_participations, at_alliance_memberships, at_donations
--      et at_player_aliases vers le canonique
--   3. En cas de conflit de clé unique : la ligne du canonique prime
--      (sauf at_donations où on garde la valeur max)
--   4. Enregistrer l'ancien nom comme alias (at_player_aliases) pour les captures futures
--   5. Supprimer l'entrée dupliquée

BEGIN;

-- ─── Table de mapping doublon → canonique ────────────────────────────────────

CREATE TEMP TABLE _merge_map (
  dup_id   uuid NOT NULL,
  canon_id uuid NOT NULL
) ON COMMIT DROP;

INSERT INTO _merge_map (dup_id, canon_id) VALUES

  -- ── Alliance 7a72b304-1189-4236-95e3-323e4bcc3f40 (LOL) ──────────────────

  -- ï¼ˆLOLï¼‰CHIANTI → CHIANTI  (（LOL） fullwidth lu comme préfixe)
  ('580e6858-cb37-408d-8c7c-45422ca5d652', '8ca86160-d508-4a5a-a862-ff86986e538d'),

  -- (LOL)Jrh → Jrh
  ('2b988a0d-71a5-4594-a3e9-74d38aa1b1fa', '72bb49a1-f6b5-4e00-90e3-bc20cff6349e'),

  -- Loki (sans données) → ~Loki~  (tildes drop OCR)
  ('7a488ba2-2f3d-4dc0-919e-c49de4e7a743', 'ea1395c5-3d45-45d9-8ee9-5b5c27be80f2'),

  -- CATFIGHT 10960 → CATFIGHT  (nombre OCR parasite collé au pseudo)
  ('6eeeba9e-c2e5-472c-9a19-05dd13b53de1', '1efb3e1c-7176-4f87-8336-79fac37e975b'),

  -- DRAÄŒONIÃƒN → DRACONIAN  (mojibake Č→ÄŒ, A→Ãƒ)
  ('063fe540-a177-4ff0-be35-322c99750dc7', 'f1a70aa5-c8d1-4938-afe2-f8aecba07c6c'),

  -- ÄRACÃ˜NIAN → DRACONIAN  (D→Ä, O→Ã˜)
  ('80a8cbd3-84db-4b30-81a3-976ee9d3e9b8', 'f1a70aa5-c8d1-4938-afe2-f8aecba07c6c'),

  -- DuyMáº¯tTheo → DuyMatTheo  (ậ→áº¯ mojibake)
  ('f084b8af-287a-435a-b0f2-3b1ba0f2c212', 'd4028f40-0c16-4b6c-baf4-977d6a100363'),

  -- DuyMáº·tTheo → DuyMatTheo  (ặ→áº· mojibake)
  ('66f808e1-4959-447e-ab90-56a347377761', 'd4028f40-0c16-4b6c-baf4-977d6a100363'),

  -- Ð"Ð¼Ð¸Ñ‚Ñ€Ð¸Ð¸Ð¹ (Дмитрии, double и) → Ð"Ð¼Ð¸Ñ‚Ñ€Ð¸Ð¹ (Дмитрий, orthographe correcte)
  ('2eb84ac6-5e7a-4cc7-8917-6ec4d6eaac97', 'ee1d9d86-7bc8-4536-92a8-2626c55d611a'),

  -- LEÃ"N → LEON  (Ó→Ã")
  ('f2e9e553-a9bd-46d5-85e6-0940d6f88f27', 'dbe77f30-db3b-43fc-b7c4-23e58e642eed'),

  -- MGK 2219 → MGK  (code joueur OCR collé au pseudo)
  ('6591e881-5284-43be-ad35-d3f325a8a77d', 'f313e126-b4d5-47f7-bf5b-eea024c3bd0a'),

  -- Kcuscg → Kcuscáº¿  (puissance et date plus récentes sur Kcuscáº¿)
  ('b992aa58-3cfe-4405-99a4-d73066ba0cc8', '4e79cf77-71a2-46ab-9ae2-7b9299c7a39b'),

  -- THOR,O1 (lettre O) → THOR,01 (chiffre 0)
  ('53827fcc-3f9a-4250-b325-10ed390dd9fa', '8b3882a5-1074-4228-a7de-1738db9825a9'),

  -- Ð¡ÐºÐ°Ð·ÐºÐ° 7131 → Ð¡ÐºÐ°Ð·ÐºÐ°  (nombre OCR parasite)
  ('0f023ba5-d66b-4692-a18e-a86b995dec24', '0d9e395c-2f30-4626-8af3-63c9c59216ac'),

  -- å¹¸æµä¸¸ãƒ»èˆ¹é•· → å¹¸æµä¸¸â†'èˆ¹é•·  (・→ãƒ» mojibake ; â†' = canonique, puissance max)
  ('9ffe0733-88be-4256-b103-a49ec3bceaf7', '2c8d40d8-c042-488d-9fbf-a052b52dbe20'),

  -- å¹¸æµä¸¸ ï¼Ÿèˆ¹é•· → å¹¸æµä¸¸â†'èˆ¹é•·  (espace + ？ OCR parasite)
  ('0789a952-77c8-4bee-82d5-d0ee199cebf9', '2c8d40d8-c042-488d-9fbf-a052b52dbe20'),

  -- å¹¸æµä¸¸åèˆ¹é•· → å¹¸æµä¸¸â†'èˆ¹é•·  (å = caractère parasite)
  ('6041bc7a-7559-4973-beca-c7610e715ee4', '2c8d40d8-c042-488d-9fbf-a052b52dbe20'),

  -- å¹¸æµä¸¸ä¸€èˆ¹é•· → å¹¸æµä¸¸â†'èˆ¹é•·  (一 = caractère parasite)
  ('172ecd4a-078a-4943-9758-a1f99ddbbcd8', '2c8d40d8-c042-488d-9fbf-a052b52dbe20'),

  -- ãŠãƒ¼ã—ã (sans données) → ãŠä¸€ã—ã‚ (おーしあ, puissance max)
  ('92d741d7-ee41-4094-8aa3-cc42507412b6', '14cd6873-b354-4512-98c9-6cb3a66af1c9'),

  -- ãŠãƒ¼ã—ã‚ → ãŠä¸€ã—ã‚  (ー→一 OCR japonais)
  ('a35ec2d6-1fed-4217-aa9a-640a6a5e4002', '14cd6873-b354-4512-98c9-6cb3a66af1c9'),

  -- j asmin → jasmin  (espace OCR parasite)
  ('0e6e9e20-f4a1-4701-a086-63ae179f1036', 'd0bb1a34-b075-4405-8cf1-417108f01742'),

  -- ── Alliance bf19b890-dd4f-447c-a7b8-3ae35f5ec6d3 ────────────────────────

  -- BigÂ§teelCurtain → BigSteelCurtain  (S→Â§ mojibake)
  ('1a53d64d-3191-4277-a55a-8a07135a7184', 'b8ee1cea-10d2-481f-9851-7e3651ea5a8e'),

  -- BigSteelCurlain → BigSteelCurtain  (rn→rl confusion OCR)
  ('8620e3ee-9e54-4170-a8b6-c3c207484649', 'b8ee1cea-10d2-481f-9851-7e3651ea5a8e'),

  -- DÃ„RKSIDÃˆãƒ»ç¯‰ → DÃ„RKSIDEãƒ»ç¯‰  (È→Ãˆ en fin de mot)
  ('646232e8-64d1-40eb-ac90-0f9c34bb4b2d', 'f6ae658a-9634-44a3-8751-491d447a9ea8'),

  -- DÃ„RKSIPEãƒ»ç¯‰ → DÃ„RKSIDEãƒ»ç¯‰  (D→P confusion OCR)
  ('25f6c95b-b98c-4ac4-8aa9-32238c0a4365', 'f6ae658a-9634-44a3-8751-491d447a9ea8'),

  -- Mjolnir → MjÃ³lnir  (puissance max sur MjÃ³lnir)
  ('c81288b8-6c81-4cfa-a2bf-c9a62fb42a7e', '84d61b7e-d456-4b30-8494-270551d675da'),

  -- MjÃ¶lnir → MjÃ³lnir  (ö→Ã¶ mojibake)
  ('52c18577-6530-4024-8177-3bf5df5e17b5', '84d61b7e-d456-4b30-8494-270551d675da'),

  -- Saâ€ ana → Satana  (apostrophe typographique â€™ → t mojibake)
  ('ddcd0e7c-2c86-4aee-b2db-613a604da382', '02500675-ffbd-4e41-9150-f2ba3ee694b6');

-- ─── 1. Mise à jour des stats du canonique (prend le meilleur) ────────────────

UPDATE at_players canon
SET
  last_power   = GREATEST(canon.last_power, dup.last_power),
  last_seen_at = GREATEST(canon.last_seen_at, dup.last_seen_at),
  last_rank    = CASE
                   WHEN dup.last_seen_at IS NOT NULL
                    AND (canon.last_seen_at IS NULL
                         OR dup.last_seen_at > canon.last_seen_at)
                   THEN dup.last_rank
                   ELSE canon.last_rank
                 END
FROM _merge_map m
JOIN at_players dup ON dup.id = m.dup_id
WHERE canon.id = m.canon_id;

-- ─── 2. at_participations ─────────────────────────────────────────────────────
-- Cas couverts :
--   A. Doublon vs canonique (même event) → supprimer le doublon
--   B. Doublon vs doublon du même canonique (même event) → supprimer celui avec le plus grand id
--      (cas typique : Mjolnir + MjÃ¶lnir participent tous les deux au même event,
--       l'un doit être éliminé avant que les deux soient réattribués au même canonique)

DELETE FROM at_participations p_dup
WHERE p_dup.player_id IN (SELECT dup_id FROM _merge_map)
  AND EXISTS (
    SELECT 1
    FROM at_participations p_winner
    JOIN _merge_map m ON p_dup.player_id = m.dup_id
    WHERE p_winner.event_id = p_dup.event_id
      AND (
        -- cas A : le canonique possède déjà cette participation
        p_winner.player_id = m.canon_id
        OR
        -- cas B : un autre doublon du même canonique a un id plus petit (l'arbitre)
        (p_winner.player_id IN (
           SELECT d2.dup_id FROM _merge_map d2 WHERE d2.canon_id = m.canon_id
         )
         AND p_winner.id < p_dup.id)
      )
  );

-- Réattribuer les participations restantes
UPDATE at_participations
SET player_id = m.canon_id
FROM _merge_map m
WHERE player_id = m.dup_id;

-- ─── 3. at_alliance_memberships ───────────────────────────────────────────────
-- Même logique que les participations : couvre doublon↔canonique et doublon↔doublon
-- La contrainte unique est (alliance_id, player_id, joined_at).

DELETE FROM at_alliance_memberships am_dup
WHERE am_dup.player_id IN (SELECT dup_id FROM _merge_map)
  AND EXISTS (
    SELECT 1
    FROM at_alliance_memberships am_winner
    JOIN _merge_map m ON am_dup.player_id = m.dup_id
    WHERE am_winner.alliance_id = am_dup.alliance_id
      AND am_winner.joined_at   = am_dup.joined_at
      AND (
        am_winner.player_id = m.canon_id
        OR
        (am_winner.player_id IN (
           SELECT d2.dup_id FROM _merge_map d2 WHERE d2.canon_id = m.canon_id
         )
         AND am_winner.id < am_dup.id)
      )
  );

-- Réattribuer les lignes restantes
UPDATE at_alliance_memberships
SET player_id = m.canon_id
FROM _merge_map m
WHERE player_id = m.dup_id;

-- ─── 4. at_donations ──────────────────────────────────────────────────────────

-- 4a. Mettre à jour le canonique au max des valeurs de tous ses doublons
--     (pour les périodes où le canonique possède déjà une ligne)
WITH dup_max AS (
  SELECT m.canon_id,
         d.donation_period_id,
         MAX(d.alliance_honor) AS max_honor,
         MAX(d.updated_at)     AS max_updated
  FROM at_donations d
  JOIN _merge_map m ON d.player_id = m.dup_id
  GROUP BY m.canon_id, d.donation_period_id
)
UPDATE at_donations d_canon
SET alliance_honor = GREATEST(d_canon.alliance_honor, dm.max_honor),
    updated_at     = GREATEST(d_canon.updated_at,     dm.max_updated)
FROM dup_max dm
WHERE d_canon.player_id          = dm.canon_id
  AND d_canon.donation_period_id = dm.donation_period_id;

-- 4b. Supprimer les dons conflictuels des doublons :
--     - cas A : le canonique a déjà ce don (valeur mise à jour en 4a)
--     - cas B : un autre doublon du même canonique a une valeur ≥ et un id ≤
DELETE FROM at_donations d_dup
WHERE d_dup.player_id IN (SELECT dup_id FROM _merge_map)
  AND EXISTS (
    SELECT 1
    FROM _merge_map m
    WHERE m.dup_id = d_dup.player_id
      AND (
        -- cas A
        EXISTS (
          SELECT 1 FROM at_donations d_canon
          WHERE d_canon.player_id          = m.canon_id
            AND d_canon.donation_period_id = d_dup.donation_period_id
        )
        OR
        -- cas B
        EXISTS (
          SELECT 1 FROM at_donations d_other
          JOIN _merge_map m2 ON d_other.player_id = m2.dup_id
          WHERE m2.canon_id               = m.canon_id
            AND d_other.donation_period_id = d_dup.donation_period_id
            AND d_other.id               != d_dup.id
            AND (
              d_other.alliance_honor > d_dup.alliance_honor
              OR (d_other.alliance_honor = d_dup.alliance_honor AND d_other.id < d_dup.id)
            )
        )
      )
  );

-- 4c. Réattribuer les dons restants (non conflictuels)
UPDATE at_donations
SET player_id = m.canon_id
FROM _merge_map m
WHERE player_id = m.dup_id;

-- ─── 5. at_player_aliases ─────────────────────────────────────────────────────

-- Mettre à jour les alias qui pointaient vers un doublon
UPDATE at_player_aliases
SET player_id = m.canon_id
FROM _merge_map m
WHERE player_id = m.dup_id;

-- ─── 6. Enregistrement des anciens noms comme alias ──────────────────────────
-- Permet de résoudre directement les futures captures OCR produisant l'ancien nom.

INSERT INTO at_player_aliases (alliance_id, player_id, raw_name, created_by)
SELECT p.alliance_id, m.canon_id, p.name, 'migration_0014'
FROM _merge_map m
JOIN at_players p ON p.id = m.dup_id
ON CONFLICT (alliance_id, raw_name) DO NOTHING;

-- ─── 7. Suppression des doublons ──────────────────────────────────────────────

DELETE FROM at_players
WHERE id IN (SELECT dup_id FROM _merge_map);

-- ─── 8. Suppression des artefacts OCR : libellés de rang lus comme pseudo ─────
-- "R1" (524dc475) et "R2" (7f28b143) n'ont pas de participations ; supprimés
-- uniquement si effectivement sans participation (sécurité).

DELETE FROM at_players
WHERE id IN (
  '524dc475-9f7e-431b-b787-f48fa4f5d8e8',  -- name = 'R1', créé le 2026-05-02 21:28
  '7f28b143-9c39-4058-b237-133da7f499af'   -- name = 'R2', créé le 2026-05-02 21:28
)
AND NOT EXISTS (
  SELECT 1 FROM at_participations WHERE player_id = at_players.id
)
AND NOT EXISTS (
  SELECT 1 FROM at_donations WHERE player_id = at_players.id
);

COMMIT;

-- ─── NOTES : cas restants à traiter manuellement ─────────────────────────────
--
-- Les entrées ci-dessous sont des noms OCR garbled SANS doublon existant
-- (le vrai joueur n'a pas encore de ligne propre). Elles nécessitent un
-- UPDATE at_players SET name = '<nom corrigé>' WHERE id = '<id>'
-- + INSERT INTO at_player_aliases pour l'ancien nom.
--
-- Alliance 7a72b304 :
--   0ccef60f  ï¼ˆLOLï¼‰Goatman    → renommer en 'Goatman'
--   71affe71  (LOL)JÓ™ÏƒÎ·Î·Î·Ð´  → déchiffrement manuel requis
--   cf90ccbc  Lol) BlizzardsKing → probablement '(LOL)BlizzardKing' ; vérifier
--   0733a796  BlizzardKing       → lié au précédent ?
--   583453d9  $imb4 6498 R4      → artefact OCR sévère, identifier le vrai joueur
--   dcf3ed03  Gumper 6738        → idem
--   cc1b7fce  VVW 6483           → idem ; potentiellement VVV ou VW ?
--   ae97a748  DarthKnight        → à confirmer : distinct de DarkKnight ?
```

## Après normalisation (service OCR)

`normalize_name()` (`app/parsers/name_ocr.py`) est désormais appliqué à la
source par les parsers OCR : mojibake latin-1/UTF-8, NFD→NFC, ponctuation
pleine chasse → ASCII et caractères zero-width sont corrigés avant que le nom
n'atteigne `at_players`. Les nouvelles captures ne devraient donc plus
reproduire les corruptions listées ci-dessus (les vecteurs de ce runbook
servent de base aux tests de `tests/test_name_ocr.py`).

**Effet de bord attendu sur le déploiement existant.** Les joueurs déjà
stockés sous forme mojibake (ex. `MjÃ¶lnir`, `ï¼ˆLOLï¼‰CHIANTI`) ne matchent
plus, par construction, le nom désormais propre que produit l'OCR (`Mjölnir`,
`(LOL)CHIANTI`) — la contrainte `unique (alliance_id, name)` ne les
rapproche pas automatiquement. La prochaine capture d'un de ces joueurs crée
donc une entrée `at_players` "propre" en doublon de l'ancienne entrée
mojibake, qui elle reste inerte (plus jamais reproduite par l'OCR).

Deux façons de traiter ce cas au fil de l'eau :

1. **Réactif** : quand un doublon apparaît (le bot ou une revue périodique le
   signale), fusionner l'ancien nom mojibake vers le nouveau propre avec
   `/merge <ancien> <propre>` — l'alias enregistré absorbe alors les
   futures captures qui reproduiraient encore l'ancienne graphie (peu
   probable une fois l'OCR normalisé, mais couvre les captures déjà en
   file d'attente au moment du déploiement).
2. **Proactif** : exécuter une fois `tools/normalize_player_names.py`
   (dry-run par défaut) pour renommer directement en base les joueurs dont
   le nom stocké diffère de sa forme normalisée et qui n'entrent en
   collision avec aucun autre joueur de la même alliance. Les collisions
   qu'il détecte (nom normalisé déjà pris par un autre joueur, ou plusieurs
   doublons convergeant vers le même nom normalisé) restent à traiter
   manuellement par `/merge` — ce sont les mêmes paires que celles déjà
   cataloguées dans ce runbook.
