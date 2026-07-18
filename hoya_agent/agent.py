from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterator

from .config import Config
from .llm import LLMClient
from .conversations import ConversationStore
from .memory import MemoryStore
from .tools import build_tools, run_tool
from .workspace_ops import HistoryStore, RunLog


SYSTEM_PROMPT = """You are Hoya Agent, a careful local task-completion AI agent.

Primary goals:
- Complete the user's task accurately and efficiently inside the local workspace.
- Think like a pragmatic product manager when a request is vague: identify the goal, likely success criteria, risks, and the smallest useful next step.
- Ask a concise clarifying question only when the goal, target file, output format, or safety boundary is truly unclear.
- Use tools when you need workspace context, persistent memory, or file changes.
- Never invent file contents. Read files before making claims about them.
- For unknown files, use list/search/index tools to locate context before reading.
- All workspace paths are relative to the project root.

Markdown output contract:
- Always write final answers in stable GitHub Flavored Markdown.
- Use short headings, bullet lists, tables, and fenced code blocks when helpful.
- Put a blank line before and after headings, lists, tables, and fenced code blocks.
- Always close fenced code blocks; add a language label when the language is known.
- Do not wrap the entire response in one fenced block unless the user explicitly asks for raw Markdown.
- Wrap file paths, commands, config keys, model names, and IDs in backticks.
- Final answers for implementation tasks should use stable sections such as `Done`, `Changed files`, `Verification`, and `Risks / notes` when relevant.
- Avoid loose plaintext dumps; keep paragraphs short and scannable.

Safety and authorization:
- Before write, shell, desktop, or other side-effecting operations, state the intended action and risk in user-visible terms.
- Even if the user broadly authorizes work, still perform path, command, and data-loss risk checks.
- Never execute destructive, cross-directory, credential, registry, system-setting, or network-download-and-run commands.
- Prefer read-only investigation and small, reversible edits.
- Never store API keys, passwords, access tokens, private keys, or other secrets in durable memory.

Visible reasoning policy:
- Do not reveal hidden chain-of-thought.
- You may provide brief, public reasoning summaries: what you are checking, why a tool is needed, and what risk gate applies.
"""

def _first_choice(chunk: dict[str, Any]) -> dict[str, Any] | None:
    choices = chunk.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    choice = choices[0]
    if not isinstance(choice, dict):
        return None
    return choice


