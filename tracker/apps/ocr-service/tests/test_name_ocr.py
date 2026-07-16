"""Tests du module partagé de lecture des pseudos (app.parsers.name_ocr)."""

import unicodedata
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest

from app.parsers.name_ocr import (
    disambiguate_cyrillic,
    fix_name_substitutions,
    has_distinctive_cyrillic,
    mean_word_conf,
    normalize_name,
    words_from_data,
)

_OCR_DATA = "app.parsers.name_ocr.pytesseract.image_to_data"


def _data(words: list[tuple[int, str]], conf: int) -> dict[str, list[Any]]:
    """Dict image_to_data minimal : liste de (left, mot) + confiance uniforme."""
    return {
        "text": [w for _, w in words],
        "conf": [str(conf)] * len(words),
        "left": [left for left, _ in words],
    }


_CROP = np.zeros((10, 10), dtype=np.uint8)


# ── words_from_data / mean_word_conf ─────────────────────────────────────────


def test_words_from_data_sorts_by_x_and_joins_with_sep() -> None:
    data = _data([(50, "World"), (10, "Hello")], conf=90)
    assert words_from_data(data, min_conf=10) == "HelloWorld"
    assert words_from_data(data, min_conf=10, sep=" ") == "Hello World"


def test_words_from_data_filters_low_confidence() -> None:
    data = {
        "text": ["keep", "drop"],
        "conf": ["80", "5"],
        "left": [0, 10],
    }
    assert words_from_data(data, min_conf=10) == "keep"


def test_mean_word_conf() -> None:
    data = {"text": ["a", "b"], "conf": ["80", "40"], "left": [0, 1]}
    assert mean_word_conf(data, min_conf=10) == 60.0


# ── fix_name_substitutions ───────────────────────────────────────────────────


def test_fix_name_substitutions_restores_arrows() -> None:
    assert fix_name_substitutions("«= .AL3X. =>") == "←.AL3X.→"
    # La règle du « > » final ne retire pas l'espace intermédiaire.
    assert fix_name_substitutions("« Name >") == "←Name →"


def test_fix_name_substitutions_kanji_between_kana() -> None:
    assert fix_name_substitutions("お一しあ") == "おーしあ"
    # Le kanji isolé (pas entouré de kana) est conservé.
    assert fix_name_substitutions("一番") == "一番"


def test_fix_name_substitutions_collapses_cjk_spaces() -> None:
    # Tesseract sème des espaces entre glyphes CJK adjacents.
    assert fix_name_substitutions("中 本") == "中本"
    assert fix_name_substitutions("幸恵 丸 ポ ー タ ー") == "幸恵丸ポーター"
    # Un espace entouré d'au moins un caractère non-CJK est conservé
    # (pseudos à flèches, handles mixtes CJK+latin).
    assert fix_name_substitutions("焼鳥 Yakitori") == "焼鳥 Yakitori"
    assert fix_name_substitutions("← .AL3X. →") == "← .AL3X. →"


def test_fix_name_substitutions_collapses_spaces_around_underscore() -> None:
    # Tesseract renders a joining underscore with flanking spaces.
    assert fix_name_substitutions("The _ Hatter") == "The_Hatter"
    assert fix_name_substitutions("a_b") == "a_b"
    # A trailing/standalone underscore (no word char on one side) is untouched.
    assert fix_name_substitutions("Name _") == "Name _"


# ── disambiguate_cyrillic ────────────────────────────────────────────────────


def test_disambiguate_noop_for_plain_latin_name() -> None:
    original = _data([(0, "Alice")], conf=70)
    with patch(_OCR_DATA, side_effect=AssertionError("no OCR pass expected")):
        name, data = disambiguate_cyrillic(_CROP, "Alice", original)
    assert name == "Alice"
    assert data is original


def test_disambiguate_noop_for_majority_latin_name() -> None:
    # A stray ambiguous-Cyrillic glyph bled from the avatar ("Е") must NOT drag
    # a majority-Latin pseudo through the Russian re-OCR (which would return an
    # all-Cyrillic misread like "Мотоа").
    original = _data([(0, "Е (SOD) Momoa")], conf=70)
    with patch(_OCR_DATA, side_effect=AssertionError("no OCR pass expected")):
        name, data = disambiguate_cyrillic(_CROP, "Е (SOD) Momoa", original)
    assert name == "Е (SOD) Momoa"
    assert data is original


