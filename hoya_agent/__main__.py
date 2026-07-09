from __future__ import annotations

import sys

from .cli import main as cli_main


def main() -> None:
    if "--tui" in sys.argv:
        try:
            from .tui import main as tui_main
        except ModuleNotFoundError as exc:
            if exc.name == "textual":
                print("Textual 未安装。请先运行: python -m pip install -r requirements.txt")
                return
            raise
        tui_main()
        return

    cli_main()


if __name__ == "__main__":
    main()
