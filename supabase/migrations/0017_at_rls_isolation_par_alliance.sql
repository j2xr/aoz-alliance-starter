-- 0017_at_rls_isolation_par_alliance.sql
-- Renforce les RLS : remplace les policies `using (true)` des migrations
-- 0003, 0005, 0010, 0011 par une isolation par alliance, basée sur
-- at_alliance_members (déjà utilisée par 0015_at_player_stats).
--
-- Le bot Discord continue d'utiliser SUPABASE_SERVICE_ROLE_KEY → bypass RLS.
-- Cette migration n'impacte que les lectures depuis le dashboard
-- (anon_key + session Auth utilisateur).
--
-- Tables référentielles inchangées :
--   - at_event_types : catalogue partagé entre toutes les alliances.

-- ─── at_alliances ─────────────────────────────────────────────────────────────
-- L'utilisateur ne voit que les alliances dont il est membre via at_alliance_members.

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
-- Pas d'alliance_id direct → on joint via at_events.

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
-- alliance_id est nullable (uploads non-attribués). On masque ces lignes au
-- dashboard : seuls les uploads rattachés à une alliance visible sont lisibles.

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
-- Pas d'alliance_id direct → on joint via at_donation_periods.

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
