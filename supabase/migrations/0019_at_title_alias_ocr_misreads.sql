-- 0019_at_title_alias_ocr_misreads.sql
-- Seed des misreads OCR connus dans at_event_types.title_aliases : le
-- dispatcher du service OCR charge cette colonne au démarrage (source de
-- vérité de la détection de type d'écran) ; un nouvel alias s'ajoute ici
-- plutôt que dans le code Python.
--
-- "lronblood battlefield" : Tesseract lit le I majuscule comme un l minuscule
-- sur la police du jeu.

update at_event_types
   set title_aliases = array_append(title_aliases, 'lronblood battlefield')
 where code = 'ironblood_battlefield'
   and not ('lronblood battlefield' = any(coalesce(title_aliases, '{}')));
