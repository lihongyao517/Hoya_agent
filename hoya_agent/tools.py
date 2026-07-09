from __future__ import annotations

import json
import os
import subprocess
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from xml.etree import ElementTree
import difflib

from .memory import MemoryStore
from .workspace_ops import build_index, search_index


TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".py",
    ".json",
    ".csv",
    ".tsv",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".log",
    ".html",
    ".css",
    ".js",
    ".ts",
}

SKIP_DIRS = {".git", "__pycache__", ".venv", "venv", ".pytest_cache", "node_modules"}
SKIP_FILE_PREFIXES = (".hoya_",)


ToolHandler = Callable[[dict[str, Any]], Any]


@dataclass
class Tool:
    schema: dict[str, Any]
    handler: ToolHandler


class Workspace:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def _clean_path(self, raw_path: str | os.PathLike[str] | None) -> str:
        text = str(raw_path or ".").strip().strip('"').strip("'")
        if not text:
            return "."
        text = text.replace("\\", "/")
        root_text = str(self.root).replace("\\", "/")
        if text == root_text:
            return "."
        if text.startswith(root_text + "/"):
            return text[len(root_text) + 1 :]
        return text

    def resolve(self, relative_path: str) -> Path:
        clean_path = self._clean_path(relative_path)
        target = (self.root / clean_path).resolve()
        if target != self.root and self.root not in target.parents:
            raise ValueError(f"Path is outside workspace: {relative_path}")
        return target


def _should_skip_workspace_path(root: Path, path: Path) -> bool:
    relative_parts = path.relative_to(root).parts
    if any(part in SKIP_DIRS for part in relative_parts):
        return True
    return path.name.startswith(SKIP_FILE_PREFIXES)


