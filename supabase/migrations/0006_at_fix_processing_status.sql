-- 0006_at_fix_processing_status.sql
-- Ajoute 'unknown_event' aux valeurs autorisées pour at_screenshot_uploads.processing_status.
-- Le bot utilise ce statut quand l'OCR renvoie un type d'événement non reconnu.

alter table at_screenshot_uploads
  drop constraint at_screenshot_uploads_processing_status_check;

alter table at_screenshot_uploads
  add constraint at_screenshot_uploads_processing_status_check
    check (processing_status in ('pending', 'processed', 'failed', 'duplicate', 'unknown_event'));
