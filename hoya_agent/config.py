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
class Config:
    api_key: str
    base_url: str
    model: str
    wire_api: str
    temperature: float
    max_steps: int
    history_context_limit: int
    history_entry_max_chars: int
    tool_result_max_chars: int
    allow_shell: bool
    allow_desktop: bool
    require_write_approval: bool
    require_shell_approval: bool
    workspace: Path
    memory_path: Path
    history_path: Path
    imports_dir: Path
    index_path: Path
    run_log_path: Path
    pending_writes_path: Path

    @classmethod
    def from_env(cls) -> "Config":
        workspace = Path.cwd().resolve()
        load_dotenv(workspace / ".env")

        api_key = os.getenv("HOYA_API_KEY", "").strip()
        base_url = os.getenv("HOYA_BASE_URL", "").strip().rstrip("/")
        model = os.getenv("HOYA_MODEL", "").strip()
        wire_api = os.getenv("HOYA_WIRE_API", "chat").strip().lower()

        if not api_key:
            raise ValueError("Missing HOYA_API_KEY. Copy .env.example to .env and fill it in.")
        if not base_url:
            raise ValueError("Missing HOYA_BASE_URL. Example: https://relay.example.com/v1")
        if not model:
            raise ValueError("Missing HOYA_MODEL. Example: gpt-4o-mini")
        if wire_api not in {"chat", "responses"}:
            raise ValueError("HOYA_WIRE_API must be either chat or responses.")

        return cls(
            api_key=api_key,
            base_url=base_url,
            model=model,
            wire_api=wire_api,
            temperature=float(os.getenv("HOYA_TEMPERATURE", "0.2")),
            max_steps=int(os.getenv("HOYA_MAX_STEPS", "8")),
            history_context_limit=int(os.getenv("HOYA_HISTORY_CONTEXT_LIMIT", "12")),
            history_entry_max_chars=int(os.getenv("HOYA_HISTORY_ENTRY_MAX_CHARS", "4000")),
            tool_result_max_chars=int(os.getenv("HOYA_TOOL_RESULT_MAX_CHARS", "12000")),
            allow_shell=os.getenv("HOYA_ALLOW_SHELL", "0").strip() == "1",
            allow_desktop=os.getenv("HOYA_ALLOW_DESKTOP", "0").strip() == "1",
            require_write_approval=os.getenv("HOYA_REQUIRE_WRITE_APPROVAL", "0").strip() == "1",
            require_shell_approval=os.getenv("HOYA_REQUIRE_SHELL_APPROVAL", "1").strip() == "1",
            workspace=workspace,
            memory_path=workspace / ".hoya_memory.json",
            history_path=workspace / ".hoya_history.jsonl",
            imports_dir=workspace / "imports",
            index_path=workspace / ".hoya_index.json",
            run_log_path=workspace / ".hoya_runs.jsonl",
            pending_writes_path=workspace / ".hoya_pending_writes.json",
        )