def _text_result(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def _load_json_list(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _save_json_list(path: Path, entries: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


def _extract_docx(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml")
    root = ElementTree.fromstring(xml)
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs = []
    for paragraph in root.findall(".//w:p", namespace):
        parts = [node.text or "" for node in paragraph.findall(".//w:t", namespace)]
        if parts:
            paragraphs.append("".join(parts))
    return "\n".join(paragraphs)


def _extract_xlsx(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.iter():
                if item.tag.endswith("}t") and item.text:
                    shared_strings.append(item.text)
        sheet_names = [name for name in names if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")]
        rows = []
        for sheet_name in sheet_names[:5]:
            root = ElementTree.fromstring(archive.read(sheet_name))
            rows.append(f"[{sheet_name}]")
            for row in root.iter():
                if not row.tag.endswith("}row"):
                    continue
                cells = []
                for cell in list(row):
                    if not cell.tag.endswith("}c"):
                        continue
                    cell_type = cell.attrib.get("t")
                    value_node = next((child for child in list(cell) if child.tag.endswith("}v")), None)
                    value = value_node.text if value_node is not None and value_node.text else ""
                    if cell_type == "s" and value.isdigit():
                        index = int(value)
                        value = shared_strings[index] if index < len(shared_strings) else value
                    cells.append(value)
                if cells:
                    rows.append("\t".join(cells))
        return "\n".join(rows)


def build_tools(
    workspace: Path,
    memory: MemoryStore,
    allow_shell: bool,
    allow_desktop: bool,
    index_path: Path,
    pending_writes_path: Path,
    require_write_approval: bool,
    require_shell_approval: bool,
) -> dict[str, Tool]:
    ws = Workspace(workspace)

    def desktop_dir() -> Path:
        home = Path(os.environ.get("USERPROFILE") or Path.home())
        return home / "Desktop"

    def list_files(args: dict[str, Any]) -> Any:
        start = ws.resolve(args.get("path", "."))
        max_files = int(args.get("max_files", 200))
        if not start.exists():
            return {"error": "path does not exist"}
        files = []
        candidates = [start] if start.is_file() else start.rglob("*")
        for path in candidates:
            if len(files) >= max_files:
                break
            if _should_skip_workspace_path(ws.root, path):
                continue
            files.append(str(path.relative_to(ws.root)))
        return {"files": files, "truncated": len(files) >= max_files}

    def read_file(args: dict[str, Any]) -> Any:
        path = ws.resolve(args["path"])
        max_chars = int(args.get("max_chars", 20000))
        if not path.exists():
            return {"error": "file does not exist", "path": args["path"]}
        if path.is_dir():
            return {"error": "path is a directory; use list_files to inspect it", "path": str(path.relative_to(ws.root))}
        if not path.is_file():
            return {"error": "path is not a regular file", "path": str(path.relative_to(ws.root))}
        text = path.read_text(encoding="utf-8", errors="replace")
        return {
            "path": str(path.relative_to(ws.root)),
            "content": text[:max_chars],
            "truncated": len(text) > max_chars,
        }

    def write_file(args: dict[str, Any]) -> Any:
        path = ws.resolve(args["path"])
        content = args["content"]
        if require_write_approval:
            old = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
            diff = "\n".join(
                difflib.unified_diff(
                    old.splitlines(),
                    content.splitlines(),
                    fromfile=str(path.relative_to(ws.root)),
                    tofile=str(path.relative_to(ws.root)),
                    lineterm="",
                )
            )
            entries = _load_json_list(pending_writes_path)
            pending_id = uuid.uuid4().hex[:8]
            entries.append(
                {
                    "id": pending_id,
                    "path": str(path.relative_to(ws.root)),
                    "content": content,
                    "diff": diff,
                }
            )
            _save_json_list(pending_writes_path, entries)
            return {
                "ok": False,
                "pending": True,
                "id": pending_id,
                "path": str(path.relative_to(ws.root)),
                "message": "Write is pending approval. Use /pending and /apply <id> in the TUI.",
                "diff": diff,
            }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return {"ok": True, "path": str(path.relative_to(ws.root)), "bytes": len(content.encode("utf-8"))}

    def read_document(args: dict[str, Any]) -> Any:
        path = ws.resolve(args["path"])
        max_chars = int(args.get("max_chars", 30000))
        if not path.exists():
            return {"error": "file does not exist", "path": args["path"]}
        if path.is_dir():
            return {"error": "path is a directory; use list_files to inspect it", "path": str(path.relative_to(ws.root))}
        if not path.is_file():
            return {"error": "path is not a regular file", "path": str(path.relative_to(ws.root))}
        suffix = path.suffix.lower()
        try:
            if suffix == ".docx":
                text = _extract_docx(path)
            elif suffix == ".xlsx":
                text = _extract_xlsx(path)
            elif suffix == ".pdf":
                try:
                    from pypdf import PdfReader
                except ModuleNotFoundError:
                    return {"error": "PDF support requires pypdf. Run: python -m pip install pypdf"}
                reader = PdfReader(str(path))
                text = "\n".join(page.extract_text() or "" for page in reader.pages)
            else:
                text = path.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            return {"error": str(exc)}
        return {
            "path": str(path.relative_to(ws.root)),
            "content": text[:max_chars],
            "truncated": len(text) > max_chars,
        }

    def write_desktop_file(args: dict[str, Any]) -> Any:
        if not allow_desktop:
            return {"error": "desktop write is disabled. Set HOYA_ALLOW_DESKTOP=1 to enable it."}

        file_name = args.get("file_name") or "hoya_agent.txt"
        file_name = Path(file_name).name
        if not file_name.lower().endswith(".txt"):
            file_name += ".txt"

        desktop = desktop_dir()
        desktop.mkdir(parents=True, exist_ok=True)
        path = desktop / file_name
        content = args.get("content", "")
        path.write_text(content, encoding="utf-8")
        return {"ok": True, "path": str(path), "bytes": len(content.encode("utf-8"))}

    def search_text(args: dict[str, Any]) -> Any:
        query = args["query"]
        start = ws.resolve(args.get("path", "."))
        max_results = int(args.get("max_results", 50))
        results = []
        if not start.exists():
            return {"error": "path does not exist"}
        candidates = [start] if start.is_file() else start.rglob("*")
        for path in candidates:
            if len(results) >= max_results:
                break
            if not path.is_file():
                continue
            if _should_skip_workspace_path(ws.root, path):
                continue
            if path.suffix.lower() not in TEXT_EXTENSIONS:
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError as exc:
                results.append({"path": str(path.relative_to(ws.root)), "error": str(exc)})
                continue
            for line_no, line in enumerate(text.splitlines(), start=1):
                if query.lower() in line.lower():
                    results.append(
                        {
                            "path": str(path.relative_to(ws.root)),
                            "line": line_no,
                            "text": line[:300],
                        }
                    )
                    if len(results) >= max_results:
                        break
        return {"results": results}

    def index_files(args: dict[str, Any]) -> Any:
        max_files = int(args.get("max_files", 1000))
        payload = build_index(ws.root, index_path, max_files=max_files)
        return {
            "ok": True,
            "built_at": payload["built_at"],
            "files": len(payload["files"]),
            "truncated": payload["truncated"],
        }

    def search_workspace_index(args: dict[str, Any]) -> Any:
        return search_index(index_path, args["query"], int(args.get("limit", 10)))

    def remember(args: dict[str, Any]) -> Any:
        return memory.add(args["text"])

    def recall_memory(args: dict[str, Any]) -> Any:
        return {"memory": memory.recent(int(args.get("limit", 8)))}

    def run_powershell(args: dict[str, Any]) -> Any:
        if not allow_shell:
            return {"error": "shell execution is disabled. Set HOYA_ALLOW_SHELL=1 to enable it."}
        if require_shell_approval:
            return {
                "error": "shell execution requires manual approval in this MVP.",
                "command": args["command"],
                "hint": "Run the command yourself or set HOYA_REQUIRE_SHELL_APPROVAL=0.",
            }
        command = args["command"]
        if any(token in command for token in ["..", "; cd", "Set-Location", "Push-Location"]):
            return {
                "error": "command rejected by workspace guard",
                "hint": "Run simple inspection/test commands from the workspace root without changing directories.",
            }
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            cwd=ws.root,
            text=True,
            capture_output=True,
            timeout=int(args.get("timeout_seconds", 30)),
            check=False,
        )
        return {
            "returncode": completed.returncode,
            "stdout": completed.stdout[-12000:],
            "stderr": completed.stderr[-12000:],
        }

    return {
        "list_files": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "list_files",
                    "description": "List files under a workspace path.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "default": "."},
                            "max_files": {"type": "integer", "default": 200},
                        },
                    },
                },
            },
            handler=list_files,
        ),
        "read_file": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a UTF-8 text file from the workspace. Accepts workspace-relative paths and absolute paths inside the workspace.",
                    "parameters": {
                        "type": "object",
                        "required": ["path"],
                        "properties": {
                            "path": {"type": "string"},
                            "max_chars": {"type": "integer", "default": 20000},
                        },
                    },
                },
            },
            handler=read_file,
        ),
        "write_file": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Write a UTF-8 text file inside the workspace.",
                    "parameters": {
                        "type": "object",
                        "required": ["path", "content"],
                        "properties": {
                            "path": {"type": "string"},
                            "content": {"type": "string"},
                        },
                    },
                },
            },
            handler=write_file,
        ),
        "read_document": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "read_document",
                    "description": "Read text from workspace files including txt/md/code/csv/docx/xlsx and pdf when pypdf is installed. Accepts workspace-relative paths and absolute paths inside the workspace.",
                    "parameters": {
                        "type": "object",
                        "required": ["path"],
                        "properties": {
                            "path": {"type": "string"},
                            "max_chars": {"type": "integer", "default": 30000},
                        },
                    },
                },
            },
            handler=read_document,
        ),
        "write_desktop_file": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "write_desktop_file",
                    "description": "Create or overwrite a .txt file on the user's Windows desktop. Use this when the user asks to create a txt file on the desktop.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "file_name": {"type": "string", "default": "hoya_agent.txt"},
                            "content": {"type": "string", "default": ""},
                        },
                    },
                },
            },
            handler=write_desktop_file,
        ),
        "search_text": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "search_text",
                    "description": "Search text in workspace files.",
                    "parameters": {
                        "type": "object",
                        "required": ["query"],
                        "properties": {
                            "query": {"type": "string"},
                            "path": {"type": "string", "default": "."},
                            "max_results": {"type": "integer", "default": 50},
                        },
                    },
                },
            },
            handler=search_text,
        ),
        "index_files": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "index_files",
                    "description": "Build a lightweight local workspace file index.",
                    "parameters": {
                        "type": "object",
                        "properties": {"max_files": {"type": "integer", "default": 1000}},
                    },
                },
            },
            handler=index_files,
        ),
        "search_index": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "search_index",
                    "description": "Search the lightweight workspace file index. Run index_files first if needed.",
                    "parameters": {
                        "type": "object",
                        "required": ["query"],
                        "properties": {
                            "query": {"type": "string"},
                            "limit": {"type": "integer", "default": 10},
                        },
                    },
                },
            },
            handler=search_workspace_index,
        ),
        "remember": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "remember",
                    "description": "Save durable user/project memory for future tasks.",
                    "parameters": {
                        "type": "object",
                        "required": ["text"],
                        "properties": {"text": {"type": "string"}},
                    },
                },
            },
            handler=remember,
        ),
        "recall_memory": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "recall_memory",
                    "description": "Read recent durable memories.",
                    "parameters": {
                        "type": "object",
                        "properties": {"limit": {"type": "integer", "default": 8}},
                    },
                },
            },
            handler=recall_memory,
        ),
        "run_powershell": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "run_powershell",
                    "description": "Run a PowerShell command in the workspace. Use for tests or inspection only.",
                    "parameters": {
                        "type": "object",
                        "required": ["command"],
                        "properties": {
                            "command": {"type": "string"},
                            "timeout_seconds": {"type": "integer", "default": 30},
                        },
                    },
                },
            },
            handler=run_powershell,
        ),
    }


def run_tool(tools: dict[str, Tool], name: str, raw_args: str) -> str:
    if name not in tools:
        return _text_result({"error": f"unknown tool: {name}"})
    try:
        args = json.loads(raw_args or "{}")
        return _text_result(tools[name].handler(args))
    except Exception as exc:
        return _text_result({"error": str(exc)})
