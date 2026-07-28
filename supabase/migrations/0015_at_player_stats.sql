-- 0015_at_player_stats.sql
-- Military stats per player, captured from the in-game "(LOL) City stats" chat.
-- One row = a player's stats for a given day.
-- Unique constraint (alliance_id, player_id, recorded_date) — latest-wins via UPSERT.

create table at_player_stats (
  id               uuid        primary key default gen_random_uuid(),
  alliance_id      uuid        not null references at_alliances(id)  on delete cascade,
  player_id        uuid        not null references at_players(id)    on delete cascade,
  attack_pct       numeric(8,2),              -- LRA or MRA in %
  attack_kind      text        check (attack_kind in ('lra', 'mra')),
  hp_pct           numeric(8,2),              -- MHP in %
  defense_pct      numeric(8,2),              -- MHD / MD in %
  ocr_confidence   real,                      -- nb_stats_parsed / 3
  raw_text         text,                      -- raw OCR lines attributed to the player
  source_upload_id uuid        references at_screenshot_uploads(id) on delete set null,
  recorded_date    date        not null,      -- UTC date of the Discord message
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (alliance_id, player_id, recorded_date)
);

create index at_player_stats_alliance_date_idx
  on at_player_stats(alliance_id, recorded_date desc);

create index at_player_stats_player_idx
  on at_player_stats(player_id, recorded_date desc);

alter table at_player_stats enable row level security;

-- Read: any authenticated user belonging to the alliance (filtered by at_alliances' RLS)
create policy "at_player_stats: authenticated read"
  on at_player_stats for select
  to authenticated
  using (
    alliance_id in (
      select alliance_id from at_alliance_members where user_id = auth.uid()
    )
  );
