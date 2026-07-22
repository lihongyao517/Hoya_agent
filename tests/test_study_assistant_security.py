from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest


ASSISTANT_ROOT = Path(__file__).resolve().parents[1] / "local_ai_study_assistant"
if str(ASSISTANT_ROOT) not in sys.path:
    sys.path.insert(0, str(ASSISTANT_ROOT))

from app import RequestBodyError, decode_upload_content, safe_web_path  # noqa: E402
from assistant.config import Settings  # noqa: E402


def test_safe_web_path_blocks_directory_traversal() -> None:
    web_root = ASSISTANT_ROOT / "web"

    assert safe_web_path(web_root, "static/styles.css") == (web_root / "static" / "styles.css").resolve()
    assert safe_web_path(web_root, "static/../../app.py") is None
    assert safe_web_path(web_root, "static/%2e%2e/%2e%2e/app.py") is None
    assert safe_web_path(web_root, "static\\..\\..\\app.py") is None


def test_settings_reject_non_positive_upload_limits(tmp_path: Path) -> None:
    with patch.dict("os.environ", {"LSA_MAX_UPLOAD_BYTES": "0"}, clear=False):
        with pytest.raises(ValueError, match="LSA_MAX_UPLOAD_BYTES"):
            Settings.load(tmp_path / ".env")


def test_read_json_rejects_oversized_requests() -> None:
    from app import read_json, settings

    class FakeHeaders:
        def get(self, _name: str, default: str = "0") -> str:
            return str(settings.max_request_bytes + 1)

    class FakeHandler:
        headers = FakeHeaders()

    with pytest.raises(RequestBodyError) as error:
        read_json(FakeHandler())  # type: ignore[arg-type]

    assert error.value.status == 413


def test_upload_decoding_uses_strict_base64_and_size_limits() -> None:
    with pytest.raises(Exception):
        decode_upload_content("not valid !", 100)

    encoded = "YWFh"
    assert decode_upload_content(encoded, 3) == b"aaa"
    with pytest.raises(RequestBodyError) as error:
        decode_upload_content(encoded, 2)
    assert error.value.status == 413
