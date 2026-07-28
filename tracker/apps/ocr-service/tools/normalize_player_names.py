"""One-shot: applies normalize_name() to nicknames already stored in at_players.

Context: normalize_name() (app/parsers/name_ocr.py) is now applied at the
source by the OCR parsers, but players already in the database in mojibake
form (see docs/maintenance/0014-player-duplicates-merge.md) will no longer
match future screenshots — those now arrive clean. This script renames the
historical data once to prevent every mojibake player from re-forming a
"clean" duplicate on the next upload.

Dry-run by default: prints the before→after table and the collisions
(alliance_id, normalized name already taken by another player) to be
handled via /merge. --apply performs the collision-free renames and
reprints the list of remaining collisions.

Usage:
    uv run python tools/normalize_player_names.py            # dry-run
    uv run python tools/normalize_player_names.py --apply     # applies

Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment (same
PostgREST access as app/dispatcher.py::refresh_title_patterns_from_supabase;
the service key is needed because at_players' RLS only grants read/write
to the authenticated/service roles).
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
    """Computes safe renames and collisions to be handled manually.

    Pure function (no network access) to stay unit-testable.

    A collision occurs when the normalized name (alliance_id, new_name)
    already coincides with ANOTHER player — either an existing player
    untouched by normalization, or another duplicate whose name normalizes
    to the same value (two mojibake variants of the same nickname, e.g.
    ``Mjolnir`` and ``MjÃ¶lnir``). The database's ``unique (alliance_id,
    name)`` forbids a direct rename in these cases; these pairs require a
    ``/merge``.
    """
    existing_names: set[tuple[str, str]] = {(p.alliance_id, p.name) for p in players}

    candidates: list[tuple[PlayerRow, str]] = []
    for p in players:
        new_name = normalize_name(p.name)
        if new_name != p.name:
            candidates.append((p, new_name))

    # Number of candidates (by distinct id) targeting the same (alliance_id, new_name).
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
                Collision(p, new_name, "name already used by another player in the alliance")
            )
            continue

        if target_counts[target_key] > 1:
            collisions.append(
                Collision(
                    p,
                    new_name,
                    "several duplicates in this alliance normalize to the same name",
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
        print(f"\n{len(renames)} rename(s):")
        for r in renames:
            print(f"  [{r.player.alliance_id}] {r.player.name!r} -> {r.new_name!r}")
    else:
        print("\nNo rename needed.")

    if collisions:
        print(f"\n{len(collisions)} collision(s) to handle via /merge:")
        for c in collisions:
            print(f"  [{c.player.alliance_id}] {c.player.name!r} -> {c.new_name!r} ({c.reason})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply the collision-free renames (dry-run by default).",
    )
    args = parser.parse_args()

    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.", file=sys.stderr)
        return 1

    players = fetch_players(url, key)
    renames, collisions = compute_renames(players)
    _print_report(renames, collisions)

    if args.apply and renames:
        print(f"\nApplying {len(renames)} rename(s)...")
        apply_renames(url, key, renames)
        print("Done.")
    elif not args.apply and renames:
        print("\nDry-run: rerun with --apply to rename.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
