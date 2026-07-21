from __future__ import annotations

import argparse
import json
import os
import shutil
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .agent import HoyaAgent
from .config import Config, mask_secret, read_api_config_values, validate_api_config_update, write_dotenv_values
from .conversations import ConversationStore
from .memory import MemoryStore
from .model_discovery import discover_models
from .user_settings import UserSettingsStore, default_settings_path
from .workspace_ops import apply_pending_operation, build_index, deny_pending_operation, import_path, load_pending_writes, search_index


def public_model_payload(model: dict[str, Any]) -> dict[str, Any]:
    payload = {key: value for key, value in model.items() if key != "api_key"}
    payload["api_key_set"] = bool(str(model.get("api_key", "")).strip())
    return payload


class AgentServerState:
    def __init__(self, workspace: Path) -> None:
        self.lock = threading.Lock()
        self.workspace = workspace.resolve()
        self.config: Config | None = None
        self.agent: HoyaAgent | None = None
        self.error: str | None = None
        self.runs_lock = threading.Lock()
        self.active_runs: dict[str, threading.Event] = {}
        self.reload()

    def reload(self, workspace: Path | None = None) -> None:
        with self.lock:
            if workspace is not None:
                self.workspace = workspace.resolve()
            try:
                self.config = Config.from_env(self.workspace, reload_dotenv=True)
                self.agent = HoyaAgent(self.config)
                self.error = None
            except Exception as exc:
                self.config = None
                self.agent = None
                self.error = str(exc)

    def status_payload(self) -> dict[str, Any]:
        with self.lock:
            config = self.config
            if config is None:
                return {"ok": False, "workspace": str(self.workspace), "error": self.error}
            return {
                "ok": True,
                "workspace": str(config.workspace),
                "provider": config.provider,
                "model": config.model,
                "wire_api": config.wire_api,
                "reasoning_effort": config.reasoning_effort,
                "show_reasoning": config.show_reasoning,
                "allow_shell": config.allow_shell,
                "allow_desktop": config.allow_desktop,
                "require_write_approval": config.require_write_approval,
                "require_shell_approval": config.require_shell_approval,
            }

    def require_config(self) -> Config:
        with self.lock:
            if self.config is None:
                raise RuntimeError(self.error or "Config is not loaded")
            return self.config

    def require_agent(self) -> HoyaAgent:
        with self.lock:
            if self.agent is None:
                raise RuntimeError(self.error or "Agent is not loaded")
            return self.agent

    def conversation_paths(self) -> tuple[Path, Path]:
        with self.lock:
            if self.config is not None:
                return self.config.conversations_index_path, self.config.conversations_dir
            state_dir = self.workspace / ".hoya"
            return state_dir / "conversations.json", state_dir / "conversations"

    def begin_run(self, run_id: str) -> threading.Event:
        with self.runs_lock:
            if run_id in self.active_runs:
                raise ValueError(f"run is already active: {run_id}")
            cancel_event = threading.Event()
            self.active_runs[run_id] = cancel_event
            return cancel_event

    def cancel_run(self, run_id: str) -> bool:
        with self.runs_lock:
            cancel_event = self.active_runs.get(run_id)
            if cancel_event is None:
                return False
            cancel_event.set()
            return True

    def finish_run(self, run_id: str) -> None:
        with self.runs_lock:
            self.active_runs.pop(run_id, None)


