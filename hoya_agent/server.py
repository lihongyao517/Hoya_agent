from __future__ import annotations

import argparse
import json
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .agent import HoyaAgent
from .config import Config, mask_secret, read_api_config_values, validate_api_config_update, write_dotenv_values
from .conversations import ConversationStore
from .memory import MemoryStore
from .user_settings import UserSettingsStore, default_settings_path
from .workspace_ops import apply_pending_operation, build_index, deny_pending_operation, import_path, load_pending_writes, search_index


class AgentServerState:
    def __init__(self, workspace: Path) -> None:
        self.lock = threading.Lock()
        self.workspace = workspace.resolve()
        self.config: Config | None = None
        self.agent: HoyaAgent | None = None
        self.error: str | None = None
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
            if parsed.path == "/api/conversations/rename":
                self.handle_rename_conversation()
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
            if parsed.path == "/api/chat":
                self.handle_chat_stream()
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
        return ConversationStore(self.state.workspace / ".hoya_conversations.json", self.state.workspace / ".hoya_conversations")

    def user_settings_store(self) -> UserSettingsStore:
        return UserSettingsStore(default_settings_path())

    def handle_workspace(self) -> None:
        payload = self.read_json()
        workspace = str(payload.get("workspace", "")).strip()
        if not workspace:
            self.write_json({"ok": False, "error": "workspace is required"}, HTTPStatus.BAD_REQUEST)
            return
        self.state.reload(Path(workspace))
        settings = self.user_settings_store().load()
        settings["last_workspace"] = str(Path(workspace).resolve())
        self.user_settings_store().save(settings)
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

    def handle_create_conversation(self) -> None:
        payload = self.read_json()
        entry = self.conversation_store().create_conversation(str(payload.get("title", "")).strip() or None)
        self.write_json({"ok": True, "conversation": entry})

    def handle_rename_conversation(self) -> None:
        payload = self.read_json()
        entry = self.conversation_store().rename_conversation(str(payload.get("id", "")), str(payload.get("title", "")))
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
        self.write_json({"ok": True, "models": store.list_models(), "active_model_id": data.get("active_model_id", "")})

    def handle_save_model(self) -> None:
        self.write_json({"ok": True, "model": self.user_settings_store().upsert_model(self.read_json())})

    def handle_select_model(self) -> None:
        payload = self.read_json()
        model = self.user_settings_store().select_model(str(payload.get("id", "")))
        updates = {
            "HOYA_LLM_PROVIDER": str(model.get("provider", "openai-compatible")),
            "HOYA_BASE_URL": str(model.get("base_url", "")),
            "HOYA_MODEL": str(model.get("model", "")),
            "HOYA_WIRE_API": str(model.get("wire_api", "chat")),
            "HOYA_REASONING_EFFORT": str(model.get("reasoning_effort", "medium")),
            "HOYA_SHOW_REASONING": "1" if model.get("show_reasoning", True) else "0",
        }
        write_dotenv_values(self.state.workspace / ".env", updates)
        self.state.reload()
        self.write_json({"ok": True, "model": model, "status": self.state.status_payload()})

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
        self.write_json(
            apply_pending_operation(
                config.workspace,
                config.pending_writes_path,
                pending_id,
                allow_shell=config.allow_shell,
            )
        )

    def handle_deny_pending(self) -> None:
        config = self.state.require_config()
        payload = self.read_json()
        pending_id = str(payload.get("id", "")).strip()
        if not pending_id:
            self.write_json({"ok": False, "error": "id is required"}, HTTPStatus.BAD_REQUEST)
            return
        self.write_json(deny_pending_operation(config.pending_writes_path, pending_id))

    def handle_chat_stream(self) -> None:
        payload = self.read_json()
        task = str(payload.get("task", "")).strip()
        conversation_store = self.conversation_store()
        conversation_id = str(payload.get("conversation_id", "")).strip() or conversation_store.ensure_default()["id"]
        if not task:
            self.write_json({"type": "error", "text": "task is required"}, HTTPStatus.BAD_REQUEST)
            return

        agent = self.state.require_agent()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        try:
            agent.history.append("user", task)
            conversation_store.append_message(conversation_id, "user", task)
            agent.run_log.append({"type": "task_start", "task": task, "conversation_id": conversation_id, "ui": "desktop"})
            final_text = ""
            for event in agent.run_stream(task, conversation_id=conversation_id):
                event_type = event.get("type")
                if event_type in {"status", "reasoning", "tool_start", "tool_result", "approval_required", "error", "done"}:
                    agent.run_log.append({"type": "agent_event", "event": event, "conversation_id": conversation_id, "ui": "desktop"})
                if event_type == "done":
                    final_text = str(event.get("text", ""))
                self.write_ndjson_event(event)
            if final_text:
                agent.history.append("assistant", final_text)
                conversation_store.append_message(conversation_id, "assistant", final_text)
        except Exception as exc:
            self.write_ndjson_event({"type": "error", "text": str(exc)})


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
