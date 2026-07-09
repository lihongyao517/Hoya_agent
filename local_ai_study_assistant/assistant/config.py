from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8008
    api_key: str = ""
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"
    max_context_chars: int = 6000

    @classmethod
    def load(cls, env_path: Path) -> "Settings":
        load_dotenv(env_path)
        return cls(
            host=os.getenv("LSA_HOST", "127.0.0.1"),
            port=int(os.getenv("LSA_PORT", "8008")),
            api_key=os.getenv("LSA_API_KEY", os.getenv("OPENAI_API_KEY", "")),
            base_url=os.getenv("LSA_BASE_URL", os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")),
            model=os.getenv("LSA_MODEL", os.getenv("OPENAI_MODEL", "gpt-4o-mini")),
            max_context_chars=int(os.getenv("LSA_MAX_CONTEXT_CHARS", "6000")),
        )
