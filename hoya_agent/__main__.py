from __future__ import annotations

import sys

from .terminal.cli import main as cli_main


def main() -> None:
    if "--qq" in sys.argv:
        from .qq_bridge import main as qq_main

        qq_main()
        return

    if "--tui" in sys.argv:
        try:
            from .terminal.tui import main as tui_main
        except ModuleNotFoundError as exc:
            if exc.name == "textual":
                print("Textual 未安装。请先运行: python -m pip install -r requirements.txt")
                return
            raise
        tui_main()
        return

    if "--server" in sys.argv:
        from .server import main as server_main

        server_main()
        return

    cli_main()


if __name__ == "__main__":
    main()
