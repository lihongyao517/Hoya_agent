from __future__ import annotations

from .agent import HoyaAgent
from .config import Config
from .workspace_ops import HistoryStore, RunLog


def main() -> None:
    try:
        config = Config.from_env()
    except ValueError as exc:
        print(f"配置错误: {exc}")
        return

    agent = HoyaAgent(config)
    history = HistoryStore(config.history_path)
    run_log = RunLog(config.run_log_path)
    print("Hoya Agent 已启动。输入任务，或输入 /exit 退出。")
    print(f"工作区: {config.workspace}")
    print(f"模型: {config.model}")
    print()

    while True:
        try:
            task = input("你 > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not task:
            continue
        if task.lower() in {"/exit", "exit", "quit", "q"}:
            break

        history.append("user", task)
        run_log.append({"type": "task_start", "task": task, "ui": "cli"})
        try:
            answer = agent.run(task)
        except Exception as exc:
            run_log.append({"type": "error", "task": task, "error": str(exc), "ui": "cli"})
            print(f"\nAgent 出错: {exc}\n")
            continue

        history.append("assistant", answer)
        run_log.append({"type": "task_done", "task": task, "ui": "cli"})
        print(f"\nHoya > {answer}\n")
