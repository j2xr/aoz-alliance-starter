from abc import ABC, abstractmethod
from typing import Literal

import numpy as np
from pydantic import BaseModel, Field

from app.parsers._trace import RowTrace


class MemberResult(BaseModel):
    name: str
    rank: str
    power: int
    points: int | None  # None = non-participant (game shows "--")
    confidence: float
    # Debug-only crop coordinates; populated by parsers when emit_trace=True
    # and excluded from JSON serialization so the production API is unchanged.
    trace: RowTrace | None = Field(default=None, exclude=True)
    # Bande verticale réellement découpée par le parser pour cette ligne.
    # Toujours renseignée (contrairement à `trace`) : le fallback LLM s'en
    # sert pour recadrer la bonne ligne — l'index dans `members` ne correspond
    # pas à l'index physique (lignes invalides éliminées) et le list_top /
    # row_height effectifs diffèrent des constantes de classe (détection
    # dynamique, scaling). Exclue de la sérialisation JSON.
    row_y: int | None = Field(default=None, exclude=True)
    row_h: int | None = Field(default=None, exclude=True)


class ParseResult(BaseModel):
    kind: Literal["event"] = "event"
    event_type: str
    event_datetime: str | None = None
    alliance_rank: int | None = None
    total_battlers: int | None = None
    total_points: int | None = None
    members: list[MemberResult] = []


class DonationMember(BaseModel):
    name: str  # canonicalisé (tag d'alliance strippé)
    alliance_tag: str | None
    rank: str  # R1..R5 ou ""
    alliance_honor: int
    confidence: float
    trace: RowTrace | None = Field(default=None, exclude=True)
    # Voir MemberResult.row_y/row_h : bande réelle de la ligne pour le fallback LLM.
    row_y: int | None = Field(default=None, exclude=True)
    row_h: int | None = Field(default=None, exclude=True)


class DonationParseResult(BaseModel):
    kind: Literal["donation"] = "donation"
    period_type: Literal["weekly", "daily", "history"]
    members: list[DonationMember] = []


class PlayerStatsMember(BaseModel):
    name: str
    attack_pct: float | None = None
    attack_kind: Literal["lra", "mra"] = "lra"
    hp_pct: float | None = None
    defense_pct: float | None = None
    confidence: float  # nb stats parsées / 3
    raw_lines: str = ""  # lignes OCR brutes attribuées à ce joueur


class PlayerStatsParseResult(BaseModel):
    kind: Literal["player_stats"] = "player_stats"
    members: list[PlayerStatsMember] = []


class BaseParser(ABC):
    @abstractmethod
    def parse(
        self,
        image: np.ndarray,
        emit_trace: bool = False,
        event_code: str | None = None,
    ) -> ParseResult | DonationParseResult | PlayerStatsParseResult:
        """Parse une capture.

        ``event_code`` est le code événement déjà connu de l'appelant
        (détection du dispatcher ou override utilisateur). Les parsers qui
        gèrent plusieurs layouts s'en servent pour choisir le bon de façon
        déterministe au lieu de le deviner à l'OCR ; les autres l'ignorent.
        """
        ...
