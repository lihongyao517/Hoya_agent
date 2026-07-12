from __future__ import annotations

import json
from typing import Any

from .agent import HoyaAgent
from .config import Config
from .workspace_ops import HistoryStore, RunLog


PROMPT = "› "
RULE = "─" * 56


def shorten(text: Any, limit: int = 180) -> str:
    value = " ".join(str(text).splitlines())
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)] + "…"


def tool_args_preview(raw_args: Any) -> str:
    if raw_args is None:
        return ""
    text = str(raw_args).strip()
    if not text:
        return ""
    try:
        parsed = json.loads(text)
    except Exception:
        return shorten(text)
    return shorten(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")))


def print_block(title: str, body: str = "") -> None:
    print(f"\n{RULE}")
    print(title)
    if body:
        print(body)
    print(RULE)


def print_intro(config: Config) -> None:
    shell = "on" if config.allow_shell else "off"
    desktop = "on" if config.allow_desktop else "off"
    print("Hoya")
    print("本地工作区 Agent · 输入任务开始，/exit 退出")
    print(f"workspace  {config.workspace}")
    print(f"model      {config.model} · {config.wire_api}")
    print(f"tools      shell={shell} desktop={desktop}")
    print(RULE)


def main() -> None:
    try:
        config = Config.from_env()
    except ValueError as exc:
        print_block("[error] Hoya 配置错误", str(exc))
        return

    agent = HoyaAgent(config)
    history = HistoryStore(config.history_path)
    run_log = RunLog(config.run_log_path)

    print_intro(config)

    while True:
        try:
            task = input(PROMPT).strip()
        except (EOFError, KeyboardInterrupt):
            print("\n已退出。")
            break

        if not task:
            continue
        if task.lower() in {"/exit", "exit", "quit", "q"}:
            print("已退出。")
            break

        history.append("user", task)
        run_log.append({"type": "task_start", "task": task, "ui": "cli"})

        answer_parts: list[str] = []
        answer_started = False
        try:
            for event in agent.run_stream(task):
                event_type = event.get("type")
                if event_type in {"status", "tool_start", "tool_result", "error", "done"}:
                    run_log.append({"type": "agent_event", "event": event, "ui": "cli"})

                if event_type == "status":
                    print(f"\n[status] {event.get('text', '运行中')}")
                    continue

                if event_type == "tool_start":
                    name = event.get("name", "unknown_tool")
                    preview = tool_args_preview(event.get("arguments"))
                    suffix = f" {preview}" if preview else ""
                    print(f"\n[tool] {name}{suffix}")
                    continue

                if event_type == "tool_result":
                    name = event.get("name", "unknown_tool")
                    print(f"[tool] {name} completed · output hidden")
                    continue

                if event_type == "token":
                    text = str(event.get("text", ""))
                    if not text:
                        continue
                    if not answer_started:
                        print("\nHoya")
                        answer_started = True
                    answer_parts.append(text)
                    print(text, end="", flush=True)
                    continue

                if event_type == "done":
                    done_text = str(event.get("text", ""))
                    if not answer_parts and done_text:
                        if not answer_started:
                            print("\nHoya")
                            answer_started = True
                        answer_parts.append(done_text)
                        print(done_text, end="", flush=True)
                    continue

                if event_type == "error":
                    print(f"\n[error] {event.get('text', '未知错误')}")
                    continue

            if answer_started:
                print("\n")
        except Exception as exc:
            run_log.append({"type": "error", "task": task, "error": str(exc), "ui": "cli"})
            print_block("[error] Hoya 出错", str(exc))
            continue

        answer = "".join(answer_parts)
        if answer:
            history.append("assistant", answer)
        run_log.append({"type": "task_done", "task": task, "ui": "cli"})


if __name__ == "__main__":
    main()
