-- rls_isolation_test.sql
-- Locks in the per-alliance row-level-security isolation introduced by
-- migration 0017 (and 0015 for at_player_stats). A dashboard user authenticates
-- with the anon key + a Supabase Auth session; RLS must ensure they only ever
-- read rows for alliances they belong to (via at_alliance_members). A dropped or
-- weakened policy is a silent cross-alliance data leak, so this is the test that
-- must fail loudly if any of those policies regress.
--
-- Method: seed two alliances' worth of data as the superuser (which bypasses
-- RLS), then impersonate alliance A's user with `set local role authenticated`
-- plus a JWT-claims GUC so auth.uid() resolves — exactly how PostgREST runs a
-- request. Counts are measured under that role into a temp table, then asserted
-- back as the superuser (keeps pgTAP's own bookkeeping on a single role).
--
-- Note on grants: `supabase db start` does not reproduce the Data-API SELECT
-- grants that Supabase Cloud gives the `authenticated` role, so we grant them
-- here inside the rolled-back transaction. RLS — not the grant — is what this
-- test exercises.

begin;
select plan(10);

-- ── seed (as superuser: bypasses RLS) ────────────────────────────────────────
grant select on
  at_alliances, at_events, at_players, at_participations,
  at_donation_periods, at_donations, at_player_stats, at_alliance_members
  to authenticated;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'),   -- user A
  ('00000000-0000-0000-0000-0000000000b1');   -- user B

insert into at_alliances (id, name) values
  ('00000000-0000-0000-0000-00000000a11a', 'Alliance A'),
  ('00000000-0000-0000-0000-00000000b11b', 'Alliance B');

insert into at_alliance_members (alliance_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000a11a', '00000000-0000-0000-0000-0000000000a1', 'viewer'),
  ('00000000-0000-0000-0000-00000000b11b', '00000000-0000-0000-0000-0000000000b1', 'viewer');

insert into at_players (id, alliance_id, name) values
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000a11a', 'Player A'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000b11b', 'Player B');

insert into at_events (id, alliance_id, event_type_id, event_datetime) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000a11a',
   (select id from at_event_types where code = 'polar_invasion'), now()),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000b11b',
   (select id from at_event_types where code = 'polar_invasion'), now());

insert into at_participations (event_id, player_id, points) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2', 100),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b2', 200);

insert into at_donation_periods (id, alliance_id, period_type, period_start) values
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-00000000a11a', 'weekly', '2026-01-05'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000b11b', 'weekly', '2026-01-05');

insert into at_donations (donation_period_id, player_id, alliance_honor) values
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a2', 500),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000b2', 600);

insert into at_player_stats (alliance_id, player_id, recorded_date) values
  ('00000000-0000-0000-0000-00000000a11a', '00000000-0000-0000-0000-0000000000a2', '2026-01-05'),
  ('00000000-0000-0000-0000-00000000b11b', '00000000-0000-0000-0000-0000000000b2', '2026-01-05');

-- Sanity: both alliances' rows really exist (so a "sees 1" result below is
-- RLS filtering, not just an empty table).
select is(
  (select count(*)::int from at_events),
  2,
  'seed created events for both alliances (visible to superuser)'
);

-- ── measure visibility as alliance A's authenticated user ────────────────────
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

create temp table _rls_seen on commit drop as
      select 'alliances'::text        as k, count(*)::int as n from at_alliances
  union all select 'events',           count(*)::int from at_events
  union all select 'players',          count(*)::int from at_players
  union all select 'participations',   count(*)::int from at_participations
  union all select 'donation_periods', count(*)::int from at_donation_periods
  union all select 'donations',        count(*)::int from at_donations
  union all select 'player_stats',     count(*)::int from at_player_stats
  union all select 'b_events',         count(*)::int from at_events
                                       where alliance_id = '00000000-0000-0000-0000-00000000b11b';

create temp table _rls_event on commit drop as select alliance_id from at_events;

reset role;

-- ── assert (as superuser) ────────────────────────────────────────────────────
select is((select n from _rls_seen where k = 'alliances'),        1, 'alliance A user sees only their own alliance');
select is((select n from _rls_seen where k = 'events'),           1, 'events isolated to alliance A');
select is((select n from _rls_seen where k = 'players'),          1, 'players isolated to alliance A');
select is((select n from _rls_seen where k = 'participations'),   1, 'participations isolated (joined via at_events)');
select is((select n from _rls_seen where k = 'donation_periods'), 1, 'donation periods isolated to alliance A');
select is((select n from _rls_seen where k = 'donations'),        1, 'donations isolated (joined via at_donation_periods)');
select is((select n from _rls_seen where k = 'player_stats'),     1, 'player stats isolated to alliance A');
select is((select n from _rls_seen where k = 'b_events'),         0, 'alliance A user cannot see alliance B events');
select is(
  (select count(*)::int from _rls_event
    where alliance_id <> '00000000-0000-0000-0000-00000000a11a'::uuid),
  0,
  'no event alliance A can read belongs to another alliance'
);

select * from finish();
rollback;
