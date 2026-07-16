# Fixtures — Polar Invasion

Ground truth pour les tests du parseur OCR `polar_invasion_v1`.

Chaque JSON représente la sortie attendue du parseur pour une capture d'écran donnée (champ `source_file`).

## Structure des fichiers

```
polar_invasion/
├── README.md                    # ce fichier
├── 20260407T1500_001.json       # Event 1, scroll le plus haut
├── 20260407T1500_002.json
├── 20260407T1500_003.json
├── 20260407T1500_004.json
├── 20260407T1500_005.json       # Event 1, scroll le plus bas
├── 20260414T2300_001.json       # Event 2, scroll le plus haut
├── 20260414T2300_002.json
└── 20260414T2300_003.json       # Event 2, scroll le plus bas
```

Les captures correspondantes (`source_file`) doivent être placées dans le même dossier, sous les noms indiqués dans chaque JSON.

## Événements couverts

| Event | Date | Alliance rank | Battlers | Points | Captures |
|-------|------|---------------|----------|--------|----------|
| 1     | 2026-04-07 15:00 | 1 | 43 | 21 955 | 5 |
| 2     | 2026-04-14 23:00 | 2 | 26 | 11 630 | 3 |

## Cohérence vérifiée

L'union des pseudos à travers toutes les captures d'un même événement correspond exactement au `total_battlers` affiché dans le header :

- Event 1 : 43 pseudos distincts sur 5 captures = 43 battlers ✓
- Event 2 : 26 pseudos distincts sur 3 captures = 26 battlers ✓

Cela garantit que les captures couvrent 100% des membres (les chevauchements volontaires entre scrolls consécutifs permettent au parseur d'être testé sur la dédup).

## Cas limites représentés

Le dataset a été choisi pour couvrir volontairement les cas qui mettent le parseur en difficulté.

### Alphabets non-latins

| Pseudo | Alphabet | Notes |
|--------|----------|-------|
| Медвежонок | Cyrillique | "Ourson" en russe |
| Метью      | Cyrillique | "Matthew" translittéré |
| Герман     | Cyrillique | "German"/"Hermann" |
| Толик      | Cyrillique | Diminutif de "Anatoly" |
| おーしあ   | Japonais (hiragana + marque d'allongement) | "Oshia" |

→ Nécessite `tesseract-ocr-rus` et `tesseract-ocr-jpn`. Si Tesseract échoue, fallback LLM déclenché.

### Caractères accentués

- `LEÓN` — accent aigu sur le O majuscule

### Ponctuation dans les pseudos

| Pseudo | Caractère spécial |
|--------|-------------------|
| KOR.Park | point |
| LATAM.REYCOLIMAN | point |
| kor,spark | virgule |
| THOR,01 | virgule |
| Ichigo_19 | underscore |
| KANHA_ | underscore terminal |
| RageX_ | underscore terminal |

→ Attention aux parseurs qui splitent naïvement sur `,` ou `.`. La whitelist de caractères pour les pseudos ne doit PAS être trop restrictive.

### Chiffres dans les pseudos

Beaucoup de pseudos mélangent lettres et chiffres (Yuyuyu325, jc0n, 1jr, FATCAT29, Goldeneye21, Hardcore101, THOR,01, doradora12, Ichigo_19, BakersBakedd27, Duvan395). Le parseur ne doit pas confondre ces chiffres avec les colonnes `power` ou `points` adjacentes. Le découpage par régions (crop par coordonnées) est crucial ici.

### Valeurs à zéro

Plusieurs joueurs ont `points: 0` (inscrits à l'événement mais n'ont rien fait). Ce n'est PAS une absence — la ligne est présente à l'écran, avec un "0" aligné à droite. Sémantiquement c'est différent d'un joueur qui n'apparaît pas du tout (lui n'était pas inscrit). Le parseur doit les conserver.

### Chevauchements entre captures

Les captures d'un même événement se chevauchent volontairement (scroll successifs). Exemples :

- `20260407T1500_003.json` et `20260407T1500_004.json` partagent `Gattopardo` (même valeurs power et points)
- `20260414T2300_002.json` et `20260414T2300_003.json` partagent 6 membres

Le parseur extrait chaque capture indépendamment. La dédup est faite en aval par l'UPSERT sur `(event_id, player_id)`. Les tests peuvent vérifier que les valeurs reportées pour un même joueur sur deux captures sont identiques — sinon c'est un bug d'extraction.

### Évolution de rank entre événements

Deux joueurs changent de rank entre event 1 et event 2 :

- `Bulleit` : R1 → R2
- `Yojimbo` : R4 → R5

Ce n'est pas une erreur OCR, c'est une promotion légitime. Le parseur ne doit pas tenter de "normaliser" le rank en le comparant à un événement antérieur. Chaque capture est la source de vérité pour le moment où elle a été prise.

### Couleur du texte (UI variante)

Certains pseudos et valeurs sont affichés en vert (ex: `Xrage` dans event 1, `1jr` dans event 2). C'est l'indicateur "c'est moi" dans l'UI du jeu. Le parseur doit traiter ces lignes comme les autres — ignorer la couleur. Ne pas ajouter de champ "is_self" dans la sortie (pas pertinent pour l'usage).

