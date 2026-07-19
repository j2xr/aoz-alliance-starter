-- 0023_at_corrections_hardening.sql
-- Hardens the at_corrections audit trail (0022) against two integrity gaps
-- found in a post-merge review of B5 (/correct):
--
-- 1. The bot originally did the score UPDATE and the at_corrections INSERT
--    as two separate PostgREST calls. If the insert failed after the update
--    succeeded, the correction was applied but never audited, and a retry
--    would read the already-corrected value as "old_value" — permanently
--    losing the original OCR value from the trail. Fix: at_apply_correction
--    below does both in one transaction (read old value -> update -> insert
--    audit row), so either both happen or neither does.
--
-- 2. at_corrections.player_id was `not null references at_players(id) on
--    delete cascade` — deleting a player (as /merge does for OCR duplicates)
--    silently erased that player's correction history along with them,
--    defeating the point of an audit log. Fix: player_id becomes nullable
--    with `on delete set null`; the bot re-points a merged alias's audit
--    rows to the canonical player before the delete (see merge.ts), so this
--    only fires for a genuine player deletion outside of /merge.

alter table at_corrections
  drop constraint at_corrections_player_id_fkey,
  alter column player_id drop not null,
  add constraint at_corrections_player_id_fkey
    foreign key (player_id) references at_players(id) on delete set null;

-- SECURITY DEFINER so the function's row lookups/writes run with the
-- function owner's privileges rather than the caller's — the bot always
-- calls this via SUPABASE_SERVICE_ROLE_KEY (already bypasses RLS on every
-- at_* table, see 0003_at_rls.sql) so this changes nothing about who can
-- call it in practice, but keeps the function's behavior independent of the
-- calling role. `search_path` pinned per Postgres/Supabase SECURITY DEFINER
-- guidance, to avoid a caller-controlled search_path resolving an object
-- name to something unexpected.
--
-- target_table/field are validated by an explicit branch per legal
-- combination (not interpolated into SQL) precisely so this function never
-- needs dynamic SQL for the column name — avoids the injection surface that
-- would come with EXECUTE format('update %I set %I = ...', ...).
create or replace function at_apply_correction(
  p_target_table text,
  p_target_id uuid,
  p_field text,
  p_new_value bigint,
  p_alliance_id uuid,
  p_player_id uuid,
  p_corrected_by text
) returns table (old_value bigint, new_value bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_value bigint;
begin
  if p_target_table = 'at_participations' and p_field = 'points' then
    select points into v_old_value from at_participations where id = p_target_id;
    if not found then
      raise exception 'at_apply_correction: target row not found (% / %)', p_target_table, p_target_id
        using errcode = 'P0002';
    end if;
    update at_participations set points = p_new_value where id = p_target_id;

  elsif p_target_table = 'at_participations' and p_field = 'power' then
    select power into v_old_value from at_participations where id = p_target_id;
    if not found then
      raise exception 'at_apply_correction: target row not found (% / %)', p_target_table, p_target_id
        using errcode = 'P0002';
    end if;
    update at_participations set power = p_new_value where id = p_target_id;

  elsif p_target_table = 'at_donations' and p_field = 'honor' then
    select alliance_honor into v_old_value from at_donations where id = p_target_id;
    if not found then
      raise exception 'at_apply_correction: target row not found (% / %)', p_target_table, p_target_id
        using errcode = 'P0002';
    end if;
    update at_donations set alliance_honor = p_new_value where id = p_target_id;

  else
    raise exception 'at_apply_correction: invalid target_table/field combination (% / %)', p_target_table, p_field
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  insert into at_corrections (
    alliance_id, player_id, target_table, target_id, field, old_value, new_value, corrected_by
  ) values (
    p_alliance_id, p_player_id, p_target_table, p_target_id, p_field, v_old_value, p_new_value, p_corrected_by
  );

  return query select v_old_value, p_new_value;
end;
$$;

-- PostgREST/supabase-js call this via SUPABASE_SERVICE_ROLE_KEY, which maps
-- to the `service_role` Postgres role — grant execute explicitly rather
-- than relying on the SECURITY DEFINER owner's implicit privileges, so a
-- future `revoke ... from public` on functions doesn't silently break this.
grant execute on function at_apply_correction(text, uuid, text, bigint, uuid, uuid, text) to service_role;
