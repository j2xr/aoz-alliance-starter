-- 0013_at_fix_donation_names.sql
-- Correctif des noms de joueurs mal enregistrés par le parser donation (OCR).
--
-- Deux formes de noms incorrects corrigées :
--   (a) préfixe de classement + tag : "6 (LOL) CATFIGHT"  → name="CATFIGHT",  tag="LOL"
--   (b) tag non strippé seul        : "(LOL) RageX_"       → name="RageX_",    tag="LOL"
--
-- NOTE : une troisième règle (préfixe numérique seul, ex. "9 Медвежонок")
-- a été retirée : un nom légitime commençant par 1-2 chiffres + espace
-- (ex. "12 Monkeys") aurait été tronqué puis fusionné/supprimé. Ces cas
-- résiduels se traitent via /player-alias ou /merge, avec validation humaine.
--
-- Pour chaque nom défectueux :
--   • Si aucun joueur canonique n'existe sous le bon nom → renommage en place.
--   • Si un joueur canonique existe déjà             → fusion : les références
--     (participations, donations, memberships) sont réaffectées au canonique,
--     l'ancien nom est enregistré comme alias, le doublon est supprimé.
--
-- Les patterns regex reproduisent exactement la logique de
-- contribution_ranking_v1.py après le correctif OCR.

-- ─── Étape 1 : calcul des corrections ────────────────────────────────────────

create temp table _at_name_fixes as
select
  p.id            as player_id,
  p.alliance_id,
  p.name          as old_name,
  case
    -- (a)+(b) : le nom contient un tag d'alliance "(TAG)" (avec éventuels
    -- caractères parasites avant la parenthèse, ou espace à l'intérieur)
    when p.name ~ '[^A-Za-z(]*\(\s*[A-Za-z0-9]{1,5}\s*\)\s+\S'
    then trim(
           (regexp_match(p.name, '\(\s*[A-Za-z0-9]{1,5}\s*\)\s+(.+)$'))[1]
         )
  end             as new_name,
  (regexp_match(p.name, '\(\s*([A-Za-z0-9]{1,5})\s*\)'))[1] as extracted_tag
from at_players p
where
  p.name ~ '[^A-Za-z(]*\(\s*[A-Za-z0-9]{1,5}\s*\)\s+\S';

-- Supprimer les lignes où l'extraction aurait produit un résultat vide
delete from _at_name_fixes
where new_name is null or trim(new_name) = '';

-- ─── Étape 2 : fusion des doublons (conflit avec joueur canonique existant) ──

-- 2a. Participations : réaffecter au canonique, ignorer si déjà présent
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

-- 2b. Donations : réaffecter au canonique, latest-wins sur conflit de période
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

-- 2c. Memberships : réaffecter, ignorer les conflits de date d'entrée
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

-- 2d. Enregistrer l'ancien nom défectueux comme alias du canonique
--     (filet de sécurité si de vieilles captures sont re-traitées)
insert into at_player_aliases (alliance_id, raw_name, player_id, created_by)
select f.alliance_id, f.old_name, p2.id, 'migration_0013'
from _at_name_fixes f
join at_players p2
  on  p2.alliance_id = f.alliance_id
  and p2.name        = f.new_name
  and p2.id         <> f.player_id
on conflict (alliance_id, raw_name) do nothing;

-- 2e. Supprimer le joueur doublon (le CASCADE gère les éventuels enfants restants)
delete from at_players p
using _at_name_fixes f
join at_players p2
  on  p2.alliance_id = f.alliance_id
  and p2.name        = f.new_name
  and p2.id         <> f.player_id
where p.id = f.player_id;

-- ─── Étape 3 : renommage simple (pas de joueur canonique existant) ────────────

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

-- ─── Étape 4 : rétro-remplissage de alliance_tag dans at_donations ────────────
-- Seuls les renommages simples restent ici (les cas de fusion ont été traités
-- en 2b). Le player_id est inchangé pour les renommages simples.

update at_donations d
set    alliance_tag = f.extracted_tag
from   _at_name_fixes f
where  d.player_id     = f.player_id
  and  f.extracted_tag is not null
  and  (d.alliance_tag is null or d.alliance_tag <> f.extracted_tag);

drop table _at_name_fixes;
