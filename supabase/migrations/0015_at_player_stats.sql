-- 0015_at_player_stats.sql
-- Stats militaires par joueur, capturées depuis le chat in-game "(LOL) City stats".
-- Une ligne = stats d'un joueur pour un jour donné.
-- Contrainte unique (alliance_id, player_id, recorded_date) — latest-wins via UPSERT.

create table at_player_stats (
  id               uuid        primary key default gen_random_uuid(),
  alliance_id      uuid        not null references at_alliances(id)  on delete cascade,
  player_id        uuid        not null references at_players(id)    on delete cascade,
  attack_pct       numeric(8,2),              -- LRA ou MRA en %
  attack_kind      text        check (attack_kind in ('lra', 'mra')),
  hp_pct           numeric(8,2),              -- MHP en %
  defense_pct      numeric(8,2),              -- MHD / MD en %
  ocr_confidence   real,                      -- nb_stats_parsées / 3
  raw_text         text,                      -- lignes OCR brutes attribuées au joueur
  source_upload_id uuid        references at_screenshot_uploads(id) on delete set null,
  recorded_date    date        not null,      -- date UTC du message Discord
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (alliance_id, player_id, recorded_date)
);

create index at_player_stats_alliance_date_idx
  on at_player_stats(alliance_id, recorded_date desc);

create index at_player_stats_player_idx
  on at_player_stats(player_id, recorded_date desc);

alter table at_player_stats enable row level security;

-- Lecture : tout utilisateur authentifié appartenant à l'alliance (filtré par RLS de at_alliances)
create policy "at_player_stats: authenticated read"
  on at_player_stats for select
  to authenticated
  using (
    alliance_id in (
      select alliance_id from at_alliance_members where user_id = auth.uid()
    )
  );
