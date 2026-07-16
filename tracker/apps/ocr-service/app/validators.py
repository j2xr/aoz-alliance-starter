import logging
import re

from app.parsers.base import DonationMember, MemberResult

logger = logging.getLogger(__name__)

MIN_POWER = 1_000_000

# En dessous de ce seuil, une valeur ne peut pas être un power réel
# (MIN_POWER = 1M) : si les points, eux, ressemblent à un power, les deux
# colonnes ont probablement été interverties par l'OCR.
SWAP_MAX_POWER = 10_000


def maybe_swap_power_points(member: MemberResult) -> tuple[MemberResult, bool]:
    """Corrige l'inversion power ↔ points produite par certains misreads OCR.

    Version ingestion de l'heuristique historique de la migration 0009 (qui ne
    réparait qu'après coup, à chaque déploiement) : le swap n'est appliqué que
    si la ligne corrigée est plausible — power < 10 000 ET points ≥ MIN_POWER
    (plus strict que le seuil 100k de 0009 : après swap, power doit de toute
    façon satisfaire validate_member). Sans ce swap, validate_member rejetait
    silencieusement la ligne et le membre était perdu.
    """
    if member.power < SWAP_MAX_POWER and member.points is not None and member.points >= MIN_POWER:
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
