from __future__ import annotations

from datetime import datetime
from typing import Any

from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.events import Resize
from textual.widgets import Button, Footer, Header, Static, TextArea

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
        background: #0b0f14;
        color: #d8dee9;
        layout: vertical;
    }

    Header {
        background: #101620;
        color: #eceff4;
    }

    #workspace {
        height: 1fr;
        padding: 1 2 0 2;
    }

    #workspace.compact {
        padding: 0 1 0 1;
    }

    #conversation_panel {
        width: 1fr;
        height: 1fr;
        border: tall #2e3440;
        background: #0f141c;
    }

    #side_panel {
        width: 34;
        height: 1fr;
        margin-left: 1;
        border: tall #2e3440;
        background: #101620;
        padding: 1 2;
    }

    #side_panel.hidden {
        display: none;
    }

    .side_title {
        color: #88c0d0;
        text-style: bold;
        margin-bottom: 1;
    }

    .side_text {
        color: #aeb6c2;
        margin-bottom: 1;
    }

    #messages {
        height: 1fr;
        padding: 1 2;
    }

    .message {
        margin-bottom: 1;
        padding: 0 1;
    }

    .user {
        color: #eceff4;
        border-left: solid #81a1c1;
    }

    .assistant {
        color: #d8dee9;
        border-left: solid #a3be8c;
    }

    .system {
        color: #88c0d0;
        border-left: solid #5e81ac;
    }

    .tool {
        color: #ebcb8b;
        border-left: solid #d08770;
    }

    .error {
        color: #bf616a;
        border-left: solid #bf616a;
    }

    #input_panel {
        height: auto;
        padding: 1 2;
        background: #0b0f14;
    }

    #input_panel.compact {
        padding: 0 1 1 1;
    }

    #task_input {
        width: 1fr;
        height: 5;
        background: #111827;
        color: #eceff4;
        border: tall #3b4252;
    }

    #task_input.narrow {
        height: 3;
    }

    Button {
        margin-left: 1;
        min-width: 8;
    }

    Button.hidden {
        display: none;
    }

    #status_bar {
        height: 1;
        padding: 0 2;
        color: #8f9aaa;
        background: #080b10;
    }

    Footer {
        background: #101620;
    }
    """

    BINDINGS = [
        ("ctrl+c", "quit", "退出"),
        ("ctrl+l", "clear_messages", "清空"),
        ("ctrl+s", "submit_task", "发送"),
        ("ctrl+j", "submit_task", "发送"),
        ("ctrl+t", "toggle_tool_details", "工具详情"),
        ("escape", "focus_input", "输入"),
    ]

    TITLE = "Hoya Agent"
    SUB_TITLE = "local task agent"

    def __init__(self) -> None:
        super().__init__()
        self.agent: HoyaAgent | None = None
        self.config: Config | None = None
        self.busy = False
        self.current_answer = ""
        self.current_assistant: Static | None = None
        self.tool_count = 0
        self.history: HistoryStore | None = None
        self.run_log: RunLog | None = None
        self.compact = False
        self.narrow = False
        self.last_state = "启动中"
        self.show_tool_details = False

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="workspace"):
            with Vertical(id="conversation_panel"):
                yield VerticalScroll(id="messages")
            with Vertical(id="side_panel"):
                yield Static("HOYA AGENT", classes="side_title")
                yield Static("状态: 启动中", id="state_info", classes="side_text")
                yield Static("模型: -", id="model_info", classes="side_text")
                yield Static("工作区: -", id="workspace_info", classes="side_text")
                yield Static("权限: -", id="permission_info", classes="side_text")
                yield Static("工具调用: 0", id="tool_info", classes="side_text")
                yield Static("当前任务: -", id="task_info", classes="side_text")
                yield Static("最近活动: -", id="activity_info", classes="side_text")
                yield Static("快捷键\nCtrl+C 退出\nCtrl+L 清空\nCtrl+T 工具详情\nEsc 聚焦输入", classes="side_text")
        with Horizontal(id="input_panel"):
            yield TextArea.code_editor("", language="markdown", id="task_input")
            yield Button("发送", id="send", variant="primary")
            yield Button("清空", id="clear")
        yield Static("正在加载配置...", id="status_bar")
        yield Footer()

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

        self.add_message("system", "Hoya Agent 已启动。输入任务后按 Ctrl+S 或点击发送按钮提交。", "system")
        self.add_message("system", "多行输入已启用：Enter 换行，输入 /help 查看本地命令。", "system")
        self.add_message("system", "工具输出详情默认折叠；按 Ctrl+T 或输入 /tools 可切换展开/折叠。", "system")
        self.refresh_side_panel("就绪")
        self.apply_responsive_layout(self.size.width)
        task_input.focus()

    def on_resize(self, event: Resize) -> None:
        self.apply_responsive_layout(event.size.width)

    def apply_responsive_layout(self, width: int) -> None:
        self.compact = width < 96
        self.narrow = width < 64

        self.query_one("#side_panel", Vertical).set_class(self.compact, "hidden")
        self.query_one("#workspace", Horizontal).set_class(self.compact, "compact")
        self.query_one("#input_panel", Horizontal).set_class(self.compact, "compact")
        self.query_one("#send", Button).set_class(self.narrow, "hidden")
        self.query_one("#clear", Button).set_class(self.narrow, "hidden")
        self.query_one("#task_input", TextArea).set_class(self.narrow, "narrow")
        self.query_one("#status_bar", Static).update(self.status_text(self.last_state))

    def add_message(self, speaker: str, text: str, css_class: str) -> Static:
        stamp = datetime.now().strftime("%H:%M")
        widget = Static(f"[{stamp}] {speaker} > {text}", classes=f"message {css_class}", markup=False)
        messages = self.query_one("#messages", VerticalScroll)
        messages.mount(widget)
        messages.scroll_end(animate=False)
        return widget

    def set_state(self, state: str) -> None:
        self.last_state = state
        self.query_one("#state_info", Static).update(f"状态: {state}")
        self.query_one("#status_bar", Static).update(self.status_text(state))

    def refresh_side_panel(self, state: str) -> None:
        if self.config is None:
            self.set_state(state)
            return

        shell = "开" if self.config.allow_shell else "关"
        desktop = "开" if self.config.allow_desktop else "关"
        workspace = str(self.config.workspace)
        if len(workspace) > 30:
            workspace = "..." + workspace[-27:]

        self.query_one("#model_info", Static).update(f"模型: {self.config.model}")
        self.query_one("#workspace_info", Static).update(f"工作区: {workspace}")
        self.query_one("#permission_info", Static).update(f"权限: Shell {shell} / 桌面 {desktop}")
        self.query_one("#tool_info", Static).update(f"工具调用: {self.tool_count}")
        self.set_state(state)

    def set_activity(self, text: str) -> None:
        if len(text) > 28:
            text = text[:25] + "..."
        self.query_one("#activity_info", Static).update(f"最近活动: {text}")

    def set_task_info(self, task: str) -> None:
        if len(task) > 28:
            task = task[:25] + "..."
        self.query_one("#task_info", Static).update(f"当前任务: {task or '-'}")

    def status_text(self, state: str) -> str:
        if self.config is None:
            return state
        shell = "on" if self.config.allow_shell else "off"
        desktop = "on" if self.config.allow_desktop else "off"
        if self.narrow:
            return f"{state} | {self.config.model} | {self.config.wire_api}"
        if self.compact:
            return f"{state} | {self.config.model} | {self.config.wire_api} | tools:{self.tool_count} | shell:{shell} desktop:{desktop}"
        return f"{state} | {self.config.model} | {self.config.wire_api} | shell:{shell} desktop:{desktop}"

    def action_clear_messages(self) -> None:
        self.query_one("#messages", VerticalScroll).remove_children()
        self.current_assistant = None
        self.current_answer = ""
        self.tool_count = 0
        self.set_task_info("")
        self.set_activity("-")
        self.refresh_side_panel("就绪")

    def action_focus_input(self) -> None:
        self.query_one("#task_input", TextArea).focus()

    def action_toggle_tool_details(self) -> None:
        self.show_tool_details = not self.show_tool_details
        state = "展开" if self.show_tool_details else "折叠"
        self.add_message("system", f"工具输出详情已切换为：{state}", "system")
        self.set_activity(f"工具详情{state}")

    def action_submit_task(self) -> None:
        self.submit_current_task()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "send":
            self.submit_current_task()
        elif event.button.id == "clear":
            self.action_clear_messages()

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
        self.busy = True
        self.query_one("#send", Button).disabled = True
        self.set_task_info(task)
        self.set_activity("开始任务")
        self.refresh_side_panel("运行中")
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
            text = event.get("text", "运行中")
            self.set_activity(text)
            self.refresh_side_panel(text)
            return

        if event_type == "token":
            self.current_answer += event.get("text", "")
            self.set_activity("正在生成回答")
            return

        if event_type == "tool_start":
            self.tool_count += 1
            self.refresh_side_panel("调用工具")
            name = event.get("name", "unknown_tool")
            self.set_activity(f"调用 {name}")
            self.add_message("tool", f"调用 {name}", "tool")
            return

        if event_type == "tool_result":
            name = event.get("name", "unknown_tool")
            self.set_activity(f"{name} 完成")
            if self.show_tool_details:
                result = str(event.get("result", ""))
                if len(result) > 800:
                    result = result[:800] + "..."
                self.add_message("tool", f"{name} 完成: {result}", "tool")
            else:
                self.add_message("tool", f"{name} 完成（详情已折叠，按 Ctrl+T 或输入 /tools 展开后续工具详情）", "tool")
            return

        if event_type == "done":
            done_text = event.get("text", "")
            if not self.current_answer and done_text:
                self.current_answer = done_text
            if self.current_answer and self.current_assistant is None:
                self.current_assistant = self.add_message("Hoya", self.current_answer, "assistant")
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
        self.query_one("#send", Button).disabled = False
        self.set_task_info("")
        self.refresh_side_panel("就绪")
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
