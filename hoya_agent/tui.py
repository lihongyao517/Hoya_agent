from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.events import Resize
from textual.widgets import Static, TextArea


class PromptTextArea(TextArea):
    async def _on_key(self, event) -> None:
        if event.key == "enter":
            event.stop()
            event.prevent_default()
            self.app.submit_current_task()
            return
        if event.key == "shift+enter":
            event.stop()
            event.prevent_default()
            start, end = self.selection
            self._replace_via_keyboard("\n", start, end)
            self.move_cursor((start[0] + 1, 0))
            return
        await super()._on_key(event)

from .agent import HoyaAgent
from .config import Config
from .workspace_ops import (
    HistoryStore,
    RunLog,
    apply_pending_write,
    build_index,
    import_path,
    load_pending_writes,
    search_index,
)


class HoyaAgentApp(App[None]):
    CSS = """
    Screen {
        background: #090b10;
        color: #d7deea;
        layout: vertical;
    }

    #messages {
        height: 1fr;
        padding: 1 4 0 4;
        background: #090b10;
        scrollbar-background: #090b10;
        scrollbar-color: #2f3a4a;
        scrollbar-color-hover: #526172;
        scrollbar-color-active: #7aa2f7;
        scrollbar-size: 1 1;
    }

    .message {
        margin-bottom: 1;
        padding: 0;
        background: #090b10;
    }

    .user {
        color: #f6f8ff;
        text-style: bold;
    }

    .assistant {
        color: #d7deea;
    }

    .status {
        color: #737f91;
    }

    .system {
        color: #8792a3;
    }

    .tool {
        color: #8ab4f8;
    }

    .error {
        color: #ff8f87;
    }

    #input_panel {
        height: auto;
        padding: 0 4 1 4;
        background: #090b10;
    }

    #prompt_marker {
        width: 2;
        height: 3;
        padding-top: 1;
        color: #8bd5ca;
        text-style: bold;
    }

    #task_input {
        width: 1fr;
        height: 3;
        padding: 0 1;
        background: #0f131a;
        color: #f6f8ff;
        border: none;
    }

    #task_input:focus {
        background: #111822;
        border: none;
    }

    TextArea > .text-area--cursor-line {
        background: #151c26;
    }

    TextArea > .text-area--selection {
        background: #2d4666;
    }

    #status_bar {
        height: 1;
        padding: 0 4;
        color: #697386;
        background: #090b10;
    }
    """

    BINDINGS = [
        ("ctrl+c", "quit", "退出"),
        ("ctrl+l", "clear_messages", "清空"),
        ("enter", "submit_task", "发送"),
        ("ctrl+s", "submit_task", "发送"),
        ("ctrl+j", "submit_task", "发送"),
        ("ctrl+t", "toggle_tool_details", "工具详情"),
        ("escape", "focus_input", "输入"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.agent: HoyaAgent | None = None
        self.config: Config | None = None
        self.busy = False
        self.current_answer = ""
        self.current_assistant: Static | None = None
        self.current_assistant_stamp = ""
        self.tool_count = 0
        self.history: HistoryStore | None = None
        self.run_log: RunLog | None = None
        self.compact = False
        self.narrow = False
        self.last_state = "启动中"
        self.show_tool_details = False

    def compose(self) -> ComposeResult:
        yield VerticalScroll(id="messages")
        with Horizontal(id="input_panel"):
            yield Static("›", id="prompt_marker")
            yield PromptTextArea(
                "",
                language="markdown",
                id="task_input",
                soft_wrap=True,
                show_line_numbers=False,
                tab_behavior="focus",
                compact=True,
                placeholder="描述你要 Hoya 做的事…",
            )
        yield Static("正在加载配置...", id="status_bar")

    def on_mount(self) -> None:
        task_input = self.query_one("#task_input", TextArea)

        try:
            self.config = Config.from_env()
            self.agent = HoyaAgent(self.config)
            self.history = HistoryStore(self.config.history_path)
            self.run_log = RunLog(self.config.run_log_path)
        except Exception as exc:
            task_input.disabled = True
            self.add_message("system", "Hoya Agent 配置错误", "error")
            self.add_message("system", str(exc), "error")
            self.add_message("system", "请检查 .env，然后重新运行 python -m hoya_agent --tui", "system")
            self.set_state("配置错误")
            return

        self.add_message("system", "Hoya 已就绪。描述任务，或输入 /help 查看本地命令。", "system")
        self.add_message("system", "Enter 发送 · Shift+Enter 换行 · Ctrl+L 清空 · Ctrl+T 工具详情 · Esc 聚焦输入", "system")
        self.refresh_status("就绪")
        self.apply_responsive_layout(self.size.width)
        task_input.focus()

    def on_resize(self, event: Resize) -> None:
        self.apply_responsive_layout(event.size.width)

    def apply_responsive_layout(self, width: int) -> None:
        self.compact = width < 120
        self.narrow = width < 72
        self.query_one("#status_bar", Static).update(self.status_text(self.last_state))

    def now(self) -> str:
        return datetime.now().strftime("%H:%M")

    def shorten(self, text: str, limit: int) -> str:
        text = " ".join(str(text).splitlines())
        if len(text) <= limit:
            return text
        return text[: max(0, limit - 1)] + "…"

    def indent_lines(self, text: str, prefix: str = "      ") -> str:
        return "\n".join(f"{prefix}{line}" for line in str(text).splitlines())

    def format_inline_message(self, prefix: str, text: str) -> str:
        lines = str(text).splitlines() or [""]
        first = f"{prefix} {lines[0]}" if lines[0] else prefix
        if len(lines) == 1:
            return first
        return first + "\n" + "\n".join(f"      {line}" for line in lines[1:])

    def tool_args_preview(self, raw_args: Any) -> str:
        if raw_args is None:
            return ""
        text = str(raw_args).strip()
        if not text:
            return ""
        try:
            parsed = json.loads(text)
        except Exception:
            return self.shorten(text, 180)
        return self.shorten(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")), 180)

    def add_event(self, kind: str, title: str, body: str = "", css_class: str = "system") -> Static:
        stamp = self.now()
        line = f"{stamp}  [{kind}] {title}"
        if body:
            line += "\n" + self.indent_lines(body, "      | ")
        widget = Static(line, classes=f"message {css_class}", markup=False)
        messages = self.query_one("#messages", VerticalScroll)
        messages.mount(widget)
        messages.scroll_end(animate=False)
        return widget

    def add_message(self, speaker: str, text: str, css_class: str) -> Static:
        stamp = self.now()
        if css_class == "user" or speaker == "你":
            content = self.format_inline_message(f"{stamp}  you", text)
        elif css_class == "assistant" or speaker == "Hoya":
            content = f"{stamp}  hoya\n{text}"
        elif css_class == "tool":
            content = self.format_inline_message(f"{stamp}  tool", text)
        elif css_class == "error":
            content = self.format_inline_message(f"{stamp}  error", text)
        else:
            content = self.format_inline_message(f"{stamp}  note", text)

        widget = Static(content, classes=f"message {css_class}", markup=False)
        messages = self.query_one("#messages", VerticalScroll)
        messages.mount(widget)
        messages.scroll_end(animate=False)
        return widget

    def ensure_assistant_message(self) -> Static:
        if self.current_assistant is None:
            self.current_assistant_stamp = self.now()
            self.current_assistant = Static(
                f"{self.current_assistant_stamp}  hoya\n",
                classes="message assistant",
                markup=False,
            )
            messages = self.query_one("#messages", VerticalScroll)
            messages.mount(self.current_assistant)
            messages.scroll_end(animate=False)
        return self.current_assistant

    def update_assistant_message(self) -> None:
        widget = self.ensure_assistant_message()
        widget.update(f"{self.current_assistant_stamp}  hoya\n{self.current_answer}")
        self.query_one("#messages", VerticalScroll).scroll_end(animate=False)

    def set_state(self, state: str) -> None:
        self.last_state = state
        self.query_one("#status_bar", Static).update(self.status_text(state))

    def refresh_status(self, state: str) -> None:
        self.set_state(state)

    def set_activity(self, text: str) -> None:
        self.set_state(text)

    def set_task_info(self, task: str) -> None:
        return

    def status_text(self, state: str) -> str:
        if self.config is None:
            return state
        shell = "on" if self.config.allow_shell else "off"
        desktop = "on" if self.config.allow_desktop else "off"
        model = self.shorten(self.config.model, 24 if self.narrow else 36)
        workspace = self.shorten(str(self.config.workspace), 28)
        if self.narrow:
            return f"{state} | {model} | tools:{self.tool_count}"
        if self.compact:
            return f"{state} | {model} | tools:{self.tool_count} | shell:{shell} desktop:{desktop}"
        return f"{state} | {model} | {self.config.wire_api} | {workspace} | shell:{shell} desktop:{desktop}"

    def action_clear_messages(self) -> None:
        self.query_one("#messages", VerticalScroll).remove_children()
        self.current_assistant = None
        self.current_answer = ""
        self.current_assistant_stamp = ""
        self.tool_count = 0
        self.set_task_info("")
        self.set_activity("-")
        self.refresh_status("就绪")

    def action_focus_input(self) -> None:
        self.query_one("#task_input", TextArea).focus()

    def action_toggle_tool_details(self) -> None:
        self.show_tool_details = not self.show_tool_details
        state = "expanded" if self.show_tool_details else "collapsed"
        self.add_event("system", f"future tool output: {state}", css_class="system")
        self.set_activity(f"工具详情{state}")

    def action_submit_task(self) -> None:
        self.submit_current_task()

    def submit_current_task(self) -> None:
        task_input = self.query_one("#task_input", TextArea)
        task = task_input.text.strip()
        if not task:
            return
        if self.busy:
            self.add_message("system", "Agent 正在处理上一个任务，请稍等。", "system")
            return
        if self.agent is None:
            self.add_message("system", "Agent 尚未初始化成功。", "error")
            return

        if task.startswith("/"):
            task_input.load_text("")
            self.handle_local_command(task)
            return

        task_input.load_text("")
        self.add_message("你", task, "user")
        if self.history is not None:
            self.history.append("user", task)
        self.current_answer = ""
        self.current_assistant = None
        self.current_assistant_stamp = ""
        self.busy = True
        self.set_task_info(task)
        self.set_activity("开始任务")
        self.refresh_status("运行中")
        self.run_agent_task(task)

    @work(thread=True)
    def run_agent_task(self, task: str) -> None:
        assert self.agent is not None
        try:
            if self.run_log is not None:
                self.run_log.append({"type": "task_start", "task": task})
            for event in self.agent.run_stream(task):
                if self.run_log is not None and event.get("type") in {"status", "tool_start", "tool_result", "error", "done"}:
                    self.run_log.append({"type": "agent_event", "event": event})
                self.call_from_thread(self.handle_agent_event, event)
        except Exception as exc:
            self.call_from_thread(self.handle_agent_event, {"type": "error", "text": str(exc)})
        finally:
            self.call_from_thread(self.finish_task)

    def handle_agent_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if event_type == "status":
            text = str(event.get("text", "运行中"))
            self.set_activity(text)
            self.refresh_status(text)
            self.add_event("status", text, css_class="status")
            return

        if event_type == "token":
            self.current_answer += event.get("text", "")
            self.update_assistant_message()
            self.set_activity("正在生成回答")
            return

        if event_type == "tool_start":
            self.tool_count += 1
            self.refresh_status("调用工具")
            name = str(event.get("name", "unknown_tool"))
            preview = self.tool_args_preview(event.get("arguments"))
            title = f"{name} {preview}" if preview else name
            self.set_activity(f"调用 {name}")
            self.add_event("tool", title, css_class="tool")
            return

        if event_type == "tool_result":
            name = str(event.get("name", "unknown_tool"))
            self.set_activity(f"{name} 完成")
            if self.show_tool_details:
                result = str(event.get("result", ""))
                if len(result) > 1200:
                    result = result[:1200] + "…"
                self.add_event("tool", f"{name} completed", result, "tool")
            else:
                self.add_event("tool", f"{name} completed", "output hidden; Ctrl+T toggles future tool output", "tool")
            return

        if event_type == "done":
            done_text = str(event.get("text", ""))
            if not self.current_answer and done_text:
                self.current_answer = done_text
                self.update_assistant_message()
            if self.history is not None and self.current_answer:
                self.history.append("assistant", self.current_answer)
            self.set_activity("回答完成")
            return

        if event_type == "error":
            self.set_activity("出错")
            self.add_message("error", event.get("text", "未知错误"), "error")
            return

    def finish_task(self) -> None:
        self.busy = False
        self.set_task_info("")
        self.refresh_status("就绪")
        self.query_one("#task_input", TextArea).focus()

    def handle_local_command(self, command: str) -> None:
        name, _, rest = command.partition(" ")
        name = name.lower()
        arg = rest.strip()

        if self.config is None:
            self.add_message("system", "配置尚未加载。", "error")
            return

        if name in {"/help", "/?"}:
            self.add_message(
                "system",
                "/import <路径> 导入文件或目录\n"
                "/index 建立工作区索引\n"
                "/search <关键词> 搜索索引\n"
                "/history [数量] 查看最近对话\n"
                "/pending 查看待审批写入\n"
                "/apply <id> 应用待审批写入\n"
                "/tools 切换工具输出详情折叠/展开\n"
                "/clear 清空界面",
                "system",
            )
            return

        if name == "/clear":
            self.action_clear_messages()
            return

        if name == "/tools":
            self.action_toggle_tool_details()
            return

        if name == "/import":
            if not arg:
                self.add_message("system", "用法：/import C:\\path\\file.txt", "error")
                return
            result = import_path(arg, self.config.imports_dir)
            if result.get("ok"):
                self.add_message("system", f"已导入: {result['relative']}", "system")
            else:
                self.add_message("system", str(result.get("error")), "error")
            return

        if name == "/index":
            payload = build_index(self.config.workspace, self.config.index_path)
            self.add_message("system", f"索引完成: {len(payload['files'])} 个文件", "system")
            return

        if name == "/search":
            if not arg:
                self.add_message("system", "用法：/search 关键词", "error")
                return
            result = search_index(self.config.index_path, arg, limit=8)
            if not result.get("ok"):
                self.add_message("system", str(result.get("error")), "error")
                return
            lines = []
            for item in result.get("results", []):
                lines.append(f"{item['score']}  {item['path']}")
            self.add_message("system", "\n".join(lines) if lines else "没有匹配结果。", "system")
            return

        if name == "/history":
            limit = 12
            if arg.isdigit():
                limit = int(arg)
            if self.history is None:
                self.add_message("system", "历史记录未初始化。", "error")
                return
            entries = self.history.recent(limit)
            lines = [f"{entry['created_at']} {entry['role']}: {entry['content'][:120]}" for entry in entries]
            self.add_message("system", "\n".join(lines) if lines else "暂无历史。", "system")
            return

        if name == "/pending":
            entries = load_pending_writes(self.config.pending_writes_path)
            if not entries:
                self.add_message("system", "没有待审批写入。", "system")
                return
            lines = []
            for entry in entries:
                diff = entry.get("diff", "")
                diff_preview = diff[:800] + ("..." if len(diff) > 800 else "")
                lines.append(f"id={entry.get('id')} path={entry.get('path')}\n{diff_preview}")
            self.add_message("system", "\n\n".join(lines), "tool")
            return

        if name == "/apply":
            if not arg:
                self.add_message("system", "用法：/apply <id>", "error")
                return
            result = apply_pending_write(self.config.workspace, self.config.pending_writes_path, arg)
            if result.get("ok"):
                self.add_message("system", f"已应用写入: {result['path']}", "system")
            else:
                self.add_message("system", str(result.get("error")), "error")
            return

        self.add_message("system", f"未知命令: {name}。输入 /help 查看可用命令。", "error")


def main() -> None:
    HoyaAgentApp().run()


if __name__ == "__main__":
    main()
