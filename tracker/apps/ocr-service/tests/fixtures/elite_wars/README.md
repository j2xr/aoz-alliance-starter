# Fixtures — Elite Wars

Ground truth pour les tests du parseur OCR `elite_wars`.

Elite Wars utilise le même layout que Polar Invasion (`PolarInvasionV1Parser`).

## Titre détecté par le dispatcher

```
"elite wars"   → elite_wars
```

## Convention de nommage

```
<YYYYMMDDTHHMM>_<NNN>.jpg    capture brute Android (~1080×2400 portrait)
<YYYYMMDDTHHMM>_<NNN>.json   sortie attendue du parseur
```

Exemple : `20260421T1500_001.jpg` / `20260421T1500_001.json`

## Format JSON attendu

```json
{
  "event_type": "polar_invasion",
  "event_datetime": "2026-04-21T15:00:00+02:00",
  "alliance_rank": 1,
  "total_battlers": 40,
  "total_points": 18500,
  "source_file": "original_filename.jpg",
  "members": [
    {"name": "Bulleit", "rank": "R1", "power": 21067465, "points": 55000},
    ...
  ]
}
```

Note : `event_type` vaut `"polar_invasion"` dans le JSON (valeur retournée directement
par le parseur). Le code `"elite_wars"` est assigné par le dispatcher en amont.
Les champs `total_battlers` et `total_points` peuvent être `null` si absents
du header (ex : captures Ironblood sans ces valeurs).

## Objectifs de qualité

| Champ | Objectif |
|-------|----------|
| `event_datetime` | Premiers 16 chars exacts |
| `total_battlers`, `alliance_rank`, `total_points` | Exact |
| `power`, `points` | Exact |
| `rank` | Exact |
| `name` | Similarité ≥ 0.66 (SequenceMatcher) |

## Ajouter des captures

1. Prendre plusieurs captures à différentes positions de scroll (5–10 captures par événement)
2. Relever manuellement les valeurs visibles à l'écran
3. Créer le JSON de référence avec les valeurs exactes lues à l'écran
4. Placer `.jpg` + `.json` dans ce dossier (même nom de fichier, extension différente)
5. Lancer `uv run pytest tests/test_v1_event_parsers.py -v` pour vérifier
