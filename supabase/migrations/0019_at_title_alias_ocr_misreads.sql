-- 0019_at_title_alias_ocr_misreads.sql
-- Seeds known OCR misreads into at_event_types.title_aliases: the OCR
-- service's dispatcher loads this column at startup (source of truth for
-- screen-type detection); a new alias is added here rather than in the
-- Python code.
--
-- "lronblood battlefield": Tesseract reads the capital I as a lowercase l
-- on the game's font.

update at_event_types
   set title_aliases = array_append(title_aliases, 'lronblood battlefield')
 where code = 'ironblood_battlefield'
   and not ('lronblood battlefield' = any(coalesce(title_aliases, '{}')));