class HoyaRequestHandler(BaseHTTPRequestHandler):
    server_version = "HoyaAgentServer/0.1"

    @property
    def state(self) -> AgentServerState:
        return self.server.state  # type: ignore[attr-defined]

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/health":
                self.write_json({"ok": True})
                return
            if parsed.path == "/api/status":
                self.write_json(self.state.status_payload())
                return
            if parsed.path == "/api/config":
                self.handle_get_config()
                return
            if parsed.path == "/api/history":
                self.handle_history(parsed.query)
                return
            if parsed.path == "/api/conversations":
                self.handle_conversations()
                return
            if parsed.path == "/api/tasks":
                self.handle_tasks()
                return
            if parsed.path == "/api/projects":
                self.handle_projects()
                return
            if parsed.path == "/api/conversations/messages":
                self.handle_conversation_messages(parsed.query)
                return
            if parsed.path == "/api/memory":
                self.handle_memory()
                return
            if parsed.path == "/api/models":
                self.handle_models()
                return
            if parsed.path == "/api/pending":
                self.handle_pending()
                return
            if parsed.path == "/api/runs":
                self.handle_runs(parsed.query)
                return
            if parsed.path == "/api/versions":
                self.handle_versions(parsed.query)
                return
            if parsed.path == "/api/search":
                self.handle_search(parsed.query)
                return
            self.write_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self.write_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/workspace":
                self.handle_workspace()
                return
            if parsed.path == "/api/reload":
                self.state.reload()
                self.write_json(self.state.status_payload())
                return
            if parsed.path == "/api/config":
                self.handle_update_config()
                return
            if parsed.path == "/api/conversations":
                self.handle_create_conversation()
                return
            if parsed.path == "/api/tasks":
                self.handle_create_task()
                return
            if parsed.path == "/api/projects":
                self.handle_create_project()
                return
            if parsed.path == "/api/projects/select":
                self.handle_select_project()
                return
            if parsed.path == "/api/projects/update":
                self.handle_update_project()
                return
            if parsed.path == "/api/projects/delete":
                self.handle_delete_project()
                return
            if parsed.path == "/api/projects/task":
                self.handle_create_project_task()
                return
            if parsed.path == "/api/conversations/rename":
                self.handle_rename_conversation()
                return
            if parsed.path == "/api/conversations/update":
                self.handle_update_conversation()
                return
            if parsed.path == "/api/conversations/delete":
                self.handle_delete_conversation()
                return
            if parsed.path == "/api/memory":
                self.handle_add_memory()
                return
            if parsed.path == "/api/memory/delete":
                self.handle_delete_memory()
                return
            if parsed.path == "/api/models":
                self.handle_save_model()
                return
            if parsed.path == "/api/models/discover":
                self.handle_discover_models()
                return
            if parsed.path == "/api/models/select":
                self.handle_select_model()
                return
            if parsed.path == "/api/models/delete":
                self.handle_delete_model()
                return
            if parsed.path == "/api/import":
                self.handle_import()
                return
            if parsed.path == "/api/index":
                self.handle_index()
                return
            if parsed.path == "/api/pending/apply":
                self.handle_apply_pending()
                return
            if parsed.path == "/api/pending/deny":
                self.handle_deny_pending()
                return
            if parsed.path == "/api/runs/resume":
                self.handle_resume_run_stream()
                return
            if parsed.path == "/api/versions/rollback":
                self.handle_rollback_version()
                return
            if parsed.path == "/api/chat":
                self.handle_chat_stream()
                return
            if parsed.path == "/api/chat/cancel":
                self.handle_cancel_chat()
                return
            self.write_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self.write_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def write_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_ndjson_event(self, event: dict[str, Any]) -> None:
        self.wfile.write(json.dumps(event, ensure_ascii=False).encode("utf-8") + b"\n")
        self.wfile.flush()

    def conversation_store(self) -> ConversationStore:
        index_path, messages_dir = self.state.conversation_paths()
        return ConversationStore(index_path, messages_dir)

    def user_settings_store(self) -> UserSettingsStore:
        return UserSettingsStore(default_settings_path())

    def handle_workspace(self) -> None:
        payload = self.read_json()
        workspace = str(payload.get("workspace", "")).strip()
        if not workspace:
            self.write_json({"ok": False, "error": "workspace is required"}, HTTPStatus.BAD_REQUEST)
            return
        self.state.reload(Path(workspace))
        self.user_settings_store().remember_project(Path(workspace))
        self.write_json(self.state.status_payload())

    def handle_get_config(self) -> None:
        workspace = self.state.workspace
        values = read_api_config_values(workspace)
        api_key = values.get("HOYA_API_KEY", "")
        self.write_json({
            "ok": True,
            "workspace": str(workspace),
            "env_path": str(workspace / ".env"),
            "status_error": self.state.error,
            "config": {
                "provider": values.get("HOYA_LLM_PROVIDER", "openai-compatible"),
                "api_key_set": bool(api_key),
                "api_key_masked": mask_secret(api_key),
                "base_url": values.get("HOYA_BASE_URL", ""),
                "model": values.get("HOYA_MODEL", ""),
                "wire_api": values.get("HOYA_WIRE_API", "chat"),
                "reasoning_effort": values.get("HOYA_REASONING_EFFORT", "medium"),
                "show_reasoning": values.get("HOYA_SHOW_REASONING", "1") == "1",
            },
        })

    def handle_update_config(self) -> None:
        payload = self.read_json()
        workspace = self.state.workspace
        existing = read_api_config_values(workspace)
        updates, field_errors = validate_api_config_update(payload, existing)
        if field_errors:
            self.write_json({"ok": False, "error": "Invalid API config", "field_errors": field_errors}, HTTPStatus.BAD_REQUEST)
            return
        write_dotenv_values(workspace / ".env", updates)
        self.state.reload()
        self.write_json(self.state.status_payload())

    def handle_conversations(self) -> None:
        self.write_json({"ok": True, "conversations": self.conversation_store().list_conversations()})

    def handle_tasks(self) -> None:
        self.write_json({"ok": True, "tasks": self.conversation_store().list_conversations()})

    def handle_projects(self) -> None:
        store = self.user_settings_store()
        projects = []
        for project in store.list_projects(include_archived=True):
            project_path = Path(str(project.get("path", ""))).expanduser()
            tasks: list[dict[str, Any]] = []
            if project_path.is_dir():
                state_dir = project_path / ".hoya"
                index_path = state_dir / "conversations.json"
                messages_dir = state_dir / "conversations"
                legacy_index = project_path / ".hoya_conversations.json"
                legacy_messages = project_path / ".hoya_conversations"
                if not index_path.exists() and legacy_index.exists():
                    index_path = legacy_index
                if not messages_dir.exists() and legacy_messages.exists():
                    messages_dir = legacy_messages
                tasks = ConversationStore(index_path, messages_dir).list_conversations() if index_path.exists() else []
            projects.append({**project, "exists": project_path.is_dir(), "tasks": tasks})
        self.write_json({"ok": True, "projects": projects, "active_path": str(self.state.workspace)})

    def handle_create_project(self) -> None:
        payload = self.read_json()
        parent_text = str(payload.get("parent", "")).strip()
        name = str(payload.get("name", "")).strip()
        if not parent_text or not name:
            self.write_json({"ok": False, "error": "parent and name are required"}, HTTPStatus.BAD_REQUEST)
            return
        if name in {".", ".."} or any(char in name for char in '<>:"/\\|?*'):
            self.write_json({"ok": False, "error": "project name contains invalid characters"}, HTTPStatus.BAD_REQUEST)
            return
        parent = Path(parent_text).expanduser().resolve()
        if not parent.is_dir():
            self.write_json({"ok": False, "error": "parent directory does not exist"}, HTTPStatus.BAD_REQUEST)
            return
        target = parent / name
        if target.exists():
            self.write_json({"ok": False, "error": "project directory already exists"}, HTTPStatus.CONFLICT)
            return
        target.mkdir()
        source_env = self.state.workspace / ".env"
        if source_env.is_file():
            shutil.copy2(source_env, target / ".env")
        self.state.reload(target)
        project = self.user_settings_store().remember_project(target, name)
        self.write_json({"ok": True, "project": project, "status": self.state.status_payload()})

    def handle_select_project(self) -> None:
        payload = self.read_json()
        project_path = Path(str(payload.get("path", "")).strip()).expanduser().resolve()
        if not project_path.is_dir():
            self.write_json({"ok": False, "error": "project directory does not exist"}, HTTPStatus.BAD_REQUEST)
            return
        self.state.reload(project_path)
        project = self.user_settings_store().remember_project(project_path)
        self.write_json({"ok": True, "project": project, "status": self.state.status_payload()})

    def handle_update_project(self) -> None:
        payload = self.read_json()
        project_id = str(payload.get("id", "")).strip()
        if not project_id:
            self.write_json({"ok": False, "error": "id is required"}, HTTPStatus.BAD_REQUEST)
            return
        name = str(payload.get("name", "")) if "name" in payload else None
        archived = bool(payload.get("archived")) if "archived" in payload else None
        project = self.user_settings_store().update_project(project_id, name=name, archived=archived)
        self.write_json({"ok": True, "project": project})

    def handle_delete_project(self) -> None:
        payload = self.read_json()
        project_id = str(payload.get("id", "")).strip()
        if not project_id:
            self.write_json({"ok": False, "error": "id is required"}, HTTPStatus.BAD_REQUEST)
            return
        self.user_settings_store().remove_project(project_id)
        self.write_json({"ok": True})

    def handle_create_project_task(self) -> None:
        payload = self.read_json()
        project_id = str(payload.get("project_id", "")).strip()
        title = str(payload.get("title", "")).strip() or "新任务"
        if not project_id:
            self.write_json({"ok": False, "error": "project_id is required"}, HTTPStatus.BAD_REQUEST)
            return
        project = self.user_settings_store().get_project(project_id)
        project_path = Path(str(project.get("path", ""))).expanduser().resolve()
        if not project_path.is_dir():
            self.write_json({"ok": False, "error": "project directory does not exist"}, HTTPStatus.BAD_REQUEST)
            return
        state_dir = project_path / ".hoya"
        task = ConversationStore(state_dir / "conversations.json", state_dir / "conversations").create_conversation(title, kind="task")
        self.write_json({"ok": True, "task": task, "project": project})

    def handle_create_conversation(self) -> None:
        payload = self.read_json()
        entry = self.conversation_store().create_conversation(str(payload.get("title", "")).strip() or None)
        self.write_json({"ok": True, "conversation": entry})

    def handle_create_task(self) -> None:
        payload = self.read_json()
        title = str(payload.get("title", "")).strip() or "新任务"
        entry = self.conversation_store().create_conversation(title, kind="task")
        self.write_json({"ok": True, "task": entry})

    def handle_rename_conversation(self) -> None:
        payload = self.read_json()
        entry = self.conversation_store().rename_conversation(str(payload.get("id", "")), str(payload.get("title", "")))
        self.write_json({"ok": True, "conversation": entry})

    def handle_update_conversation(self) -> None:
        payload = self.read_json()
        conversation_id = str(payload.get("id", "")).strip()
        if not conversation_id:
            self.write_json({"ok": False, "error": "id is required"}, HTTPStatus.BAD_REQUEST)
            return
        title = str(payload.get("title", "")) if "title" in payload else None
        color = str(payload.get("color", "")) if "color" in payload else None
        try:
            entry = self.conversation_store().update_conversation(conversation_id, title=title, color=color)
        except ValueError as exc:
            self.write_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        self.write_json({"ok": True, "conversation": entry})

    def handle_delete_conversation(self) -> None:
        payload = self.read_json()
        self.conversation_store().delete_conversation(str(payload.get("id", "")))
        self.write_json({"ok": True, "conversations": self.conversation_store().list_conversations()})

    def handle_conversation_messages(self, query: str) -> None:
        params = parse_qs(query)
        store = self.conversation_store()
        conversation_id = params.get("id", [""])[0] or store.ensure_default()["id"]
        limit = int(params.get("limit", ["200"])[0])
        self.write_json({"ok": True, "id": conversation_id, "messages": store.messages(conversation_id, limit=limit)})

    def handle_memory(self) -> None:
        config = self.state.require_config()
        self.write_json({"ok": True, "memory": MemoryStore(config.memory_path).load()})

    def handle_add_memory(self) -> None:
        config = self.state.require_config()
        payload = self.read_json()
        text = str(payload.get("text", "")).strip()
        if not text:
            self.write_json({"ok": False, "error": "text is required"}, HTTPStatus.BAD_REQUEST)
            return
        self.write_json({"ok": True, "entry": MemoryStore(config.memory_path).add(text)})

    def handle_delete_memory(self) -> None:
        config = self.state.require_config()
        payload = self.read_json()
        MemoryStore(config.memory_path).delete(str(payload.get("created_at", "")))
        self.write_json({"ok": True, "memory": MemoryStore(config.memory_path).load()})

    def handle_models(self) -> None:
        store = self.user_settings_store()
        data = store.load()
        self.write_json({"ok": True, "models": [public_model_payload(item) for item in store.list_models()], "active_model_id": data.get("active_model_id", "")})

    def handle_save_model(self) -> None:
        model = self.user_settings_store().upsert_model(self.read_json())
        self.write_json({"ok": True, "model": public_model_payload(model)})

    def handle_discover_models(self) -> None:
        payload = self.read_json()
        provider = str(payload.get("provider", "openai-compatible")).strip().lower() or "openai-compatible"
        base_url = str(payload.get("base_url", "")).strip()
        api_key = str(payload.get("api_key", "")).strip()
        if not base_url:
            self.write_json({"ok": False, "error": "base_url is required"}, HTTPStatus.BAD_REQUEST)
            return
        self.write_json(discover_models(base_url, api_key, provider))

    def handle_select_model(self) -> None:
        payload = self.read_json()
        model = self.user_settings_store().select_model(str(payload.get("id", "")))
        updates = {
            "HOYA_LLM_PROVIDER": str(model.get("provider", "openai-compatible")),
            "HOYA_BASE_URL": str(model.get("base_url", "")),
            "HOYA_MODEL": str(model.get("model", "")),
            "HOYA_API_KEY": str(model.get("api_key", "")),
            "HOYA_WIRE_API": str(model.get("wire_api", "chat")),
            "HOYA_REASONING_EFFORT": str(model.get("reasoning_effort", "medium")),
            "HOYA_SHOW_REASONING": "1" if model.get("show_reasoning", True) else "0",
        }
        write_dotenv_values(self.state.workspace / ".env", updates)
        self.state.reload()
        self.write_json({"ok": True, "model": public_model_payload(model), "status": self.state.status_payload()})

    def handle_delete_model(self) -> None:
        payload = self.read_json()
        self.user_settings_store().delete_model(str(payload.get("id", "")))
        self.write_json({"ok": True})

    def handle_history(self, query: str) -> None:
        config = self.state.require_config()
        limit = int(parse_qs(query).get("limit", ["24"])[0])
        entries = self.state.require_agent().history.recent(limit)
        self.write_json({"ok": True, "workspace": str(config.workspace), "entries": entries})

    def handle_pending(self) -> None:
        config = self.state.require_config()
        self.write_json({"ok": True, "entries": load_pending_writes(config.pending_writes_path)})

    def handle_runs(self, query: str) -> None:
        params = parse_qs(query)
        conversation_id = params.get("conversation_id", [""])[0]
        limit = int(params.get("limit", ["20"])[0])
        runs = self.state.require_agent().runs.list(conversation_id, limit)
        self.write_json({"ok": True, "runs": runs, "latest": runs[0] if runs else None})

    def handle_versions(self, query: str) -> None:
        params = parse_qs(query)
        run_id = params.get("run_id", [""])[0]
        limit = int(params.get("limit", ["50"])[0])
        self.write_json({"ok": True, "versions": self.state.require_agent().changes.list(run_id, limit)})

    def handle_search(self, query: str) -> None:
        config = self.state.require_config()
        params = parse_qs(query)
        q = params.get("q", [""])[0]
        limit = int(params.get("limit", ["12"])[0])
        self.write_json(search_index(config.index_path, q, limit=limit))

    def handle_import(self) -> None:
        config = self.state.require_config()
        payload = self.read_json()
        source = str(payload.get("source", "")).strip()
        if not source:
            self.write_json({"ok": False, "error": "source is required"}, HTTPStatus.BAD_REQUEST)
            return
        self.write_json(import_path(source, config.imports_dir))

    def handle_index(self) -> None:
        config = self.state.require_config()
        payload = build_index(config.workspace, config.index_path)
        self.write_json({"ok": True, "files": len(payload.get("files", [])), "truncated": payload.get("truncated", False)})

    def handle_apply_pending(self) -> None:
        config = self.state.require_config()
        payload = self.read_json()
        pending_id = str(payload.get("id", "")).strip()
        if not pending_id:
            self.write_json({"ok": False, "error": "id is required"}, HTTPStatus.BAD_REQUEST)
            return
        agent = self.state.require_agent()
        result = apply_pending_operation(
            config.workspace,
            config.pending_writes_path,
            pending_id,
            allow_shell=config.allow_shell,
            change_store=agent.changes,
        )
        run_id = str(result.get("run_id", ""))
        if run_id and agent.runs.get(run_id) is not None:
            if result.get("version_id"):
                agent._register_change(run_id, result)
            agent.runs.resolve_approval(run_id, "approved", result)
            result["resumable"] = True
        self.write_json(result)

    def handle_deny_pending(self) -> None:
        config = self.state.require_config()
        payload = self.read_json()
        pending_id = str(payload.get("id", "")).strip()
        if not pending_id:
            self.write_json({"ok": False, "error": "id is required"}, HTTPStatus.BAD_REQUEST)
            return
        agent = self.state.require_agent()
        result = deny_pending_operation(config.pending_writes_path, pending_id)
        run_id = str(result.get("run_id", ""))
        if run_id and agent.runs.get(run_id) is not None:
            denial_result = {**result, "ok": False, "denied": True, "error": "operation denied by user"}
            agent.runs.resolve_approval(run_id, "denied", denial_result)
            result["resumable"] = True
        self.write_json(result)

    def handle_rollback_version(self) -> None:
        payload = self.read_json()
        version_id = str(payload.get("version_id", "")).strip()
        if not version_id:
            self.write_json({"ok": False, "error": "version_id is required"}, HTTPStatus.BAD_REQUEST)
            return
        agent = self.state.require_agent()
        version = agent.changes.get(version_id)
        result = agent.changes.rollback(version_id)
        if result.get("ok") and version and version.get("run_id") and agent.runs.get(str(version["run_id"])):
            agent.runs.add_change(
                str(version["run_id"]),
                {
                    "version_id": version_id,
                    "path": version.get("path"),
                    "verification": version.get("verification") or {},
                    "rolled_back_at": result.get("rolled_back_at"),
                },
            )
        self.write_json(result)

    def handle_cancel_chat(self) -> None:
        payload = self.read_json()
        run_id = str(payload.get("run_id", "")).strip()
        if not run_id:
            self.write_json({"ok": False, "error": "run_id is required"}, HTTPStatus.BAD_REQUEST)
            return
        cancelled = self.state.cancel_run(run_id)
        self.write_json({"ok": True, "run_id": run_id, "cancelled": cancelled})

    def handle_chat_stream(self) -> None:
        payload = self.read_json()
        task = str(payload.get("task", "")).strip()
        run_id = str(payload.get("run_id", "")).strip() or uuid.uuid4().hex
        conversation_store = self.conversation_store()
        conversation_id = str(payload.get("conversation_id", "")).strip() or conversation_store.ensure_default()["id"]
        if not task:
            self.write_json({"type": "error", "text": "task is required"}, HTTPStatus.BAD_REQUEST)
            return
        if len(run_id) > 128 or any(not (ch.isalnum() or ch in "-_") for ch in run_id):
            self.write_json({"type": "error", "text": "run_id is invalid"}, HTTPStatus.BAD_REQUEST)
            return

        agent = self.state.require_agent()
        cancel_event = self.state.begin_run(run_id)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        try:
            self.write_ndjson_event({"type": "run_started", "run_id": run_id})
            agent.history.append("user", task)
            conversation_store.append_message(conversation_id, "user", task)
            agent.run_log.append({"type": "task_start", "task": task, "run_id": run_id, "conversation_id": conversation_id, "ui": "desktop"})
            final_text = ""
            reasoning_items: list[str] = []
            tool_results: list[dict[str, Any]] = []
            for event in agent.run_stream(task, conversation_id=conversation_id, cancel_event=cancel_event, run_id=run_id):
                event_type = event.get("type")
                if event_type in {"status", "reasoning", "tool_start", "tool_result", "approval_required", "error", "cancelled", "done"}:
                    agent.run_log.append({"type": "agent_event", "event": event, "run_id": run_id, "conversation_id": conversation_id, "ui": "desktop"})
                if event_type == "done":
                    final_text = str(event.get("text", ""))
                elif event_type == "reasoning" and event.get("text"):
                    reasoning_items.append(str(event["text"]))
                elif event_type == "tool_result":
                    tool_results.append({"name": str(event.get("name", "")), "result": str(event.get("result", ""))})
                self.write_ndjson_event(event)
            if final_text:
                agent.history.append("assistant", final_text)
                conversation_store.append_message(
                    conversation_id,
                    "assistant",
                    final_text,
                    {"run_id": run_id, "reasoning": reasoning_items, "tool_results": tool_results},
                )
        except (BrokenPipeError, ConnectionResetError):
            cancel_event.set()
        except Exception as exc:
            try:
                if agent.runs.get(run_id) is not None:
                    agent.runs.mark(run_id, "failed", str(exc))
                self.write_ndjson_event({"type": "error", "text": str(exc)})
            except (BrokenPipeError, ConnectionResetError):
                cancel_event.set()
        finally:
            self.state.finish_run(run_id)

    def handle_resume_run_stream(self) -> None:
        payload = self.read_json()
        run_id = str(payload.get("run_id", "")).strip()
        if not run_id:
            self.write_json({"ok": False, "error": "run_id is required"}, HTTPStatus.BAD_REQUEST)
            return
        agent = self.state.require_agent()
        run = agent.runs.get(run_id)
        if run is None:
            self.write_json({"ok": False, "error": "run not found"}, HTTPStatus.NOT_FOUND)
            return
        if run.get("status") != "ready_to_resume":
            self.write_json({"ok": False, "error": "run is not ready to resume"}, HTTPStatus.CONFLICT)
            return
        cancel_event = self.state.begin_run(run_id)
        conversation_id = str(run.get("conversation_id", ""))
        conversation_store = self.conversation_store()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.write_ndjson_event({"type": "run_started", "run_id": run_id, "resumed": True})
            final_text = ""
            reasoning_items: list[str] = []
            tool_results: list[dict[str, Any]] = []
            for event in agent.resume_stream(run_id, cancel_event=cancel_event):
                event_type = event.get("type")
                if event_type in {"status", "reasoning", "tool_start", "tool_result", "approval_required", "verification", "error", "cancelled", "done"}:
                    agent.run_log.append({"type": "agent_event", "event": event, "run_id": run_id, "conversation_id": conversation_id, "ui": "desktop"})
                if event_type == "done":
                    final_text = str(event.get("text", ""))
                elif event_type == "reasoning" and event.get("text"):
                    reasoning_items.append(str(event["text"]))
                elif event_type == "tool_result":
                    tool_results.append({"name": str(event.get("name", "")), "result": str(event.get("result", ""))})
                self.write_ndjson_event(event)
            if final_text:
                agent.history.append("assistant", final_text)
                conversation_store.append_message(
                    conversation_id,
                    "assistant",
                    final_text,
                    {"run_id": run_id, "reasoning": reasoning_items, "tool_results": tool_results},
                )
        except (BrokenPipeError, ConnectionResetError):
            cancel_event.set()
        except Exception as exc:
            try:
                agent.runs.mark(run_id, "failed", str(exc))
                self.write_ndjson_event({"type": "error", "text": str(exc)})
            except (BrokenPipeError, ConnectionResetError):
                cancel_event.set()
        finally:
            self.state.finish_run(run_id)


class HoyaHTTPServer(ThreadingHTTPServer):
    state: AgentServerState


def main() -> None:
    parser = argparse.ArgumentParser(description="Hoya Agent local HTTP server")
    parser.add_argument("--host", default=os.getenv("HOYA_SERVER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("HOYA_SERVER_PORT", "8787")))
    parser.add_argument("--workspace", default=os.getenv("HOYA_WORKSPACE", str(Path.cwd())))
    args, _ = parser.parse_known_args()

    server = HoyaHTTPServer((args.host, args.port), HoyaRequestHandler)
    server.state = AgentServerState(Path(args.workspace))
    print(f"Hoya Agent server listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
