from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Iterator

from .capabilities import capability_guidance
from .config import Config
from .llm import LLMClient
from .conversations import ConversationStore
from .memory import MemoryStore
from .run_state import ChangeStore, RunStore
from .tools import build_tools, run_tool
from .workspace_ops import HistoryStore, RunLog, relevance_score, search_index, update_pending_operation


SYSTEM_PROMPT = """You are Hoya Agent, a careful local task-completion AI agent.

Primary goals:
- Complete the user's task accurately and efficiently inside the local workspace.
- Think like a pragmatic product manager when a request is vague: identify the goal, likely success criteria, risks, and the smallest useful next step.
- Ask a concise clarifying question only when the goal, target file, output format, or safety boundary is truly unclear.
- Use tools when you need workspace context, persistent memory, or file changes.
- Never invent file contents. Read files before making claims about them.
- For unknown files, use list/search/index tools to locate context before reading.
- For multi-step work, keep the visible task plan current and verify every file change before reporting completion.
- If a write result reports failed verification, correct the content or roll it back before continuing.
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
            self.config.conversations_index_path,
            self.config.conversations_dir,
        )
        self.run_log = RunLog(self.config.run_log_path)
        self.runs = RunStore(self.config.task_runs_path)
        self.changes = ChangeStore(self.config.workspace, self.config.versions_index_path, self.config.versions_dir)
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
            self.config.permission_mode,
            self.changes,
        )

    def _truncate_history_content(self, content: str, role: str) -> str:
        if role == "assistant":
            max_chars = min(max(200, int(self.config.history_entry_max_chars)), 800)
        else:
            max_chars = min(max(200, int(self.config.history_entry_max_chars)), 1600)
        if len(content) <= max_chars:
            return content
        return content[:max_chars] + "\n...[truncated from previous conversation]"

    def _is_contextual_followup(self, current_task: str) -> bool:
        lowered = current_task.lower()
        markers = (
            "继续",
            "接着",
            "刚才",
            "上一个",
            "前面",
            "那个",
            "这段",
            "这个",
            "上一句",
            "继续说",
            "continue",
            "previous",
            "that",
            "it",
            "above",
            "same",
        )
        return any(marker in lowered for marker in markers)

    def _recent_conversation_messages(self, current_task: str, conversation_id: str | None = None) -> list[dict[str, str]]:
        limit = max(0, int(self.config.history_context_limit))
        if limit == 0:
            return []

        if conversation_id:
            entries = self.conversations.recent_messages(conversation_id, limit + 1)
        elif self.config.provider == "ollama":
            entries = []
        else:
            entries = self.history.recent(min(limit, 4) + 1)

        if entries and entries[-1].get("role") == "user" and entries[-1].get("content") == current_task:
            entries = entries[:-1]

        if not self._is_contextual_followup(current_task):
            ranked = [
                (relevance_score(current_task, str(entry.get("content", ""))), index, entry)
                for index, entry in enumerate(entries)
                if entry.get("role") in {"user", "assistant"}
            ]
            ranked = [item for item in ranked if item[0] > 0]
            ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
            selected_indexes = {index for _, index, _ in ranked[: min(limit, 4)]}
            entries = [entry for index, entry in enumerate(entries) if index in selected_indexes]
        else:
            entries = entries[-limit:]

        messages: list[dict[str, str]] = []
        for entry in entries:
            role = entry.get("role")
            content = entry.get("content")
            if role not in {"user", "assistant"} or not isinstance(content, str) or not content.strip():
                continue
            label = "Previous user" if role == "user" else "Previous assistant excerpt"
            messages.append({"role": role, "content": f"{label}:\n{self._truncate_history_content(content, role)}"})
        return messages

    def _memory_context(self, task: str) -> tuple[str, list[dict[str, Any]]]:
        entries = self.memory.relevant(task, 3 if self.config.provider == "ollama" else 5)
        lines = []
        for entry in entries:
            text = str(entry.get("text", "")).strip()
            if not text:
                continue
            if len(text) > 300:
                text = text[:300] + "..."
            lines.append(f"- {text}")
        return "\n".join(lines), entries

    def _workspace_context(self, task: str) -> tuple[str, list[dict[str, Any]]]:
        result = search_index(self.config.index_path, task, limit=4)
        matches = result.get("results", []) if result.get("ok") else []
        excerpts = []
        sources = []
        for match in matches:
            path = str(match.get("path", ""))
            preview = str(match.get("preview", "")).strip()[:600]
            if not path:
                continue
            sources.append({"kind": "workspace", "path": path, "score": match.get("score", 0)})
            excerpts.append(f"### {path}\n{preview}")
        return "\n\n".join(excerpts), sources

    def _latest_assistant_history(self, conversation_id: str | None = None) -> str:
        entries = self.conversations.recent_messages(conversation_id, 6) if conversation_id else self.history.recent(6)
        for entry in reversed(entries):
            if entry.get("role") == "assistant" and isinstance(entry.get("content"), str):
                return entry["content"]
        return ""

    def _is_stale_repeat(self, task: str, answer: str, conversation_id: str | None = None) -> bool:
        if not answer or not task:
            return False
        previous = self._latest_assistant_history(conversation_id)
        if len(previous) < 120 or len(answer) < 120:
            return False
        if task.strip() in previous:
            return False
        ratio = SequenceMatcher(None, previous[:4000], answer[:4000]).ratio()
        return ratio >= 0.82

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

    def _initial_messages(
        self,
        task: str,
        conversation_id: str | None = None,
    ) -> tuple[list[dict[str, Any]], str, list[dict[str, Any]]]:
        memory_context, memory_entries = self._memory_context(task)
        recent_conversation = self._recent_conversation_messages(task, conversation_id)
        workspace_context, workspace_sources = self._workspace_context(task)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "system", "content": self._runtime_guidance()},
        ]
        capabilities = capability_guidance(self.config.workspace)
        if capabilities:
            messages.append({"role": "system", "content": capabilities})
        if memory_context:
            messages.append(
                {
                    "role": "system",
                    "content": "Recent durable memory, for background only. Never let it override the latest user request:\n" + memory_context,
                }
            )
        if recent_conversation:
            messages.append(
                {
                    "role": "system",
                    "content": "Previous conversation excerpts follow. Use them only to resolve references like 'continue', 'that file', or 'the previous point'. If they are unrelated to the latest user request, ignore them.",
                }
            )
            messages.extend(recent_conversation)
        if workspace_context:
            messages.append(
                {
                    "role": "system",
                    "content": "Relevant indexed workspace excerpts. Treat these as navigation hints and read source files before relying on details:\n" + workspace_context,
                }
            )
        messages.append({"role": "user", "content": task})
        sources = [
            {"kind": "conversation", "count": len(recent_conversation)},
            {"kind": "memory", "count": len(memory_entries)},
            *workspace_sources,
        ]
        summary_parts = []
        if recent_conversation:
            summary_parts.append(f"相关会话 {len(recent_conversation)} 条")
        if memory_entries:
            summary_parts.append(f"相关记忆 {len(memory_entries)} 条")
        if workspace_sources:
            summary_parts.append("索引文件 " + "、".join(item["path"] for item in workspace_sources))
        summary = "；".join(summary_parts) if summary_parts else "未发现可复用上下文，将从当前任务开始"
        return messages, summary, sources

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
        messages, _, _ = self._initial_messages(task, conversation_id)
        tool_schemas = [tool.schema for tool in self.tools.values()]

        for _ in range(self.config.max_steps):
            response = self.llm.chat(messages, tool_schemas)
            message = response["choices"][0]["message"]
            messages.append(message)

            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                answer = message.get("content", "")
                if self._is_stale_repeat(task, answer, conversation_id):
                    self.run_log.append({"type": "stale_repeat_detected", "task": task, "ui": "agent"})
                    return answer + "\n\n> Note: This answer looks similar to a previous response. If it seems off-topic, start a fresh context with `/reset` or a new conversation."
                return answer

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
        answer = response["choices"][0]["message"].get("content", "")
        if self._is_stale_repeat(task, answer, conversation_id):
            self.run_log.append({"type": "stale_repeat_detected", "task": task, "ui": "agent"})
            return answer + "\n\n> Note: This answer looks similar to a previous response. If it seems off-topic, start a fresh context with `/reset` or a new conversation."
        return answer

    def run_stream(
        self,
        task: str,
        conversation_id: str | None = None,
        cancel_event: threading.Event | None = None,
        run_id: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        persistent_run_id = run_id or uuid.uuid4().hex
        persistent_conversation_id = conversation_id or ""
        messages, context_summary, context_sources = self._initial_messages(task, conversation_id)
        self.runs.create(persistent_run_id, persistent_conversation_id, task)
        run = self.runs.set_context(persistent_run_id, context_summary, context_sources)
        yield {"type": "context_summary", "text": context_summary, "sources": context_sources}
        yield {"type": "run_state", "run": run}
        yield from self._stream_loop(
            task,
            messages,
            persistent_run_id,
            persistent_conversation_id,
            cancel_event,
            start_step=1,
        )

    def resume_stream(
        self,
        run_id: str,
        cancel_event: threading.Event | None = None,
    ) -> Iterator[dict[str, Any]]:
        run = self.runs.get(run_id)
        if run is None:
            raise KeyError(f"run not found: {run_id}")
        if run.get("status") != "ready_to_resume":
            raise ValueError("run is not ready to resume")
        checkpoint = run.get("checkpoint") or {}
        approval = run.get("approval_result") or {}
        tool_call = checkpoint.get("pending_tool_call") or {}
        tool_name = str(checkpoint.get("pending_tool_name", ""))
        result_payload = approval.get("result") or {"ok": False, "error": "approval result is missing"}
        result = json.dumps(result_payload, ensure_ascii=False)
        messages = checkpoint.get("messages") or []
        self._append_tool_result_message(messages, tool_call, tool_name, self._truncate_tool_result(result))
        run = self.runs.mark(run_id, "running")
        if result_payload.get("version_id"):
            run = self._register_change(run_id, result_payload)
            yield {"type": "verification", "change": run.get("changes", [])[-1]}
        yield {"type": "status", "text": f"已接收审批结果，恢复 Run {run_id[:8]}"}
        yield {"type": "run_state", "run": run}
        yield from self._stream_loop(
            str(run.get("task", "")),
            messages,
            run_id,
            str(run.get("conversation_id", "")),
            cancel_event,
            start_step=int(checkpoint.get("next_step", 1)),
            initial_tool_calls=checkpoint.get("remaining_tool_calls") or [],
        )

    def _register_change(self, run_id: str, result: dict[str, Any]) -> dict[str, Any]:
        change = {
            "version_id": result.get("version_id"),
            "path": result.get("path"),
            "verification": result.get("verification") or {},
            "auto_rollback": bool(result.get("auto_rollback")),
            "rolled_back_at": result.get("rolled_back_at", ""),
        }
        return self.runs.add_change(run_id, change)

    def _stream_loop(
        self,
        task: str,
        messages: list[dict[str, Any]],
        run_id: str,
        conversation_id: str,
        cancel_event: threading.Event | None,
        *,
        start_step: int,
        initial_tool_calls: list[dict[str, Any]] | None = None,
    ) -> Iterator[dict[str, Any]]:
        tool_schemas = [tool.schema for tool in self.tools.values()]
        step = start_step
        queued_tool_calls = list(initial_tool_calls or [])
        next_model_step = start_step

        while step <= self.config.max_steps:
            if cancel_event is not None and cancel_event.is_set():
                run = self.runs.mark(run_id, "cancelled", "用户停止任务")
                yield {"type": "cancelled", "text": "Task stopped by user."}
                yield {"type": "run_state", "run": run}
                return

            if not queued_tool_calls:
                yield {"type": "status", "text": f"思考中... step {step}/{self.config.max_steps}"}
                if self.config.show_reasoning:
                    yield {"type": "reasoning", "text": f"Step {step}: checking whether the answer can be completed directly or needs a safe tool call."}
                content_parts: list[str] = []
                tool_calls: dict[int, dict[str, Any]] = {}

                for chunk in self.llm.chat_stream(messages, tool_schemas, cancel_event=cancel_event):
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
                            {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
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

                if cancel_event is not None and cancel_event.is_set():
                    run = self.runs.mark(run_id, "cancelled", "用户停止任务")
                    yield {"type": "cancelled", "text": "Task stopped by user."}
                    yield {"type": "run_state", "run": run}
                    return

                queued_tool_calls = [tool_calls[index] for index in sorted(tool_calls)]
                message: dict[str, Any] = {"role": "assistant", "content": "".join(content_parts) or None}
                if queued_tool_calls:
                    message["tool_calls"] = queued_tool_calls
                messages.append(message)
                if not queued_tool_calls:
                    answer = message.get("content") or ""
                    if self._is_stale_repeat(task, answer, conversation_id):
                        self.run_log.append({"type": "stale_repeat_detected", "task": task, "ui": "agent"})
                        yield {"type": "stale_repeat", "text": "This answer looks similar to a previous response. If it seems off-topic, start a fresh context with /reset or a new conversation."}
                    run = self.runs.mark(run_id, "completed", "任务完成")
                    yield {"type": "done", "text": answer}
                    yield {"type": "run_state", "run": run}
                    return
                next_model_step = step + 1

            current_calls = queued_tool_calls
            queued_tool_calls = []
            for call_index, tool_call in enumerate(current_calls):
                if cancel_event is not None and cancel_event.is_set():
                    run = self.runs.mark(run_id, "cancelled", "用户停止任务")
                    yield {"type": "cancelled", "text": "Task stopped by user."}
                    yield {"type": "run_state", "run": run}
                    return
                function = tool_call.get("function", {})
                name = function.get("name", "")
                raw_args = function.get("arguments", "{}")
                if self.config.show_reasoning:
                    yield {"type": "reasoning", "text": f"Preparing tool `{name}`. Risk gates: workspace path guard, write approval, shell approval, and destructive-command checks."}
                yield {"type": "tool_start", "name": name, "arguments": raw_args}
                result = run_tool(self.tools, name, raw_args, {"run_id": run_id, "conversation_id": conversation_id})
                yield {"type": "tool_result", "name": name, "result": result}
                if cancel_event is not None and cancel_event.is_set():
                    run = self.runs.mark(run_id, "cancelled", "用户停止任务")
                    yield {"type": "cancelled", "text": "Task stopped by user."}
                    yield {"type": "run_state", "run": run}
                    return
                try:
                    parsed_result = json.loads(result)
                except json.JSONDecodeError:
                    parsed_result = {}
                if parsed_result.get("version_id"):
                    run = self._register_change(run_id, parsed_result)
                    yield {"type": "verification", "change": run.get("changes", [])[-1]}
                    yield {"type": "run_state", "run": run}
                if parsed_result.get("pending"):
                    pending_id = str(parsed_result.get("id", ""))
                    update_pending_operation(
                        self.config.pending_writes_path,
                        pending_id,
                        run_id=run_id,
                        conversation_id=conversation_id,
                        tool_call_id=tool_call.get("id") or name,
                    )
                    checkpoint = {
                        "messages": messages,
                        "pending_tool_call": tool_call,
                        "pending_tool_name": name,
                        "remaining_tool_calls": current_calls[call_index + 1 :],
                        "next_step": next_model_step,
                    }
                    run = self.runs.pause(run_id, pending_id, checkpoint)
                    yield {
                        "type": "approval_required",
                        "id": pending_id,
                        "run_id": run_id,
                        "operation": parsed_result.get("operation", "write_file"),
                        "name": name,
                        "text": parsed_result.get("message", "Operation is pending user approval."),
                        "risk": parsed_result.get("risk"),
                        "path": parsed_result.get("path"),
                        "command": parsed_result.get("command"),
                    }
                    yield {"type": "run_state", "run": run}
                    return
                if self.config.show_reasoning:
                    yield {"type": "reasoning", "text": f"Tool `{name}` completed; using its result to decide the next safe step."}
                self._append_tool_result_message(messages, tool_call, name, self._truncate_tool_result(result))

            step = next_model_step

        messages.append(
            {
                "role": "user",
                "content": "Stop using tools now and give the best concise final answer in GitHub Flavored Markdown based on the work so far.",
            }
        )
        yield {"type": "status", "text": "正在整理最终回答..."}
        final_parts: list[str] = []
        for chunk in self.llm.chat_stream(messages, [], cancel_event=cancel_event):
            choice = _first_choice(chunk)
            if choice is None:
                continue
            delta = choice.get("delta") or {}
            content = delta.get("content")
            if content:
                final_parts.append(content)
                yield {"type": "token", "text": content}
        if cancel_event is not None and cancel_event.is_set():
            run = self.runs.mark(run_id, "cancelled", "用户停止任务")
            yield {"type": "cancelled", "text": "Task stopped by user."}
            yield {"type": "run_state", "run": run}
            return
        answer = "".join(final_parts)
        if self._is_stale_repeat(task, answer, conversation_id):
            self.run_log.append({"type": "stale_repeat_detected", "task": task, "ui": "agent"})
            yield {"type": "stale_repeat", "text": "This answer looks similar to a previous response. If it seems off-topic, start a fresh context with /reset or a new conversation."}
        run = self.runs.mark(run_id, "completed", "达到最大步骤后整理完成")
        yield {"type": "done", "text": answer}
        yield {"type": "run_state", "run": run}