@dataclass
class HoyaAgent:
    config: Config

    def __post_init__(self) -> None:
        self.memory = MemoryStore(self.config.memory_path)
        self.history = HistoryStore(self.config.history_path)
        self.conversations = ConversationStore(
            self.config.workspace / ".hoya_conversations.json",
            self.config.workspace / ".hoya_conversations",
        )
        self.run_log = RunLog(self.config.run_log_path)
        self.llm = LLMClient(
            api_key=self.config.api_key,
            base_url=self.config.base_url,
            model=self.config.model,
            provider=self.config.provider,
            wire_api=self.config.wire_api,
            reasoning_effort=self.config.reasoning_effort,
            temperature=self.config.temperature,
        )
        self.tools = build_tools(
            self.config.workspace,
            self.memory,
            self.config.allow_shell,
            self.config.allow_desktop,
            self.config.index_path,
            self.config.pending_writes_path,
            self.config.require_write_approval,
            self.config.require_shell_approval,
        )

    def _truncate_history_content(self, content: str) -> str:
        max_chars = max(200, int(self.config.history_entry_max_chars))
        if len(content) <= max_chars:
            return content
        return content[:max_chars] + "\n...[truncated from conversation history]"

    def _recent_conversation_messages(self, current_task: str, conversation_id: str | None = None) -> list[dict[str, str]]:
        limit = max(0, int(self.config.history_context_limit))
        if limit == 0:
            return []

        # Read one extra item so dropping a just-recorded current user task does not
        # unexpectedly reduce the configured amount of usable history.
        entries = self.conversations.recent_messages(conversation_id, limit + 1) if conversation_id else self.history.recent(limit + 1)
        if entries and entries[-1].get("role") == "user" and entries[-1].get("content") == current_task:
            entries = entries[:-1]
        entries = entries[-limit:]

        messages: list[dict[str, str]] = []
        for entry in entries:
            role = entry.get("role")
            content = entry.get("content")
            if role not in {"user", "assistant"} or not isinstance(content, str) or not content.strip():
                continue
            messages.append({"role": role, "content": self._truncate_history_content(content)})
        return messages

    def _runtime_guidance(self) -> str:
        effort_notes = {
            "low": "Use the shortest adequate reasoning path. Avoid optional exploration.",
            "medium": "Use balanced reasoning and verify important assumptions.",
            "high": "Reason carefully, compare alternatives, and verify before acting.",
            "xhigh": "Use extra scrutiny for planning, edge cases, and verification, without adding unrelated work.",
            "max": "Use maximum practical scrutiny, especially around risk, correctness, and edge cases.",
        }
        show = "enabled" if self.config.show_reasoning else "disabled"
        return (
            f"Runtime controls: reasoning_effort={self.config.reasoning_effort}. "
            f"{effort_notes.get(self.config.reasoning_effort, effort_notes['medium'])} "
            f"Public reasoning summaries are {show}. Keep final output in stable GitHub Flavored Markdown."
        )

    def _initial_messages(self, task: str, conversation_id: str | None = None) -> list[dict[str, Any]]:
        memory = self.memory.recent()
        recent_conversation = self._recent_conversation_messages(task, conversation_id)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "system", "content": self._runtime_guidance()},
            {"role": "system", "content": f"Recent durable memory:\n{json.dumps(memory, ensure_ascii=False)}"},
        ]
        if recent_conversation:
            messages.append(
                {
                    "role": "system",
                    "content": "Recent conversation context follows. Use it to resolve references like 'continue', 'that file', or 'the previous point', but prefer the latest user request if there is any conflict.",
                }
            )
            messages.extend(recent_conversation)
        messages.append({"role": "user", "content": task})
        return messages

    def _truncate_tool_result(self, result: str) -> str:
        max_chars = max(500, int(self.config.tool_result_max_chars))
        if len(result) <= max_chars:
            return result
        return result[:max_chars] + "\n...[tool result truncated; increase HOYA_TOOL_RESULT_MAX_CHARS if more detail is needed]"

    def _append_tool_result_message(self, messages: list[dict[str, Any]], tool_call: dict[str, Any], name: str, result: str) -> None:
        messages.append(
            {
                "role": "tool",
                "tool_call_id": tool_call.get("id") or name,
                "name": name,
                "content": result,
            }
        )

    def run(self, task: str, conversation_id: str | None = None) -> str:
        messages = self._initial_messages(task, conversation_id)
        tool_schemas = [tool.schema for tool in self.tools.values()]

        for _ in range(self.config.max_steps):
            response = self.llm.chat(messages, tool_schemas)
            message = response["choices"][0]["message"]
            messages.append(message)

            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                return message.get("content", "")

            for tool_call in tool_calls:
                function = tool_call.get("function", {})
                name = function.get("name", "")
                raw_args = function.get("arguments", "{}")
                self.run_log.append({"type": "tool_start", "name": name, "arguments": raw_args, "ui": "agent"})
                result = run_tool(self.tools, name, raw_args)
                model_result = self._truncate_tool_result(result)
                try:
                    parsed_result = json.loads(result)
                except json.JSONDecodeError:
                    parsed_result = {}
                if parsed_result.get("pending"):
                    self.run_log.append(
                        {
                            "type": "approval_required",
                            "name": name,
                            "id": parsed_result.get("id"),
                            "operation": parsed_result.get("operation", "write_file"),
                            "ui": "agent",
                        }
                    )
                self.run_log.append(
                    {
                        "type": "tool_result",
                        "name": name,
                        "result_preview": result[:2000],
                        "truncated": len(result) > 2000,
                        "model_truncated": model_result != result,
                        "ui": "agent",
                    }
                )
                self._append_tool_result_message(messages, tool_call, name, model_result)

        messages.append(
            {
                "role": "user",
                "content": "Stop using tools now and give the best concise final answer in GitHub Flavored Markdown based on the work so far.",
            }
        )
        response = self.llm.chat(messages, [])
        return response["choices"][0]["message"].get("content", "")

    def run_stream(self, task: str, conversation_id: str | None = None) -> Iterator[dict[str, Any]]:
        messages = self._initial_messages(task, conversation_id)
        tool_schemas = [tool.schema for tool in self.tools.values()]

        for step in range(1, self.config.max_steps + 1):
            yield {"type": "status", "text": f"思考中... step {step}/{self.config.max_steps}"}
            if self.config.show_reasoning:
                yield {"type": "reasoning", "text": f"Step {step}: checking whether the answer can be completed directly or needs a safe tool call."}
            content_parts: list[str] = []
            tool_calls: dict[int, dict[str, Any]] = {}

            for chunk in self.llm.chat_stream(messages, tool_schemas):
                choice = _first_choice(chunk)
                if choice is None:
                    continue
                delta = choice.get("delta") or {}

                content = delta.get("content")
                if content:
                    content_parts.append(content)
                    yield {"type": "token", "text": content}

                for tool_delta in delta.get("tool_calls") or []:
                    index = int(tool_delta.get("index", 0))
                    current = tool_calls.setdefault(
                        index,
                        {
                            "id": "",
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        },
                    )
                    if tool_delta.get("id"):
                        current["id"] = tool_delta["id"]
                    if tool_delta.get("type"):
                        current["type"] = tool_delta["type"]

                    function_delta = tool_delta.get("function") or {}
                    if function_delta.get("name"):
                        current["function"]["name"] += function_delta["name"]
                    if function_delta.get("arguments"):
                        current["function"]["arguments"] += function_delta["arguments"]

            ordered_tool_calls = [tool_calls[index] for index in sorted(tool_calls)]
            message: dict[str, Any] = {
                "role": "assistant",
                "content": "".join(content_parts) or None,
            }
            if ordered_tool_calls:
                message["tool_calls"] = ordered_tool_calls
            messages.append(message)

            if not ordered_tool_calls:
                yield {"type": "done", "text": message.get("content") or ""}
                return

            for tool_call in ordered_tool_calls:
                function = tool_call.get("function", {})
                name = function.get("name", "")
                raw_args = function.get("arguments", "{}")
                if self.config.show_reasoning:
                    yield {"type": "reasoning", "text": f"Preparing tool `{name}`. Risk gates: workspace path guard, write approval, shell approval, and destructive-command checks."}
                yield {"type": "tool_start", "name": name, "arguments": raw_args}
                result = run_tool(self.tools, name, raw_args)
                yield {"type": "tool_result", "name": name, "result": result}
                try:
                    parsed_result = json.loads(result)
                except json.JSONDecodeError:
                    parsed_result = {}
                if parsed_result.get("pending"):
                    yield {
                        "type": "approval_required",
                        "id": parsed_result.get("id"),
                        "operation": parsed_result.get("operation", "write_file"),
                        "name": name,
                        "text": parsed_result.get("message", "Operation is pending user approval."),
                        "risk": parsed_result.get("risk"),
                        "path": parsed_result.get("path"),
                        "command": parsed_result.get("command"),
                    }
                if self.config.show_reasoning:
                    yield {"type": "reasoning", "text": f"Tool `{name}` completed; using its result to decide the next safe step."}
                self._append_tool_result_message(messages, tool_call, name, self._truncate_tool_result(result))

        messages.append(
            {
                "role": "user",
                "content": "Stop using tools now and give the best concise final answer in GitHub Flavored Markdown based on the work so far.",
            }
        )
        yield {"type": "status", "text": "正在整理最终回答..."}
        final_parts: list[str] = []
        for chunk in self.llm.chat_stream(messages, []):
            choice = _first_choice(chunk)
            if choice is None:
                continue
            delta = choice.get("delta") or {}
            content = delta.get("content")
            if content:
                final_parts.append(content)
                yield {"type": "token", "text": content}
        yield {"type": "done", "text": "".join(final_parts)}
