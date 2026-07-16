"""Tests for llm_fallback.py keep_alive handling and empty-response retry."""

from unittest.mock import MagicMock, patch

import numpy as np

from app.llm_fallback import (
    _resize_for_llm,
    llm_fallback,
    llm_fallback_player_stats,
)


def _fake_image() -> np.ndarray:
    """Create a dummy grayscale image for testing."""
    return np.zeros((225, 1080), dtype=np.uint8)


_DEFAULT_RESPONSE = '{"name": "Test"}'


def _mock_response(response_text: str = _DEFAULT_RESPONSE) -> MagicMock:
    """Create a mock httpx response."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {
        "response": response_text,
        "thinking": "",
        "done_reason": "stop",
        "prompt_eval_count": 10,
        "eval_count": 50,
        "eval_duration": 1_000_000_000,
    }
    return mock_resp


class TestKeepAlive:
    """Test suite for keep_alive parameter in Ollama requests."""

    def test_keep_alive_present_in_payload(self) -> None:
        """Verify keep_alive key is included in the request payload."""
        with patch("httpx.post") as mock_post:
            mock_post.return_value = _mock_response()
            llm_fallback(_fake_image())

            payload = mock_post.call_args.kwargs.get("json", {})
            assert "keep_alive" in payload, "keep_alive key must be present in payload"

    def test_keep_alive_default_30m(self) -> None:
        """Default keep_alive is '30m' when OLLAMA_KEEP_ALIVE is not set."""
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("OLLAMA_KEEP_ALIVE", None)

            with patch("httpx.post") as mock_post:
                mock_post.return_value = _mock_response()
                llm_fallback(_fake_image())

                payload = mock_post.call_args.kwargs.get("json", {})
                assert payload["keep_alive"] == "30m", "Default should be '30m'"

    def test_keep_alive_minus_one_as_int(self) -> None:
        """OLLAMA_KEEP_ALIVE=-1 should be converted to integer -1."""
        with patch.dict("os.environ", {"OLLAMA_KEEP_ALIVE": "-1"}, clear=False):
            with patch("httpx.post") as mock_post:
                mock_post.return_value = _mock_response()
                llm_fallback(_fake_image())

                payload = mock_post.call_args.kwargs.get("json", {})
                assert payload["keep_alive"] == -1
                assert isinstance(payload["keep_alive"], int)

    def test_keep_alive_duration_string(self) -> None:
        """OLLAMA_KEEP_ALIVE=1h should be passed as string '1h'."""
        with patch.dict("os.environ", {"OLLAMA_KEEP_ALIVE": "1h"}, clear=False):
            with patch("httpx.post") as mock_post:
                mock_post.return_value = _mock_response()
                llm_fallback(_fake_image())

                payload = mock_post.call_args.kwargs.get("json", {})
                assert payload["keep_alive"] == "1h"
                assert isinstance(payload["keep_alive"], str)

    def test_keep_alive_zero_as_int(self) -> None:
        """OLLAMA_KEEP_ALIVE=0 should be converted to integer 0."""
        with patch.dict("os.environ", {"OLLAMA_KEEP_ALIVE": "0"}, clear=False):
            with patch("httpx.post") as mock_post:
                mock_post.return_value = _mock_response()
                llm_fallback(_fake_image())

                payload = mock_post.call_args.kwargs.get("json", {})
                assert payload["keep_alive"] == 0
                assert isinstance(payload["keep_alive"], int)

    def test_keep_alive_numeric_seconds(self) -> None:
        """OLLAMA_KEEP_ALIVE=600 should be converted to integer 600."""
        with patch.dict("os.environ", {"OLLAMA_KEEP_ALIVE": "600"}, clear=False):
            with patch("httpx.post") as mock_post:
                mock_post.return_value = _mock_response()
                llm_fallback(_fake_image())

                payload = mock_post.call_args.kwargs.get("json", {})
                assert payload["keep_alive"] == 600
                assert isinstance(payload["keep_alive"], int)

    def test_default_moondream_payload_omits_think_controls(self) -> None:
        """The default moondream setup should not send qwen-specific controls."""
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("OLLAMA_MODEL", None)
            os.environ.pop("OLLAMA_THINK", None)

            with patch("httpx.post") as mock_post:
                mock_post.return_value = _mock_response()
                llm_fallback(_fake_image())

                payload = mock_post.call_args.kwargs.get("json", {})
                assert payload["model"] == "moondream"
                assert "think" not in payload
                assert "/no_think" not in payload["prompt"]

    def test_moondream_uses_json_format(self) -> None:
        """moondream payload must include format=json to avoid empty EOS responses."""
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("OLLAMA_MODEL", None)

            with patch("httpx.post") as mock_post:
                mock_post.return_value = _mock_response()
                llm_fallback(_fake_image())

                payload = mock_post.call_args.kwargs.get("json", {})
                assert payload.get("format") == "json"

    def test_moondream_uses_simple_prompt(self) -> None:
        """moondream must use the simplified prompt, not the full JSON-template prompt."""
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("OLLAMA_MODEL", None)

            with patch("httpx.post") as mock_post:
                mock_post.return_value = _mock_response()
                llm_fallback(_fake_image())

                payload = mock_post.call_args.kwargs.get("json", {})
                assert '{"name": "string"' not in payload["prompt"]
                assert "JSON object" in payload["prompt"]

    def test_non_moondream_omits_json_format(self) -> None:
        """Non-moondream models must not receive format=json."""
        with patch.dict("os.environ", {"OLLAMA_MODEL": "llava:7b"}, clear=False):
            with patch("httpx.post") as mock_post:
                mock_post.return_value = _mock_response()
                llm_fallback(_fake_image())

                payload = mock_post.call_args.kwargs.get("json", {})
                assert "format" not in payload

    def test_qwen_payload_keeps_think_controls(self) -> None:
        """Thinking-capable models still receive the compatibility controls."""
        with patch.dict(
            "os.environ",
            {"OLLAMA_MODEL": "qwen3-vl:2b", "OLLAMA_THINK": "false"},
            clear=False,
        ):
            with patch("httpx.post") as mock_post:
                mock_post.return_value = _mock_response()
                llm_fallback(_fake_image())

                payload = mock_post.call_args.kwargs.get("json", {})
                assert payload["think"] is False
                assert payload["prompt"].endswith("/no_think")


def _empty_length_response(eval_count: int = 600, thinking_text: str = "") -> MagicMock:
    """Mock response where the model consumed the entire num_predict budget."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {
        "response": "",
        "thinking": thinking_text,
        "done_reason": "length",
        "prompt_eval_count": 320,
        "eval_count": eval_count,
        "eval_duration": 47_000_000_000,
    }
    return mock_resp