## Convention de datetime

Les captures affichent `2026-04-07 15:00` sans information de fuseau horaire. On suppose que c'est l'heure locale de l'utilisateur (Strasbourg, CEST = UTC+2 à ces dates). Les fixtures utilisent donc `+02:00`.

**À vérifier** : si le jeu affiche en réalité l'heure du serveur et non l'heure locale, corriger le `event_datetime` dans tous les fichiers. Dans ce cas, documenter la convention dans `app/parsers/polar_invasion_v1.py`.

## Usage dans les tests

Exemple d'utilisation pytest (à adapter selon la structure du parseur) :

```python
import json
from pathlib import Path
import pytest
from app.parsers.polar_invasion_v1 import parse

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "polar_invasion"

@pytest.mark.parametrize("fixture_file", sorted(FIXTURES_DIR.glob("*.json")))
def test_parser_matches_fixture(fixture_file: Path):
    with fixture_file.open(encoding="utf-8") as f:
        expected = json.load(f)

    image_path = FIXTURES_DIR / expected["source_file"]
    result = parse(image_path)

    # Header
    assert result["event_type"] == expected["event_type"]
    assert result["event_datetime"] == expected["event_datetime"]
    assert result["alliance_rank"] == expected["alliance_rank"]
    assert result["total_battlers"] == expected["total_battlers"]
    assert result["total_points"] == expected["total_points"]

    # Members, par position
    assert len(result["members"]) == len(expected["members"])
    for i, (got, want) in enumerate(zip(result["members"], expected["members"])):
        assert got["name"] == want["name"], f"row {i}: name mismatch"
        assert got["rank"] == want["rank"], f"row {i}: rank mismatch"
        assert got["power"] == want["power"], f"row {i}: power mismatch"
        assert got["points"] == want["points"], f"row {i}: points mismatch"
```

Pour un test plus permissif (accepter une erreur tolérée sur les pseudos exotiques) :

```python
from difflib import SequenceMatcher

def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()

# Dans le test
assert similar(got["name"], want["name"]) > 0.9, f"row {i}: name too different"
# Mais strict sur les nombres
assert got["power"] == want["power"]
assert got["points"] == want["points"]
```

## Objectifs de qualité

Pour considérer le parseur prêt pour la Phase 2 (bot Discord) :

| Champ | Objectif | Stratégie |
|-------|----------|-----------|
| `total_battlers`, `total_points`, `alliance_rank` | 100% | Crop fixe, whitelist chiffres |
| `event_datetime` | 100% | Crop fixe, whitelist `0-9-: ` |
| `power`, `points` | ≥ 95% | Crop par ligne, whitelist chiffres |
| `rank` | ≥ 98% | Badge R1-R5, whitelist `R12345` |
| `name` (latin) | ≥ 90% | Tesseract eng |
| `name` (cyrillique, japonais) | ≥ 75% OU fallback LLM | Tesseract rus+jpn, fallback si conf < 0.75 |

Si ces seuils ne sont pas atteints, activer le LLM fallback (cf PLAN.md §4.3) avant de passer à la Phase 2.
