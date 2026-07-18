-- 0022_at_corrections.sql
-- Audit log for manual score corrections made via the /correct Discord
-- command (B5): every time an admin overwrites a misread OCR value, the old
-- and new values get recorded here so the change is traceable.
--
-- The bot continues to use SUPABASE_SERVICE_ROLE_KEY -> bypasses RLS on
-- writes (same convention as every other at_* table, see 0003_at_rls.sql).
-- Only a read policy is defined, matching 0017's isolation-per-alliance
-- pattern; at_corrections has a direct alliance_id column so no join needed.

create table at_corrections (
  id            uuid primary key default gen_random_uuid(),
  alliance_id   uuid not null references at_alliances(id) on delete cascade,
  player_id     uuid not null references at_players(id) on delete cascade,
  target_table  text not null check (target_table in ('at_participations', 'at_donations')),
  target_id     uuid not null,
  field         text not null check (field in ('points', 'power', 'honor')),
  old_value     bigint,
  new_value     bigint not null,
  corrected_by  text not null,
  created_at    timestamptz not null default now()
);

create index idx_at_corrections_alliance_created on at_corrections(alliance_id, created_at desc);

alter table at_corrections enable row level security;

create policy "at_corrections: authenticated read"
  on at_corrections for select
  to authenticated
  using (
    alliance_id in (
      select alliance_id from at_alliance_members where user_id = auth.uid()
    )
  );
