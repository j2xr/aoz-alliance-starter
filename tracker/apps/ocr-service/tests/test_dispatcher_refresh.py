"""Tests du chargement des alias de titres depuis Supabase (app.dispatcher)."""

from collections.abc import Iterator
from typing import Any

import httpx
import numpy as np
import pytest

from app import dispatcher


@pytest.fixture(autouse=True)
def _reset_patterns() -> Iterator[None]:
    yield
    dispatcher.reset_title_patterns()


def test_refresh_is_noop_without_supabase_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    assert dispatcher.refresh_title_patterns_from_supabase() is False


def _enable_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")


def test_refresh_loads_db_aliases_and_detection_uses_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_env(monkeypatch)

    class _Resp:
        def raise_for_status(self) -> None:
            pass

        def json(self) -> list[dict[str, Any]]:
            return [{"code": "new_event", "title_aliases": ["Brand New Event"]}]

    monkeypatch.setattr(dispatcher.httpx, "get", lambda *a, **k: _Resp())
    assert dispatcher.refresh_title_patterns_from_supabase() is True

    # An alias present only in the database must now be detected.
    monkeypatch.setattr(dispatcher, "_ocr_header", lambda image: "brand new event 2026-05-01")
    kind, code = dispatcher.detect_screen_kind(np.zeros((10, 10), dtype=np.uint8))
    assert (kind, code) == ("event", "new_event")


def test_refresh_keeps_fallback_on_empty_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_env(monkeypatch)

    class _Resp:
        def raise_for_status(self) -> None:
            pass

        def json(self) -> list[dict[str, Any]]:
            return [{"code": "polar_invasion", "title_aliases": []}]

    monkeypatch.setattr(dispatcher.httpx, "get", lambda *a, **k: _Resp())
    assert dispatcher.refresh_title_patterns_from_supabase() is False

    # The static fallback remains operational.
    monkeypatch.setattr(dispatcher, "_ocr_header", lambda image: "polar invasion 2026")
    kind, code = dispatcher.detect_screen_kind(np.zeros((10, 10), dtype=np.uint8))
    assert (kind, code) == ("event", "polar_invasion")


def test_refresh_propagates_network_error_for_lifespan_to_catch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_env(monkeypatch)

    def _boom(*a: Any, **k: Any) -> Any:
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(dispatcher.httpx, "get", _boom)
    with pytest.raises(httpx.ConnectError):
        dispatcher.refresh_title_patterns_from_supabase()

    # After the failure (swallowed by the lifespan), the fallback stays in place.
    monkeypatch.setattr(dispatcher, "_ocr_header", lambda image: "void war 2026")
    kind, code = dispatcher.detect_screen_kind(np.zeros((10, 10), dtype=np.uint8))
    assert (kind, code) == ("event", "void_war")
