from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from .state_paths import migrate_workspace_state, workspace_config_path

DEFAULT_LLM_PROVIDER = "openai-compatible"
ANTHROPIC_PROVIDER = "anthropic"
ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"
OLLAMA_PROVIDER = "ollama"
OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"
OLLAMA_DEFAULT_MODEL = "qwen2.5-coder:7b"
SUPPORTED_LLM_PROVIDERS = {DEFAULT_LLM_PROVIDER, ANTHROPIC_PROVIDER, OLLAMA_PROVIDER}
SUPPORTED_REASONING_EFFORTS = {"low", "medium", "high", "xhigh", "max"}
REASONING_EFFORT_ALIASES = {"minimal": "low", "standard": "medium"}
DEFAULT_REASONING_EFFORT = "medium"
_CONFIG_WRITE_LOCK = threading.RLock()

API_CONFIG_KEYS = {
    "HOYA_LLM_PROVIDER",
    "HOYA_BASE_URL",
    "HOYA_MODEL",
    "HOYA_WIRE_API",
    "HOYA_REASONING_EFFORT",
    "HOYA_SHOW_REASONING",
    "HOYA_PERMISSION_MODE",
    "HOYA_ALLOW_SHELL",
    "HOYA_ALLOW_DESKTOP",
    "HOYA_REQUIRE_WRITE_APPROVAL",
    "HOYA_REQUIRE_SHELL_APPROVAL",
    "HOYA_TEMPERATURE",
    "HOYA_MAX_STEPS",
    "HOYA_HISTORY_CONTEXT_LIMIT",
    "HOYA_HISTORY_ENTRY_MAX_CHARS",
    "HOYA_TOOL_RESULT_MAX_CHARS",
}


def dotenv_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        values[key] = value.strip().strip('"').strip("'")
    return values


def load_dotenv(path: Path, override: bool = False) -> None:
    for key, value in dotenv_values(path).items():
        if override:
            os.environ[key] = value
        else:
            os.environ.setdefault(key, value)


