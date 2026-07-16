import logging
import os
import re
from collections import Counter
from datetime import datetime
from zoneinfo import ZoneInfo

import cv2
import numpy as np

from app import tess_engine as pytesseract
from app.parsers._trace import FieldBox, RowTrace
from app.parsers.base import BaseParser, MemberResult, ParseResult
from app.parsers.name_ocr import disambiguate_cyrillic, normalize_name
from app.parsers.name_ocr import fix_name_substitutions as _fix_name_substitutions
from app.parsers.name_ocr import mean_word_conf as _mean_word_conf
from app.parsers.name_ocr import words_from_data as _words_from_data
from app.tess_engine import Output
from app.validators import maybe_swap_power_points, parse_number, validate_member

from .sword_icon_utils import mask_sword_icon

logger = logging.getLogger(__name__)

# ── Layout constants at TARGET_WIDTH=1080px ──────────────────────────────────
# Used by extract.py for LLM fallback row slicing.
# After preprocess() the image is always 1080px wide and the game UI elements
# are at fixed pixel positions regardless of total image height (different
# device aspect ratios change the visible bottom area, not the UI element
# pitch). So we use absolute pixel positions, not scaled by height.

CANONICAL_HEIGHT = 2400

# Header crop y-coordinates
_DATE_Y = (135, 195)
_STATS_Y = (278, 340)

# Header crop x-coordinates for the 3-column layout (Battlers | Alliance
# Ranking | Alliance Points) used by polar_invasion and elite_wars.
_DATE_X = (380, 710)
_BATTLERS_X = (200, 310)
_ALLIANCE_RANK_X = (480, 595)
_TOTAL_POINTS_X = (720, 925)

# Header crop x-coordinates for the 2-column layout (Battlers or
# "Alliance Members" | Alliance Points) used by wasteland_showdown,
# battle_frenzy, void_war — these screens don't show an alliance ranking.
_BATTLERS_X_2COL = (350, 500)
_TOTAL_POINTS_X_2COL = (550, 800)

# Layout de header par code événement (vérifié sur les fixtures : ironblood
# est 3 colonnes — avec battlers/points parfois illisibles — et battle_frenzy
# 2 colonnes). Quand le code est connu, le layout est choisi ici de façon
# déterministe ; l'ancienne heuristique « un chiffre lu dans la cellule rang
# → 3 colonnes » reste en fallback, mais un chiffre parasite pouvait forcer
# les mauvaises colonnes sur un écran 2 colonnes (les plages 2 colonnes
# chevauchent x=480-595).
_THREE_COL_EVENTS = frozenset({"polar_invasion", "elite_wars", "ironblood_battlefield"})
_TWO_COL_EVENTS = frozenset({"wasteland_showdown", "battle_frenzy", "void_war"})

# Member list layout
_MEMBER_LIST_TOP = 411  # fallback y-start of first row when detection fails
_ROW_HEIGHT = 179  # row height in pixels (constant in 1080-wide images)
_MAX_ROWS = 12

# Column crops within each row (y-offsets, x-coordinates)
_RANK_CROPS: list[tuple[int, int, int, int]] = [
    (35, 80, 45, 115),
    (30, 80, 40, 120),
    (40, 75, 50, 110),
]
_NAME_Y_OFF = (50, 103)  # primary crop (event-1 layout)
_NAME_Y_OFF_WIDE = (45, 130)  # fallback crop (event-2 layout, ~15px lower)
_NAME_X = (220, 680)
_POWER_Y_OFF = (100, 165)
_POWER_X = (240, 545)
_POINTS_X = (720, 1060)

# Public aliases expected by extract.py
MEMBER_LIST_TOP = _MEMBER_LIST_TOP
ROW_HEIGHT = _ROW_HEIGHT

_DIGIT_MAP = {"I": "1", "i": "1", "l": "1", "L": "1", "|": "1", "!": "1", "D": "1", "d": "1"}

