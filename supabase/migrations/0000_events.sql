-- 0000_events.sql
-- Frontend-owned table: the public event calendar.
--
-- This is the only table WITHOUT the at_ prefix. It is owned by the frontend
-- (frontend/src/App.jsx) and is intentionally public read/write — no login is
-- required to view or post calendar events. The alliance-tracker backend never
-- touches this table; it only writes the at_* tables created by later migrations.
--
-- All times are UTC. `time` is a bare time-of-day; `date` is the (first) day.

create table if not exists events (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  date            date not null,
  time            time not null,
  type            text not null default 'event',
  description     text,
  author          text not null,
  recurrence      text not null default 'none',
  recurrence_end  date,
  created_at      timestamptz not null default now()
);

-- Public read/write (no login required). RLS is enabled but the policies allow
-- anonymous access, which keeps the table explicit about its open nature.
alter table events enable row level security;

create policy "events: public read"   on events for select using (true);
create policy "events: public insert" on events for insert with check (true);
create policy "events: public update" on events for update using (true) with check (true);
create policy "events: public delete" on events for delete using (true);
