from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import os
import shutil
import stat
import threading
import time
import uuid
from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .agent import HoyaAgent
from .capabilities import discover_mcp_servers, discover_skills
from .config import Config, mask_secret, read_api_config_values, validate_api_config_update, write_dotenv_values
from .conversations import ConversationStore
from .memory import MemoryStore
from .model_discovery import discover_models
from .state_paths import app_data_dir, workspace_config_path, workspace_state_dir
from .user_settings import UserSettingsStore, default_settings_path
from .workspace_ops import (
    apply_pending_operation,
    bounded_int,
    build_index,
    delete_pending_for_runs,
    deny_pending_operation,
    finalize_pending_operation,
    import_path,
    load_pending_writes,
    search_index,
)


MAX_JSON_BODY_BYTES = 2 * 1024 * 1024


class RequestBodyTooLarge(ValueError):
    pass


def is_loopback_host(host: str) -> bool:
    if host.strip().lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip()).is_loopback
    except ValueError:
        return False


def public_model_payload(model: dict[str, Any]) -> dict[str, Any]:
    payload = {key: value for key, value in model.items() if key != "api_key"}
    payload["api_key_set"] = bool(model.get("api_key_set") or str(model.get("api_key", "")).strip())
    return payload


class AgentServerState:
    def __init__(self, workspace: Path) -> None:
        self.lock = threading.RLock()
        self.workspace = workspace.resolve()
        self.config: Config | None = None
        self.agent: HoyaAgent | None = None
        self.error: str | None = None
        self.runs_lock = threading.Lock()
        self.active_runs: dict[str, threading.Event] = {}
        self.session_api_key = os.getenv("HOYA_API_KEY", "").strip()
        self.reload()

    def reload(self, workspace: Path | None = None, *, session_api_key: str | None = None) -> None:
        with self.lock:
            if self.has_active_runs():
                raise RuntimeError("当前任务仍在运行，请先停止任务再切换工作区或配置。")
            if workspace is not None:
                self.workspace = workspace.resolve()
                self.session_api_key = ""
            if session_api_key is not None:
                self.session_api_key = session_api_key.strip()
            try:
                self.config = Config.from_env(
                    self.workspace,
                    reload_dotenv=True,
                    session_api_key=self.session_api_key,
                )
                self.agent = HoyaAgent(self.config)
                self.error = None
            except Exception as exc:
                self.config = None
                self.agent = None
                self.error = str(exc)

    def update_config(self, updates: dict[str, str], *, session_api_key: str | None = None) -> None:
        """Persist and activate config as one state-locked, rollback-safe operation."""
        with self.lock:
            if self.has_active_runs():
                raise RuntimeError("当前任务仍在运行，请先停止任务再切换工作区或配置。")
            path = workspace_config_path(self.workspace)
            original = path.read_bytes() if path.exists() else None
            previous = (self.config, self.agent, self.error, self.session_api_key)
            try:
                write_dotenv_values(path, updates)
                self.reload(session_api_key=session_api_key)
                if self.config is None or self.agent is None:
                    raise RuntimeError(self.error or "配置加载失败。")
            except Exception:
                self._restore_config_file(path, original)
                self.config, self.agent, self.error, self.session_api_key = previous
                raise

    @staticmethod
    def _restore_config_file(path: Path, original: bytes | None) -> None:
        if original is None:
            path.unlink(missing_ok=True)
            return
        temporary = path.with_suffix(path.suffix + f".{uuid.uuid4().hex}.tmp")
        temporary.write_bytes(original)
        temporary.replace(path)

    def status_payload(self) -> dict[str, Any]:
        with self.lock:
            config = self.config
            if config is None:
                return {
                    "ok": False,
                    "backend_ok": True,
                    "configured": False,
                    "workspace": str(self.workspace),
                    "error": self.error,
                }
            return {
                "ok": True,
                "backend_ok": True,
                "configured": config.configured,
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
                "permission_mode": config.permission_mode,
                "api_key_set": bool(config.api_key),
                "error": None if config.configured else "请先在设置中配置模型连接。",
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

    def require_configured_agent(self) -> HoyaAgent:
        with self.lock:
            if self.config is None or self.agent is None:
                raise RuntimeError(self.error or "Config is not loaded")
            if not self.config.configured:
                raise RuntimeError("模型尚未配置，请先在设置中填写 API 地址、模型和密钥。")
            return self.agent

    def agent_snapshot(self, *, configured: bool = False) -> tuple[Config, HoyaAgent]:
        with self.lock:
            config = self.config
            agent = self.agent
            if config is None or agent is None:
                raise RuntimeError(self.error or "Config is not loaded")
            if configured and not config.configured:
                raise RuntimeError("模型尚未配置，请先在设置中填写 API 地址、模型和密钥。")
            return config, agent

    @contextmanager
    def locked_agent(self) -> Any:
        with self.lock:
            config, agent = self.agent_snapshot()
            yield config, agent

    @contextmanager
    def locked_config(self) -> Any:
        with self.lock:
            yield self.require_config()

    def has_active_runs(self) -> bool:
        with self.runs_lock:
            return bool(self.active_runs)

    def conversation_paths(self) -> tuple[Path, Path]:
        with self.lock:
            if self.config is not None:
                return self.config.conversations_index_path, self.config.conversations_dir
            state_dir = workspace_state_dir(self.workspace)
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

    def allowed_origin(self) -> str:
        origin = self.headers.get("Origin", "").strip()
        if not origin:
            return ""
        if origin == "null":
            return origin
        parsed = urlparse(origin)
        if parsed.scheme == "file" and not parsed.netloc:
            return origin
        if parsed.scheme in {"http", "https"} and parsed.hostname in {"127.0.0.1", "localhost"}:
            return origin
        return ""

    def is_authorized(self) -> bool:
        origin = self.headers.get("Origin", "").strip()
        if origin and not self.allowed_origin():
            return False
        expected = self.server.auth_token  # type: ignore[attr-defined]
        if not expected:
            return not origin
        authorization = self.headers.get("Authorization", "")
        prefix = "Bearer "
        supplied = authorization[len(prefix) :] if authorization.startswith(prefix) else ""
        return bool(supplied) and hmac.compare_digest(supplied, expected)

    def require_authorization(self) -> bool:
        if self.is_authorized():
            return True
        self.write_json({"ok": False, "error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
        return False

    def end_headers(self) -> None:
        allowed_origin = self.allowed_origin()
        if allowed_origin:
            self.send_header("Access-Control-Allow-Origin", allowed_origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_OPTIONS(self) -> None:
        if self.headers.get("Origin", "").strip() and not self.allowed_origin():
            self.send_response(HTTPStatus.FORBIDDEN)
            self.end_headers()
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        if not self.require_authorization():
            return
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
            if parsed.path == "/api/capabilities":
                self.handle_capabilities()
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
        except (ValueError, UnicodeDecodeError) as exc:
            self.write_json({"ok": False, "error": f"Invalid request: {exc}"}, HTTPStatus.BAD_REQUEST)
        except KeyError as exc:
            self.write_json({"ok": False, "error": str(exc)}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self.write_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        if not self.require_authorization():
            return
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/workspace":
                self.handle_workspace()
                return
            if parsed.path == "/api/reload":
                with self.state.lock:
                    if not self.ensure_reload_allowed():
                        return
                    self.state.reload()
                self.write_json(self.state.status_payload())
                return
            if parsed.path == "/api/config":
                self.handle_update_config()
                return
            if parsed.path == "/api/permissions":
                self.handle_update_permissions()
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
            if parsed.path == "/api/conversations/compact":
                self.handle_compact_conversation()
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
        except RequestBodyTooLarge as exc:
            self.write_json({"ok": False, "error": str(exc)}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            self.write_json({"ok": False, "error": f"Invalid request: {exc}"}, HTTPStatus.BAD_REQUEST)
        except KeyError as exc:
            self.write_json({"ok": False, "error": str(exc)}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self.write_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def read_json(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length", "0") or "0"
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise ValueError("Content-Length must be an integer") from exc
        if length <= 0:
            return {}
        if length > MAX_JSON_BODY_BYTES:
            raise RequestBodyTooLarge(f"Request body exceeds {MAX_JSON_BODY_BYTES} bytes")
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

    def ensure_reload_allowed(self) -> bool:
        if not self.state.has_active_runs():
            return True
        self.write_json(
            {"ok": False, "error": "当前任务仍在运行，请先停止任务再切换工作区或配置。"},
            HTTPStatus.CONFLICT,
        )
        return False

    def handle_workspace(self) -> None:
        payload = self.read_json()
        workspace = str(payload.get("workspace", "")).strip()
        if not workspace:
            self.write_json({"ok": False, "error": "workspace is required"}, HTTPStatus.BAD_REQUEST)
            return
        workspace_path = Path(workspace).expanduser().resolve()
        if not workspace_path.is_dir():
            self.write_json({"ok": False, "error": "workspace directory does not exist"}, HTTPStatus.BAD_REQUEST)
            return
        with self.state.lock:
            if not self.ensure_reload_allowed():
                return
            self.state.reload(workspace_path)
            self.user_settings_store().select_project(workspace_path)
        self.write_json(self.state.status_payload())

    def handle_get_config(self) -> None:
        with self.state.lock:
            workspace = self.state.workspace
            values = read_api_config_values(workspace, session_api_key=self.state.session_api_key)
            status_error = self.state.error
        api_key = values.get("HOYA_API_KEY", "")
        self.write_json({
            "ok": True,
            "workspace": str(workspace),
            "config_path": str(workspace_config_path(workspace)),
            "status_error": status_error,
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
        with self.state.lock:
            if not self.ensure_reload_allowed():
                return
            workspace = self.state.workspace
            existing = read_api_config_values(workspace, session_api_key=self.state.session_api_key)
            updates, field_errors = validate_api_config_update(payload, existing)
            if field_errors:
                self.write_json({"ok": False, "error": "Invalid API config", "field_errors": field_errors}, HTTPStatus.BAD_REQUEST)
                return
            self.state.update_config(updates, session_api_key=updates.get("HOYA_API_KEY", ""))
        self.write_json(self.state.status_payload())

    def handle_update_permissions(self) -> None:
        payload = self.read_json()
        mode = str(payload.get("mode", "")).strip().lower()
        if mode not in {"strict", "risk", "yolo"}:
            self.write_json({"ok": False, "error": "mode must be strict, risk, or yolo"}, HTTPStatus.BAD_REQUEST)
            return
        updates = {
            "HOYA_PERMISSION_MODE": mode,
            "HOYA_ALLOW_SHELL": "1",
            "HOYA_ALLOW_DESKTOP": "1",
            "HOYA_REQUIRE_WRITE_APPROVAL": "1" if mode == "strict" else "0",
            "HOYA_REQUIRE_SHELL_APPROVAL": "1" if mode == "strict" else "0",
        }
        with self.state.lock:
            if not self.ensure_reload_allowed():
                return
            self.state.update_config(updates)
        self.write_json({"ok": True, "status": self.state.status_payload()})

    def handle_conversations(self) -> None:
        with self.state.lock:
            conversations = self.conversation_store().list_conversations()
        self.write_json({"ok": True, "conversations": conversations})

    def handle_tasks(self) -> None:
        with self.state.lock:
            tasks = self.conversation_store().list_conversations(kind="task")
        self.write_json({"ok": True, "tasks": tasks})

    def _project_tasks(self, project_path: Path) -> list[dict[str, Any]]:
        if not project_path.is_dir():
            return []
        state_dir = workspace_state_dir(project_path)
        return ConversationStore(state_dir / "conversations.json", state_dir / "conversations").list_conversations(kind="project_task")

    def handle_projects(self) -> None:
        store = self.user_settings_store()
        projects = []
        for project in store.list_projects(include_archived=True):
            project_path = Path(str(project.get("path", ""))).expanduser()
            exists = project_path.is_dir()
            projects.append(
                {
                    **project,
                    "exists": exists,
                    "tasks": self._project_tasks(project_path.resolve()) if exists else [],
                }
            )
        self.write_json({"ok": True, "projects": projects, "active_path": str(self.state.workspace)})

    def handle_capabilities(self) -> None:
        with self.state.locked_config() as config:
            skills = discover_skills(config.workspace)
            mcp_servers = discover_mcp_servers(config.workspace)
        self.write_json({"ok": True, "skills": skills, "mcp_servers": mcp_servers})

    def _fallback_workspace(self) -> Path:
        fallback = app_data_dir() / "scratch"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback.resolve()

    def _delete_project_directory(self, project_path: Path) -> None:
        if not project_path.exists():
            return
        if not project_path.is_dir():
            raise ValueError("project path is not a directory")
        if project_path.is_symlink():
            raise ValueError("refusing to delete a linked project directory")
        info = project_path.lstat()
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        if reparse_flag and getattr(info, "st_file_attributes", 0) & reparse_flag:
            raise ValueError("refusing to delete a linked project directory")
        resolved = project_path.resolve()
        anchor = Path(resolved.anchor).resolve() if resolved.anchor else None
        protected = {Path.home().resolve()}
        if anchor is not None:
            protected.add(anchor)
        if resolved in protected or resolved.parent == resolved:
            raise ValueError("refusing to delete a protected directory")
        if resolved.name.strip() in {"", ".", ".."}:
            raise ValueError("refusing to delete an invalid project directory")
        shutil.rmtree(resolved)

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
        with self.state.lock:
            if not self.ensure_reload_allowed():
                return
            if target.exists():
                self.write_json({"ok": False, "error": "project directory already exists"}, HTTPStatus.CONFLICT)
                return
            target.mkdir()
            self.state.reload(target)
            project = self.user_settings_store().remember_project(target, name)
        self.write_json({"ok": True, "project": project, "status": self.state.status_payload()})

    def handle_select_project(self) -> None:
        payload = self.read_json()
        project_path = Path(str(payload.get("path", "")).strip()).expanduser().resolve()
        if not project_path.is_dir():
            self.write_json({"ok": False, "error": "project directory does not exist"}, HTTPStatus.BAD_REQUEST)
            return
        with self.state.lock:
            if not self.ensure_reload_allowed():
                return
            self.state.reload(project_path)
            project = self.user_settings_store().select_project(project_path)
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
        if self.state.has_active_runs():
            self.write_json(
                {"ok": False, "error": "当前任务仍在运行，请先停止任务再删除项目。"},
                HTTPStatus.CONFLICT,
            )
            return
        with self.state.lock:
            if not self.ensure_reload_allowed():
                return
            project = self.user_settings_store().get_project(project_id)
            project_path = Path(str(project.get("path", ""))).expanduser().resolve()
            state_dir = workspace_state_dir(project_path)
            self._delete_project_directory(project_path)
            self.user_settings_store().remove_project(project_id)
            active_deleted = os.path.normcase(str(self.state.workspace)) == os.path.normcase(str(project_path))
            if active_deleted:
                fallback = self._fallback_workspace()
                self.state.reload(fallback)
            if state_dir.exists():
                shutil.rmtree(state_dir)
        self.write_json({"ok": True, "status": self.state.status_payload()})

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
        state_dir = workspace_state_dir(project_path)
        task = ConversationStore(state_dir / "conversations.json", state_dir / "conversations").create_conversation(title, kind="project_task")
        self.write_json({"ok": True, "task": task, "project": project})

    def handle_create_conversation(self) -> None:
        payload = self.read_json()
        with self.state.lock:
            entry = self.conversation_store().create_conversation(str(payload.get("title", "")).strip() or None)
        self.write_json({"ok": True, "conversation": entry})

    def handle_create_task(self) -> None:
        payload = self.read_json()
        title = str(payload.get("title", "")).strip() or "新任务"
        with self.state.lock:
            entry = self.conversation_store().create_conversation(title, kind="task")
        self.write_json({"ok": True, "task": entry})

    def handle_rename_conversation(self) -> None:
        payload = self.read_json()
        with self.state.lock:
            entry = self.conversation_store().rename_conversation(
                str(payload.get("id", "")),
                str(payload.get("title", "")),
            )
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
            with self.state.lock:
                entry = self.conversation_store().update_conversation(conversation_id, title=title, color=color)
        except ValueError as exc:
            self.write_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        self.write_json({"ok": True, "conversation": entry})

    def handle_delete_conversation(self) -> None:
        payload = self.read_json()
        conversation_id = str(payload.get("id", "")).strip()
        if not conversation_id:
            self.write_json({"ok": False, "error": "id is required"}, HTTPStatus.BAD_REQUEST)
            return
        if self.state.has_active_runs():
            self.write_json(
                {"ok": False, "error": "当前任务仍在运行，请先停止任务再删除。"},
                HTTPStatus.CONFLICT,
            )
            return
        with self.state.locked_agent() as (config, agent):
            if self.state.has_active_runs():
                self.write_json(
                    {"ok": False, "error": "当前任务仍在运行，请先停止任务再删除。"},
                    HTTPStatus.CONFLICT,
                )
                return
            store = ConversationStore(config.conversations_index_path, config.conversations_dir)
            if not store.contains(conversation_id):
                self.write_json({"ok": False, "error": "conversation not found"}, HTTPStatus.NOT_FOUND)
                return
            run_ids = agent.runs.delete_conversation(conversation_id)
            deleted_versions = agent.changes.delete_runs(run_ids)
            deleted_pending = delete_pending_for_runs(config.pending_writes_path, run_ids)
            deleted_history = agent.history.delete_conversation(conversation_id)
            deleted_run_log = agent.run_log.delete_conversation(conversation_id)
            store.delete_conversation(conversation_id)
            conversations = store.list_conversations()
        self.write_json(
            {
                "ok": True,
                "deleted_runs": len(run_ids),
                "deleted_versions": deleted_versions,
                "deleted_pending": deleted_pending,
                "deleted_history": deleted_history,
                "deleted_run_log": deleted_run_log,
                "conversations": conversations,
            }
        )

    def handle_compact_conversation(self) -> None:
        payload = self.read_json()
        conversation_id = str(payload.get("id", "")).strip()
        keep_last = bounded_int(payload.get("keep_last"), 12, 4, 40)
        if not conversation_id:
            self.write_json({"ok": False, "error": "id is required"}, HTTPStatus.BAD_REQUEST)
            return
        if self.state.has_active_runs():
            self.write_json(
                {"ok": False, "error": "当前任务仍在运行，请先停止任务再压缩上下文。"},
                HTTPStatus.CONFLICT,
            )
            return
        with self.state.lock:
            result = self.conversation_store().compact_conversation(conversation_id, keep_last=keep_last)
        self.write_json(result)

    def handle_conversation_messages(self, query: str) -> None:
        params = parse_qs(query)
        limit = int(params.get("limit", ["200"])[0])
        with self.state.lock:
            store = self.conversation_store()
            conversation_id = params.get("id", [""])[0] or store.ensure_default()["id"]
            messages = store.messages(conversation_id, limit=limit)
        self.write_json({"ok": True, "id": conversation_id, "messages": messages})

    def handle_memory(self) -> None:
        with self.state.locked_config() as config:
            memory = MemoryStore(config.memory_path).load()
        self.write_json({"ok": True, "memory": memory})

    def handle_add_memory(self) -> None:
        payload = self.read_json()
        text = str(payload.get("text", "")).strip()
        if not text:
            self.write_json({"ok": False, "error": "text is required"}, HTTPStatus.BAD_REQUEST)
            return
        with self.state.locked_config() as config:
            entry = MemoryStore(config.memory_path).add(text)
        self.write_json({"ok": True, "entry": entry})

    def handle_delete_memory(self) -> None:
        payload = self.read_json()
        identifier = str(payload.get("id") or payload.get("created_at") or "")
        with self.state.locked_config() as config:
            store = MemoryStore(config.memory_path)
            store.delete(identifier)
            memory = store.load()
        self.write_json({"ok": True, "memory": memory})

    def handle_models(self) -> None:
        store = self.user_settings_store()
        data = store.load()
        self.write_json({"ok": True, "models": [public_model_payload(item) for item in store.list_models()], "active_model_id": data.get("active_model_id", "")})

    def handle_save_model(self) -> None:
        payload = self.read_json()
        with self.state.lock:
            existing = read_api_config_values(self.state.workspace, session_api_key=self.state.session_api_key)
        updates, field_errors = validate_api_config_update(payload, existing)
        field_errors.pop("api_key", None)
        if field_errors:
            self.write_json({"ok": False, "error": "Invalid model preset", "field_errors": field_errors}, HTTPStatus.BAD_REQUEST)
            return
        model = self.user_settings_store().upsert_model(
            {
                **payload,
                "provider": updates["HOYA_LLM_PROVIDER"],
                "base_url": updates["HOYA_BASE_URL"],
                "model": updates["HOYA_MODEL"],
                "wire_api": updates["HOYA_WIRE_API"],
                "reasoning_effort": updates["HOYA_REASONING_EFFORT"],
                "show_reasoning": updates["HOYA_SHOW_REASONING"] == "1",
            }
        )
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
        store = self.user_settings_store()
        model_id = str(payload.get("id", "")).strip()
        model = store.get_model(model_id)
        updates = {
            "HOYA_LLM_PROVIDER": str(model.get("provider", "openai-compatible")),
            "HOYA_BASE_URL": str(model.get("base_url", "")),
            "HOYA_MODEL": str(model.get("model", "")),
            "HOYA_WIRE_API": str(model.get("wire_api", "chat")),
            "HOYA_REASONING_EFFORT": str(model.get("reasoning_effort", "medium")),
            "HOYA_SHOW_REASONING": "1" if model.get("show_reasoning", True) else "0",
        }
        _validated, field_errors = validate_api_config_update(
            {
                "provider": updates["HOYA_LLM_PROVIDER"],
                "base_url": updates["HOYA_BASE_URL"],
                "model": updates["HOYA_MODEL"],
                "wire_api": updates["HOYA_WIRE_API"],
                "reasoning_effort": updates["HOYA_REASONING_EFFORT"],
                "show_reasoning": updates["HOYA_SHOW_REASONING"] == "1",
            },
            {},
        )
        field_errors.pop("api_key", None)
        if field_errors:
            self.write_json({"ok": False, "error": "Invalid model preset", "field_errors": field_errors}, HTTPStatus.BAD_REQUEST)
            return
        with self.state.lock:
            if not self.ensure_reload_allowed():
                return
            self.state.update_config(updates, session_api_key="")
            store.select_model(model_id)
        self.write_json({"ok": True, "model": public_model_payload(model), "status": self.state.status_payload()})

    def handle_delete_model(self) -> None:
        payload = self.read_json()
        self.user_settings_store().delete_model(str(payload.get("id", "")))
        self.write_json({"ok": True})

    def handle_history(self, query: str) -> None:
        limit = bounded_int(parse_qs(query).get("limit", ["24"])[0], 24, 1, 200)
        with self.state.locked_agent() as (config, agent):
            entries = agent.history.recent(limit)
        self.write_json({"ok": True, "workspace": str(config.workspace), "entries": entries})

    def handle_pending(self) -> None:
        with self.state.locked_config() as config:
            entries = load_pending_writes(config.pending_writes_path)
        self.write_json({"ok": True, "entries": entries})

    def handle_runs(self, query: str) -> None:
        params = parse_qs(query)
        conversation_id = params.get("conversation_id", [""])[0]
        limit = bounded_int(params.get("limit", ["20"])[0], 20, 1, 200)
        with self.state.locked_agent() as (_config, agent):
            runs = agent.runs.list(conversation_id, limit)
        self.write_json({"ok": True, "runs": runs, "latest": runs[0] if runs else None})

    def handle_versions(self, query: str) -> None:
        params = parse_qs(query)
        run_id = params.get("run_id", [""])[0]
        limit = bounded_int(params.get("limit", ["50"])[0], 50, 1, 500)
        with self.state.locked_agent() as (_config, agent):
            versions = agent.changes.list(run_id, limit)
        self.write_json({"ok": True, "versions": versions})

    def handle_search(self, query: str) -> None:
        params = parse_qs(query)
        q = params.get("q", [""])[0]
        limit = bounded_int(params.get("limit", ["12"])[0], 12, 1, 100)
        with self.state.locked_config() as config:
            result = search_index(config.index_path, q, limit=limit)
        self.write_json(result)

    def handle_import(self) -> None:
        payload = self.read_json()
        source = str(payload.get("source", "")).strip()
        if not source:
            self.write_json({"ok": False, "error": "source is required"}, HTTPStatus.BAD_REQUEST)
            return
        with self.state.locked_config() as config:
            result = import_path(source, config.imports_dir)
        self.write_json(result)

    def handle_index(self) -> None:
        with self.state.locked_config() as config:
            payload = build_index(config.workspace, config.index_path)
        self.write_json({"ok": True, "files": len(payload.get("files", [])), "truncated": payload.get("truncated", False)})

    def handle_apply_pending(self) -> None:
        payload = self.read_json()
        pending_id = str(payload.get("id", "")).strip()
        if not pending_id:
            self.write_json({"ok": False, "error": "id is required"}, HTTPStatus.BAD_REQUEST)
            return
        with self.state.locked_agent() as (config, agent):
            pending = next(
                (entry for entry in load_pending_writes(config.pending_writes_path) if entry.get("id") == pending_id),
                None,
            )
            pending_run_id = str((pending or {}).get("run_id", ""))
            if pending_run_id:
                run = agent.runs.get(pending_run_id)
                approval = (run or {}).get("approval_result") or {}
                already_resolved = (
                    (pending or {}).get("status") == "applied"
                    and (run or {}).get("status") == "ready_to_resume"
                    and approval.get("decision") == "approved"
                )
                if already_resolved:
                    stored_result = (pending or {}).get("result") or {}
                    finalize_pending_operation(config.pending_writes_path, pending_id)
                    self.write_json({**stored_result, "resumable": True, "already_resolved": True})
                    return
                if (
                    run is None
                    or run.get("status") != "waiting_approval"
                    or run.get("pending_approval_id") != pending_id
                ):
                    self.write_json(
                        {"ok": False, "error": "该审批不再对应等待中的任务，未执行任何操作。"},
                        HTTPStatus.CONFLICT,
                    )
                    return
            result = apply_pending_operation(
                config.workspace,
                config.pending_writes_path,
                pending_id,
                allow_shell=config.allow_shell,
                change_store=agent.changes,
            )
            run_id = str(result.get("run_id", ""))
            if result.get("consumed") and run_id and agent.runs.get(run_id) is not None:
                if result.get("version_id"):
                    agent._register_change(run_id, result)
                agent.runs.resolve_approval(run_id, "approved", result)
                finalize_pending_operation(config.pending_writes_path, pending_id)
                result["resumable"] = True
            elif result.get("consumed"):
                finalize_pending_operation(config.pending_writes_path, pending_id)
        self.write_json(result)

    def handle_deny_pending(self) -> None:
        payload = self.read_json()
        pending_id = str(payload.get("id", "")).strip()
        if not pending_id:
            self.write_json({"ok": False, "error": "id is required"}, HTTPStatus.BAD_REQUEST)
            return
        with self.state.locked_agent() as (config, agent):
            pending = next(
                (entry for entry in load_pending_writes(config.pending_writes_path) if entry.get("id") == pending_id),
                None,
            )
            pending_run_id = str((pending or {}).get("run_id", ""))
            if pending_run_id:
                run = agent.runs.get(pending_run_id)
                approval = (run or {}).get("approval_result") or {}
                already_resolved = (
                    (pending or {}).get("status") == "denied"
                    and (run or {}).get("status") == "ready_to_resume"
                    and approval.get("decision") == "denied"
                )
                if already_resolved:
                    stored_result = (pending or {}).get("result") or {}
                    finalize_pending_operation(config.pending_writes_path, pending_id)
                    self.write_json({**stored_result, "resumable": True, "already_resolved": True})
                    return
                if (
                    run is None
                    or run.get("status") != "waiting_approval"
                    or run.get("pending_approval_id") != pending_id
                ):
                    self.write_json(
                        {"ok": False, "error": "该审批不再对应等待中的任务，未更改任何状态。"},
                        HTTPStatus.CONFLICT,
                    )
                    return
            result = deny_pending_operation(config.pending_writes_path, pending_id)
            run_id = str(result.get("run_id", ""))
            if run_id and agent.runs.get(run_id) is not None:
                denial_result = {**result, "ok": False, "denied": True, "error": "operation denied by user"}
                agent.runs.resolve_approval(run_id, "denied", denial_result)
                finalize_pending_operation(config.pending_writes_path, pending_id)
                result["resumable"] = True
            elif result.get("consumed"):
                finalize_pending_operation(config.pending_writes_path, pending_id)
        self.write_json(result)

    def handle_rollback_version(self) -> None:
        payload = self.read_json()
        version_id = str(payload.get("version_id", "")).strip()
        if not version_id:
            self.write_json({"ok": False, "error": "version_id is required"}, HTTPStatus.BAD_REQUEST)
            return
        with self.state.locked_agent() as (_config, agent):
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
        if not task:
            self.write_json({"type": "error", "text": "task is required"}, HTTPStatus.BAD_REQUEST)
            return
        if len(run_id) > 128 or any(not (ch.isalnum() or ch in "-_") for ch in run_id):
            self.write_json({"type": "error", "text": "run_id is invalid"}, HTTPStatus.BAD_REQUEST)
            return

        with self.state.locked_agent() as (config, agent):
            if not config.configured:
                self.write_json(
                    {"ok": False, "error": "模型尚未配置，请先在设置中填写 API 地址、模型和密钥。"},
                    HTTPStatus.PRECONDITION_REQUIRED,
                )
                return
            conversation_store = ConversationStore(config.conversations_index_path, config.conversations_dir)
            conversation_id = str(payload.get("conversation_id", "")).strip() or conversation_store.ensure_default()["id"]
            if not conversation_store.contains(conversation_id):
                self.write_json({"ok": False, "error": "conversation not found"}, HTTPStatus.NOT_FOUND)
                return
            cancel_event = self.state.begin_run(run_id)
        started_at = time.monotonic()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        try:
            self.write_ndjson_event({"type": "run_started", "run_id": run_id})
            agent.history.append("user", task, {"conversation_id": conversation_id, "run_id": run_id})
            conversation_store.append_message(conversation_id, "user", task)
            agent.run_log.append({"type": "task_start", "task": task, "run_id": run_id, "conversation_id": conversation_id, "ui": "desktop"})
            final_text = ""
            duration_ms = 0
            reasoning_items: list[str] = []
            tool_results: list[dict[str, Any]] = []
            for event in agent.run_stream(task, conversation_id=conversation_id, cancel_event=cancel_event, run_id=run_id):
                event_type = event.get("type")
                if event_type in {"status", "reasoning", "tool_start", "tool_result", "approval_required", "error", "cancelled", "done"}:
                    agent.run_log.append({"type": "agent_event", "event": event, "run_id": run_id, "conversation_id": conversation_id, "ui": "desktop"})
                if event_type == "done":
                    final_text = str(event.get("text", ""))
                    duration_ms = max(0, round((time.monotonic() - started_at) * 1000))
                    event = {**event, "duration_ms": duration_ms}
                elif event_type == "reasoning" and event.get("text"):
                    reasoning_items.append(str(event["text"]))
                elif event_type == "tool_result":
                    tool_results.append({"name": str(event.get("name", "")), "result": str(event.get("result", ""))})
                self.write_ndjson_event(event)
            if final_text and conversation_store.contains(conversation_id):
                agent.history.append(
                    "assistant",
                    final_text,
                    {"conversation_id": conversation_id, "run_id": run_id},
                )
                conversation_store.append_message(
                    conversation_id,
                    "assistant",
                    final_text,
                    {"run_id": run_id, "reasoning": reasoning_items, "tool_results": tool_results, "duration_ms": duration_ms},
                )
        except (BrokenPipeError, ConnectionResetError):
            cancel_event.set()
        except Exception as exc:
            try:
                error_text = str(exc)
                if agent.runs.get(run_id) is not None:
                    agent.runs.mark(run_id, "failed", error_text)
                if conversation_store.contains(conversation_id):
                    conversation_store.append_message(
                        conversation_id,
                        "error",
                        error_text,
                        {"run_id": run_id, "error": True},
                    )
                self.write_ndjson_event({"type": "error", "text": error_text})
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
        with self.state.locked_agent() as (config, agent):
            if not config.configured:
                self.write_json(
                    {"ok": False, "error": "模型尚未配置，请先在设置中填写 API 地址、模型和密钥。"},
                    HTTPStatus.PRECONDITION_REQUIRED,
                )
                return
            run = agent.runs.get(run_id)
            if run is None:
                self.write_json({"ok": False, "error": "run not found"}, HTTPStatus.NOT_FOUND)
                return
            if run.get("status") != "ready_to_resume":
                self.write_json({"ok": False, "error": "run is not ready to resume"}, HTTPStatus.CONFLICT)
                return
            cancel_event = self.state.begin_run(run_id)
        started_at = time.monotonic()
        conversation_id = str(run.get("conversation_id", ""))
        conversation_store = ConversationStore(config.conversations_index_path, config.conversations_dir)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.write_ndjson_event({"type": "run_started", "run_id": run_id, "resumed": True})
            final_text = ""
            duration_ms = 0
            reasoning_items: list[str] = []
            tool_results: list[dict[str, Any]] = []
            for event in agent.resume_stream(run_id, cancel_event=cancel_event):
                event_type = event.get("type")
                if event_type in {"status", "reasoning", "tool_start", "tool_result", "approval_required", "verification", "error", "cancelled", "done"}:
                    agent.run_log.append({"type": "agent_event", "event": event, "run_id": run_id, "conversation_id": conversation_id, "ui": "desktop"})
                if event_type == "done":
                    final_text = str(event.get("text", ""))
                    duration_ms = max(0, round((time.monotonic() - started_at) * 1000))
                    event = {**event, "duration_ms": duration_ms}
                elif event_type == "reasoning" and event.get("text"):
                    reasoning_items.append(str(event["text"]))
                elif event_type == "tool_result":
                    tool_results.append({"name": str(event.get("name", "")), "result": str(event.get("result", ""))})
                self.write_ndjson_event(event)
            if final_text and conversation_store.contains(conversation_id):
                agent.history.append(
                    "assistant",
                    final_text,
                    {"conversation_id": conversation_id, "run_id": run_id},
                )
                conversation_store.append_message(
                    conversation_id,
                    "assistant",
                    final_text,
                    {"run_id": run_id, "reasoning": reasoning_items, "tool_results": tool_results, "duration_ms": duration_ms},
                )
        except (BrokenPipeError, ConnectionResetError):
            cancel_event.set()
        except Exception as exc:
            try:
                error_text = str(exc)
                if agent.runs.get(run_id) is not None:
                    agent.runs.mark(run_id, "failed", error_text)
                if conversation_store.contains(conversation_id):
                    conversation_store.append_message(
                        conversation_id,
                        "error",
                        error_text,
                        {"run_id": run_id, "error": True},
                    )
                self.write_ndjson_event({"type": "error", "text": error_text})
            except (BrokenPipeError, ConnectionResetError):
                cancel_event.set()
        finally:
            self.state.finish_run(run_id)


class HoyaHTTPServer(ThreadingHTTPServer):
    state: AgentServerState
    auth_token: str


def main() -> None:
    parser = argparse.ArgumentParser(description="Hoya Agent local HTTP server")
    parser.add_argument("--host", default=os.getenv("HOYA_SERVER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("HOYA_SERVER_PORT", "8787")))
    parser.add_argument("--workspace", default=os.getenv("HOYA_WORKSPACE", str(Path.cwd())))
    args, _ = parser.parse_known_args()

    auth_token = os.getenv("HOYA_SERVER_TOKEN", "").strip()
    if not auth_token and not is_loopback_host(args.host):
        parser.error("HOYA_SERVER_TOKEN is required when binding outside loopback")
    server = HoyaHTTPServer((args.host, args.port), HoyaRequestHandler)
    server.state = AgentServerState(Path(args.workspace))
    server.auth_token = auth_token
    bound_host, bound_port = server.server_address[:2]
    ready = json.dumps({"host": bound_host, "port": bound_port}, ensure_ascii=True, separators=(",", ":"))
    print(f"HOYA_SERVER_READY {ready}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