# Tight badge crop: Inner R-disc only, no avatar overlap.
_RANK_BADGE_X = (38, 90)
_RANK_BADGE_Y = (33, 80)

# Rank OCR (threshold, psm) combos ordered by empirical first-hit rate on the
# fixture set: combos at the front yield a strong R[1-5] reading more often,
# so trying them first lets us exit after ≤ 2-3 attempts on most rows instead
# of running the full 7×3 = 21-call sweep. Order measured on 181 rows across
# all event fixtures; (100, 11) and (120, 11) alone cover ~96% of rows. The
# tail (combos that never produced a strong hit in measurement) is kept as a
# safety net for outlier lighting conditions.
_RANK_OCR_ORDER: tuple[tuple[int, int], ...] = (
    (100, 11),
    (120, 11),
    (80, 11),
    (160, 11),
    (180, 11),
    (160, 7),
    (140, 11),
    (120, 7),
    (140, 7),
    (100, 7),
    (80, 7),
    (180, 7),
    (60, 7),
    (60, 11),
    (60, 8),
    (80, 8),
    (100, 8),
    (120, 8),
    (140, 8),
    (160, 8),
    (180, 8),
)


def _detect_rank_from_crop(
    crop: np.ndarray,
    last_winning_combo: tuple[int, int] | None = None,
) -> tuple[str, tuple[int, int] | None]:
    """Run the multi-threshold × multi-PSM sweep on a pre-cropped badge.

    Returns ``(rank, winning_combo)`` where ``winning_combo`` is the
    ``(threshold, psm)`` pair whose strong R[1-5] reading carried the vote
    (or ``None`` when no strong hit was found and a weak fallback or the R1
    default decided).  Callers should remember this combo and pass it as
    ``last_winning_combo`` for subsequent rows in the same image — lighting
    is constant within a screenshot, so the combo that worked on row N is
    very likely to work on row N+1 too, letting the early-exit path fire on
    the first attempt.

    Early-exit strategy:
        * Try combos in ``_RANK_OCR_ORDER`` (cached combo first if given).
        * Collect strong matches (``R[1-5]``) and weak matches (lone digit).
        * Return as soon as the same strong rank has been seen ≥ 2 times
          (high-confidence majority).
        * Once all combos are exhausted, fall back to the most-voted strong
          match, then to the most-voted weak match, then to ``R1`` default.
    """
    if last_winning_combo is not None and last_winning_combo in _RANK_OCR_ORDER:
        order: tuple[tuple[int, int], ...] = (
            last_winning_combo,
            *(c for c in _RANK_OCR_ORDER if c != last_winning_combo),
        )
    else:
        order = _RANK_OCR_ORDER

    strong_hits: list[tuple[tuple[int, int], str]] = []  # (combo, "R<digit>")
    weak_hits: list[str] = []  # "R<digit>" reconstructed from lone digits

    for combo in order:
        thresh, psm = combo
        _, mask = cv2.threshold(crop, thresh, 255, cv2.THRESH_BINARY)
        padded = cv2.copyMakeBorder(mask, 30, 30, 30, 30, cv2.BORDER_CONSTANT, value=255)
        big = cv2.resize(padded, None, fx=5, fy=5, interpolation=cv2.INTER_CUBIC)
        text = pytesseract.image_to_string(
            big,
            config=f"--psm {psm} -c tessedit_char_whitelist=R12345",
        ).strip()
        m = re.search(r"R([1-5])", text)
        if m:
            rank_str = f"R{m.group(1)}"
            strong_hits.append((combo, rank_str))
            counts = Counter(r for _, r in strong_hits)
            best_rank, best_count = counts.most_common(1)[0]
            if best_count >= 2:
                winning_combo = next(c for c, r in strong_hits if r == best_rank)
                return best_rank, winning_combo
        else:
            m2 = re.search(r"(?<!R)([1-5])", text)
            if m2:
                weak_hits.append(f"R{m2.group(1)}")

    if strong_hits:
        # A single un-confirmed strong hit — still more reliable than a weak
        # vote.  Return it without setting the cache (we have no confidence
        # it'll repeat on the next row).
        return strong_hits[0][1], None
    if weak_hits:
        return Counter(weak_hits).most_common(1)[0][0], None
    # No strategy matched — default to R1 so validate_member accepts the row.
    return "R1", None