def test_disambiguate_noop_when_distinctive_cyrillic_present() -> None:
    original = _data([(0, "Аня")], conf=70)  # я est distinctif
    assert has_distinctive_cyrillic("Аня")
    with patch(_OCR_DATA, side_effect=AssertionError("no OCR pass expected")):
        name, data = disambiguate_cyrillic(_CROP, "Аня", original)
    assert name == "Аня"
    assert data is original


def test_disambiguate_rus_branch_returns_winning_pass_data() -> None:
    original = _data([(0, "АНА")], conf=30)  # sosies uniquement
    rus = _data([(0, "Аня")], conf=85)

    with patch(_OCR_DATA, return_value=rus) as mocked:
        name, data = disambiguate_cyrillic(_CROP, "АНА", original)

    assert name == "Аня"
    # La confiance recalculée en aval doit refléter la passe russe gagnante.
    assert data is rus
    assert mean_word_conf(data) == 85.0
    assert "-l rus" in mocked.call_args_list[0].kwargs.get(
        "config", mocked.call_args_list[0].args[1] if len(mocked.call_args_list[0].args) > 1 else ""
    )


def test_disambiguate_eng_branch_returns_winning_pass_data() -> None:
    original = _data([(0, "КАМНА_")], conf=30)
    rus = _data([(0, "КАМНА_")], conf=40)  # toujours pas de distinctif
    eng = _data([(0, "KANHA_")], conf=88)

    with patch(_OCR_DATA, side_effect=[rus, eng]):
        name, data = disambiguate_cyrillic(_CROP, "КАМНА_", original)

    assert name == "KANHA_"
    assert data is eng
    assert mean_word_conf(data) == 88.0


def test_disambiguate_keeps_original_when_eng_too_short() -> None:
    original = _data([(0, "КАМНА_")], conf=30)
    rus = _data([(0, "")], conf=0)
    eng = _data([(0, "K")], conf=90)  # trop court : len < len(original) - 1

    with patch(_OCR_DATA, side_effect=[rus, eng]):
        name, data = disambiguate_cyrillic(_CROP, "КАМНА_", original)

    assert name == "КАМНА_"
    assert data is original


# ── normalize_name ────────────────────────────────────────────────────────────
#
# Vecteurs issus des corruptions réellement observées, catalogués dans
# docs/maintenance/0014-player-duplicates-merge.md.


@pytest.mark.parametrize(
    "raw,expected",
    [
        # Mojibake latin-1/UTF-8
        ("MjÃ¶lnir", "Mjölnir"),
        ("BigÂ§teelCurtain", "Big§teelCurtain"),
        ("Ð¡ÐºÐ°Ð·ÐºÐ°", "Сказка"),
        ("DuyMáº¯tTheo", "DuyMắtTheo"),
        # Pleine chasse → ASCII (repli aussi la parenthèse, indispensable pour
        # _ALLIANCE_TAG_RE côté contribution_ranking)
        ("ï¼ˆLOLï¼‰CHIANTI", "(LOL)CHIANTI"),
        ("ＶＩＰ", "VIP"),
        # Zero-width supprimé, espaces multiples repliés, trim
        ("a​b", "ab"),
        ("a‌b‍", "ab"),
        ("﻿Name", "Name"),
        ("  Name   With   Spaces  ", "Name With Spaces"),
        # Pseudos légitimes non altérés
        ("← .AL3X. →", "← .AL3X. →"),
        ("おーしあ", "おーしあ"),
        ("Дмитрий", "Дмитрий"),
        ("§", "§"),
    ],
)
def test_normalize_name(raw: str, expected: str) -> None:
    assert normalize_name(raw) == expected


def test_normalize_name_nfd_to_nfc() -> None:
    decomposed = unicodedata.normalize("NFD", "é")  # 'e' + combining acute
    assert decomposed != "é"
    assert normalize_name(decomposed) == "é"
    assert normalize_name(decomposed) == unicodedata.normalize("NFC", decomposed)


@pytest.mark.parametrize(
    "raw",
    [
        "MjÃ¶lnir",
        "ï¼ˆLOLï¼‰CHIANTI",
        "BigÂ§teelCurtain",
        "Ð¡ÐºÐ°Ð·ÐºÐ°",
        "DuyMáº¯tTheo",
        "ＶＩＰ",
        "a​b",
        "← .AL3X. →",
        "おーしあ",
        "Дмитрий",
    ],
)
def test_normalize_name_idempotent(raw: str) -> None:
    once = normalize_name(raw)
    assert normalize_name(once) == once