class TestEmptyResponseRetry:
    """Retry logic when a model exhausts num_predict before visible output."""

    def test_retries_with_doubled_num_predict_on_empty_length(self) -> None:
        """First call returns empty+length, second succeeds -> two HTTP calls made."""
        with patch.dict(
            "os.environ",
            {"OLLAMA_MODEL": "qwen3-vl:2b", "OLLAMA_NUM_PREDICT": "600"},
            clear=False,
        ):
            with patch("httpx.post") as mock_post:
                mock_post.side_effect = [
                    _empty_length_response(thinking_text="hidden chain of thought"),
                    _mock_response(),
                ]
                result = llm_fallback(_fake_image())

        assert result == "Test"
        assert mock_post.call_count == 2
        first_num_predict = mock_post.call_args_list[0].kwargs["json"]["options"]["num_predict"]
        second_num_predict = mock_post.call_args_list[1].kwargs["json"]["options"]["num_predict"]
        assert first_num_predict == 600
        assert second_num_predict == 1200

    def test_raises_after_exhausting_max_multiplier(self) -> None:
        """Raises ValueError once num_predict hits the cap and response is still empty."""
        with patch.dict("os.environ", {"OLLAMA_NUM_PREDICT": "600"}, clear=False):
            with patch("httpx.post") as mock_post:
                mock_post.return_value = _empty_length_response()
                import pytest

                with pytest.raises(ValueError, match="empty response"):
                    llm_fallback(_fake_image())

        assert mock_post.call_count == 3

    def test_no_retry_when_done_reason_is_not_length(self) -> None:
        """Empty response with done_reason != 'length' raises immediately without retry."""
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {
            "response": "",
            "thinking": "",
            "done_reason": "stop",
            "prompt_eval_count": 10,
            "eval_count": 5,
            "eval_duration": 1_000_000,
        }
        with patch("httpx.post") as mock_post:
            mock_post.return_value = mock_resp
            import pytest

            with pytest.raises(ValueError, match="empty response"):
                llm_fallback(_fake_image())

        assert mock_post.call_count == 1


