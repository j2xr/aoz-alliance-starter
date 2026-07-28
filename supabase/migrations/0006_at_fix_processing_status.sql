-- 0006_at_fix_processing_status.sql
-- Adds 'unknown_event' to the allowed values for at_screenshot_uploads.processing_status.
-- The bot uses this status when OCR returns an unrecognized event type.

alter table at_screenshot_uploads
  drop constraint at_screenshot_uploads_processing_status_check;

alter table at_screenshot_uploads
  add constraint at_screenshot_uploads_processing_status_check
    check (processing_status in ('pending', 'processed', 'failed', 'duplicate', 'unknown_event'));
