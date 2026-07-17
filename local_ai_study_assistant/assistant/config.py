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


def env_bool(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip() == "1"


def env_int(name: str, default: str) -> int:
    value = os.getenv(name, default).strip()
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer.") from exc


def env_path(base_dir: Path, name: str, default: str) -> Path:
    raw = os.getenv(name, default).strip()
    path = Path(raw)
    if path.is_absolute():
        return path
    return base_dir / path


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8008
    api_key: str = ""
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"
    max_context_chars: int = 6000
    agent_tool_enabled: bool = True
    agent_max_question_chars: int = 2000
    agent_default_top_k: int = 5
    agent_max_top_k: int = 10
    payment_mode: str = "off"
    payment_price: str = "$0.001"
    payment_asset: str = "USDC"
    payment_network: str = "base-sepolia"
    payment_recipient: str = ""
    payment_resource: str = "/api/agent/ask"
    payment_mock_token: str = "dev-paid"
    payment_timeout_seconds: int = 30
    x402_verify_url: str = ""
    x402_api_key: str = ""
    usage_log_path: Path = Path("data/usage.jsonl")

    @classmethod
    def load(cls, env_path_value: Path) -> "Settings":
        load_dotenv(env_path_value)
        base_dir = env_path_value.parent
        payment_mode = os.getenv("LSA_PAYMENT_MODE", "off").strip().lower()
        if payment_mode not in {"off", "mock", "x402"}:
            raise ValueError("LSA_PAYMENT_MODE must be one of: off, mock, x402.")

        agent_default_top_k = env_int("LSA_AGENT_DEFAULT_TOP_K", "5")
        agent_max_top_k = env_int("LSA_AGENT_MAX_TOP_K", "10")
        if agent_max_top_k <= 0:
            raise ValueError("LSA_AGENT_MAX_TOP_K must be positive.")
        if agent_default_top_k <= 0:
            raise ValueError("LSA_AGENT_DEFAULT_TOP_K must be positive.")

        return cls(
            host=os.getenv("LSA_HOST", "127.0.0.1"),
            port=env_int("LSA_PORT", "8008"),
            api_key=os.getenv("LSA_API_KEY", os.getenv("OPENAI_API_KEY", "")),
            base_url=os.getenv("LSA_BASE_URL", os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")),
            model=os.getenv("LSA_MODEL", os.getenv("OPENAI_MODEL", "gpt-4o-mini")),
            max_context_chars=env_int("LSA_MAX_CONTEXT_CHARS", "6000"),
            agent_tool_enabled=env_bool("LSA_AGENT_TOOL_ENABLED", "1"),
            agent_max_question_chars=env_int("LSA_AGENT_MAX_QUESTION_CHARS", "2000"),
            agent_default_top_k=min(agent_default_top_k, agent_max_top_k),
            agent_max_top_k=agent_max_top_k,
            payment_mode=payment_mode,
            payment_price=os.getenv("LSA_PAYMENT_PRICE", "$0.001").strip(),
            payment_asset=os.getenv("LSA_PAYMENT_ASSET", "USDC").strip(),
            payment_network=os.getenv("LSA_PAYMENT_NETWORK", "base-sepolia").strip(),
            payment_recipient=os.getenv("LSA_PAYMENT_RECIPIENT", "").strip(),
            payment_resource=os.getenv("LSA_PAYMENT_RESOURCE", "/api/agent/ask").strip(),
            payment_mock_token=os.getenv("LSA_PAYMENT_MOCK_TOKEN", "dev-paid").strip(),
            payment_timeout_seconds=env_int("LSA_PAYMENT_TIMEOUT_SECONDS", "30"),
            x402_verify_url=os.getenv("LSA_X402_VERIFY_URL", "").strip(),
            x402_api_key=os.getenv("LSA_X402_API_KEY", "").strip(),
            usage_log_path=env_path(base_dir, "LSA_USAGE_LOG_PATH", "data/usage.jsonl"),
        )
