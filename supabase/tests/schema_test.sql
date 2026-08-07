-- schema_test.sql
-- Structural invariants the dashboard and the RLS model depend on. These are
-- cheap, deterministic assertions that catch a migration silently dropping a
-- protection or a column the frontend reads.

begin;
select plan(8);

-- 1. Every at_* base table has RLS enabled. A new table added without
--    `enable row level security` would default to open, leaking across
--    alliances the moment a policy elsewhere is assumed to gate it.
select is(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname like 'at\_%'
      and not c.relrowsecurity),
  0,
  'all at_* tables have row level security enabled'
);

-- 2. Every at_v_* view runs with security_invoker (migration 0018 onward).
--    Without it a view is evaluated as its owner and bypasses the caller's RLS
--    — the classic "view leaks past RLS" hole.
select is(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and c.relname like 'at\_v\_%'
      and (c.reloptions is null
           or not ('security_invoker=true' = any(c.reloptions)))),
  0,
  'all at_v_* views are declared security_invoker=true'
);

-- 3-4. needs_review flag columns (migration 0021), read by the Review page.
select has_column('at_participations', 'needs_review', 'at_participations.needs_review exists (OCR quality flag)');
select has_column('at_donations',      'needs_review', 'at_donations.needs_review exists (OCR quality flag)');

-- 5-6. Dashboard-facing views exist.
select has_view('at_v_needs_review',       'at_v_needs_review view exists (Review page)');
select has_view('at_v_event_import_delta', 'at_v_event_import_delta view exists (import-completeness badge)');

-- 7-8. Representative columns the frontend selects from those views. A renamed
--      or dropped column here breaks the dashboard without any unit test noticing.
select has_column('at_v_event_import_delta', 'battlers_coverage_pct',
  'at_v_event_import_delta exposes battlers_coverage_pct');
select has_column('at_v_needs_review', 'ocr_confidence',
  'at_v_needs_review exposes ocr_confidence');

select * from finish();
rollback;
