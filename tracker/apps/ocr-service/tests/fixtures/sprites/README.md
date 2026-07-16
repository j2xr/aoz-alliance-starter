# Sprites pour template matching

Ce dossier contient les sprites utilisés pour le template matching dans les parsers OCR.

- `sword_icon.png` : icône épées croisées, extraite de la fixture `20260407T1500_001.png` (event-1, Polar Invasion, ligne 1, crop power, x≈210–270, y_off≈115–160), prétraitée avec `preprocess()`.

Format :
- PNG, niveaux de gris, même prétraitement que les images d'entrée.
- Utilisé pour masquer l'icône avant OCR du nom/power (cf. `polar_invasion_v1.py`).
