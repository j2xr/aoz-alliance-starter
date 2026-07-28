-- check_events_integrity.sql
-- Data integrity check for at_events.
--
-- Usage: paste into the Supabase SQL editor, or via psql:
--   psql "$DATABASE_URL" -f tools/sql/check_events_integrity.sql
--
-- Two checks:
--   1. Nullable columns that are NULL in at_events
--   2. total_battlers ≠ actual number of recorded participations

-- ─── 1. NULL values in at_events ──────────────────────────────────────────────
-- The alliance_rank, total_battlers, total_points and source_message_id
-- columns are optional in the schema but should all be populated after a
-- successful OCR run.

SELECT
  e.id                                          AS event_id,
  a.name                                        AS alliance,
  et.code                                       AS event_type,
  e.event_datetime,
  e.source_message_id,
  CASE WHEN e.alliance_rank     IS NULL THEN 'alliance_rank '     ELSE '' END ||
  CASE WHEN e.total_battlers    IS NULL THEN 'total_battlers '    ELSE '' END ||
  CASE WHEN e.total_points      IS NULL THEN 'total_points '      ELSE '' END ||
  CASE WHEN e.source_message_id IS NULL THEN 'source_message_id ' ELSE '' END
    AS null_fields
FROM at_events e
JOIN at_alliances  a  ON a.id  = e.alliance_id
JOIN at_event_types et ON et.id = e.event_type_id
WHERE
  e.alliance_rank     IS NULL
  OR e.total_battlers    IS NULL
  OR e.total_points      IS NULL
  OR e.source_message_id IS NULL
ORDER BY e.event_datetime DESC;

-- ─── 2. total_battlers vs actual participations discrepancies ────────────────
-- total_battlers is extracted by OCR from the event's summary screen.
-- The number of rows in at_participations should match.
-- A discrepancy indicates either an OCR inversion or an incomplete capture (scroll).

SELECT
  e.id                                              AS event_id,
  a.name                                            AS alliance,
  et.code                                           AS event_type,
  e.event_datetime,
  e.total_battlers                                  AS ocr_total_battlers,
  count(p.id)                                       AS recorded_participations,
  count(p.id) - coalesce(e.total_battlers, 0)       AS discrepancy,
  e.source_message_id
FROM at_events e
JOIN at_alliances   a  ON a.id  = e.alliance_id
JOIN at_event_types et ON et.id = e.event_type_id
LEFT JOIN at_participations p ON p.event_id = e.id
GROUP BY e.id, a.name, et.code, e.event_datetime, e.total_battlers, e.source_message_id
HAVING count(p.id) <> coalesce(e.total_battlers, 0)
ORDER BY abs(count(p.id) - coalesce(e.total_battlers, 0)) DESC, e.event_datetime DESC;
