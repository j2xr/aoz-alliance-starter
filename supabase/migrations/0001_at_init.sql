-- 0001_at_init.sql
-- Schéma initial : tables, index, activation RLS
-- Les policies RLS sont dans 0003_at_rls.sql

-- ─── Tables ───────────────────────────────────────────────────────────────────

create table at_alliances (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique,
  discord_channel_id  text unique,
  created_at          timestamptz not null default now()
);

create table at_event_types (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  display_name    text not null,
  layout_version  text not null default 'v1'
);

create table at_events (
  id                uuid primary key default gen_random_uuid(),
  alliance_id       uuid not null references at_alliances(id) on delete cascade,
  event_type_id     uuid not null references at_event_types(id) on delete restrict,
  event_datetime    timestamptz not null,
  alliance_rank     int,
  total_battlers    int,
  total_points      bigint,
  source_message_id text,
  created_at        timestamptz not null default now(),
  unique (alliance_id, event_type_id, event_datetime)
);

create table at_players (
  id            uuid primary key default gen_random_uuid(),
  alliance_id   uuid not null references at_alliances(id) on delete cascade,
  name          text not null,
  last_power    bigint,
  last_rank     text,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (alliance_id, name)
);

create table at_participations (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references at_events(id) on delete cascade,
  player_id       uuid not null references at_players(id) on delete cascade,
  player_rank     text,
  power           bigint,
  points          int not null default 0,
  ocr_confidence  real,
  raw_ocr         jsonb,
  created_at      timestamptz not null default now(),
  unique (event_id, player_id)
);

create table at_screenshot_uploads (
  id                  uuid primary key default gen_random_uuid(),
  discord_message_id  text not null,
  discord_user_id     text not null,
  alliance_id         uuid references at_alliances(id) on delete restrict,
  file_path           text not null,
  file_hash           text not null,
  processed_at        timestamptz,
  extracted_event_id  uuid references at_events(id) on delete set null,
  processing_status   text not null default 'pending',
  error_message       text,
  created_at          timestamptz not null default now(),
  unique (file_hash, alliance_id),
  constraint at_screenshot_uploads_processing_status_check
    check (processing_status in ('pending', 'processed', 'failed', 'duplicate'))
);

-- ─── Index ────────────────────────────────────────────────────────────────────

create index idx_at_participations_event      on at_participations(event_id);
create index idx_at_participations_player     on at_participations(player_id);
create index idx_at_events_alliance_datetime  on at_events(alliance_id, event_datetime desc);
create index idx_at_players_alliance_name     on at_players(alliance_id, name);
create index idx_at_screenshot_uploads_status on at_screenshot_uploads(processing_status)
  where processing_status = 'pending';

-- ─── RLS — activation (policies dans 0003_at_rls.sql) ────────────────────────

alter table at_alliances          enable row level security;
alter table at_event_types        enable row level security;
alter table at_events             enable row level security;
alter table at_players            enable row level security;
alter table at_participations     enable row level security;
alter table at_screenshot_uploads enable row level security;
