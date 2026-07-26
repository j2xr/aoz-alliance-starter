# Contribution Ranking fixtures

Captures de l'écran « Contribution Ranking » (Alliance Honor / dons de
ressources) du jeu mobile, fournies par l'utilisateur lors de la livraison
initiale du suivi des dons.

## Convention de nommage

```
weekly_<NNN>.jpg    capture brute (Android, ~1080×2400 portrait)
weekly_<NNN>.json   sortie attendue du parser (DonationParseResult)
daily_<NNN>.jpg     capture brute, onglet Daily — voir §5, PAS de .json associé
```

Le numéro `<NNN>` reflète l'ordre de scroll : `weekly_001` montre le top de la
liste (rangs 1 à 12), `weekly_009` le bas (rangs 75 à 86). Des chevauchements
de 1 à 3 lignes existent entre captures consécutives — le parser n'a pas à les
gérer (c'est l'UPSERT côté bot, sur `(donation_period_id, player_id)`, qui
les fusionne).

## Format JSON attendu

```json
{
  "kind": "donation",
  "period_type": "weekly",
  "members": [
    {
      "name": "Аня",
      "alliance_tag": "SOD",
      "rank": "R1",
      "alliance_honor": 8291
    }
  ]
}
```

Le champ `confidence` n'est pas fixé dans les fixtures (variable selon les
réglages Tesseract). Il est ignoré par le bench tant que la valeur dépasse 0.

## Cas particuliers à connaître

1. **Trophées top 3** : les rangs 1, 2 et 3 affichent une icône or/argent/bronze
   au lieu d'un chiffre dans la colonne Rank. Le parser ignore cette colonne
   (l'ordre des lignes encode déjà le classement) — il ne faut donc surtout
   pas annoter une position numérique distincte du R-badge.
2. **Ligne du viewer surdimensionnée** : la ligne du joueur connecté est
   visuellement mise en avant (pas de cadre R-badge autour de l'avatar,
   chiffre de rang plus gros). Le parser tombe alors par défaut sur
   `rank = "R1"`. Documenter cette ligne en `R1` dans le JSON attendu pour
   ne pas faire échouer le bench.
3. **Préfixe d'alliance `(SOD)`** : strippé par le parser via la regex
   `^\s*\(([A-Za-z0-9]{1,5})\)\s*` puis stocké dans `alliance_tag`. Le nom
   stocké dans `name` ne doit PAS contenir le préfixe.
4. **Captures multilingues** : Cyrillique (`Аня`), japonais (`焼鳥_Yakitori`,
   `ばななヨーグルト`, `中本`, `幸恵丸ボーター`), vietnamien (`TôiyêuViệtNam`),
   ASCII art (`ÐÃŘĶ§ĮĐĒ•築`). Le bench compare la similarité ≥ 0.7.
5. **Onglet Daily / Weekly / History** : le champ `period_type` est la vérité
   terrain de la détection d'onglet (`_detect_selected_tab`). La détection
   repose sur l'intensité (la pilule sélectionnée ressort en niveaux de gris)
   et non sur la couleur, donc pas besoin de l'image d'origine en couleur.

   `daily_001.jpg` (capture réelle, onglet Daily confirmé visuellement — voir
   `docs/maintenance/2026-07-26-reprocess-channel-sod-data-quality-report.md`,
   finding 1, qui documente comment une capture Daily non détectée a corrompu
   une période weekly en production) couvre le cas positif inverse. **Ce
   fixture n'a délibérément PAS de `.json` associé** :
   - `tools/bench-ocr/bench.py` énumère les fixtures via `glob("*.json")` —
     un `.jpg` sans `.json` lui est invisible (aucune entrée de baseline,
     aucune latence ajoutée au budget CI). C'est déjà le fonctionnement pour
     `sprites/`, un dossier de fixtures ignoré du bench faute d'event_type
     enregistré.
   - **Piège** : `bench.py` déduit `is_donation` du **premier** `.json` par
     ordre alphabétique (`fixtures[0]`). Un `daily_001.json` serait trié
     *avant* `weekly_001.json` — s'il lui manquait un jour `"kind": "donation"`,
     toute la scène serait notée avec les critères d'un event (`power`/`points`)
     au lieu de ceux d'une donation. Ne jamais ajouter de `.json` `daily_*`
     ou `history_*` sans avoir vérifié ce risque.

   La vérité terrain vient donc du **préfixe du nom de fichier** (`daily_`
   vs `weekly_`), déjà la convention documentée ci-dessus — pas d'un fichier
   séparé. `tests/test_contribution_ranking_parser.py` dérive l'attendu ainsi
   pour chaque `.jpg` du dossier et vérifie qu'au moins deux valeurs de
   `period_type` distinctes sont couvertes (sans quoi la suppression accidentelle
   de `daily_001.jpg` passerait inaperçue). Aucune capture `history_<NNN>`
   n'est disponible à ce jour.

## Cibles de qualité (à atteindre avant merge en production)

- `alliance_honor` : ≥ 95 % de match exact.
- `name`           : ≥ 90 % de similarité Levenshtein.
- `rank`           : ≥ 95 % de match exact (sauf ligne viewer, voir ci-dessus).

À mesurer via `uv run python ../../tools/bench-ocr/bench.py --event-type contribution_ranking` (depuis `apps/ocr-service/`).
