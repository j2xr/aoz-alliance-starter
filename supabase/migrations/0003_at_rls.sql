-- 0003_at_rls.sql
-- Row-Level Security : policies
-- Le bot Discord utilise service_role (bypass RLS automatique).
-- Ces policies protègent l'accès depuis le dashboard (anon_key + session Auth).

-- ─── at_event_types ───────────────────────────────────────────────────────────

create policy "at_event_types: authenticated read"
  on at_event_types for select
  to authenticated
  using (true);

-- ─── at_alliances ─────────────────────────────────────────────────────────────

create policy "at_alliances: authenticated read"
  on at_alliances for select
  to authenticated
  using (true);

-- ─── at_events ────────────────────────────────────────────────────────────────

create policy "at_events: authenticated read"
  on at_events for select
  to authenticated
  using (true);

-- ─── at_players ───────────────────────────────────────────────────────────────

create policy "at_players: authenticated read"
  on at_players for select
  to authenticated
  using (true);

-- ─── at_participations ────────────────────────────────────────────────────────

create policy "at_participations: authenticated read"
  on at_participations for select
  to authenticated
  using (true);

-- ─── at_screenshot_uploads ────────────────────────────────────────────────────

create policy "at_screenshot_uploads: authenticated read"
  on at_screenshot_uploads for select
  to authenticated
  using (true);