class TestResizeForLlm:
    """_resize_for_llm scales down only when a bound is exceeded, keeping aspect."""

    def test_no_resize_when_within_bounds(self) -> None:
        """An image already under both caps is returned untouched (same object)."""
        img = np.zeros((100, 200, 3), dtype=np.uint8)
        out = _resize_for_llm(img, max_width=720, max_height=960)
        assert out is img

    def test_downscale_on_width_preserves_aspect(self) -> None:
        img = np.zeros((400, 1080, 3), dtype=np.uint8)
        out = _resize_for_llm(img, max_width=720)
        h, w = out.shape[:2]
        assert w == 720
        # 400 * (720/1080) = 266.67 -> int() truncates to 266
        assert h == int(400 * (720 / 1080))

    def test_downscale_on_height_cap(self) -> None:
        """Height cap binds when it is the tighter constraint."""
        img = np.zeros((1600, 720, 3), dtype=np.uint8)
        out = _resize_for_llm(img, max_width=720, max_height=960)
        h, w = out.shape[:2]
        assert h == 960
        assert w == int(720 * (960 / 1600))

    def test_tightest_constraint_wins(self) -> None:
        """When both caps bind, the smaller scale factor is applied to both dims."""
        img = np.zeros((2400, 1080, 3), dtype=np.uint8)
        out = _resize_for_llm(img, max_width=720, max_height=960)
        h, w = out.shape[:2]
        # width scale = 720/1080 = 0.667, height scale = 960/2400 = 0.4 -> 0.4 wins
        assert h == 960
        assert w == int(1080 * 0.4)


def _player_stats_response(payload_json: str) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {
        "response": payload_json,
        "thinking": "",
        "done_reason": "stop",
        "prompt_eval_count": 10,
        "eval_count": 50,
        "eval_duration": 1_000_000_000,
    }
    return mock_resp


class TestLlmFallbackPlayerStats:
    """Full-image player_stats extraction: shape handling and coercion."""

    def test_parses_members_object(self) -> None:
        body = (
            '{"members": [{"name": "Alice", "attack_pct": 412, "hp_pct": 1183, '
            '"defense_pct": null}]}'
        )
        with patch("httpx.post") as mock_post:
            mock_post.return_value = _player_stats_response(body)
            members = llm_fallback_player_stats(np.zeros((1600, 720, 3), dtype=np.uint8))

        assert members == [
            {"name": "Alice", "attack_pct": 412.0, "hp_pct": 1183.0, "defense_pct": None}
        ]

    def test_numeric_string_stats_are_coerced_to_float(self) -> None:
        """String-typed numbers from the model are coerced; junk becomes None."""
        body = (
            '{"members": [{"name": "Bob", "attack_pct": "300", "hp_pct": "n/a", '
            '"defense_pct": 250}]}'
        )
        with patch("httpx.post") as mock_post:
            mock_post.return_value = _player_stats_response(body)
            members = llm_fallback_player_stats(np.zeros((800, 720, 3), dtype=np.uint8))

        assert members is not None
        assert members[0]["attack_pct"] == 300.0  # numeric string coerced
        assert members[0]["hp_pct"] is None  # unparseable string -> None
        assert members[0]["defense_pct"] == 250.0

    def test_skips_entries_without_usable_name(self) -> None:
        body = (
            '{"members": [{"name": "", "attack_pct": 1}, {"attack_pct": 2}, '
            '{"name": "  Carol  ", "attack_pct": 3}]}'
        )
        with patch("httpx.post") as mock_post:
            mock_post.return_value = _player_stats_response(body)
            members = llm_fallback_player_stats(np.zeros((800, 720, 3), dtype=np.uint8))

        assert members == [
            {"name": "Carol", "attack_pct": 3.0, "hp_pct": None, "defense_pct": None}
        ]

    def test_unexpected_shape_returns_none(self) -> None:
        with patch("httpx.post") as mock_post:
            mock_post.return_value = _player_stats_response('{"foo": "bar"}')
            assert llm_fallback_player_stats(np.zeros((800, 720, 3), dtype=np.uint8)) is None

    def test_downscales_large_image_before_encoding(self) -> None:
        """A 1080-wide screenshot is capped to the player-stats max width."""
        with patch("httpx.post") as mock_post:
            mock_post.return_value = _player_stats_response('{"members": []}')
            with patch("app.llm_fallback._encode_image", return_value="x") as mock_enc:
                llm_fallback_player_stats(np.zeros((2400, 1080, 3), dtype=np.uint8))

        sent = mock_enc.call_args.args[0]
        assert sent.shape[1] <= 720
        assert sent.shape[0] <= 960
