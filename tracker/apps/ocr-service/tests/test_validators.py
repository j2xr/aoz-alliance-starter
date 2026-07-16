import pytest

from app.parsers.base import MemberResult
from app.validators import maybe_swap_power_points, parse_number, validate_member


def _member(**overrides: object) -> MemberResult:
    defaults: dict[str, object] = {
        "name": "TestPlayer",
        "rank": "R3",
        "power": 5_000_000,
        "points": 1_000,
        "confidence": 0.9,
    }
    defaults.update(overrides)
    return MemberResult(**defaults)  # type: ignore[arg-type]


def test_valid_member() -> None:
    assert validate_member(_member()) is True


def test_power_below_minimum() -> None:
    assert validate_member(_member(power=999_999)) is False


def test_power_at_minimum() -> None:
    assert validate_member(_member(power=1_000_000)) is True


def test_negative_points() -> None:
    assert validate_member(_member(points=-1)) is False


def test_zero_points_allowed() -> None:
    assert validate_member(_member(points=0)) is True


def test_null_points_allowed() -> None:
    """None points = non-participant (game shows '--'), still a valid member row."""
    assert validate_member(_member(points=None)) is True


def test_empty_name() -> None:
    assert validate_member(_member(name="")) is False


@pytest.mark.parametrize("rank", ["R1", "R2", "R3", "R4", "R5"])
def test_valid_ranks(rank: str) -> None:
    assert validate_member(_member(rank=rank)) is True


@pytest.mark.parametrize("rank", ["R0", "R6", "r1", "rank1", ""])
def test_invalid_ranks(rank: str) -> None:
    assert validate_member(_member(rank=rank)) is False


@pytest.mark.parametrize(
    "text,expected",
    [
        ("1,234,567", 1_234_567),
        ("9065", 9065),
        ("0", 0),
        ("  42  ", 42),
        ("abc", None),
        ("-", None),
        ("", None),
        ("1,2,3", 123),
        ("15,103,026", 15_103_026),
    ],
)
def test_parse_number(text: str, expected: int | None) -> None:
    assert parse_number(text) == expected


# ── maybe_swap_power_points ───────────────────────────────────────────────────


def test_swap_fires_on_inverted_columns() -> None:
    member, swapped = maybe_swap_power_points(_member(power=500, points=2_000_000))
    assert swapped is True
    assert member.power == 2_000_000
    assert member.points == 500
    assert validate_member(member) is True


def test_swap_skips_when_points_not_power_like() -> None:
    # points < MIN_POWER : le swap produirait une ligne invalide de toute façon.
    member, swapped = maybe_swap_power_points(_member(power=500, points=50_000))
    assert swapped is False
    assert member.power == 500


def test_swap_skips_healthy_row() -> None:
    member, swapped = maybe_swap_power_points(_member(power=15_000_000, points=50_000))
    assert swapped is False
    assert member.power == 15_000_000


def test_swap_skips_none_points() -> None:
    member, swapped = maybe_swap_power_points(_member(power=500, points=None))
    assert swapped is False
    assert member.points is None


def test_swap_skips_zero_power() -> None:
    # power=0 means OCR failed to read power at all; it must not adopt a
    # legitimate points value instead of being rejected by validate_member.
    member, swapped = maybe_swap_power_points(_member(power=0, points=1_500_000))
    assert swapped is False
    assert member.power == 0
    assert validate_member(member) is False