def _clean_rank(text: str) -> str | None:
    """Extract normalised R1–R5 from OCR text; return None if absent."""
    m = re.search(r"[Rr]([1-5])", text)
    if m:
        return f"R{m.group(1)}"
    return None


def _parse_datetime(text: str) -> str | None:
    """Return 'YYYY-MM-DDTHH:MM' from OCR text, or None."""
    m = re.search(r"(\d{4}-\d{2}-\d{2})\s*T?\s*(\d{2}:\d{2})", text)
    if m:
        return f"{m.group(1)}T{m.group(2)}"
    return None


def _paris_isoformat(dt: str) -> str | None:
    """'YYYY-MM-DDTHH:MM' (heure murale Europe/Paris) → ISO 8601 avec le bon offset.

    L'offset dépend de la date (CET +01:00 l'hiver, CEST +02:00 l'été) : un
    +02:00 codé en dur décalait d'une heure l'instant stocké pour tous les
    événements d'hiver. Retourne None si l'OCR a produit une date invalide
    (ex. mois 13), traitée en aval comme un en-tête illisible.
    """
    try:
        parsed = datetime.fromisoformat(f"{dt}:00")
    except ValueError:
        return None
    return parsed.replace(tzinfo=ZoneInfo("Europe/Paris")).isoformat()


# Trailing run of digits and digit-separators (',', '.', "'", '"', spaces)
# that the OCR sometimes captures when the power column bleeds into the name
# crop. The match must start with a digit so we don't strip pure punctuation.
_TRAILING_DIGIT_RUN = re.compile(r"\d[\d.,'\"\s]*$")

# ASCII fast-path: try eng-only OCR first; escalate to full multilang only when
# the result contains non-ASCII characters or confidence is below the threshold.
_ASCII_FAST_PATH_ENABLED: bool = (
    os.getenv("OCR_NAME_ASCII_FAST_PATH_ENABLED", "true").lower() == "true"
)
_ASCII_FAST_PATH_MIN_CONF: float = float(os.getenv("OCR_NAME_ASCII_FAST_PATH_MIN_CONF", "0.60"))
_ASCII_RE = re.compile(r"^[A-Za-z0-9_|§\-\.]+$")


def _strip_trailing_power_digits(name: str) -> tuple[str, bool]:
    """Strip a trailing power-like digit run from name; return (cleaned, did_strip).

    The OCR sometimes returns names like 'Yet12,937,418', 'Ye'9519.244' or
    'Ye12893,651' where the player's power value is concatenated to the name.
    The previous logic only matched f'{power:,}' exactly and missed variants
    where the OCR misplaced commas/periods/apostrophes. Here we match any
    trailing run of digits + separators and strip it when the digit count
    suggests a value ≥ 1,000,000 (i.e. ≥ 7 digits) — the same threshold
    used by _detect_power to qualify a token as power.
    """
    m = _TRAILING_DIGIT_RUN.search(name)
    if not m:
        return name, False
    digits = re.sub(r"\D", "", m.group(0))
    if len(digits) < 7:
        return name, False
    cleaned = name[: m.start()].rstrip(" \t.,'\"`-_")
    return cleaned, True


