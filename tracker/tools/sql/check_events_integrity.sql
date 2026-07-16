-- check_events_integrity.sql
-- Vérification de l'intégrité des données dans at_events.
--
-- Usage : coller dans l'éditeur SQL Supabase, ou via psql :
--   psql "$DATABASE_URL" -f tools/sql/check_events_integrity.sql
--
-- Deux vérifications :
--   1. Colonnes nullable à NULL dans at_events
--   2. total_battlers ≠ nombre réel de participations enregistrées

-- ─── 1. Valeurs NULL dans at_events ──────────────────────────────────────────
-- Les colonnes alliance_rank, total_battlers, total_points et source_message_id
-- sont optionnelles dans le schéma mais devraient toutes être renseignées
-- après un traitement OCR réussi.

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
    AS champs_null
FROM at_events e
JOIN at_alliances  a  ON a.id  = e.alliance_id
JOIN at_event_types et ON et.id = e.event_type_id
WHERE
  e.alliance_rank     IS NULL
  OR e.total_battlers    IS NULL
  OR e.total_points      IS NULL
  OR e.source_message_id IS NULL
ORDER BY e.event_datetime DESC;

-- ─── 2. Écarts total_battlers vs participations réelles ──────────────────────
-- total_battlers est extrait par OCR depuis l'écran récapitulatif de l'événement.
-- Le nombre de lignes dans at_participations doit correspondre.
-- Un écart indique soit une inversion OCR, soit une capture incomplète (scroll).

SELECT
  e.id                                              AS event_id,
  a.name                                            AS alliance,
  et.code                                           AS event_type,
  e.event_datetime,
  e.total_battlers                                  AS ocr_total_battlers,
  count(p.id)                                       AS participations_enregistrees,
  count(p.id) - coalesce(e.total_battlers, 0)       AS ecart,
  e.source_message_id
FROM at_events e
JOIN at_alliances   a  ON a.id  = e.alliance_id
JOIN at_event_types et ON et.id = e.event_type_id
LEFT JOIN at_participations p ON p.event_id = e.id
GROUP BY e.id, a.name, et.code, e.event_datetime, e.total_battlers, e.source_message_id
HAVING count(p.id) <> coalesce(e.total_battlers, 0)
ORDER BY abs(count(p.id) - coalesce(e.total_battlers, 0)) DESC, e.event_datetime DESC;
