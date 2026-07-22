from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from hoya_agent.qq_bridge import QQBridgeConfig, read_json


def _minimum_bridge_env() -> dict[str, str]:
    return {
        "HOYA_QQ_WEBHOOK_TOKEN": "strong-test-token",
        "HOYA_QQ_ALLOWED_USERS": "123456",
        "HOYA_QQ_ONEBOT_API_URL": "http://127.0.0.1:3000",
    }


def test_qq_bridge_rejects_unbounded_message_configuration() -> None:
    values = {**_minimum_bridge_env(), "HOYA_QQ_MAX_MESSAGE_CHARS": "20001"}
    with patch.dict(os.environ, values, clear=True):
        with pytest.raises(ValueError, match="MAX_MESSAGE_CHARS"):
            QQBridgeConfig.from_env()


def test_qq_bridge_read_json_rejects_invalid_content_length() -> None:
    class Headers:
        def __init__(self, value: str) -> None:
            self.value = value

        def get(self, _name: str, default: str = "0") -> str:
            return self.value or default

    class Handler:
        def __init__(self, value: str) -> None:
            self.headers = Headers(value)

    for value in ["abc", "-1"]:
        with pytest.raises(ValueError):
            read_json(Handler(value), 4000)  # type: ignore[arg-type]
