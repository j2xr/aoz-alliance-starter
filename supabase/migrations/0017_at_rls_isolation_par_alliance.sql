-- 0017_at_rls_isolation_par_alliance.sql
-- Strengthens RLS: replaces the `using (true)` policies from migrations
-- 0003, 0005, 0010, 0011 with per-alliance isolation, based on
-- at_alliance_members (already used by 0015_at_player_stats).
--
-- The Discord bot keeps using SUPABASE_SERVICE_ROLE_KEY → bypasses RLS.
-- This migration only affects reads from the dashboard
-- (anon_key + user Auth session).
--
-- Reference tables left unchanged:
--   - at_event_types: catalog shared across all alliances.

-- ─── at_alliances ─────────────────────────────────────────────────────────────
-- The user only sees alliances they're a member of, via at_alliance_members.

drop policy if exists "at_alliances: authenticated read" on at_alliances;

create policy "at_alliances: authenticated read"
  on at_alliances for select
  to authenticated
  using (
    id in (
      select alliance_id from at_alliance_members where user_id = auth.uid()
    )
  );

-- ─── at_events ────────────────────────────────────────────────────────────────

drop policy if exists "at_events: authenticated read" on at_events;

create policy "at_events: authenticated read"
  on at_events for select
  to authenticated
  using (
    alliance_id in (
      select alliance_id from at_alliance_members where user_id = auth.uid()
    )
  );

-- ─── at_players ───────────────────────────────────────────────────────────────

drop policy if exists "at_players: authenticated read" on at_players;

create policy "at_players: authenticated read"
  on at_players for select
  to authenticated
  using (
    alliance_id in (
      select alliance_id from at_alliance_members where user_id = auth.uid()
    )
  );

-- ─── at_participations ────────────────────────────────────────────────────────
-- No direct alliance_id → joined via at_events.

drop policy if exists "at_participations: authenticated read" on at_participations;

create policy "at_participations: authenticated read"
  on at_participations for select
  to authenticated
  using (
    event_id in (
      select e.id
      from at_events e
      where e.alliance_id in (
        select alliance_id from at_alliance_members where user_id = auth.uid()
      )
    )
  );

-- ─── at_screenshot_uploads ────────────────────────────────────────────────────
-- alliance_id is nullable (unattributed uploads). These rows are hidden from
-- the dashboard: only uploads attached to a visible alliance are readable.

drop policy if exists "at_screenshot_uploads: authenticated read" on at_screenshot_uploads;

create policy "at_screenshot_uploads: authenticated read"
  on at_screenshot_uploads for select
  to authenticated
  using (
    alliance_id in (
      select alliance_id from at_alliance_members where user_id = auth.uid()
    )
  );

-- ─── at_alliance_memberships ──────────────────────────────────────────────────

drop policy if exists "at_alliance_memberships: authenticated read" on at_alliance_memberships;

create policy "at_alliance_memberships: authenticated read"
  on at_alliance_memberships for select
  to authenticated
  using (
    alliance_id in (
      select alliance_id from at_alliance_members where user_id = auth.uid()
    )
  );

-- ─── at_player_aliases ────────────────────────────────────────────────────────

drop policy if exists at_player_aliases_select on at_player_aliases;

create policy at_player_aliases_select
  on at_player_aliases for select
  to authenticated
  using (
    alliance_id in (
      select alliance_id from at_alliance_members where user_id = auth.uid()
    )
  );

-- ─── at_donation_periods ──────────────────────────────────────────────────────

drop policy if exists "at_donation_periods: authenticated read" on at_donation_periods;

create policy "at_donation_periods: authenticated read"
  on at_donation_periods for select
  to authenticated
  using (
    alliance_id in (
      select alliance_id from at_alliance_members where user_id = auth.uid()
    )
  );

-- ─── at_donations ─────────────────────────────────────────────────────────────
-- No direct alliance_id → joined via at_donation_periods.

drop policy if exists "at_donations: authenticated read" on at_donations;

create policy "at_donations: authenticated read"
  on at_donations for select
  to authenticated
  using (
    donation_period_id in (
      select dp.id
      from at_donation_periods dp
      where dp.alliance_id in (
        select alliance_id from at_alliance_members where user_id = auth.uid()
      )
    )
  );
