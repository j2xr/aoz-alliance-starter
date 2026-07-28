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
    # Vertical band actually cropped by the parser for this row. Always set
    # (unlike `trace`): the LLM fallback uses it to re-crop the right row —
    # the index in `members` doesn't match the physical index (invalid rows
    # dropped) and the effective list_top / row_height differ from the
    # class constants (dynamic detection, scaling). Excluded from JSON
    # serialization.
    row_y: int | None = Field(default=None, exclude=True)
    row_h: int | None = Field(default=None, exclude=True)


class TruncationFlagMixin(BaseModel):
    # True when fewer members were parsed than the row slots that physically
    # fit onscreen — a row went missing, whether unreadable or rejected by
    # validation. Advisory only: a legitimately short capture (few real
    # members) can also trip this. Shared by ParseResult and
    # DonationParseResult (see PolarInvasionV1Parser.parse and
    # ContributionRankingV1Parser.parse) so the field and its rationale are
    # defined once instead of drifting across copies.
    possible_truncation: bool = False
    # Row slots that physically fit onscreen (the denominator possible_truncation
    # was computed against), i.e. len(members) < expected_rows iff
    # possible_truncation. None for parsers that don't compute this geometry
    # (e.g. player_stats). Lets a caller judge how severe a truncation is —
    # 1 of 12 rows read is a rejection-worthy loss, 11 of 12 is not — instead
    # of only seeing the boolean.
    expected_rows: int | None = None


class ParseResult(TruncationFlagMixin):
    kind: Literal["event"] = "event"
    event_type: str
    event_datetime: str | None = None
    alliance_rank: int | None = None
    total_battlers: int | None = None
    total_points: int | None = None
    members: list[MemberResult] = []


class DonationMember(BaseModel):
    name: str  # canonicalized (alliance tag stripped)
    alliance_tag: str | None
    rank: str  # R1..R5 ou ""
    alliance_honor: int
    confidence: float
    # On-screen leaderboard position (1-81), best-effort OCR. Informational
    # only — NOT an identity/dedup key (a plausibility calibration against a
    # real fixture showed digit misreads here can be confidently wrong, e.g.
    # rank 1 read as "2"; see contribution_ranking_v1._ocr_position). None
    # when the multi-config vote doesn't reach a strong majority.
    leaderboard_position: int | None = None
    trace: RowTrace | None = Field(default=None, exclude=True)
    # See MemberResult.row_y/row_h: actual row band for the LLM fallback.
    row_y: int | None = Field(default=None, exclude=True)
    row_h: int | None = Field(default=None, exclude=True)
    # Physical on-screen row slot (0.._MAX_ROWS-1) this member came from,
    # BEFORE any rows were dropped for being unreadable or failing
    # validation. _repair_position_sequence needs this: once any earlier row
    # is dropped, `members`' own list index no longer matches the row's
    # actual screen position, and computing the leaderboard_position offset
    # from list index instead of this field silently mis-repairs every
    # member after the gap (see _repair_position_sequence's docstring).
    row_index: int | None = Field(default=None, exclude=True)
    # (lower, upper) bound the honor-monotonicity re-OCR gate held this row's
    # value to, set whenever alliance_honor broke monotonicity — regardless
    # of whether the re-OCR found a fix. One field, not a bool + two ints:
    # "suspect" ⇔ not None, so the flag and the constraint used to judge a
    # correction can never desync. Consumed by extract.py's LLM fallback,
    # which uses the same window to judge an independently-produced score
    # instead of demanding it exactly match a value already known suspect.
    # Excluded from the wire payload like the other row-geometry fields above.
    suspect_honor_window: tuple[int, int] | None = Field(default=None, exclude=True)


class DonationParseResult(TruncationFlagMixin):
    kind: Literal["donation"] = "donation"
    period_type: Literal["weekly", "daily", "history", "unknown"]
    members: list[DonationMember] = []


class PlayerStatsMember(BaseModel):
    name: str
    attack_pct: float | None = None
    attack_kind: Literal["lra", "mra"] = "lra"
    hp_pct: float | None = None
    defense_pct: float | None = None
    confidence: float  # nb stats parsed / 3
    raw_lines: str = ""  # raw OCR lines attributed to this player


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
        """Parse a screenshot.

        ``event_code`` is the event code already known to the caller
        (dispatcher detection or user override). Parsers that handle
        several layouts use it to pick the right one deterministically
        instead of guessing from OCR; others ignore it.
        """
        ...
