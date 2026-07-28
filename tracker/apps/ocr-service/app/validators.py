import logging
import re

from app.parsers.base import DonationMember, MemberResult

logger = logging.getLogger(__name__)

MIN_POWER = 1_000_000

# Below this threshold, a value can't be a real power reading
# (MIN_POWER = 1M): if the points, on the other hand, look like a power,
# the two columns were probably swapped by OCR.
SWAP_MAX_POWER = 10_000


def maybe_swap_power_points(member: MemberResult) -> tuple[MemberResult, bool]:
    """Fixes the power ↔ points inversion produced by some OCR misreads.

    Ingestion-time version of migration 0009's historical heuristic (which
    only repaired after the fact, on every deployment): the swap is only
    applied if the corrected row is plausible — 0 < power < 10,000 AND
    points >= MIN_POWER (stricter than 0009's 100k threshold: after the swap,
    power must still satisfy validate_member anyway). power=0 is deliberately
    excluded: an OCR read that didn't capture any power at all shouldn't
    inherit a legitimate points value. Without this swap, validate_member
    would silently reject the row and the member would be lost.
    """
    if (
        0 < member.power < SWAP_MAX_POWER
        and member.points is not None
        and member.points >= MIN_POWER
    ):
        logger.warning(
            "Swapping inverted power/points for %r (power=%d, points=%d)",
            member.name,
            member.power,
            member.points,
        )
        return member.model_copy(update={"power": member.points, "points": member.power}), True
    return member, False


def validate_member(member: MemberResult) -> bool:
    """Return True if member data passes basic plausibility checks."""
    if not member.name:
        return False
    if member.power < MIN_POWER:
        return False
    if member.points is not None and member.points < 0:
        return False
    if not re.match(r"^R[1-5]$", member.rank):
        return False
    return True


def validate_donation_member(member: DonationMember) -> bool:
    """Return True if donation row passes basic plausibility checks.

    Donation rows have neither power nor points — only name + alliance_honor.
    Rank may legitimately be empty for the highlighted "viewer" row, so we
    do not enforce R1..R5 here (we already default to R1 in the parser).
    """
    if not member.name:
        return False
    if member.alliance_honor < 0:
        return False
    return True


def parse_number(text: str) -> int | None:
    """Strip commas and cast to int; return None if unparseable."""
    cleaned = text.replace(",", "").strip()
    try:
        return int(cleaned)
    except ValueError:
        return None
