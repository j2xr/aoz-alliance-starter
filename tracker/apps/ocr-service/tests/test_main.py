from unittest.mock import patch

import cv2
import numpy as np
from fastapi.testclient import TestClient

from app.dispatcher import UnknownEventError
from app.main import app
from app.parsers.base import MemberResult, ParseResult


def _make_png() -> bytes:
    img = np.zeros((10, 10, 3), dtype=np.uint8)
    _, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def test_health() -> None:
    with TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "tesseract": True, "db": True}


def test_health_degraded_when_tesseract_fails() -> None:
    with patch("app.main.health_check", return_value=False), TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["tesseract"] is False
    assert body["db"] is True


def test_health_degraded_when_db_fails() -> None:
    with TestClient(app) as client, patch("app.main._db") as mock_db:
        mock_db.execute.side_effect = RuntimeError("db closed")
        resp = client.get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["tesseract"] is True
    assert body["db"] is False


def test_extract_rejects_non_image() -> None:
    with TestClient(app) as client:
        resp = client.post("/extract", files={"file": ("test.txt", b"hello", "text/plain")})
    assert resp.status_code == 400


def test_extract_returns_job_id_and_polling_yields_result() -> None:
    mock_result = ParseResult(
        event_type="polar_invasion",
        event_datetime="2026-04-07T15:00",
        alliance_rank=1,
        total_battlers=43,
        total_points=21_955,
        members=[
            MemberResult(
                name="Yuyuyu325",
                rank="R2",
                power=15_103_026,
                points=9_065,
                confidence=0.94,
            )
        ],
    )

    with (
        patch("app.main.preprocess_image") as mock_pre,
        patch("app.main.extract") as mock_ext,
        TestClient(app) as client,
    ):
        mock_pre.return_value = np.zeros((100, 100), dtype=np.uint8)
        mock_ext.return_value = mock_result

        resp = client.post(
            "/extract",
            files={"file": ("screenshot.png", _make_png(), "image/png")},
        )
        assert resp.status_code == 202
        job_id = resp.json()["job_id"]
        assert resp.json()["status"] == "pending"

        # TestClient runs background tasks synchronously after the response,
        # so a follow-up GET sees the terminal state immediately.
        poll = client.get(f"/jobs/{job_id}")

    assert poll.status_code == 200
    body = poll.json()
    assert body["status"] == "done"
    assert body["result"]["event_type"] == "polar_invasion"
    assert body["result"]["members"][0]["name"] == "Yuyuyu325"


def test_get_job_unknown_returns_404() -> None:
    with TestClient(app) as client:
        resp = client.get("/jobs/does-not-exist")
    assert resp.status_code == 404


def test_extract_unknown_event_surfaces_via_job() -> None:
    with (
        patch("app.main.preprocess_image") as mock_pre,
        patch("app.main.extract", side_effect=UnknownEventError("unknown_event")),
        TestClient(app) as client,
    ):
        mock_pre.return_value = np.zeros((100, 100), dtype=np.uint8)
        resp = client.post(
            "/extract",
            files={"file": ("screenshot.png", _make_png(), "image/png")},
        )
        job_id = resp.json()["job_id"]
        poll = client.get(f"/jobs/{job_id}")

    assert poll.status_code == 200
    body = poll.json()
    assert body["status"] == "error"
    assert body["error"] == "unknown_event"


def test_extract_internal_error_surfaces_via_job() -> None:
    with (
        patch("app.main.preprocess_image", side_effect=RuntimeError("boom")),
        TestClient(app) as client,
    ):
        resp = client.post(
            "/extract",
            files={"file": ("screenshot.png", _make_png(), "image/png")},
        )
        job_id = resp.json()["job_id"]
        poll = client.get(f"/jobs/{job_id}")

    assert poll.status_code == 200
    body = poll.json()
    assert body["status"] == "error"
    assert body["error"] == "internal_error"
    assert "boom" in body["detail"]


def test_get_job_terminal_state_survives_repeat_reads() -> None:
    """A second GET on a terminal job still returns the result, not 404 — a
    dropped bot connection or poll retry must be able to re-read it."""
    mock_result = ParseResult(event_type="polar_invasion")
    with (
        patch("app.main.preprocess_image") as mock_pre,
        patch("app.main.extract", return_value=mock_result),
        TestClient(app) as client,
    ):
        mock_pre.return_value = np.zeros((100, 100), dtype=np.uint8)
        resp = client.post(
            "/extract",
            files={"file": ("screenshot.png", _make_png(), "image/png")},
        )
        job_id = resp.json()["job_id"]
        first = client.get(f"/jobs/{job_id}")
        second = client.get(f"/jobs/{job_id}")

    assert first.status_code == 200
    assert first.json()["status"] == "done"
    assert second.status_code == 200
    assert second.json()["status"] == "done"
    assert second.json()["result"] == first.json()["result"]
