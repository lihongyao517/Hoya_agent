from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
from unittest.mock import patch
from pathlib import Path

from hoya_agent.agent import HoyaAgent
from hoya_agent.config import ANTHROPIC_DEFAULT_BASE_URL, Config, validate_api_config_update
from hoya_agent.conversations import ConversationStore
from hoya_agent.llm import LLMClient, connection_error_message, urlopen_with_ollama_retry
from hoya_agent.memory import MemoryStore
from hoya_agent.model_discovery import discover_models
from hoya_agent.run_state import ChangeStore, RunStore
from hoya_agent.server import AgentServerState, public_model_payload
from hoya_agent.user_settings import UserSettingsStore
from hoya_agent.workspace_ops import apply_pending_operation, build_index, search_index


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

    def test_model_presets_keep_api_key_for_reopen(self) -> None:
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

            self.assertEqual(saved["api_key"], "sk-test-key")
            self.assertEqual(reloaded.list_models()[0]["api_key"], "sk-test-key")
            public = public_model_payload(saved)
            self.assertNotIn("api_key", public)
            self.assertTrue(public["api_key_set"])


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


class RelevantContextTests(unittest.TestCase):
    def test_memory_recall_prefers_task_relevance_over_recency(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = MemoryStore(Path(directory) / "memory.json")
            store.add("项目使用 pytest 运行后端测试")
            store.add("界面主题偏好为浅色")

            result = store.relevant("验证后端 pytest", 1)

            self.assertEqual(len(result), 1)
            self.assertIn("pytest", result[0]["text"])

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


if __name__ == "__main__":
    unittest.main()
