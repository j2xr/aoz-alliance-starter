"""Tests unitaires du calcul de collisions de tools/normalize_player_names.py.

Fonction pure (pas d'accès réseau) : aucun mock PostgREST nécessaire.
"""

from tools.normalize_player_names import PlayerRow, compute_renames

_ALLIANCE = "11111111-1111-1111-1111-111111111111"


def test_no_renames_when_already_normalized() -> None:
    players = [PlayerRow(id="1", alliance_id=_ALLIANCE, name="Clean")]
    renames, collisions = compute_renames(players)
    assert renames == []
    assert collisions == []


def test_simple_rename_no_collision() -> None:
    players = [PlayerRow(id="1", alliance_id=_ALLIANCE, name="MjÃ¶lnir")]
    renames, collisions = compute_renames(players)
    assert len(renames) == 1
    assert renames[0].player.id == "1"
    assert renames[0].new_name == "Mjölnir"
    assert collisions == []


def test_collision_with_existing_untouched_player() -> None:
    players = [
        PlayerRow(id="1", alliance_id=_ALLIANCE, name="MjÃ¶lnir"),
        PlayerRow(id="2", alliance_id=_ALLIANCE, name="Mjölnir"),
    ]
    renames, collisions = compute_renames(players)
    assert renames == []
    assert len(collisions) == 1
    assert collisions[0].player.id == "1"
    assert collisions[0].new_name == "Mjölnir"


def test_collision_between_two_duplicates_normalizing_to_same_name() -> None:
    players = [
        PlayerRow(id="1", alliance_id=_ALLIANCE, name="MjÃ¶lnir"),
        PlayerRow(id="2", alliance_id=_ALLIANCE, name="MjÃ¶lnir​"),
    ]
    renames, collisions = compute_renames(players)
    assert renames == []
    assert {c.player.id for c in collisions} == {"1", "2"}


def test_same_raw_name_different_alliances_no_cross_collision() -> None:
    other_alliance = "22222222-2222-2222-2222-222222222222"
    players = [
        PlayerRow(id="1", alliance_id=_ALLIANCE, name="MjÃ¶lnir"),
        PlayerRow(id="2", alliance_id=other_alliance, name="Mjölnir"),
    ]
    renames, collisions = compute_renames(players)
    assert len(renames) == 1
    assert renames[0].player.id == "1"
    assert collisions == []
