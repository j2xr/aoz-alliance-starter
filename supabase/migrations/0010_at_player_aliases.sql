-- 0010_at_player_aliases.sql
-- Table de correspondance nom OCR brut → joueur canonique
-- Structure : id, alliance_id, raw_name, player_id, created_by, created_at

create table at_player_aliases (
  id          uuid primary key default gen_random_uuid(),
  alliance_id uuid not null references at_alliances(id) on delete cascade,
  raw_name    text not null,
  player_id   uuid not null references at_players(id) on delete cascade,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  unique (alliance_id, raw_name)
);

create index at_player_aliases_alliance_raw_idx on at_player_aliases(alliance_id, raw_name);

alter table at_player_aliases enable row level security;

create policy at_player_aliases_select on at_player_aliases
  for select using (true);
