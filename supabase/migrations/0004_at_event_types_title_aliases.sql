-- add title_aliases to at_event_types for OCR dispatcher event detection
alter table at_event_types
  add column title_aliases text[] not null default '{}';
