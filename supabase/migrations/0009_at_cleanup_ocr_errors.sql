-- 0009_at_cleanup_ocr_errors.sql
--
-- NO-OP — one-off repair from the original deployment, removed from the
-- migration path. The file is kept (empty) so the original deployment's
-- Supabase migration history stays consistent: deleting it would force a
-- `supabase migration repair` over there.
--
-- Original content: heuristic power ↔ points swap on already-ingested
-- rows + manual deletion of suspect players. This fix only handled the
-- existing stock and let every new screenshot reintroduce the bug; it now
-- lives at ingestion time, in the OCR service
-- (apps/ocr-service/app/validators.py, maybe_swap_power_points).
--
-- Original SQL archived as a runbook: docs/maintenance/0009-ocr-cleanup.md

select 1;
