# Runbook — duplicate player merge (ex-migration 0014)

Original SQL from `supabase/migrations/0014_at_fix_player_duplicates.sql`,
removed from the migration path: it merged specific players (hardcoded UUIDs)
from the original deployment and made no sense on a fresh clone. For
day-to-day needs, use the bot's `/merge` and `/player-alias` commands. Kept
here as a bulk-merge template (the _merge_map → reassignments → alias →
delete structure is reusable).

```sql
-- 0014_at_fix_player_duplicates.sql
-- Merge duplicate at_players entries caused by OCR errors:
--   - UTF-8 mojibake (ï¼ˆLOLï¼‰ instead of （LOL）, Ã instead of Ä, etc.)
--   - alliance tag read as a nickname prefix ((LOL)Jrh)
--   - stray character or OCR-inserted space (j asmin, MGK 2219)
--   - letter/digit confusion (THOR,O1 vs THOR,01)
--   - rank artifacts read as a nickname (R1, R2)
--
-- Strategy for each pair (duplicate → canonical):
--   1. Update the canonical player's stats with the best values
--   2. Reassign at_participations, at_alliance_memberships, at_donations
--      and at_player_aliases to the canonical player
--   3. On a unique-key conflict: the canonical row wins
--      (except at_donations, where we keep the max value)
--   4. Record the old name as an alias (at_player_aliases) for future screenshots
--   5. Delete the duplicate entry

BEGIN;

-- ─── Duplicate → canonical mapping table ─────────────────────────────────────

CREATE TEMP TABLE _merge_map (
  dup_id   uuid NOT NULL,
  canon_id uuid NOT NULL
) ON COMMIT DROP;

INSERT INTO _merge_map (dup_id, canon_id) VALUES

  -- ── Alliance 7a72b304-1189-4236-95e3-323e4bcc3f40 (LOL) ──────────────────

  -- ï¼ˆLOLï¼‰CHIANTI → CHIANTI  (fullwidth （LOL） read as a prefix)
  ('580e6858-cb37-408d-8c7c-45422ca5d652', '8ca86160-d508-4a5a-a862-ff86986e538d'),

  -- (LOL)Jrh → Jrh
  ('2b988a0d-71a5-4594-a3e9-74d38aa1b1fa', '72bb49a1-f6b5-4e00-90e3-bc20cff6349e'),

  -- Loki (no data) → ~Loki~  (tildes dropped by OCR)
  ('7a488ba2-2f3d-4dc0-919e-c49de4e7a743', 'ea1395c5-3d45-45d9-8ee9-5b5c27be80f2'),

  -- CATFIGHT 10960 → CATFIGHT  (stray OCR number stuck to the nickname)
  ('6eeeba9e-c2e5-472c-9a19-05dd13b53de1', '1efb3e1c-7176-4f87-8336-79fac37e975b'),

  -- DRAÄŒONIÃƒN → DRACONIAN  (mojibake Č→ÄŒ, A→Ãƒ)
  ('063fe540-a177-4ff0-be35-322c99750dc7', 'f1a70aa5-c8d1-4938-afe2-f8aecba07c6c'),

  -- ÄRACÃ˜NIAN → DRACONIAN  (D→Ä, O→Ã˜)
  ('80a8cbd3-84db-4b30-81a3-976ee9d3e9b8', 'f1a70aa5-c8d1-4938-afe2-f8aecba07c6c'),

  -- DuyMáº¯tTheo → DuyMatTheo  (ậ→áº¯ mojibake)
  ('f084b8af-287a-435a-b0f2-3b1ba0f2c212', 'd4028f40-0c16-4b6c-baf4-977d6a100363'),

  -- DuyMáº·tTheo → DuyMatTheo  (ặ→áº· mojibake)
  ('66f808e1-4959-447e-ab90-56a347377761', 'd4028f40-0c16-4b6c-baf4-977d6a100363'),

  -- Ð"Ð¼Ð¸Ñ‚Ñ€Ð¸Ð¸Ð¹ (Дмитрии, double и) → Ð"Ð¼Ð¸Ñ‚Ñ€Ð¸Ð¹ (Дмитрий, correct spelling)
  ('2eb84ac6-5e7a-4cc7-8917-6ec4d6eaac97', 'ee1d9d86-7bc8-4536-92a8-2626c55d611a'),

  -- LEÃ"N → LEON  (Ó→Ã")
  ('f2e9e553-a9bd-46d5-85e6-0940d6f88f27', 'dbe77f30-db3b-43fc-b7c4-23e58e642eed'),

  -- MGK 2219 → MGK  (OCR player code stuck to the nickname)
  ('6591e881-5284-43be-ad35-d3f325a8a77d', 'f313e126-b4d5-47f7-bf5b-eea024c3bd0a'),

  -- Kcuscg → Kcuscáº¿  (Kcuscáº¿ has more recent power and date)
  ('b992aa58-3cfe-4405-99a4-d73066ba0cc8', '4e79cf77-71a2-46ab-9ae2-7b9299c7a39b'),

  -- THOR,O1 (letter O) → THOR,01 (digit 0)
  ('53827fcc-3f9a-4250-b325-10ed390dd9fa', '8b3882a5-1074-4228-a7de-1738db9825a9'),

  -- Ð¡ÐºÐ°Ð·ÐºÐ° 7131 → Ð¡ÐºÐ°Ð·ÐºÐ°  (stray OCR number)
  ('0f023ba5-d66b-4692-a18e-a86b995dec24', '0d9e395c-2f30-4626-8af3-63c9c59216ac'),

  -- å¹¸æµä¸¸ãƒ»èˆ¹é•· → å¹¸æµä¸¸â†'èˆ¹é•·  (・→ãƒ» mojibake ; â†' = canonical, max power)
  ('9ffe0733-88be-4256-b103-a49ec3bceaf7', '2c8d40d8-c042-488d-9fbf-a052b52dbe20'),

  -- å¹¸æµä¸¸ ï¼Ÿèˆ¹é•· → å¹¸æµä¸¸â†'èˆ¹é•·  (stray OCR space + ？)
  ('0789a952-77c8-4bee-82d5-d0ee199cebf9', '2c8d40d8-c042-488d-9fbf-a052b52dbe20'),

  -- å¹¸æµä¸¸åèˆ¹é•· → å¹¸æµä¸¸â†'èˆ¹é•·  (å = stray character)
  ('6041bc7a-7559-4973-beca-c7610e715ee4', '2c8d40d8-c042-488d-9fbf-a052b52dbe20'),

  -- å¹¸æµä¸¸ä¸€èˆ¹é•· → å¹¸æµä¸¸â†'èˆ¹é•·  (一 = stray character)
  ('172ecd4a-078a-4943-9758-a1f99ddbbcd8', '2c8d40d8-c042-488d-9fbf-a052b52dbe20'),

  -- ãŠãƒ¼ã—ã (no data) → ãŠä¸€ã—ã‚ (おーしあ, max power)
  ('92d741d7-ee41-4094-8aa3-cc42507412b6', '14cd6873-b354-4512-98c9-6cb3a66af1c9'),

  -- ãŠãƒ¼ã—ã‚ → ãŠä¸€ã—ã‚  (ー→一 Japanese OCR)
  ('a35ec2d6-1fed-4217-aa9a-640a6a5e4002', '14cd6873-b354-4512-98c9-6cb3a66af1c9'),

  -- j asmin → jasmin  (stray OCR space)
  ('0e6e9e20-f4a1-4701-a086-63ae179f1036', 'd0bb1a34-b075-4405-8cf1-417108f01742'),

  -- ── Alliance bf19b890-dd4f-447c-a7b8-3ae35f5ec6d3 ────────────────────────

  -- BigÂ§teelCurtain → BigSteelCurtain  (S→Â§ mojibake)
  ('1a53d64d-3191-4277-a55a-8a07135a7184', 'b8ee1cea-10d2-481f-9851-7e3651ea5a8e'),

  -- BigSteelCurlain → BigSteelCurtain  (rn→rl OCR confusion)
  ('8620e3ee-9e54-4170-a8b6-c3c207484649', 'b8ee1cea-10d2-481f-9851-7e3651ea5a8e'),

  -- DÃ„RKSIDÃˆãƒ»ç¯‰ → DÃ„RKSIDEãƒ»ç¯‰  (È→Ãˆ at end of word)
  ('646232e8-64d1-40eb-ac90-0f9c34bb4b2d', 'f6ae658a-9634-44a3-8751-491d447a9ea8'),

  -- DÃ„RKSIPEãƒ»ç¯‰ → DÃ„RKSIDEãƒ»ç¯‰  (D→P OCR confusion)
  ('25f6c95b-b98c-4ac4-8aa9-32238c0a4365', 'f6ae658a-9634-44a3-8751-491d447a9ea8'),

  -- Mjolnir → MjÃ³lnir  (MjÃ³lnir has max power)
  ('c81288b8-6c81-4cfa-a2bf-c9a62fb42a7e', '84d61b7e-d456-4b30-8494-270551d675da'),

  -- MjÃ¶lnir → MjÃ³lnir  (ö→Ã¶ mojibake)
  ('52c18577-6530-4024-8177-3bf5df5e17b5', '84d61b7e-d456-4b30-8494-270551d675da'),

  -- Saâ€ ana → Satana  (typographic apostrophe â€™ → t mojibake)
  ('ddcd0e7c-2c86-4aee-b2db-613a604da382', '02500675-ffbd-4e41-9150-f2ba3ee694b6');

-- ─── 1. Update canonical player's stats (take the best) ───────────────────────

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
-- Cases covered:
--   A. Duplicate vs canonical (same event) → delete the duplicate
--   B. Duplicate vs duplicate of the same canonical (same event) → delete the one with the larger id
--      (typical case: Mjolnir + MjÃ¶lnir both participate in the same event,
--       one must be eliminated before both are reassigned to the same canonical)

DELETE FROM at_participations p_dup
WHERE p_dup.player_id IN (SELECT dup_id FROM _merge_map)
  AND EXISTS (
    SELECT 1
    FROM at_participations p_winner
    JOIN _merge_map m ON p_dup.player_id = m.dup_id
    WHERE p_winner.event_id = p_dup.event_id
      AND (
        -- case A: the canonical already has this participation
        p_winner.player_id = m.canon_id
        OR
        -- case B: another duplicate of the same canonical has a smaller id (the tiebreaker)
        (p_winner.player_id IN (
           SELECT d2.dup_id FROM _merge_map d2 WHERE d2.canon_id = m.canon_id
         )
         AND p_winner.id < p_dup.id)
      )
  );

-- Reassign the remaining participations
UPDATE at_participations
SET player_id = m.canon_id
FROM _merge_map m
WHERE player_id = m.dup_id;

-- ─── 3. at_alliance_memberships ───────────────────────────────────────────────
-- Same logic as participations: covers duplicate↔canonical and duplicate↔duplicate
-- The unique constraint is (alliance_id, player_id, joined_at).

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

-- Reassign the remaining rows
UPDATE at_alliance_memberships
SET player_id = m.canon_id
FROM _merge_map m
WHERE player_id = m.dup_id;

-- ─── 4. at_donations ──────────────────────────────────────────────────────────

-- 4a. Update the canonical to the max of all its duplicates' values
--     (for periods where the canonical already has a row)
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

-- 4b. Delete conflicting donations from the duplicates:
--     - case A: the canonical already has this donation (value updated in 4a)
--     - case B: another duplicate of the same canonical has a value ≥ and an id ≤
DELETE FROM at_donations d_dup
WHERE d_dup.player_id IN (SELECT dup_id FROM _merge_map)
  AND EXISTS (
    SELECT 1
    FROM _merge_map m
    WHERE m.dup_id = d_dup.player_id
      AND (
        -- case A
        EXISTS (
          SELECT 1 FROM at_donations d_canon
          WHERE d_canon.player_id          = m.canon_id
            AND d_canon.donation_period_id = d_dup.donation_period_id
        )
        OR
        -- case B
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

-- 4c. Reassign the remaining (non-conflicting) donations
UPDATE at_donations
SET player_id = m.canon_id
FROM _merge_map m
WHERE player_id = m.dup_id;

-- ─── 5. at_player_aliases ─────────────────────────────────────────────────────

-- Update aliases that pointed to a duplicate
UPDATE at_player_aliases
SET player_id = m.canon_id
FROM _merge_map m
WHERE player_id = m.dup_id;

-- ─── 6. Recording old names as aliases ────────────────────────────────────────
-- Lets future OCR screenshots producing the old name resolve directly.

INSERT INTO at_player_aliases (alliance_id, player_id, raw_name, created_by)
SELECT p.alliance_id, m.canon_id, p.name, 'migration_0014'
FROM _merge_map m
JOIN at_players p ON p.id = m.dup_id
ON CONFLICT (alliance_id, raw_name) DO NOTHING;

-- ─── 7. Deleting the duplicates ────────────────────────────────────────────────

DELETE FROM at_players
WHERE id IN (SELECT dup_id FROM _merge_map);

-- ─── 8. Deleting OCR artifacts: rank labels read as a nickname ────────────────
-- "R1" (524dc475) and "R2" (7f28b143) have no participations; deleted
-- only if they genuinely have no participation (safety check).

DELETE FROM at_players
WHERE id IN (
  '524dc475-9f7e-431b-b787-f48fa4f5d8e8',  -- name = 'R1', created on 2026-05-02 21:28
  '7f28b143-9c39-4058-b237-133da7f499af'   -- name = 'R2', created on 2026-05-02 21:28
)
AND NOT EXISTS (
  SELECT 1 FROM at_participations WHERE player_id = at_players.id
)
AND NOT EXISTS (
  SELECT 1 FROM at_donations WHERE player_id = at_players.id
);

COMMIT;

-- ─── NOTES: remaining cases to handle manually ────────────────────────────────
--
-- The entries below are garbled OCR names WITHOUT an existing duplicate
-- (the real player doesn't have a clean row yet). They require an
-- UPDATE at_players SET name = '<corrected name>' WHERE id = '<id>'
-- + INSERT INTO at_player_aliases for the old name.
--
-- Alliance 7a72b304:
--   0ccef60f  ï¼ˆLOLï¼‰Goatman    → rename to 'Goatman'
--   71affe71  (LOL)JÓ™ÏƒÎ·Î·Î·Ð´  → manual decoding required
--   cf90ccbc  Lol) BlizzardsKing → likely '(LOL)BlizzardKing'; verify
--   0733a796  BlizzardKing       → linked to the previous one?
--   583453d9  $imb4 6498 R4      → severe OCR artifact, identify the real player
--   dcf3ed03  Gumper 6738        → same
--   cc1b7fce  VVW 6483           → same; potentially VVV or VW?
--   ae97a748  DarthKnight        → to confirm: distinct from DarkKnight?
```