def mask_secret(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    if len(value) <= 8:
        return "••••"
    return f"{value[:3]}...{value[-4:]}"


def normalize_provider(value: str | None) -> str:
    return (value or DEFAULT_LLM_PROVIDER).strip().lower() or DEFAULT_LLM_PROVIDER


def normalize_reasoning_effort(value: str | None) -> str:
    raw = (value or DEFAULT_REASONING_EFFORT).strip().lower() or DEFAULT_REASONING_EFFORT
    return REASONING_EFFORT_ALIASES.get(raw, raw)


def _apply_provider_defaults(values: dict[str, str]) -> dict[str, str]:
    provider = normalize_provider(values.get("HOYA_LLM_PROVIDER"))
    values["HOYA_LLM_PROVIDER"] = provider
    if provider == OLLAMA_PROVIDER:
        values["HOYA_BASE_URL"] = (values.get("HOYA_BASE_URL") or OLLAMA_DEFAULT_BASE_URL).rstrip("/")
        values["HOYA_MODEL"] = values.get("HOYA_MODEL") or OLLAMA_DEFAULT_MODEL
        values["HOYA_WIRE_API"] = "chat"
    elif provider == ANTHROPIC_PROVIDER:
        values["HOYA_BASE_URL"] = (values.get("HOYA_BASE_URL") or ANTHROPIC_DEFAULT_BASE_URL).rstrip("/")
        values["HOYA_WIRE_API"] = "messages"
    return values


def read_api_config_values(workspace: Path, session_api_key: str | None = None) -> dict[str, str]:
    """Read Hoya settings without loading project variables into process state.

    New settings live in private application data. A project-level ``.env`` is
    read only as a compatibility fallback. Electron always passes a session key
    value (including an empty one), so project secrets are ignored there. CLI and
    TUI calls leave it as ``None`` and may still read a legacy project API key.
    """
    legacy = dotenv_values(workspace / ".env")
    private = dotenv_values(workspace_config_path(workspace))

    def setting(name: str, default: str = "") -> str:
        if name in private:
            return private[name].strip()
        if name in legacy and name != "HOYA_API_KEY":
            return legacy[name].strip()
        return os.getenv(name, default).strip()

    values = _apply_provider_defaults(
        {
            "HOYA_LLM_PROVIDER": normalize_provider(setting("HOYA_LLM_PROVIDER", DEFAULT_LLM_PROVIDER)),
            "HOYA_API_KEY": (
                session_api_key
                if session_api_key is not None
                else os.getenv("HOYA_API_KEY", legacy.get("HOYA_API_KEY", ""))
            ).strip(),
            "HOYA_BASE_URL": setting("HOYA_BASE_URL").rstrip("/"),
            "HOYA_MODEL": setting("HOYA_MODEL"),
            "HOYA_WIRE_API": setting("HOYA_WIRE_API", "chat").lower() or "chat",
            "HOYA_REASONING_EFFORT": normalize_reasoning_effort(setting("HOYA_REASONING_EFFORT", DEFAULT_REASONING_EFFORT)),
            "HOYA_SHOW_REASONING": setting("HOYA_SHOW_REASONING", "1") or "1",
            "HOYA_PERMISSION_MODE": setting("HOYA_PERMISSION_MODE", "risk").lower() or "risk",
            "HOYA_ALLOW_SHELL": setting("HOYA_ALLOW_SHELL", "0") or "0",
            "HOYA_ALLOW_DESKTOP": setting("HOYA_ALLOW_DESKTOP", "0") or "0",
            "HOYA_REQUIRE_WRITE_APPROVAL": setting("HOYA_REQUIRE_WRITE_APPROVAL", "0") or "0",
            "HOYA_REQUIRE_SHELL_APPROVAL": setting("HOYA_REQUIRE_SHELL_APPROVAL", "1") or "1",
        }
    )
    if not private:
        legacy_settings = {key: value for key, value in legacy.items() if key in API_CONFIG_KEYS}
        if legacy_settings:
            write_dotenv_values(workspace_config_path(workspace), legacy_settings)
    return values


def _has_newline(value: str) -> bool:
    return "\n" in value or "\r" in value


def _payload_bool(payload: dict, name: str) -> bool:
    value = payload.get(name, False)
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def validate_api_config_update(payload: dict, existing: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    field_errors: dict[str, str] = {}

    provider = normalize_provider(str(payload.get("provider", existing.get("HOYA_LLM_PROVIDER", DEFAULT_LLM_PROVIDER))))
    raw_api_key = str(payload.get("api_key", "")).strip()
    clear_api_key = _payload_bool(payload, "clear_api_key")
    base_url = str(payload.get("base_url", existing.get("HOYA_BASE_URL", ""))).strip().rstrip("/")
    model = str(payload.get("model", existing.get("HOYA_MODEL", ""))).strip()
    wire_api = str(payload.get("wire_api", existing.get("HOYA_WIRE_API", "chat"))).strip().lower() or "chat"
    reasoning_effort = normalize_reasoning_effort(str(payload.get("reasoning_effort", existing.get("HOYA_REASONING_EFFORT", DEFAULT_REASONING_EFFORT))))
    raw_show_reasoning = payload.get("show_reasoning", existing.get("HOYA_SHOW_REASONING", "1"))
    show_reasoning = "1" if (raw_show_reasoning if isinstance(raw_show_reasoning, bool) else str(raw_show_reasoning).strip().lower() in {"1", "true", "yes", "on"}) else "0"

    if clear_api_key:
        api_key = ""
    else:
        api_key = raw_api_key or existing.get("HOYA_API_KEY", "").strip()

    if _has_newline(provider):
        field_errors["provider"] = "Provider must not contain newlines."
    elif provider not in SUPPORTED_LLM_PROVIDERS:
        field_errors["provider"] = "Provider must be openai-compatible, anthropic, or ollama."

    if raw_api_key and _has_newline(raw_api_key):
        field_errors["api_key"] = "API key must not contain newlines."

    if provider == OLLAMA_PROVIDER:
        if not base_url:
            base_url = OLLAMA_DEFAULT_BASE_URL
        if not model:
            model = OLLAMA_DEFAULT_MODEL
        wire_api = "chat"
    elif provider == ANTHROPIC_PROVIDER:
        base_url = base_url or ANTHROPIC_DEFAULT_BASE_URL
        wire_api = "messages"
        if not api_key and not clear_api_key:
            field_errors["api_key"] = "API key is required for Anthropic providers."
    elif not api_key and not clear_api_key:
        field_errors["api_key"] = "API key is required for OpenAI-compatible providers."

    if _has_newline(base_url):
        field_errors["base_url"] = "Base URL must not contain newlines."
    elif not base_url:
        field_errors["base_url"] = "Base URL is required."
    else:
        parsed = urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            field_errors["base_url"] = "Base URL must be a valid http:// or https:// URL."

    if _has_newline(model):
        field_errors["model"] = "Model must not contain newlines."
    elif not model:
        field_errors["model"] = "Model is required."

    if _has_newline(wire_api):
        field_errors["wire_api"] = "Wire API must not contain newlines."
    elif wire_api not in {"chat", "responses", "messages"}:
        field_errors["wire_api"] = "Wire API must be chat, responses, or messages."
    elif provider == OLLAMA_PROVIDER and wire_api != "chat":
        field_errors["wire_api"] = "Ollama provider supports only chat wire API."
    elif provider == ANTHROPIC_PROVIDER and wire_api != "messages":
        field_errors["wire_api"] = "Anthropic provider supports only messages wire API."
    elif provider == DEFAULT_LLM_PROVIDER and wire_api == "messages":
        field_errors["wire_api"] = "OpenAI-compatible provider supports chat or responses wire API."

    if _has_newline(reasoning_effort):
        field_errors["reasoning_effort"] = "Reasoning effort must not contain newlines."
    elif reasoning_effort not in SUPPORTED_REASONING_EFFORTS:
        field_errors["reasoning_effort"] = "Reasoning effort must be low, medium, high, xhigh, or max."

    updates = {
        "HOYA_LLM_PROVIDER": provider,
        "HOYA_API_KEY": api_key,
        "HOYA_BASE_URL": base_url,
        "HOYA_MODEL": model,
        "HOYA_WIRE_API": wire_api,
        "HOYA_REASONING_EFFORT": reasoning_effort,
        "HOYA_SHOW_REASONING": show_reasoning,
    }
    return updates, field_errors


def _format_dotenv_value(value: str) -> str:
    if _has_newline(value):
        raise ValueError("Config values must not contain newlines.")
    if value == "":
        return ""
    simple = all(ch.isalnum() or ch in "-._/:@" for ch in value)
    if simple:
        return value
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def write_dotenv_values(path: Path, updates: dict[str, str]) -> None:
    with _CONFIG_WRITE_LOCK:
        _write_dotenv_values_unlocked(path, updates)


def _write_dotenv_values_unlocked(path: Path, updates: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = {key: value for key, value in updates.items() if key in API_CONFIG_KEYS}
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    seen: set[str] = set()
    next_lines: list[str] = []

    for line in lines:
        stripped = line.lstrip()
        prefix = line[: len(line) - len(stripped)]
        candidate = stripped[7:].lstrip() if stripped.startswith("export ") else stripped
        if "=" in candidate and not candidate.startswith("#"):
            key = candidate.split("=", 1)[0].strip()
            if key in normalized:
                next_lines.append(f"{prefix}{key}={_format_dotenv_value(normalized[key])}")
                seen.add(key)
                continue
        next_lines.append(line)

    if next_lines and next_lines[-1].strip():
        next_lines.append("")
    for key in [
        "HOYA_LLM_PROVIDER",
        "HOYA_BASE_URL",
        "HOYA_MODEL",
        "HOYA_WIRE_API",
        "HOYA_REASONING_EFFORT",
        "HOYA_SHOW_REASONING",
        "HOYA_PERMISSION_MODE",
        "HOYA_ALLOW_SHELL",
        "HOYA_ALLOW_DESKTOP",
        "HOYA_REQUIRE_WRITE_APPROVAL",
        "HOYA_REQUIRE_SHELL_APPROVAL",
        "HOYA_TEMPERATURE",
        "HOYA_MAX_STEPS",
        "HOYA_HISTORY_CONTEXT_LIMIT",
        "HOYA_HISTORY_ENTRY_MAX_CHARS",
        "HOYA_TOOL_RESULT_MAX_CHARS",
    ]:
        if key not in seen and key in normalized:
            next_lines.append(f"{key}={_format_dotenv_value(normalized[key])}")

    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text("\n".join(next_lines).rstrip() + "\n", encoding="utf-8")
    temporary.replace(path)


@dataclass(frozen=True)
class Config:
    configured: bool
    provider: str
    api_key: str
    base_url: str
    model: str
    wire_api: str
    temperature: float
    reasoning_effort: str
    show_reasoning: bool
    max_steps: int
    history_context_limit: int
    history_entry_max_chars: int
    tool_result_max_chars: int
    allow_shell: bool
    allow_desktop: bool
    require_write_approval: bool
    require_shell_approval: bool
    permission_mode: str
    workspace: Path
    memory_path: Path
    history_path: Path
    imports_dir: Path
    index_path: Path
    run_log_path: Path
    pending_writes_path: Path
    conversations_index_path: Path
    conversations_dir: Path
    task_runs_path: Path
    versions_index_path: Path
    versions_dir: Path

    @classmethod
    def from_env(
        cls,
        workspace: Path | None = None,
        reload_dotenv: bool = False,
        *,
        session_api_key: str | None = None,
    ) -> "Config":
        workspace = (workspace or Path.cwd()).resolve()
        values = read_api_config_values(workspace, session_api_key=session_api_key)
        private_values = dotenv_values(workspace_config_path(workspace))
        legacy_values = dotenv_values(workspace / ".env")

        def env(name: str, default: str = "") -> str:
            if name in values:
                return values[name]
            if name in private_values:
                return private_values[name]
            if name in legacy_values and name != "HOYA_API_KEY":
                return legacy_values[name]
            return os.getenv(name, default)

        provider = normalize_provider(env("HOYA_LLM_PROVIDER", DEFAULT_LLM_PROVIDER))
        api_key = env("HOYA_API_KEY").strip()
        base_url = env("HOYA_BASE_URL").strip().rstrip("/")
        model = env("HOYA_MODEL").strip()
        wire_api = env("HOYA_WIRE_API", "chat").strip().lower() or "chat"
        reasoning_effort = normalize_reasoning_effort(env("HOYA_REASONING_EFFORT", DEFAULT_REASONING_EFFORT))
        show_reasoning = env("HOYA_SHOW_REASONING", "1").strip() == "1"

        if provider not in SUPPORTED_LLM_PROVIDERS:
            raise ValueError("HOYA_LLM_PROVIDER must be openai-compatible, anthropic, or ollama.")

        if provider == OLLAMA_PROVIDER:
            base_url = base_url or OLLAMA_DEFAULT_BASE_URL
            model = model or OLLAMA_DEFAULT_MODEL
            wire_api = "chat"
        elif provider == ANTHROPIC_PROVIDER:
            base_url = base_url or ANTHROPIC_DEFAULT_BASE_URL
            wire_api = "messages"

        if wire_api not in {"chat", "responses", "messages"}:
            raise ValueError("HOYA_WIRE_API must be chat, responses, or messages.")
        if provider == DEFAULT_LLM_PROVIDER and wire_api == "messages":
            raise ValueError("OpenAI-compatible provider supports chat or responses wire API.")
        if reasoning_effort not in SUPPORTED_REASONING_EFFORTS:
            raise ValueError("HOYA_REASONING_EFFORT must be low, medium, high, xhigh, or max.")

        local_defaults = provider == OLLAMA_PROVIDER
        max_steps_default = "4" if local_defaults else "8"
        history_limit_default = "4" if local_defaults else "12"
        history_chars_default = "1200" if local_defaults else "4000"
        tool_result_default = "4000" if local_defaults else "12000"

        permission_mode = env("HOYA_PERMISSION_MODE", "risk").strip().lower()
        if permission_mode not in {"strict", "risk", "yolo"}:
            permission_mode = "risk"

        return cls(
            configured=provider == OLLAMA_PROVIDER or bool(api_key and base_url and model),
            provider=provider,
            api_key=api_key,
            base_url=base_url,
            model=model,
            wire_api=wire_api,
            temperature=float(env("HOYA_TEMPERATURE", "0.2")),
            reasoning_effort=reasoning_effort,
            show_reasoning=show_reasoning,
            max_steps=int(env("HOYA_MAX_STEPS", max_steps_default)),
            history_context_limit=int(env("HOYA_HISTORY_CONTEXT_LIMIT", history_limit_default)),
            history_entry_max_chars=int(env("HOYA_HISTORY_ENTRY_MAX_CHARS", history_chars_default)),
            tool_result_max_chars=int(env("HOYA_TOOL_RESULT_MAX_CHARS", tool_result_default)),
            allow_shell=env("HOYA_ALLOW_SHELL", "0").strip() == "1",
            allow_desktop=env("HOYA_ALLOW_DESKTOP", "0").strip() == "1",
            require_write_approval=env("HOYA_REQUIRE_WRITE_APPROVAL", "0").strip() == "1",
            require_shell_approval=env("HOYA_REQUIRE_SHELL_APPROVAL", "1").strip() == "1",
            permission_mode=permission_mode,
            workspace=workspace,
            memory_path=migrate_workspace_state(
                workspace, "memory.json", ".hoya/memory.json", ".hoya_memory.json"
            ),
            history_path=migrate_workspace_state(
                workspace, "history.jsonl", ".hoya/history.jsonl", ".hoya_history.jsonl"
            ),
            imports_dir=workspace / "imports",
            index_path=migrate_workspace_state(
                workspace, "index.json", ".hoya/index.json", ".hoya_index.json"
            ),
            run_log_path=migrate_workspace_state(
                workspace, "runs.jsonl", ".hoya/runs.jsonl", ".hoya_runs.jsonl"
            ),
            pending_writes_path=migrate_workspace_state(
                workspace, "pending_writes.json", ".hoya/pending_writes.json", ".hoya_pending_writes.json"
            ),
            conversations_index_path=migrate_workspace_state(
                workspace, "conversations.json", ".hoya/conversations.json", ".hoya_conversations.json"
            ),
            conversations_dir=migrate_workspace_state(
                workspace, "conversations", ".hoya/conversations", ".hoya_conversations"
            ),
            task_runs_path=migrate_workspace_state(
                workspace, "task_runs.json", ".hoya/task_runs.json", ".hoya_task_runs.json"
            ),
            versions_index_path=migrate_workspace_state(
                workspace, "versions.json", ".hoya/versions.json", ".hoya_versions.json"
            ),
            versions_dir=migrate_workspace_state(
                workspace, "versions", ".hoya/versions", ".hoya_versions"
            ),
        )
