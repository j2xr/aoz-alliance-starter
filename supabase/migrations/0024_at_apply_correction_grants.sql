-- 0024_at_apply_correction_grants.sql
-- Security fix: at_apply_correction (0023) is SECURITY DEFINER, so it bypasses
-- RLS on every table it touches. 0023 granted EXECUTE to service_role but
-- never revoked the default grants Postgres/Supabase give to PUBLIC, anon and
-- authenticated -- meaning any client holding the (non-secret, bundled into
-- the frontend JS) anon key could call it directly via PostgREST and edit any
-- alliance's participation/donation rows, bypassing /correct's ManageGuild
-- and alliance-ownership checks entirely. Only the bot's service-role key
-- should ever be able to call this function.

revoke execute on function at_apply_correction(text, uuid, text, bigint, uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function at_apply_correction(text, uuid, text, bigint, uuid, uuid, text)
  to service_role;
