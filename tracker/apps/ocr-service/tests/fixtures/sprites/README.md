# Sprites for template matching

This folder contains the sprites used for template matching in the OCR parsers.

- `sword_icon.png`: crossed-swords icon, extracted from fixture `20260407T1500_001.png` (event-1, Polar Invasion, row 1, power crop, x≈210–270, y_off≈115–160), preprocessed with `preprocess()`.

Format:
- PNG, grayscale, same preprocessing as the input images.
- Used to mask the icon before OCR of the name/power (cf. `polar_invasion_v1.py`).
