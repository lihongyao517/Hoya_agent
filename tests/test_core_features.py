from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
from pathlib import Path

from hoya_agent.agent import HoyaAgent
from hoya_agent.config import ANTHROPIC_DEFAULT_BASE_URL, Config, validate_api_config_update, write_dotenv_values
from hoya_agent.conversations import ConversationStore
from hoya_agent.llm import LLMClient, connection_error_message, urlopen_with_ollama_retry
from hoya_agent.memory import MemoryStore
from hoya_agent.model_discovery import discover_models
from hoya_agent.run_state import ChangeStore, RunStore
from hoya_agent.server import AgentServerState, HoyaHTTPServer, HoyaRequestHandler, is_loopback_host, public_model_payload
from hoya_agent.state_paths import migrate_workspace_state, workspace_config_path, workspace_state_dir
from hoya_agent.tools import assess_shell_risk
from hoya_agent.user_settings import UserSettingsStore
from hoya_agent.workspace_ops import (
    HistoryStore,
    apply_pending_operation,
    build_index,
    delete_pending_for_runs,
    finalize_pending_operation,
    load_pending_writes,
    search_index,
)


class ConversationStoreTests(unittest.TestCase):
    def test_rename_and_color_are_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ConversationStore(root / "conversations.json", root / "messages")
            conversation = store.create_conversation("Original")

            store.rename_conversation(conversation["id"], "Renamed")
            store.set_conversation_color(conversation["id"], "purple")

            loaded = store.list_conversations()[0]
            self.assertEqual(loaded["title"], "Renamed")
            self.assertEqual(loaded["color"], "purple")

    def test_rejects_unknown_color(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ConversationStore(root / "conversations.json", root / "messages")
            conversation = store.create_conversation()

            with self.assertRaises(ValueError):
                store.set_conversation_color(conversation["id"], "url(javascript:alert(1))")

    def test_existing_conversations_are_exposed_as_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ConversationStore(root / "conversations.json", root / "messages")
            store.create_conversation("Task")

            loaded = store.list_conversations()[0]
            self.assertEqual(loaded["kind"], "task")
            self.assertEqual(loaded["status"], "open")

    def test_message_metadata_is_persisted_for_reasoning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ConversationStore(root / "conversations.json", root / "messages")
            conversation = store.create_conversation("Task")

            store.append_message(
                conversation["id"],
                "assistant",
                "完成",
                {"reasoning": ["检查上下文", "验证结果"], "tool_results": [{"name": "read_file", "result": "ok"}]},
            )

            loaded = store.messages(conversation["id"])[0]
            self.assertEqual(loaded["meta"]["reasoning"], ["检查上下文", "验证结果"])
            self.assertEqual(loaded["meta"]["tool_results"][0]["name"], "read_file")

    def test_conversation_ids_cannot_escape_the_message_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ConversationStore(root / "conversations.json", root / "messages")

            with self.assertRaises(ValueError):
                store.messages("../outside")


class ProjectSettingsTests(unittest.TestCase):
    def test_projects_are_remembered_and_reselected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = UserSettingsStore(root / "settings.json")
            project = root / "demo"
            project.mkdir()

            first = settings.remember_project(project, "Demo")
            second = settings.remember_project(project, "Renamed")

            self.assertEqual(first["id"], second["id"])
            self.assertEqual(settings.load()["last_workspace"], str(project.resolve()))
            self.assertEqual(settings.list_projects()[0]["name"], "Renamed")

    def test_projects_can_be_archived_renamed_and_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = UserSettingsStore(root / "settings.json")
            project_path = root / "demo"
            project_path.mkdir()
            project = settings.remember_project(project_path, "Demo")

            updated = settings.update_project(project["id"], name="Client", archived=True)

            self.assertEqual(updated["name"], "Client")
            self.assertTrue(updated["archived"])
            self.assertEqual(settings.list_projects(), [])
            self.assertEqual(settings.list_projects(include_archived=True)[0]["id"], project["id"])

            settings.remove_project(project["id"])
            self.assertEqual(settings.list_projects(include_archived=True), [])

    def test_selecting_project_does_not_change_project_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = UserSettingsStore(root / "settings.json")
            first_path = root / "first"
            second_path = root / "second"
            first_path.mkdir()
            second_path.mkdir()
            first = settings.remember_project(first_path, "First")
            second = settings.remember_project(second_path, "Second")
            data = settings.load()
            for project in data["projects"]:
                project["updated_at"] = "2026-01-01T00:00:00" if project["id"] == first["id"] else "2026-01-02T00:00:00"
            settings.save(data)

            before = [project["id"] for project in settings.list_projects()]
            selected = settings.select_project(first_path)
            after = [project["id"] for project in settings.list_projects()]

            self.assertEqual(before, [second["id"], first["id"]])
            self.assertEqual(after, before)
            self.assertEqual(selected["id"], first["id"])
            self.assertEqual(settings.load()["last_workspace"], str(first_path.resolve()))

    def test_model_presets_never_persist_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            store = UserSettingsStore(path)
            saved = store.upsert_model(
                {
                    "name": "Relay",
                    "provider": "openai-compatible",
                    "base_url": "https://relay.example.com/v1",
                    "model": "gpt-test",
                    "api_key": "sk-test-key",
                }
            )

            reloaded = UserSettingsStore(path)

            self.assertNotIn("api_key", saved)
            self.assertNotIn("api_key", reloaded.list_models()[0])
            self.assertNotIn("sk-test-key", path.read_text(encoding="utf-8"))
            public = public_model_payload(saved)
            self.assertNotIn("api_key", public)
            self.assertTrue(public["api_key_set"])

    def test_legacy_model_secret_is_removed_during_load(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text(
                json.dumps({"models": [{"id": "model-1", "api_key": "legacy-secret"}]}),
                encoding="utf-8",
            )

            loaded = UserSettingsStore(path).load()

            self.assertNotIn("api_key", loaded["models"][0])
            self.assertTrue(loaded["models"][0]["api_key_set"])
            self.assertNotIn("legacy-secret", path.read_text(encoding="utf-8"))


class ApiConfigurationTests(unittest.TestCase):
    def test_anthropic_defaults_to_messages_api(self) -> None:
        updates, errors = validate_api_config_update(
            {
                "provider": "anthropic",
                "api_key": "test-key",
                "base_url": "",
                "model": "claude-test",
                "wire_api": "chat",
            },
            {},
        )

        self.assertEqual(errors, {})
        self.assertEqual(updates["HOYA_BASE_URL"], ANTHROPIC_DEFAULT_BASE_URL)
        self.assertEqual(updates["HOYA_WIRE_API"], "messages")

    def test_first_install_keeps_backend_state_available(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                state = AgentServerState(workspace)

            status = state.status_payload()
            self.assertTrue(status["ok"])
            self.assertTrue(status["backend_ok"])
            self.assertFalse(status["configured"])
            self.assertIsNotNone(state.require_agent())

    def test_workspace_state_and_nonsecret_config_leave_project(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            legacy_state = workspace / ".hoya"
            legacy_state.mkdir(parents=True)
            (legacy_state / "memory.json").write_text('[{"text":"remember"}]', encoding="utf-8")
            (workspace / ".env").write_text(
                "HOYA_LLM_PROVIDER=openai-compatible\n"
                "HOYA_API_KEY=legacy-project-secret\n"
                "HOYA_BASE_URL=https://relay.example.com/v1\n"
                "HOYA_MODEL=gpt-test\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                config = Config.from_env(workspace, reload_dotenv=True, session_api_key="session-secret")
                private_config = workspace_config_path(workspace)

            self.assertTrue(config.configured)
            self.assertEqual(config.api_key, "session-secret")
            self.assertTrue(config.memory_path.is_relative_to(root / "data"))
            self.assertFalse(legacy_state.joinpath("memory.json").exists())
            self.assertNotIn("HOYA_API_KEY", private_config.read_text(encoding="utf-8"))
            self.assertIn("HOYA_MODEL=gpt-test", private_config.read_text(encoding="utf-8"))

    def test_legacy_state_is_copied_out_when_move_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            legacy = workspace / ".hoya_memory.json"
            legacy.write_text('[{"text":"remember"}]', encoding="utf-8")

            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                with patch("hoya_agent.state_paths.shutil.move", side_effect=OSError("locked")):
                    migrated = migrate_workspace_state(workspace, "memory.json", ".hoya_memory.json")

            self.assertTrue(migrated.is_relative_to(root / "data"))
            self.assertEqual(migrated.read_text(encoding="utf-8"), '[{"text":"remember"}]')
            self.assertFalse(legacy.exists())

    def test_split_legacy_state_is_merged_without_overwriting_current_entries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            legacy = workspace / ".hoya_memory.json"
            legacy.write_text('[{"id":"old"},{"id":"same","value":"legacy"}]', encoding="utf-8")
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                current = workspace_state_dir(workspace) / "memory.json"
                current.write_text('[{"id":"same","value":"current"}]', encoding="utf-8")
                migrated = migrate_workspace_state(workspace, "memory.json", ".hoya_memory.json")

            self.assertEqual(
                json.loads(migrated.read_text(encoding="utf-8")),
                [{"id": "old"}, {"id": "same", "value": "current"}],
            )
            self.assertFalse(legacy.exists())

    def test_legacy_state_leaf_symlink_is_not_migrated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            external = root / "external.json"
            external.write_text('[{"text":"outside"}]', encoding="utf-8")
            try:
                os.symlink(external, workspace / ".hoya_memory.json")
            except OSError as exc:
                self.skipTest(f"symlinks are unavailable: {exc}")

            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                migrated = migrate_workspace_state(workspace, "memory.json", ".hoya_memory.json")

            self.assertFalse(migrated.exists())
            self.assertEqual(external.read_text(encoding="utf-8"), '[{"text":"outside"}]')

    def test_legacy_state_parent_directory_symlink_is_not_migrated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            external = root / "external"
            external.mkdir()
            (external / "history.jsonl").write_text('{"outside":true}\n', encoding="utf-8")
            try:
                os.symlink(external, workspace / ".hoya", target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"directory symlinks are unavailable: {exc}")

            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                migrated = migrate_workspace_state(workspace, "history.jsonl", ".hoya/history.jsonl")

            self.assertFalse(migrated.exists())
            self.assertTrue((external / "history.jsonl").exists())

    def test_legacy_state_tree_with_hard_link_is_not_migrated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            legacy = workspace / ".hoya_conversations"
            legacy.mkdir(parents=True)
            external = root / "external.jsonl"
            external.write_text('{"outside":true}\n', encoding="utf-8")
            os.link(external, legacy / "linked.jsonl")

            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                migrated = migrate_workspace_state(workspace, "conversations", ".hoya_conversations")

            self.assertFalse(migrated.exists())
            self.assertTrue(legacy.exists())
            self.assertEqual(external.read_text(encoding="utf-8"), '{"outside":true}\n')

    def test_config_update_is_rejected_before_disk_write_while_run_is_active(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                state = AgentServerState(workspace)
                config_path = workspace_config_path(workspace)
                original = config_path.read_bytes() if config_path.exists() else None
                state.begin_run("active-run")
                try:
                    with self.assertRaises(RuntimeError):
                        state.update_config({"HOYA_LLM_PROVIDER": "ollama"})
                finally:
                    state.finish_run("active-run")

            self.assertEqual(config_path.read_bytes() if config_path.exists() else None, original)

    def test_failed_config_reload_restores_file_and_live_agent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                state = AgentServerState(workspace)
                old_agent = state.agent
                old_config = state.config
                old_error = state.error
                old_session_api_key = state.session_api_key
                config_path = workspace_config_path(workspace)
                original = config_path.read_bytes() if config_path.exists() else None
                with patch("hoya_agent.server.HoyaAgent", side_effect=RuntimeError("reload failed")):
                    with self.assertRaises(RuntimeError):
                        state.update_config({"HOYA_LLM_PROVIDER": "ollama"}, session_api_key="new-secret")

            self.assertIs(state.agent, old_agent)
            self.assertIs(state.config, old_config)
            self.assertEqual(state.error, old_error)
            self.assertEqual(state.session_api_key, old_session_api_key)
            self.assertEqual(config_path.read_bytes() if config_path.exists() else None, original)

    def test_permission_settings_are_persisted_and_loaded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                path = workspace_config_path(workspace)
                write_dotenv_values(
                    path,
                    {
                        "HOYA_LLM_PROVIDER": "ollama",
                        "HOYA_PERMISSION_MODE": "strict",
                        "HOYA_ALLOW_SHELL": "1",
                        "HOYA_ALLOW_DESKTOP": "1",
                        "HOYA_REQUIRE_WRITE_APPROVAL": "1",
                        "HOYA_REQUIRE_SHELL_APPROVAL": "1",
                    },
                )
                config = Config.from_env(workspace, reload_dotenv=True)

            self.assertEqual(config.permission_mode, "strict")
            self.assertTrue(config.allow_shell)
            self.assertTrue(config.allow_desktop)
            self.assertTrue(config.require_write_approval)
            self.assertTrue(config.require_shell_approval)

    def test_api_key_can_be_cleared_without_persisting_a_placeholder(self) -> None:
        updates, errors = validate_api_config_update(
            {
                "provider": "openai-compatible",
                "clear_api_key": True,
                "base_url": "https://relay.example.com/v1",
                "model": "gpt-test",
                "wire_api": "chat",
            },
            {"HOYA_API_KEY": "old-session-secret"},
        )

        self.assertEqual(errors, {})
        self.assertEqual(updates["HOYA_API_KEY"], "")


class ServerSecurityTests(unittest.TestCase):
    def test_only_loopback_bind_addresses_are_recognized_without_a_token(self) -> None:
        self.assertTrue(is_loopback_host("127.0.0.1"))
        self.assertTrue(is_loopback_host("::1"))
        self.assertTrue(is_loopback_host("localhost"))
        self.assertFalse(is_loopback_host("0.0.0.0"))

    def test_tokenless_server_rejects_browser_origins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                server = HoyaHTTPServer(("127.0.0.1", 0), HoyaRequestHandler)
                server.state = AgentServerState(workspace)
                server.auth_token = ""
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                url = f"http://127.0.0.1:{server.server_address[1]}/api/health"
                try:
                    with urllib.request.urlopen(url, timeout=2) as response:
                        self.assertTrue(json.loads(response.read())["ok"])
                    request = urllib.request.Request(url, headers={"Origin": "null"})
                    with self.assertRaises(urllib.error.HTTPError) as unauthorized:
                        urllib.request.urlopen(request, timeout=2)
                    self.assertEqual(unauthorized.exception.code, 401)
                    unauthorized.exception.close()
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)
    def test_server_requires_bearer_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                server = HoyaHTTPServer(("127.0.0.1", 0), HoyaRequestHandler)
                server.state = AgentServerState(workspace)
                server.auth_token = "test-server-token"
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                url = f"http://127.0.0.1:{server.server_address[1]}/api/health"
                try:
                    with self.assertRaises(urllib.error.HTTPError) as unauthorized:
                        urllib.request.urlopen(url, timeout=2)
                    self.assertEqual(unauthorized.exception.code, 401)
                    unauthorized.exception.close()

                    request = urllib.request.Request(
                        url,
                        headers={"Authorization": "Bearer test-server-token"},
                    )
                    with urllib.request.urlopen(request, timeout=2) as response:
                        self.assertEqual(json.loads(response.read())["ok"], True)
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_config_endpoint_keeps_api_key_in_memory_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                server = HoyaHTTPServer(("127.0.0.1", 0), HoyaRequestHandler)
                server.state = AgentServerState(workspace)
                server.auth_token = "test-server-token"
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                payload = json.dumps(
                    {
                        "provider": "openai-compatible",
                        "api_key": "session-only-secret",
                        "base_url": "https://relay.example.com/v1",
                        "model": "gpt-test",
                        "wire_api": "chat",
                    }
                ).encode()
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_address[1]}/api/config",
                    data=payload,
                    method="POST",
                    headers={
                        "Authorization": "Bearer test-server-token",
                        "Content-Type": "application/json",
                    },
                )
                try:
                    with urllib.request.urlopen(request, timeout=2) as response:
                        self.assertTrue(json.loads(response.read())["configured"])
                    self.assertEqual(server.state.session_api_key, "session-only-secret")
                    config_text = workspace_config_path(workspace).read_text(encoding="utf-8")
                    self.assertNotIn("session-only-secret", config_text)
                    self.assertFalse((workspace / ".env").exists())
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_server_rejects_oversized_json_before_reading_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                server = HoyaHTTPServer(("127.0.0.1", 0), HoyaRequestHandler)
                server.state = AgentServerState(workspace)
                server.auth_token = "test-server-token"
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_address[1]}/api/config",
                    data=b"{}",
                    method="POST",
                    headers={
                        "Authorization": "Bearer test-server-token",
                        "Content-Type": "application/json",
                        "Content-Length": str(2 * 1024 * 1024 + 1),
                    },
                )
                try:
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(request, timeout=2)
                    self.assertEqual(error.exception.code, 413)
                    error.exception.close()
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_server_query_limits_are_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                server = HoyaHTTPServer(("127.0.0.1", 0), HoyaRequestHandler)
                server.state = AgentServerState(workspace)
                server.auth_token = "test-server-token"
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_address[1]}/api/runs?limit=-1000",
                    headers={"Authorization": "Bearer test-server-token"},
                )
                try:
                    with urllib.request.urlopen(request, timeout=2) as response:
                        self.assertTrue(json.loads(response.read())["ok"])
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)


