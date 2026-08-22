-- Register the 7th 3-column event type, seen for the first time in the
-- 400x652 emulator captures delivered 2026-08-22 (aoz-alliance-starter, see
-- plan que-reste-t-il-swirling-penguin). Header geometry measured identical
-- to polar_invasion's on 6/6 captures once forced onto the 3-column branch
-- (app/parsers/polar_invasion_v1.py's _THREE_COL_EVENTS) — this is a pure
-- registration, no new crop constants.
insert into at_event_types (code, display_name, layout_version, title_aliases) values
  ('triangle_war', 'Triangle War', 'v1', array['triangle war'])
on conflict (code) do update
  set display_name   = excluded.display_name,
      layout_version = excluded.layout_version,
      title_aliases  = excluded.title_aliases;
