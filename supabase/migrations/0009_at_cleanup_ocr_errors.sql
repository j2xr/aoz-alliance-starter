-- 0009_at_cleanup_ocr_errors.sql
--
-- NO-OP — réparation ponctuelle du déploiement d'origine, retirée du chemin
-- de migration. Le fichier est conservé (vide) pour que l'historique de
-- versions Supabase du déploiement d'origine reste cohérent : le supprimer
-- forcerait un `supabase migration repair` là-bas.
--
-- Contenu d'origine : swap heuristique power ↔ points sur les lignes déjà
-- ingérées + suppressions manuelles de joueurs suspects. Ce correctif ne
-- traitait que le stock existant et laissait chaque nouvelle capture
-- réintroduire le bug ; il vit désormais à l'ingestion, dans le service OCR
-- (apps/ocr-service/app/validators.py, maybe_swap_power_points).
--
-- SQL d'origine archivé comme runbook : docs/maintenance/0009-ocr-cleanup.md

select 1;