class ToolSecurityTests(unittest.TestCase):
    def test_shell_risk_detection_handles_aliases_and_spacing(self) -> None:
        for command in ["rm\tsecret.txt", "REG ADD HKCU\\Demo", "Invoke-RestMethod https://example.test"]:
            risk = assess_shell_risk(command)
            self.assertEqual(risk["level"], "high")
            self.assertFalse(risk["allowed"])


class LLMClientTests(unittest.TestCase):
    def make_client(self, **overrides: str) -> LLMClient:
        values = {
            "api_key": "test-key",
            "base_url": ANTHROPIC_DEFAULT_BASE_URL,
            "model": "claude-test",
            "provider": "anthropic",
            "wire_api": "messages",
        }
        values.update(overrides)
        return LLMClient(**values)

    def test_endpoint_urls_support_direct_and_relay_addresses(self) -> None:
        self.assertEqual(self.make_client().endpoint_url(), "https://api.anthropic.com/v1/messages")
        self.assertEqual(
            self.make_client(base_url="https://relay.example.com/anthropic/v1").endpoint_url(),
            "https://relay.example.com/anthropic/v1/messages",
        )
        self.assertEqual(
            self.make_client(base_url="https://relay.example.com/v1/messages").endpoint_url(),
            "https://relay.example.com/v1/messages",
        )
        openai = self.make_client(
            provider="openai-compatible",
            wire_api="chat",
            base_url="https://relay.example.com/openai/v1",
        )
        self.assertEqual(openai.endpoint_url(), "https://relay.example.com/openai/v1/chat/completions")

    def test_anthropic_payload_converts_tools_and_results(self) -> None:
        client = self.make_client()
        messages = [
            {"role": "system", "content": "System rules"},
            {"role": "user", "content": "Read a file"},
            {
                "role": "assistant",
                "content": "I will inspect it.",
                "tool_calls": [
                    {
                        "id": "toolu_1",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path":"README.md"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "toolu_1", "name": "read_file", "content": "contents"},
        ]
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
                },
            }
        ]

        payload = client._payload(messages, tools, stream=True)

        self.assertEqual(payload["system"], "System rules")
        self.assertEqual(payload["tools"][0]["input_schema"]["type"], "object")
        self.assertEqual(payload["messages"][1]["content"][1]["type"], "tool_use")
        self.assertEqual(payload["messages"][2]["content"][0]["type"], "tool_result")
        self.assertEqual(payload["messages"][2]["content"][0]["tool_use_id"], "toolu_1")

    def test_anthropic_headers_support_direct_api_and_gateways(self) -> None:
        headers = self.make_client()._headers()

        self.assertEqual(headers["x-api-key"], "test-key")
        self.assertEqual(headers["Authorization"], "Bearer test-key")
        self.assertEqual(headers["anthropic-version"], "2023-06-01")

    def test_anthropic_stream_events_normalize_to_openai_deltas(self) -> None:
        client = self.make_client()
        start = client._normalize_anthropic_stream_event(
            {
                "type": "content_block_start",
                "index": 1,
                "content_block": {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {}},
            }
        )
        arguments = client._normalize_anthropic_stream_event(
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": '{"path":"README.md"}'},
            }
        )

        self.assertEqual(start["choices"][0]["delta"]["tool_calls"][0]["function"]["name"], "read_file")
        self.assertEqual(
            json.loads(arguments["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"]),
            {"path": "README.md"},
        )

    def test_ollama_connection_is_retried_after_startup(self) -> None:
        request = object()
        response = object()
        refused = urllib.error.URLError(ConnectionRefusedError(10061, "refused"))
        with patch("hoya_agent.llm.urllib.request.urlopen", side_effect=[refused, response]) as urlopen:
            with patch("hoya_agent.llm.ensure_ollama_service", return_value=True):
                result = urlopen_with_ollama_retry(
                    request,
                    base_url="http://127.0.0.1:11434/v1",
                    provider="ollama",
                    timeout=5,
                )

        self.assertIs(result, response)
        self.assertEqual(urlopen.call_count, 2)

    def test_ollama_connection_error_is_actionable(self) -> None:
        message = connection_error_message("ollama", "http://127.0.0.1:11434/v1", "refused")

        self.assertIn("自动启动", message)
        self.assertIn("11434", message)


