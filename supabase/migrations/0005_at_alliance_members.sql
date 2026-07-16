-- 0005_at_alliance_members.sql
-- Ajoute at_alliance_memberships (périodes de présence joueur)
-- et at_alliance_members (jonction user ↔ alliance pour le dashboard / RLS).

-- ─── at_alliance_memberships ──────────────────────────────────────────────────
-- Périodes d'appartenance d'un joueur à une alliance.
-- Gérées automatiquement par le bot au moment des insertions de participation.

create table at_alliance_memberships (
  id          uuid primary key default gen_random_uuid(),
  alliance_id uuid not null references at_alliances(id) on delete cascade,
  player_id   uuid not null references at_players(id)   on delete cascade,
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,  -- null si toujours membre
  created_at  timestamptz not null default now(),
  unique (alliance_id, player_id, joined_at)
);

create index at_memberships_active_idx
  on at_alliance_memberships(alliance_id, player_id)
  where left_at is null;

alter table at_alliance_memberships enable row level security;

create policy "at_alliance_memberships: authenticated read"
  on at_alliance_memberships for select
  to authenticated
  using (true);

-- ─── at_alliance_members ──────────────────────────────────────────────────────
-- Jonction user Auth ↔ alliance : détermine quelles alliances un utilisateur
-- du dashboard est autorisé à consulter.

create table at_alliance_members (
  alliance_id uuid not null references at_alliances(id) on delete cascade,
  user_id     uuid not null references auth.users(id)   on delete cascade,
  role        text not null default 'viewer',  -- viewer | leader | admin
  created_at  timestamptz not null default now(),
  primary key (alliance_id, user_id),
  constraint at_alliance_members_role_check
    check (role in ('viewer', 'leader', 'admin'))
);

alter table at_alliance_members enable row level security;

-- Un utilisateur peut lire ses propres lignes
create policy "at_alliance_members: read own rows"
  on at_alliance_members for select
  to authenticated
  using (user_id = auth.uid());

-- ─── Vue : joueurs probablement partis ────────────────────────────────────────
-- Joueurs absents des 3 derniers événements de leur alliance et encore
-- enregistrés comme membres actifs dans at_alliance_memberships.

create view at_v_probable_leavers as
select
  p.id          as player_id,
  p.alliance_id,
  p.name,
  p.last_seen_at,
  count(distinct e.id) filter (
    where e.event_datetime > p.last_seen_at
  )             as events_missed_since_last_seen
from at_players p
join at_events e on e.alliance_id = p.alliance_id
left join at_alliance_memberships m
  on  m.player_id = p.id
 and  m.left_at is null
group by p.id, p.alliance_id, p.name, p.last_seen_at
having count(distinct e.id) filter (where e.event_datetime > p.last_seen_at) >= 3
   and bool_or(m.id is not null);
