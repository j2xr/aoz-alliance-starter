-- 0014_at_fix_player_duplicates.sql
--
-- NO-OP — réparation ponctuelle du déploiement d'origine, retirée du chemin
-- de migration. Le fichier est conservé (vide) pour que l'historique de
-- versions Supabase du déploiement d'origine reste cohérent : le supprimer
-- forcerait un `supabase migration repair` là-bas.
--
-- Contenu d'origine : fusion d'une trentaine de joueurs dupliqués (mojibake)
-- référencés par UUID en dur — sans objet dans un clone neuf, où ces UUID
-- n'existent pas. Les fusions courantes passent par les commandes /merge et
-- /player-alias du bot (table at_player_aliases).
--
-- SQL d'origine archivé comme runbook :
-- docs/maintenance/0014-player-duplicates-merge.md

select 1;
