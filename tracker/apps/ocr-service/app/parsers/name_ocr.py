"""Helpers OCR partagés pour la lecture des pseudos.

Historiquement dupliqués entre ``polar_invasion_v1.py`` et
``contribution_ranking_v1.py`` (le second annonçait « reused verbatim » tout
en re-déclarant les fonctions, et les copies avaient divergé : séparateur de
jointure des mots et restauration des flèches). Source unique désormais ; le
séparateur est paramétrable (polar joint sans espace, contribution avec
espace).
"""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any

import ftfy
import numpy as np

from app import tess_engine as pytesseract
from app.tess_engine import Output

logger = logging.getLogger(__name__)

# Fullwidth ASCII variants (U+FF01–FF5E) → their ASCII counterparts
# (U+0021–007E), plus the ideographic space (U+3000) → regular space.
# Not a full NFKC (too aggressive: it would also fold stylised pseudos like
# ligatures or circled letters into plain ASCII), just the printable-ASCII
# block that OCR emits for full-width punctuation/parentheses.
_FULLWIDTH_TO_ASCII: dict[int, int] = {cp: cp - 0xFEE0 for cp in range(0xFF01, 0xFF5F)}
_FULLWIDTH_TO_ASCII[0x3000] = 0x20

# Zero-width characters that carry no visual meaning in a pseudo: zero-width
# space/non-joiner/joiner (U+200B–200D) and the BOM/zero-width no-break space
# (U+FEFF) when it shows up mid-string.
_ZERO_WIDTH_RE = re.compile("[\u200b-\u200d\ufeff]")
_MULTI_SPACE_RE = re.compile(r" {2,}")


def normalize_name(name: str) -> str:
    """Normalise l'encodage d'un pseudo OCR pour tarir les doublons NFC/mojibake.

    Traite uniquement les classes de corruption d'*encodage* observées dans le
    runbook ``docs/maintenance/0014-player-duplicates-merge.md`` — les
    misreads OCR (rn→rl, chiffres parasites…) restent du ressort des alias et
    de ``/merge`` :

      * mojibake latin-1/UTF-8 (``MjÃ¶lnir`` → ``Mjölnir``,
        ``Ð¡ÐºÐ°Ð·ÐºÐ°`` → ``Сказка``) via ``ftfy.fix_encoding`` — pas
        ``fix_text``, qui toucherait aussi guillemets et sauts de ligne ;
      * formes composées/décomposées (NFD → NFC) ;
      * ponctuation pleine chasse → ASCII (``（LOL）`` → ``(LOL)``), pour que
        ``_ALLIANCE_TAG_RE`` reconnaisse le tag — pas de NFKC global, trop
        agressif pour des pseudos stylisés ;
      * caractères zero-width supprimés, espaces multiples repliés, trim.
    """
    name = ftfy.fix_encoding(name)
    name = unicodedata.normalize("NFC", name)
    name = name.translate(_FULLWIDTH_TO_ASCII)
    name = _ZERO_WIDTH_RE.sub("", name)
    name = _MULTI_SPACE_RE.sub(" ", name)
    return name.strip()


# Cyrillic letters whose glyph is identical to a Latin letter at the typical
# screenshot resolution. A name made entirely of these (plus ASCII) cannot be
# disambiguated from Latin by tesseract; when the multilingual model picks
# them, we re-OCR with `-l eng` to recover the real Latin spelling.
AMBIGUOUS_CYRILLIC = frozenset("АВЕКМНОРСТХаеорсух")


def has_distinctive_cyrillic(text: str) -> bool:
    """True when text contains a Cyrillic letter that is *not* a Latin lookalike.

    Used to decide whether a multilingual OCR pass that produced Cyrillic
    output reflects a genuine Russian pseudo (keep it) or a mis-classification
    of a Latin pseudo (re-OCR with eng).
    """
    for ch in text:
        if 0x0400 <= ord(ch) <= 0x04FF and ch not in AMBIGUOUS_CYRILLIC:
            return True
    return False


def is_kana(ch: str) -> bool:
    """True for hiragana (3040–309F) or katakana (30A0–30FF) code points."""
    cp = ord(ch)
    return 0x3040 <= cp <= 0x30FF


def is_cjk(ch: str) -> bool:
    """True for a CJK ideograph or kana glyph (the scripts Tesseract space-splits)."""
    cp = ord(ch)
    return (
        0x3040 <= cp <= 0x30FF  # hiragana + katakana (incl. ー U+30FC)
        or 0x3400 <= cp <= 0x4DBF  # CJK unified ext A
        or 0x4E00 <= cp <= 0x9FFF  # CJK unified ideographs
        or 0xF900 <= cp <= 0xFAFF  # CJK compatibility ideographs
    )


def _collapse_cjk_spaces(name: str) -> str:
    """Drop spaces Tesseract sprinkles *between* adjacent CJK glyphs.

    ``中本`` comes back as ``中 本`` and ``幸恵丸ポーター`` as ``幸恵 丸 ポ ー タ
    ー``. A space is removed only when the characters on both sides are CJK, so
    pseudos with legitimate spaces (arrow names like ``← .AL3X. →``, or mixed
    ``焼鳥 Yakitori``-style handles) keep them.
    """
    if " " not in name:
        return name
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch == " " and 0 < i < len(name) - 1 and is_cjk(name[i - 1]) and is_cjk(name[i + 1]):
            continue
        out.append(ch)
    return "".join(out)


