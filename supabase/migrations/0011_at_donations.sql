-- 0011_at_donations.sql
-- Tables pour le suivi des dons de ressources (Alliance Honor / Contribution Ranking).
-- Domaine séparé d'at_events ; partage at_players / at_alliance_memberships
-- pour la canonicalisation des joueurs.

create table at_donation_periods (
  id            uuid primary key default gen_random_uuid(),
  alliance_id   uuid not null references at_alliances(id) on delete cascade,
  period_type   text not null check (period_type in ('weekly')),
  period_start  date not null, -- lundi ISO en Europe/Paris
  period_end    date generated always as (period_start + interval '6 days') stored,
  created_at    timestamptz not null default now(),
  unique (alliance_id, period_type, period_start)
);

create index at_donation_periods_alliance_idx
  on at_donation_periods(alliance_id, period_type, period_start desc);

create table at_donations (
  id                  uuid primary key default gen_random_uuid(),
  donation_period_id  uuid not null references at_donation_periods(id) on delete cascade,
  player_id           uuid not null references at_players(id) on delete cascade,
  alliance_honor      bigint not null check (alliance_honor >= 0),
  player_rank         text,                   -- R1..R5 au moment de la capture
  alliance_tag        text,                   -- "(SOD)" capturé pour diagnostic
  ocr_confidence      real,
  raw_ocr             jsonb,
  source_message_id   text,
  source_upload_id    uuid references at_screenshot_uploads(id) on delete set null,
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  unique (donation_period_id, player_id)
);

create index at_donations_period_idx        on at_donations(donation_period_id);
create index at_donations_player_idx        on at_donations(player_id);
create index at_donations_period_amount_idx on at_donations(donation_period_id, alliance_honor desc);

alter table at_donation_periods enable row level security;
alter table at_donations        enable row level security;

create policy "at_donation_periods: authenticated read"
  on at_donation_periods for select
  to authenticated
  using (true);

create policy "at_donations: authenticated read"
  on at_donations for select
  to authenticated
  using (true);
