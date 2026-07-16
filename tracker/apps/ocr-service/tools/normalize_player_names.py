"""One-shot : applique normalize_name() aux pseudos déjà stockés dans at_players.

Contexte : normalize_name() (app/parsers/name_ocr.py) est désormais appliqué à
la source par les parsers OCR, mais les joueurs déjà en base sous forme
mojibake (voir docs/maintenance/0014-player-duplicates-merge.md) ne
matcheront plus les captures futures — celles-ci arrivent désormais propres.
Ce script renomme l'historique une seule fois pour éviter que chaque joueur
mojibake reforme un doublon "propre" au prochain upload.

Dry-run par défaut : affiche le tableau avant→après et les collisions
(alliance_id, nom normalisé déjà pris par un autre joueur) à traiter par
/merge. --apply exécute les renommages sans collision et réaffiche la liste
des collisions restantes.

Usage:
    uv run python tools/normalize_player_names.py            # dry-run
    uv run python tools/normalize_player_names.py --apply     # applique

Requiert SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY dans l'environnement (même
accès PostgREST que app/dispatcher.py::refresh_title_patterns_from_supabase ;
la clé service est nécessaire car la RLS de at_players ne donne la lecture/
écriture qu'aux rôles authenticated/service).
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass

import httpx

from app.parsers.name_ocr import normalize_name


@dataclass(frozen=True)
class PlayerRow:
    id: str
    alliance_id: str
    name: str


@dataclass(frozen=True)
class Rename:
    player: PlayerRow
    new_name: str


@dataclass(frozen=True)
class Collision:
    player: PlayerRow
    new_name: str
    reason: str


def fetch_players(url: str, key: str, timeout: float = 30.0) -> list[PlayerRow]:
    resp = httpx.get(
        f"{url.rstrip('/')}/rest/v1/at_players",
        params={"select": "id,alliance_id,name"},
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        timeout=timeout,
    )
    resp.raise_for_status()
    return [
        PlayerRow(id=row["id"], alliance_id=row["alliance_id"], name=row["name"])
        for row in resp.json()
    ]


def compute_renames(players: list[PlayerRow]) -> tuple[list[Rename], list[Collision]]:
    """Calcule les renommages sûrs et les collisions à traiter manuellement.

    Fonction pure (aucun accès réseau) pour rester testable unitairement.

    Une collision survient quand le nom normalisé (alliance_id, new_name)
    coïncide déjà avec un AUTRE joueur — soit un joueur existant non touché
    par la normalisation, soit un autre doublon dont le nom normalise vers la
    même valeur (deux variantes mojibake du même pseudo, ex. ``Mjolnir`` et
    ``MjÃ¶lnir``). ``unique (alliance_id, name)`` en base interdit le
    renommage direct dans ces cas ; ces paires nécessitent un ``/merge``.
    """
    existing_names: set[tuple[str, str]] = {(p.alliance_id, p.name) for p in players}

    candidates: list[tuple[PlayerRow, str]] = []
    for p in players:
        new_name = normalize_name(p.name)
        if new_name != p.name:
            candidates.append((p, new_name))

    # Nombre de candidats (par id distinct) visant le même (alliance_id, new_name).
    target_counts: dict[tuple[str, str], int] = {}
    for p, new_name in candidates:
        key = (p.alliance_id, new_name)
        target_counts[key] = target_counts.get(key, 0) + 1

    renames: list[Rename] = []
    collisions: list[Collision] = []
    for p, new_name in candidates:
        target_key = (p.alliance_id, new_name)

        other_existing = target_key in existing_names and (p.alliance_id, p.name) != target_key
        if other_existing:
            collisions.append(
                Collision(p, new_name, "nom déjà utilisé par un autre joueur de l'alliance")
            )
            continue

        if target_counts[target_key] > 1:
            collisions.append(
                Collision(
                    p,
                    new_name,
                    "plusieurs doublons de cette alliance normalisent vers le même nom",
                )
            )
            continue

        renames.append(Rename(p, new_name))

    return renames, collisions


def apply_renames(url: str, key: str, renames: list[Rename], timeout: float = 30.0) -> None:
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    with httpx.Client(timeout=timeout) as client:
        for r in renames:
            resp = client.patch(
                f"{url.rstrip('/')}/rest/v1/at_players",
                params={"id": f"eq.{r.player.id}"},
                headers=headers,
                json={"name": r.new_name},
            )
            resp.raise_for_status()


def _print_report(renames: list[Rename], collisions: list[Collision]) -> None:
    if renames:
        print(f"\n{len(renames)} renommage(s):")
        for r in renames:
            print(f"  [{r.player.alliance_id}] {r.player.name!r} -> {r.new_name!r}")
    else:
        print("\nAucun renommage nécessaire.")

    if collisions:
        print(f"\n{len(collisions)} collision(s) à traiter par /merge:")
        for c in collisions:
            print(f"  [{c.player.alliance_id}] {c.player.name!r} -> {c.new_name!r} ({c.reason})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Applique les renommages sans collision (dry-run par défaut).",
    )
    args = parser.parse_args()

    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        print("SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis.", file=sys.stderr)
        return 1

    players = fetch_players(url, key)
    renames, collisions = compute_renames(players)
    _print_report(renames, collisions)

    if args.apply and renames:
        print(f"\nApplication de {len(renames)} renommage(s)...")
        apply_renames(url, key, renames)
        print("Terminé.")
    elif not args.apply and renames:
        print("\nDry-run : relancer avec --apply pour renommer.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
