-- 0021_at_needs_review.sql
-- Adds a `needs_review` flag on at_participations and at_donations so rows
-- the OCR pipeline is unsure about surface for manual review instead of
-- silently blending into aggregates.
--
-- `ocr_confidence` already exists on both tables (0001_at_init.sql,
-- 0011_at_donations.sql) — nothing to add there. `needs_review` itself is
-- computed bot-side from `ocr_confidence` (see discord-bot/src/lib/upsert.ts):
-- true when 0 <= ocr_confidence < 0.5, false otherwise — the sentinel -1
-- (LLM-corrected and accepted) is deliberately NOT flagged.
--
-- No view/RLS change: existing policies already cover added columns, and
-- surfacing this in the frontend is out of scope for this migration
-- (backlog item — badge on the tracking tables).

alter table at_participations
  add column needs_review boolean not null default false;

alter table at_donations
  add column needs_review boolean not null default false;

comment on column at_participations.needs_review is
  'True when ocr_confidence is in [0, 0.5) — low-confidence OCR read (possibly a rejected LLM correction) that should be manually checked. Never true for the -1 sentinel (accepted LLM correction).';

comment on column at_donations.needs_review is
  'True when ocr_confidence is in [0, 0.5) — low-confidence OCR read (possibly a rejected LLM correction) that should be manually checked. Never true for the -1 sentinel (accepted LLM correction).';