## After normalization (OCR service)

`normalize_name()` (`app/parsers/name_ocr.py`) is now applied at the source
by the OCR parsers: latin-1/UTF-8 mojibake, NFD→NFC, fullwidth punctuation →
ASCII, and zero-width characters are fixed before the name reaches
`at_players`. New screenshots should therefore no longer reproduce the
corruptions listed above (this runbook's vectors form the basis of
`tests/test_name_ocr.py`'s tests).

**Expected side effect on the existing deployment.** Players already stored
in mojibake form (e.g. `MjÃ¶lnir`, `ï¼ˆLOLï¼‰CHIANTI`) no longer match, by
construction, the now-clean name the OCR produces (`Mjölnir`,
`(LOL)CHIANTI`) — the `unique (alliance_id, name)` constraint doesn't
reconcile them automatically. The next screenshot of one of these players
therefore creates a "clean" `at_players` entry that duplicates the old
mojibake entry, which stays inert (never reproduced by OCR again).

Two ways to handle this as it comes up:

1. **Reactive**: when a duplicate appears (flagged by the bot or a periodic
   review), merge the old mojibake name into the new clean one with
   `/merge <old> <clean>` — the recorded alias then absorbs any future
   screenshots that would still reproduce the old spelling (unlikely once
   OCR is normalized, but covers screenshots already queued at deploy time).
2. **Proactive**: run `tools/normalize_player_names.py` once (dry-run by
   default) to directly rename, in the database, players whose stored name
   differs from its normalized form and who don't collide with any other
   player in the same alliance. The collisions it detects (normalized name
   already taken by another player, or several duplicates converging on the
   same normalized name) still need to be handled manually via `/merge` —
   these are the same pairs already cataloged in this runbook.