class ModelDiscoveryTests(unittest.TestCase):
    def test_openai_compatible_models_are_normalized(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps({"data": [{"id": "gpt-a"}, {"id": "gpt-a"}, {"id": "gpt-b"}]}).encode()

        with patch("hoya_agent.model_discovery.urllib.request.urlopen", return_value=FakeResponse()) as request:
            result = discover_models("https://relay.example.com/v1/chat/completions", "sk-test")

        self.assertTrue(result["ok"])
        self.assertEqual([item["id"] for item in result["models"]], ["gpt-a", "gpt-b"])
        self.assertEqual(result["endpoint"], "https://relay.example.com/v1/models")
        headers = request.call_args.args[0].headers
        self.assertEqual(headers["Authorization"], "Bearer sk-test")


class RunCancellationTests(unittest.TestCase):
    def test_active_run_can_be_cancelled_and_finished(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text(
                "HOYA_LLM_PROVIDER=ollama\n"
                "HOYA_BASE_URL=http://127.0.0.1:11434/v1\n"
                "HOYA_MODEL=test-model\n",
                encoding="utf-8",
            )
            state = AgentServerState(root)

            event = state.begin_run("run-1")
            self.assertTrue(state.cancel_run("run-1"))
            self.assertTrue(event.is_set())
            state.finish_run("run-1")
            self.assertFalse(state.cancel_run("run-1"))


class DurableRunStateTests(unittest.TestCase):
    def test_paused_run_can_be_reloaded_and_resolved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runs.json"
            store = RunStore(path)
            store.create("run-1", "conversation-1", "Update config")
            store.set_context("run-1", "相关会话 2 条", [{"kind": "conversation", "count": 2}])
            store.pause(
                "run-1",
                "approval-1",
                {"messages": [{"role": "user", "content": "Update config"}], "next_step": 2},
            )

            reloaded = RunStore(path)
            paused = reloaded.get("run-1")
            self.assertEqual(paused["status"], "waiting_approval")
            self.assertEqual(paused["checkpoint"]["next_step"], 2)

            resumed = reloaded.resolve_approval("run-1", "approved", {"ok": True})
            self.assertEqual(resumed["status"], "ready_to_resume")
            self.assertEqual(resumed["approval_result"]["decision"], "approved")

    def test_approved_write_resumes_the_original_model_loop(self) -> None:
        class FakeStreamingLlm:
            def __init__(self) -> None:
                self.calls = 0

            def chat_stream(self, messages, tools, cancel_event=None):
                self.calls += 1
                if self.calls == 1:
                    yield {
                        "choices": [
                            {
                                "delta": {
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "id": "call-write",
                                            "type": "function",
                                            "function": {
                                                "name": "write_file",
                                                "arguments": json.dumps({"path": "result.json", "content": '{"ok": true}'}),
                                            },
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                else:
                    yield {"choices": [{"delta": {"content": "写入并验证完成。"}}]}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text(
                "HOYA_LLM_PROVIDER=ollama\n"
                "HOYA_BASE_URL=http://127.0.0.1:11434/v1\n"
                "HOYA_MODEL=test-model\n"
                "HOYA_REQUIRE_WRITE_APPROVAL=1\n",
                encoding="utf-8",
            )
            agent = HoyaAgent(Config.from_env(root, reload_dotenv=True))
            agent.llm = FakeStreamingLlm()

            first_events = list(agent.run_stream("写入 result.json", "conversation-1", run_id="run-1"))
            approval = next(event for event in first_events if event["type"] == "approval_required")
            self.assertEqual(agent.runs.get("run-1")["status"], "waiting_approval")

            result = apply_pending_operation(
                root,
                agent.config.pending_writes_path,
                approval["id"],
                change_store=agent.changes,
            )
            agent._register_change("run-1", result)
            agent.runs.resolve_approval("run-1", "approved", result)
            resumed_events = list(agent.resume_stream("run-1"))

            self.assertEqual(next(event for event in resumed_events if event["type"] == "done")["text"], "写入并验证完成。")
            self.assertEqual(agent.runs.get("run-1")["status"], "completed")
            self.assertEqual(json.loads((root / "result.json").read_text(encoding="utf-8")), {"ok": True})


class ChangeStoreTests(unittest.TestCase):
    def make_store(self, root: Path) -> ChangeStore:
        return ChangeStore(root, root / ".hoya" / "versions.json", root / ".hoya" / "versions")

    def test_verified_change_can_be_rolled_back(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "config.json"
            target.write_text('{"enabled": false}', encoding="utf-8")
            store = self.make_store(root)

            result = store.write_text("config.json", '{"enabled": true}', "run-1")
            self.assertTrue(result["ok"])
            self.assertTrue(result["verification"]["ok"])

            rollback = store.rollback(result["version_id"])
            self.assertTrue(rollback["ok"])
            self.assertEqual(target.read_text(encoding="utf-8"), '{"enabled": false}')

    def test_invalid_json_is_automatically_rolled_back(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "config.json"
            target.write_text('{"enabled": false}', encoding="utf-8")
            store = self.make_store(root)

            result = store.write_text("config.json", '{"enabled":', "run-1")

            self.assertFalse(result["ok"])
            self.assertTrue(result["auto_rollback"]["ok"])
            self.assertEqual(target.read_text(encoding="utf-8"), '{"enabled": false}')

    def test_rollback_refuses_to_overwrite_newer_edits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "notes.txt"
            target.write_text("before", encoding="utf-8")
            store = self.make_store(root)
            result = store.write_text("notes.txt", "agent edit", "run-1")
            target.write_text("newer user edit", encoding="utf-8")

            rollback = store.rollback(result["version_id"])

            self.assertFalse(rollback["ok"])
            self.assertTrue(rollback["conflict"])
            self.assertEqual(target.read_text(encoding="utf-8"), "newer user edit")

    def test_concurrent_writes_form_a_linear_version_chain(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "notes.txt"
            target.write_text("original", encoding="utf-8")
            stores = [self.make_store(root), self.make_store(root)]
            barrier = threading.Barrier(3)
            failures: list[Exception] = []

            def write(store: ChangeStore, content: str) -> None:
                try:
                    barrier.wait()
                    store.write_text("notes.txt", content)
                except Exception as exc:  # pragma: no cover - asserted below
                    failures.append(exc)

            threads = [
                threading.Thread(target=write, args=(store, content))
                for store, content in zip(stores, ("first", "second"), strict=True)
            ]
            for thread in threads:
                thread.start()
            barrier.wait()
            for thread in threads:
                thread.join(timeout=2)

            entries = stores[0]._load()
            self.assertEqual(failures, [])
            self.assertEqual(len(entries), 2)
            self.assertEqual(entries[0]["before_sha256"], hashlib.sha256(b"original").hexdigest())
            self.assertEqual(entries[1]["before_sha256"], entries[0]["after_sha256"])
            self.assertEqual(
                entries[1]["after_sha256"],
                hashlib.sha256(target.read_text(encoding="utf-8").encode()).hexdigest(),
            )

    def test_run_and_version_indexes_do_not_silently_drop_old_entries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runs = RunStore(root / "runs.json")
            for index in range(205):
                runs.create(f"run-{index}", "conversation", f"Task {index}")
            changes = self.make_store(root)
            versions = [{"id": f"version-{index}"} for index in range(505)]
            changes._save(versions)

            self.assertEqual(len(runs._load()), 205)
            self.assertEqual(len(changes._load()), 505)

    def test_conversation_cleanup_removes_runs_and_snapshots(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runs = RunStore(root / "runs.json")
            changes = self.make_store(root)
            history = HistoryStore(root / "history.jsonl")
            pending_path = root / "pending.json"
            runs.create("run-1", "conversation-1", "Edit file")
            result = changes.write_text("notes.txt", "updated", "run-1")
            history.append("user", "Edit file", {"conversation_id": "conversation-1", "run_id": "run-1"})
            pending_path.write_text(json.dumps([{"id": "pending-1", "run_id": "run-1"}]), encoding="utf-8")

            run_ids = runs.delete_conversation("conversation-1")
            deleted_versions = changes.delete_runs(run_ids)
            deleted_history = history.delete_conversation("conversation-1")
            deleted_pending = delete_pending_for_runs(pending_path, run_ids)

            self.assertEqual(run_ids, ["run-1"])
            self.assertEqual(deleted_versions, 1)
            self.assertEqual(deleted_history, 1)
            self.assertEqual(deleted_pending, 1)
            self.assertEqual(runs.list("conversation-1"), [])
            self.assertEqual(changes.list("run-1"), [])
            self.assertEqual(history.recent(), [])
            self.assertEqual(json.loads(pending_path.read_text(encoding="utf-8")), [])
            self.assertFalse((root / ".hoya" / "versions" / f"{result['version_id']}.before").exists())


class RelevantContextTests(unittest.TestCase):
    def test_memory_recall_prefers_task_relevance_over_recency(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = MemoryStore(Path(directory) / "memory.json")
            store.add("项目使用 pytest 运行后端测试")
            store.add("界面主题偏好为浅色")

            result = store.relevant("验证后端 pytest", 1)

            self.assertEqual(len(result), 1)
            self.assertIn("pytest", result[0]["text"])

    def test_memory_writes_are_atomic_across_store_instances(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "memory.json"
            errors: list[Exception] = []

            def add_entry(index: int) -> None:
                try:
                    MemoryStore(path).add(f"memory-{index}")
                except Exception as exc:  # pragma: no cover - assertion reports worker failures
                    errors.append(exc)

            workers = [threading.Thread(target=add_entry, args=(index,)) for index in range(24)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=5)

            entries = MemoryStore(path).load()
            self.assertEqual(errors, [])
            self.assertEqual(len(entries), 24)
            self.assertEqual(len({entry["id"] for entry in entries}), 24)

    def test_legacy_memory_delete_removes_only_one_matching_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "memory.json"
            created_at = "2026-07-22T18:00:00"
            path.write_text(
                json.dumps(
                    [
                        {"created_at": created_at, "text": "first"},
                        {"created_at": created_at, "text": "second"},
                    ]
                ),
                encoding="utf-8",
            )

            removed = MemoryStore(path).delete(created_at)

            self.assertTrue(removed)
            self.assertEqual([entry["text"] for entry in MemoryStore(path).load()], ["second"])

    def test_workspace_index_matches_chinese_subphrases(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "workflow.md").write_text("审批后的任务需要恢复执行。", encoding="utf-8")
            index_path = root / ".hoya" / "index.json"
            index_path.parent.mkdir()
            build_index(root, index_path)

            result = search_index(index_path, "任务恢复", 5)

            self.assertTrue(result["ok"])
            self.assertEqual(result["results"][0]["path"], "workflow.md")

    def test_sensitive_files_are_not_read_or_indexed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text(
                "HOYA_LLM_PROVIDER=ollama\nHOYA_API_KEY=must-not-leak\n",
                encoding="utf-8",
            )
            (root / "notes.md").write_text("safe content", encoding="utf-8")
            (root / ".git").mkdir()
            (root / ".git" / "config").write_text("credential=must-not-leak", encoding="utf-8")
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                agent = HoyaAgent(Config.from_env(root, reload_dotenv=True))
                read_result = agent.tools["read_file"].handler({"path": ".env"})
                git_result = agent.tools["read_file"].handler({"path": ".git/config"})
                index = build_index(root, agent.config.index_path)

            self.assertIn("blocked", read_result["error"])
            self.assertIn("blocked", git_result["error"])
            indexed_paths = {item["path"] for item in index["files"]}
            self.assertNotIn(".env", indexed_paths)
            self.assertIn("notes.md", indexed_paths)

    def test_hard_link_to_sensitive_file_is_not_read_or_indexed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = root / ".env"
            alias = root / "notes.txt"
            secret.write_text("HOYA_API_KEY=must-not-leak", encoding="utf-8")
            try:
                os.link(secret, alias)
            except OSError as exc:
                self.skipTest(f"hard links are unavailable: {exc}")
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                agent = HoyaAgent(Config.from_env(root, reload_dotenv=True))
                read_result = agent.tools["read_file"].handler({"path": "notes.txt"})
                index = build_index(root, agent.config.index_path)

            self.assertIn("blocked", read_result["error"])
            self.assertNotIn("notes.txt", {item["path"] for item in index["files"]})

    def test_desktop_write_requires_approval_outside_yolo_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text(
                "HOYA_LLM_PROVIDER=ollama\n"
                "HOYA_ALLOW_DESKTOP=1\n"
                "HOYA_PERMISSION_MODE=risk\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"HOYA_DATA_DIR": str(root / "data")}, clear=False):
                agent = HoyaAgent(Config.from_env(root, reload_dotenv=True))
                result = agent.tools["write_desktop_file"].handler(
                    {"file_name": "hoya-approval-test.txt", "content": "pending"}
                )

            self.assertTrue(result["pending"])
            self.assertEqual(result["risk"]["level"], "high")
            self.assertEqual(len(json.loads(agent.config.pending_writes_path.read_text(encoding="utf-8"))), 1)


class PendingOperationTests(unittest.TestCase):
    def test_sensitive_target_is_rechecked_when_approval_is_applied(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / ".env"
            target.write_text("original", encoding="utf-8")
            pending_path = root / "pending.json"
            pending_path.write_text(
                json.dumps([{"id": "pending-1", "operation": "write_file", "path": ".env", "content": "changed"}]),
                encoding="utf-8",
            )

            result = apply_pending_operation(root, pending_path, "pending-1")

            self.assertFalse(result["ok"])
            self.assertIn("sensitive", result["error"])
            self.assertEqual(target.read_text(encoding="utf-8"), "original")
            self.assertEqual(load_pending_writes(pending_path)[0]["status"], "pending")

    def test_unknown_shell_outcome_is_retained_and_never_retried_automatically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pending_path = root / "pending.json"
            pending_path.write_text(
                json.dumps(
                    [{"id": "shell-1", "operation": "run_powershell", "command": "Set-Content result.txt done"}]
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"PRIVATE_API_KEY": "must-not-leak"}, clear=False):
                with patch(
                    "hoya_agent.workspace_ops.subprocess.run",
                    side_effect=subprocess.TimeoutExpired("powershell", 1),
                ) as run:
                    first = apply_pending_operation(root, pending_path, "shell-1", allow_shell=True)
                    second = apply_pending_operation(root, pending_path, "shell-1", allow_shell=True)

            self.assertTrue(first["outcome_unknown"])
            self.assertTrue(second["outcome_unknown"])
            self.assertEqual(run.call_count, 1)
            self.assertNotIn("PRIVATE_API_KEY", run.call_args.kwargs["env"])
            self.assertEqual(load_pending_writes(pending_path)[0]["status"], "outcome_unknown")

    def test_applied_operation_is_replayed_without_repeating_the_side_effect(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pending_path = root / "pending.json"
            pending_path.write_text(
                json.dumps(
                    [{"id": "write-1", "operation": "write_file", "path": "result.txt", "content": "approved"}]
                ),
                encoding="utf-8",
            )

            first = apply_pending_operation(root, pending_path, "write-1")
            (root / "result.txt").write_text("changed-after-apply", encoding="utf-8")
            second = apply_pending_operation(root, pending_path, "write-1")

            self.assertTrue(first["consumed"])
            self.assertTrue(second["replayed"])
            self.assertEqual((root / "result.txt").read_text(encoding="utf-8"), "changed-after-apply")
            self.assertEqual(load_pending_writes(pending_path)[0]["status"], "applied")
            self.assertTrue(finalize_pending_operation(pending_path, "write-1"))
            self.assertEqual(load_pending_writes(pending_path), [])


if __name__ == "__main__":
    unittest.main()
