from app.parsers.base import BaseParser
from app.parsers.contribution_ranking_v1 import ContributionRankingV1Parser
from app.parsers.player_stats_chat_v1 import PlayerStatsChatV1Parser
from app.parsers.polar_invasion_v1 import PolarInvasionV1Parser

_v1 = PolarInvasionV1Parser()
_donation_v1 = ContributionRankingV1Parser()
_player_stats_v1 = PlayerStatsChatV1Parser()

# All events currently share the same member-list layout (v1).
REGISTRY: dict[str, BaseParser] = {
    "polar_invasion": _v1,
    "elite_wars": _v1,
    "wasteland_showdown": _v1,
    "battle_frenzy": _v1,
    "void_war": _v1,
    "ironblood_battlefield": _v1,
    "contribution_ranking": _donation_v1,
    "player_stats_chat": _player_stats_v1,
}


def get_parser(code: str) -> BaseParser | None:
    return REGISTRY.get(code)
