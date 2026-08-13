"""Tests for vision_fallback.py: row parsing, the API call, quota cap, key handling."""

import json
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

import app.vision_fallback as vf
from app.vision_fallback import (
    _parse_row,
    vision_enabled,
    vision_fallback,
    vision_fallback_donation,
)


def _img() -> np.ndarray:
    return np.zeros((175, 1080), dtype=np.uint8)


def _mock_response(text: str) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {"responses": [{"fullTextAnnotation": {"text": text}}]}
    return resp


def _mock_error(message: str) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {"responses": [{"error": {"message": message}}]}
    return resp


# ── vision_enabled ─────────────────────────────────────────────────────────────


def test_disabled_by_default() -> None:
    with patch.dict("os.environ", {}, clear=True):
        assert vision_enabled() is False


def test_enabled_when_true() -> None:
    with patch.dict("os.environ", {"OCR_VISION_FALLBACK_ENABLED": "true"}):
        assert vision_enabled() is True


# ── _parse_row: the layout Vision returns is rank / R-badge / (TAG) name / score ──


def test_parse_donation_name_and_score() -> None:
    name, score = _parse_row("121\nR1\n(SOD) Аня\n8483")
    assert name == "Аня"
    assert score == 8483


def test_parse_strips_leading_tag_keeps_decoration() -> None:
    name, _ = _parse_row("3\nR4\n(SOD) .AL3X. →\n8392")
    assert name == ".AL3X. →"


def test_parse_event_name_no_tag() -> None:
    name, score = _parse_row("R4\n[VI\njasmin\n13,522,685")
    assert name == "jasmin"
    assert score == 13522685  # power line; event path ignores it


def test_parse_homoglyph_recovered() -> None:
    name, _ = _parse_row("12\nR4\n(SOD) Mjölnir\n5532")
    assert name == "Mjölnir"


def test_parse_empty_text_is_none() -> None:
    assert _parse_row("") == (None, None)


# ── the API call ────────────────────────────────────────────────────────────────


@pytest.fixture
def _quota_tmp(tmp_path):  # type: ignore[no-untyped-def]
    """Point the usage counter at a writable temp file and raise the cap."""
    with (
        patch.object(vf, "_USAGE_FILE", str(tmp_path / "usage.json")),
        patch.object(vf, "_MONTHLY_UNIT_CAP", 1000),
        patch.dict("os.environ", {"OCR_VISION_API_KEY": "test-key"}),
    ):
        yield tmp_path


def test_donation_call_returns_name_and_score(_quota_tmp) -> None:  # type: ignore[no-untyped-def]
    with patch("httpx.post", return_value=_mock_response("121\nR1\n(SOD) Аня\n8483")) as post:
        name, score = vision_fallback_donation(_img())
    assert (name, score) == ("Аня", 8483)
    # 1 unit: exactly one TEXT_DETECTION feature.
    feats = post.call_args.kwargs["json"]["requests"][0]["features"]
    assert feats == [{"type": "TEXT_DETECTION"}]


def test_event_call_returns_name(_quota_tmp) -> None:  # type: ignore[no-untyped-def]
    with patch("httpx.post", return_value=_mock_response("R2\nAdaline\n9598400")):
        assert vision_fallback(_img()) == "Adaline"


def test_api_error_raises(_quota_tmp) -> None:  # type: ignore[no-untyped-def]
    with patch("httpx.post", return_value=_mock_error("bad image")):
        with pytest.raises(RuntimeError, match="Cloud Vision API error"):
            vision_fallback(_img())


def test_missing_key_raises(tmp_path) -> None:  # type: ignore[no-untyped-def]
    with patch.dict("os.environ", {}, clear=True), patch("httpx.post") as post:
        with pytest.raises(RuntimeError, match="no key"):
            vision_fallback(_img())
    post.assert_not_called()  # never leaves the box without a key


def test_quota_cap_blocks_call(tmp_path) -> None:  # type: ignore[no-untyped-def]
    usage = tmp_path / "usage.json"
    usage.write_text(json.dumps({"month": vf._month_key(), "units": 5}))
    with (
        patch.object(vf, "_USAGE_FILE", str(usage)),
        patch.object(vf, "_MONTHLY_UNIT_CAP", 5),
        patch.dict("os.environ", {"OCR_VISION_API_KEY": "k"}),
        patch("httpx.post") as post,
    ):
        with pytest.raises(RuntimeError, match="monthly cap reached"):
            vision_fallback(_img())
    post.assert_not_called()  # capped before any egress


def test_quota_counts_up_and_resets_next_month(tmp_path) -> None:  # type: ignore[no-untyped-def]
    usage = tmp_path / "usage.json"
    # last month's count must not carry into this month
    usage.write_text(json.dumps({"month": "1999-01", "units": 999}))
    with (
        patch.object(vf, "_USAGE_FILE", str(usage)),
        patch.object(vf, "_MONTHLY_UNIT_CAP", 3),
        patch.dict("os.environ", {"OCR_VISION_API_KEY": "k"}),
        patch("httpx.post", return_value=_mock_response("R1\nBob\n10")),
    ):
        vision_fallback(_img())
    stored = json.loads(usage.read_text())
    assert stored["month"] == vf._month_key()
    assert stored["units"] == 1