def fix_name_substitutions(name: str) -> str:
    """Apply post-OCR character corrections for known Tesseract misreads on names.

    1. The kanji 一 (U+4E00, "one") is visually identical to katakana ー (U+30FC,
       prolongation mark). Tesseract often picks the kanji even when surrounded
       by kana — e.g. "おーしあ" → "お一しあ". When that 一 sits between hiragana
       or katakana characters, replace it with ー.

    2. Unicode arrows in pseudos are systematically misread because tesseract
       lacks ←/→ in its character set. ← (U+2190) becomes "«=" or "«-", and →
       (U+2192) becomes ">" or "=>". When these patterns sit at the start or
       end of a name we can confidently restore the arrows — they're too
       distinctive to appear in legitimate ASCII pseudos. (La migration 0014
       montre que ces pseudos à flèches apparaissent aussi sur les écrans de
       dons, d'où l'application des deux corrections aux deux parsers.)
    """
    # Arrow normalization: bracket-then-equals at start → left arrow,
    # equals-then-bracket at end → right arrow. Trim adjacent whitespace
    # since OCR often drops the space between arrow and the rest of the name.
    name = re.sub(r"^(?:«=|«-|<=|<<|«)\s*", "←", name)
    name = re.sub(r"\s*(?:=>|>>|=»|->|»)$", "→", name)
    # Once the leading arrow is restored, a bare ">" trailing the name is
    # almost certainly the matching right arrow — this pattern decorates many
    # in-game pseudos (e.g. "← .AL3X. →") and never appears organically.
    if name.startswith("←") and name.endswith(">"):
        name = name[:-1] + "→"

    if "一" in name:
        chars = list(name)
        for i, ch in enumerate(chars):
            if ch != "一":
                continue
            prev_kana = i > 0 and is_kana(chars[i - 1])
            next_kana = i + 1 < len(chars) and is_kana(chars[i + 1])
            if prev_kana or next_kana:
                chars[i] = "ー"
        name = "".join(chars)

    name = _collapse_cjk_spaces(name)

    # An underscore is a word-joiner in pseudos; Tesseract sometimes renders it
    # with flanking spaces ("The_Hatter" → "The _ Hatter"). Collapse those when
    # the underscore sits between two word characters, so a genuinely spaced
    # handle is left alone.
    name = re.sub(r"(?<=\w) *_ *(?=\w)", "_", name)

    return name


def words_from_data(data: dict[str, Any], min_conf: int = 20, *, sep: str = "") -> str:
    """Concatenate high-confidence words from image_to_data output (x-sorted)."""
    pairs: list[tuple[int, str]] = []
    for i, text in enumerate(data["text"]):
        text = text.strip()
        if text and int(data["conf"][i]) >= min_conf:
            pairs.append((data["left"][i], text))
    pairs.sort(key=lambda p: p[0])
    return sep.join(p[1] for p in pairs)


def mean_word_conf(data: dict[str, Any], min_conf: int = 10) -> float:
    """Mean confidence of words that survived the min_conf filter (0–100)."""
    confs = [int(c) for c in data["conf"] if str(c).lstrip("-").isdigit() and int(c) >= min_conf]
    return sum(confs) / len(confs) if confs else 0.0


def ocr_name_pass(
    crop: np.ndarray, lang: str, *, sep: str = "", min_conf: int = 10
) -> tuple[str, dict[str, Any]]:
    """Une passe OCR de nom : retourne (nom joint, dict image_to_data).

    Contrairement à ``image_to_string``, la passe expose ses confidences —
    l'appelant peut donc recalculer ``confidence`` depuis la passe gagnante.
    """
    data = pytesseract.image_to_data(crop, config=f"--psm 7 -l {lang}", output_type=Output.DICT)
    return words_from_data(data, min_conf=min_conf, sep=sep), data


def disambiguate_cyrillic(
    crop: np.ndarray, name: str, name_data: dict[str, Any], *, sep: str = ""
) -> tuple[str, dict[str, Any]]:
    """Désambiguïse un nom composé uniquement de sosies cyrilliques/latins.

    Deux cas quand la passe multilingue ne produit que des lettres cyrilliques
    identiques à des latines (А/Н/О/…) :
      1. Vrai pseudo russe dont les lettres distinctives ont été manquées
         (« Аня » → « АНА ») : une passe russe seule les retrouve souvent.
      2. Pseudo latin mal classé (« KANHA_ » → « КАМНА_ ») : repli sur une
         passe anglaise seule.

    Retourne (nom, data) de la passe GAGNANTE — historiquement le nom était
    remplacé via ``image_to_string`` mais ``name_data`` restait celui de la
    passe multilingue, et la confiance (donc le déclenchement du fallback LLM)
    était calculée sur des données périmées.

    Ne se déclenche que si le cyrillique *domine* le pseudo. Un pseudo latin
    avec un seul sosie cyrillique parasite (bave d'avatar « Е (SOD) Momoa », ou
    un « у » collé au tag) déclenchait à tort la passe russe, qui rendait alors
    un mot tout cyrillique (« Мотоа ») porteur d'une lettre distinctive issue
    d'un misread — écrasant le latin correct. Exiger la majorité cyrillique
    protège ce cas sans gêner « Аня » / « КАМНА_ » (100 % cyrillique).
    """
    cyrillic = sum(1 for c in name if 0x0400 <= ord(c) <= 0x04FF)
    latin = sum(1 for c in name if c.isascii() and c.isalpha())
    if not (name and cyrillic and cyrillic >= latin and not has_distinctive_cyrillic(name)):
        return name, name_data

    name_rus, data_rus = ocr_name_pass(crop, "rus", sep=sep)
    if name_rus and has_distinctive_cyrillic(name_rus):
        # Russian-only pass found distinctive Cyrillic → genuine Russian pseudo.
        return name_rus, data_rus

    name_eng, data_eng = ocr_name_pass(crop, "eng", sep=sep)
    if name_eng and len(name_eng) >= len(name) - 1:
        return name_eng, data_eng

    return name, name_data
