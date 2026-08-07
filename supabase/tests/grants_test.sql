-- grants_test.sql
-- Locks in the EXECUTE-privilege fix from migration 0024 (security audit
-- finding 1). at_apply_correction is SECURITY DEFINER, so it bypasses RLS on
-- every table it writes. 0023 granted EXECUTE to service_role but left the
-- default PUBLIC grant in place — meaning any client holding the anon key
-- (bundled, non-secret, in the frontend JS) could call it via PostgREST and
-- edit any alliance's rows, bypassing /correct's ManageGuild checks. 0024
-- revoked it from public/anon/authenticated. If that revoke ever regresses,
-- this test fails.

begin;
select plan(4);

select ok(
  not has_function_privilege(
    'anon',
    'at_apply_correction(text, uuid, text, bigint, uuid, uuid, text)',
    'EXECUTE'),
  'anon role cannot EXECUTE at_apply_correction'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'at_apply_correction(text, uuid, text, bigint, uuid, uuid, text)',
    'EXECUTE'),
  'authenticated role cannot EXECUTE at_apply_correction'
);

select ok(
  has_function_privilege(
    'service_role',
    'at_apply_correction(text, uuid, text, bigint, uuid, uuid, text)',
    'EXECUTE'),
  'service_role (the bot key) can EXECUTE at_apply_correction'
);

-- No lingering PUBLIC grant hiding behind the role checks above.
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral aclexplode(p.proacl) a
    where n.nspname = 'public'
      and p.proname = 'at_apply_correction'
      and a.grantee = 0            -- 0 = PUBLIC pseudo-role
      and a.privilege_type = 'EXECUTE'),
  0,
  'at_apply_correction has no EXECUTE grant to PUBLIC'
);

select * from finish();
rollback;