class PolarInvasionV1Parser(BaseParser):
    member_list_top: int = MEMBER_LIST_TOP
    row_height: int = ROW_HEIGHT

    def parse(
        self,
        image: np.ndarray,
        emit_trace: bool = False,
        event_code: str | None = None,
    ) -> ParseResult:
        h = image.shape[0]

        dt, battlers, alliance_rank, total_points = self._parse_header(image, event_code)
        event_datetime = _paris_isoformat(dt) if dt else None

        row_h = _ROW_HEIGHT
        list_top = self._detect_list_top(image)

        members: list[MemberResult] = []
        consecutive_none = 0
        # Local across the whole image: the (threshold, psm) combo that
        # carried the most recent successful rank vote.  Lighting is
        # constant within a screenshot, so re-trying that combo first on
        # the next row usually lets _detect_rank exit after 1–2 attempts.
        rank_cache: dict[str, tuple[int, int] | None] = {"last": None}
        # Require enough of the power crop (y + 145, i.e. _POWER_Y_OFF[1] - 20)
        # to be inside the image. Allowing up to 20 px of overhang accepts the
        # last row even when it's slightly clipped, but rejects rows where the
        # power digits are too truncated to read reliably — without this, OCR
        # on the partial power line returns noise and validate_member spuriously
        # accepts it (e.g. void_war-002 row 10 returning a 49M garbage value).
        usable_end = h - (_POWER_Y_OFF[1] - 20)
        for i in range(_MAX_ROWS):
            y = list_top + i * row_h
            if y > usable_end:
                break
            member = self._parse_row(
                image,
                y,
                row_h,
                emit_trace=emit_trace,
                list_top=list_top,
                row_index=i,
                rank_cache=rank_cache,
            )
            if member is None:
                consecutive_none += 1
                if consecutive_none >= 3:
                    break
                continue
            consecutive_none = 0
            # Répare l'inversion power ↔ points à la source (ex-migration 0009) :
            # sans cela validate_member rejetait la ligne et le membre était perdu.
            member, _ = maybe_swap_power_points(member)
            if validate_member(member):
                members.append(member)

        return ParseResult(
            event_type="polar_invasion",
            event_datetime=event_datetime,
            alliance_rank=alliance_rank,
            total_battlers=battlers,
            total_points=total_points,
            members=members,
        )

    # ── List top detection ────────────────────────────────────────────────────

    def _detect_list_top(self, image: np.ndarray) -> int:
        """Detect y-start of row 0 by locating the row-separator gap pattern.

        Each member row is a panel ~155px tall followed by a ~20px bright
        gap (= row separator); the row-to-row pitch is consistently 179px in
        1080-wide images. We sample the right-edge column (x=970-1070) where
        no text intrudes, find narrow bright zones (5–30px wide), and pick
        the first pair whose pitch is ≈179. The first zone of that pair is
        the gap between row 0 and row 1, so row 0 top = first_gap_start - 179.

        Width filtering excludes the wide (~47px) bright zone that sits
        above row 0 (a mix of stats/header background and the gap below the
        Member/Points column titles). Falls back to the canonical
        _MEMBER_LIST_TOP when no qualifying pair is found.
        """
        h = int(image.shape[0])

        if image.ndim == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image

        right_edge = gray[:, 970:1070].mean(axis=1)

        # Bright zones (brightness ≥ 226) of width 5–30 are row separators.
        zones: list[tuple[int, int]] = []
        in_zone = False
        zs = 0
        for y in range(380, h):
            if right_edge[y] >= 226.0 and not in_zone:
                in_zone = True
                zs = y
            elif right_edge[y] < 226.0 and in_zone:
                in_zone = False
                width = y - zs
                if 5 <= width <= 30:
                    zones.append((zs, y))
        if in_zone and (h - zs) <= 30 and (h - zs) >= 5:
            zones.append((zs, h))

        for i in range(len(zones) - 1):
            z1 = zones[i]
            z2 = zones[i + 1]
            pitch = z2[0] - z1[0]
            if 175 <= pitch <= 185:
                row_0_top = z1[0] - _ROW_HEIGHT
                result = max(0, min(h - 1, row_0_top))
                logger.debug(
                    "list_top: zone[%d]=%s pitch=%d row_0_top=%d",
                    i,
                    z1,
                    pitch,
                    result,
                )
                return result

        logger.debug("list_top: no ~179 zone pair found, using fallback %d", _MEMBER_LIST_TOP)
        return _MEMBER_LIST_TOP

    # ── Header ────────────────────────────────────────────────────────────────

    def _parse_header(
        self, image: np.ndarray, event_code: str | None = None
    ) -> tuple[str | None, int | None, int | None, int | None]:
        date_text = pytesseract.image_to_string(
            image[_DATE_Y[0] : _DATE_Y[1], _DATE_X[0] : _DATE_X[1]], config="--psm 7"
        ).strip()
        dt = _parse_datetime(date_text)

        sy1, sy2 = _STATS_Y

        def _ocr_number(x_range: tuple[int, int]) -> int | None:
            return parse_number(
                pytesseract.image_to_string(
                    image[sy1:sy2, x_range[0] : x_range[1]],
                    config="--psm 7 -c tessedit_char_whitelist=0123456789",
                ).strip()
            )

        # Layout connu de façon déterministe quand le code événement est fourni
        # (production : dispatcher ou override). On ne lit jamais la cellule
        # rang sur un écran 2 colonnes — elle chevauche les colonnes réelles.
        if event_code in _THREE_COL_EVENTS:
            return (
                dt,
                _ocr_number(_BATTLERS_X),
                _ocr_number(_ALLIANCE_RANK_X),
                _ocr_number(_TOTAL_POINTS_X),
            )
        if event_code in _TWO_COL_EVENTS:
            return dt, _ocr_number(_BATTLERS_X_2COL), None, _ocr_number(_TOTAL_POINTS_X_2COL)

        # Fallback (code absent : appels directs des tests/outils) — heuristique
        # historique durcie : un chiffre dans la cellule rang ne suffit plus,
        # il faut aussi que la lecture 3 colonnes soit plausible.
        alliance_rank = _ocr_number(_ALLIANCE_RANK_X)
        if alliance_rank is not None and 1 <= alliance_rank <= 9999:
            battlers = _ocr_number(_BATTLERS_X)
            if battlers is None or battlers <= 999:
                total_points = _ocr_number(_TOTAL_POINTS_X)
                return dt, battlers, alliance_rank, total_points

        # 2-column layout: Battlers (or "Alliance Members") | Alliance Points.
        # Used by wasteland_showdown, battle_frenzy, void_war — both numeric
        # values sit further from the screen edges than in the 3-column case.
        battlers = _ocr_number(_BATTLERS_X_2COL)
        total_points = _ocr_number(_TOTAL_POINTS_X_2COL)
        return dt, battlers, None, total_points

    # ── Member row ────────────────────────────────────────────────────────────

    def _parse_row(
        self,
        image: np.ndarray,
        y: int,
        row_h: int,
        emit_trace: bool = False,
        list_top: int = 0,
        row_index: int = 0,
        rank_cache: dict[str, tuple[int, int] | None] | None = None,
    ) -> MemberResult | None:
        """Parse one member row. Returns None when the row appears empty.

        Masquage de l'icône épées croisées (⚔) par template matching avant OCR du nom et du power.
        Sprite source : fixture 20260407T1500_001.png, event-1, Polar Invasion, ligne 1,
        crop power, x≈210–270, y_off≈115–160, prétraité avec preprocess().
        """
        # Copie locale de la bande de la ligne (mask_sword_icon dessine dedans).
        # Limitée à x < _POINTS_X[0] : tout ce qui lit row_img (badge de rang
        # x=38-90, nom x=220-680, power x<720, bande de recherche de l'icône
        # x=180-320) reste sous cette borne ; la colonne points est lue plus
        # bas directement sur `image`. Copier toute la largeur gaspillait ~33%.
        row_img = image[y : y + row_h, : _POINTS_X[0]].copy()
        # Masque l'icône épées croisées si présente
        row_img = mask_sword_icon(row_img, 1.0)

        # Les fonctions de détection utilisent les coordonnées relatives à la ligne
        # Adapter les appels pour utiliser row_img au lieu de image, et y=0
        rank = self._detect_rank(row_img, 0, rank_cache=rank_cache)

        # Detect power before name so we can strip it from the name string when
        # OCR bleeds across column boundaries (e.g. "Ye12,034,411" → "Ye").
        power = self._detect_power(row_img, 0)

        ny1, ny2 = _NAME_Y_OFF
        name_y_off_used = _NAME_Y_OFF
        crop = row_img[ny1:ny2, _NAME_X[0] : _NAME_X[1]]
        crop_2x = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        if _ASCII_FAST_PATH_ENABLED:
            _fp_data = pytesseract.image_to_data(
                crop_2x,
                config="--psm 7 -l eng+rus -c load_system_dawg=0 -c load_freq_dawg=0",
                output_type=Output.DICT,
            )
            _fp_name = _words_from_data(_fp_data, min_conf=10)
            _fp_confs = [
                int(c) for c in _fp_data["conf"] if str(c).lstrip("-").isdigit() and int(c) >= 0
            ]
            _fp_conf = sum(_fp_confs) / (len(_fp_confs) * 100) if _fp_confs else 0.0
            _fp_reliable = (
                _ASCII_RE.match(_fp_name)
                and len(_fp_name) >= 3
                and _fp_conf > _ASCII_FAST_PATH_MIN_CONF
            )
            if _fp_reliable:
                name_data = _fp_data
                name = _fp_name
                logger.debug("row y=%d name fast-path HIT: %r conf=%.2f", y, _fp_name, _fp_conf)
            else:
                logger.debug("row y=%d name fast-path MISS: %r conf=%.2f", y, _fp_name, _fp_conf)
                name_data = pytesseract.image_to_data(
                    crop_2x,
                    config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                    output_type=Output.DICT,
                )
                name = _words_from_data(name_data, min_conf=10)
        else:
            name_data = pytesseract.image_to_data(
                crop_2x,
                config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                output_type=Output.DICT,
            )
            name = _words_from_data(name_data, min_conf=10)
        if len(name) < 2:
            # Event-2 layout: name sits ~15px lower — use wider crop
            ny1w, ny2w = _NAME_Y_OFF_WIDE
            name_y_off_used = _NAME_Y_OFF_WIDE
            crop_w = row_img[ny1w:ny2w, _NAME_X[0] : _NAME_X[1]]
            crop_w2x = cv2.resize(crop_w, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
            name_data = pytesseract.image_to_data(
                crop_w2x,
                config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                output_type=Output.DICT,
            )
            name = _words_from_data(name_data, min_conf=10)

        # Last resort for low-contrast names: some coloured names (e.g. green R3 text)
        # appear as medium gray (~121) after the standard grayscale+inversion preprocess
        # instead of near-black (~0). Tesseract sees no text at all in that case.
        # Stretching the crop to [0, 255] restores the contrast and fixes detection.
        if len(name) < 2:
            norm_crop = cv2.normalize(crop_2x, None, 0, 255, cv2.NORM_MINMAX)  # type: ignore[call-overload]
            name_data = pytesseract.image_to_data(
                norm_crop,
                config="--psm 7 -l eng+rus+jpn+chi_sim+vie+kor",
                output_type=Output.DICT,
            )
            name = _words_from_data(name_data, min_conf=10)

        # Cyrillic-lookalike disambiguation — name AND name_data viennent de la
        # passe gagnante, pour que la confiance calculée plus bas (et donc le
        # déclenchement du fallback LLM) reflète le nom réellement retourné.
        name, name_data = disambiguate_cyrillic(crop_2x, name, name_data)
        name = normalize_name(name)

        raw_name = name

        # Strip power value from name tail when the name crop overlaps the
        # power column and the multilingual OCR reads both on the same line.
        # Robust to comma/period/apostrophe variants the OCR introduces (e.g.
        # 'Ye'9519.244' or 'Ye12893,651' where the punctuation between digits
        # is wrong) — we match any trailing run of digits ≥ 1M, regardless
        # of separators.
        name, stripped_power = _strip_trailing_power_digits(name)
        # Belt-and-braces: when the digit run was shorter than 7 chars but
        # exactly matches the detected power, still strip it.
        if not stripped_power and power is not None and name:
            power_formatted = f"{power:,}"
            if name.endswith(power_formatted):
                name = name[: -len(power_formatted)].rstrip(" \t.,'\"`-_")
                stripped_power = True
            elif name.endswith(str(power)):
                name = name[: -len(str(power))].rstrip(" \t.,'\"`-_")
                stripped_power = True

        mean_name_conf = _mean_word_conf(name_data, min_conf=10)
        logger.debug(
            "row y=%d name OCR: raw=%r mean_conf=%.1f stripped_power=%s final=%r power=%s rank=%s",
            y,
            raw_name,
            mean_name_conf,
            stripped_power,
            name,
            power,
            rank,
        )

        if power is None and not name:
            return None

        # Include "-" in the whitelist so Tesseract returns it when the cell
        # shows the non-participant marker instead of a score.
        pts_data = pytesseract.image_to_data(
            image[y : y + row_h, _POINTS_X[0] : _POINTS_X[1]],
            config="--psm 6 -c tessedit_char_whitelist=0123456789,-",
            output_type=Output.DICT,
        )
        # Distinguish participation from absence:
        #   "--"  → non-participant (explicit dash marker, any confidence ≥ 10)
        #   empty → non-participant (game shows "--" but OCR confidence too low to
        #           meet min_conf=10; a genuine "0" always renders as a legible digit)
        #   "0"   → participant who scored 0 (legible, parse_number returns 0)
        #   "N"   → participant who scored N points
        # In all non-participant cases points stays None; the row is still returned
        # so the player is tracked in at_players / at_alliance_memberships.
        raw_pts = _words_from_data(pts_data, min_conf=10)
        if raw_pts and re.match(r"^-+$", raw_pts):
            points: int | None = None
        else:
            points = parse_number(_words_from_data(pts_data, min_conf=20).replace(",", ""))
            # parse_number returns None for empty/unparseable → treat as non-participant

        # Use name field only: numeric fields (pts) have high Tesseract confidence
        # and would dilute a low-confidence short name above the fallback threshold.
        # Filter must match what actually built `name` (_words_from_data above):
        # same min_conf=10, and only words with non-empty text -- a >=0 filter
        # with no text check let empty-text boxes with a "confident" score dilute
        # the average even though they contributed nothing to `name`.
        confs = [
            int(c)
            for t, c in zip(name_data["text"], name_data["conf"], strict=False)
            if t.strip() and str(c).lstrip("-").isdigit() and int(c) >= 10
        ]
        confidence = sum(confs) / (len(confs) * 100) if confs else 0.0

        trace: RowTrace | None = None
        if emit_trace:
            ny1u, ny2u = name_y_off_used
            trace = RowTrace(
                list_top=list_top,
                row_index=row_index,
                row_height=row_h,
                name=FieldBox(y1=y + ny1u, y2=y + ny2u, x1=_NAME_X[0], x2=_NAME_X[1]),
                rank=FieldBox(
                    y1=y + _RANK_BADGE_Y[0],
                    y2=y + _RANK_BADGE_Y[1],
                    x1=_RANK_BADGE_X[0],
                    x2=_RANK_BADGE_X[1],
                ),
                # Power: record the primary PSM-11 sweep region (full-row strip
                # left of the points column). The sword-icon mask is applied to
                # this strip before OCR; the trace box is the pre-mask extent.
                power=FieldBox(y1=y, y2=y + row_h, x1=0, x2=_POINTS_X[0]),
                points=FieldBox(y1=y, y2=y + row_h, x1=_POINTS_X[0], x2=_POINTS_X[1]),
            )

        return MemberResult(
            name=_fix_name_substitutions(name),
            rank=rank or "",
            power=power or 0,
            points=points,
            confidence=confidence,
            trace=trace,
            row_y=y,
            row_h=row_h,
        )

    # ── Power detection ───────────────────────────────────────────────────────

    def _detect_power(self, image: np.ndarray, y: int) -> int | None:
        """Detect power using PSM 11 full-row scan (x=260–560), with PSM 8 fallback."""
        h = image.shape[0]
        row_end = min(y + _ROW_HEIGHT, h)

        # Primary: PSM 11 sparse text on the left portion of the row only.
        # The points column starts at _POINTS_X[0]=720 and is excluded so that
        # events like Ironblood Battlefield (where scores exceed 1 M) don't
        # return a score value instead of the actual power.  The power column
        # sits well within x<720 on all observed layouts.
        data = pytesseract.image_to_data(
            image[y:row_end, : _POINTS_X[0]],
            config="--psm 11 -c tessedit_char_whitelist=0123456789,",
            output_type=Output.DICT,
        )
        for i, t in enumerate(data["text"]):
            t = t.strip()
            if not t:
                continue
            conf = int(data["conf"][i])
            if conf < 0:
                continue
            val = parse_number(t)
            if val is not None and val >= 1_000_000:
                return val

        # Fallback: PSM 8 on fixed crop — left margin widened to 100 to catch power
        # numbers whose leading digits start near x=120 on some layouts.
        py1 = y + 85
        py2 = y + 175
        data = pytesseract.image_to_data(
            image[py1:py2, 100:545],
            config="--psm 8 -c tessedit_char_whitelist=0123456789,",
            output_type=Output.DICT,
        )
        val = parse_number(_words_from_data(data, min_conf=0))
        if val is not None and val >= 1_000_000:
            return val

        # Normalized fallback: coloured power text (e.g. green R3) appears as medium
        # gray (~121) after the standard grayscale+inversion preprocess — same root
        # cause as the name detection failure for the same row. Stretching the power
        # crop to [0, 255] makes the digits legible. Use _POWER_X to skip the avatar
        # and the masked sword-icon area, both of which would corrupt normalization.
        power_crop = image[py1:py2, _POWER_X[0] : _POWER_X[1]]
        if power_crop.size > 0:
            norm_power = cv2.normalize(power_crop, None, 0, 255, cv2.NORM_MINMAX)  # type: ignore[call-overload]
            data = pytesseract.image_to_data(
                norm_power,
                config="--psm 11 -c tessedit_char_whitelist=0123456789,",
                output_type=Output.DICT,
            )
            for i, t in enumerate(data["text"]):
                t = t.strip()
                if not t:
                    continue
                if int(data["conf"][i]) < 0:
                    continue
                nval = parse_number(t)
                if nval is not None and nval >= 1_000_000:
                    return nval
        return None

    # ── Rank detection ────────────────────────────────────────────────────────

    def _detect_rank(
        self,
        image: np.ndarray,
        y: int,
        rank_cache: dict[str, tuple[int, int] | None] | None = None,
    ) -> str | None:
        """Detect R1–R5 badge via tight-crop OCR with empirical-order early exit.

        Delegates the actual OCR sweep to ``_detect_rank_from_crop`` and
        threads the per-image winning-combo cache through ``rank_cache``.
        Defaults to R1 when no strategy yields a hit — R1 is the
        statistically dominant rank (~57% of fixture rows) and an empty rank
        would otherwise cause validate_member() to drop the entire row.
        """
        h = image.shape[0]
        y1 = y + _RANK_BADGE_Y[0]
        y2 = y + _RANK_BADGE_Y[1]
        if y1 >= h or y2 > h:
            return None
        crop = image[y1:y2, _RANK_BADGE_X[0] : _RANK_BADGE_X[1]]
        if crop.size == 0:
            return None

        last = rank_cache["last"] if rank_cache is not None else None
        rank, winning_combo = _detect_rank_from_crop(crop, last_winning_combo=last)
        if rank_cache is not None and winning_combo is not None:
            rank_cache["last"] = winning_combo
        return rank
