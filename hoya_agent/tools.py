from __future__ import annotations

import json
import os
import re
import subprocess
import uuid
import zipfile
from datetime import datetime
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from xml.etree import ElementTree
import difflib

from .capabilities import discover_mcp_servers, discover_skills
from .memory import MemoryStore
from .path_security import is_sensitive_path
from .run_state import ChangeStore
from .workspace_ops import append_pending_operation, build_index, sanitized_subprocess_environment, search_index


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

SKIP_DIRS = {
    ".agents",
    ".claude",
    ".codex",
    ".git",
    ".hoya",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "archive",
    "artifacts",
    "build",
    "dist",
    "dist-backend",
    "node_modules",
    "release",
    "venv",
}
SKIP_FILE_PREFIXES = (".hoya_",)
MAX_LIST_FILES = 1000
MAX_READ_CHARS = 100_000
MAX_SEARCH_RESULTS = 200
MAX_INDEX_FILES = 5000
MAX_SHELL_TIMEOUT_SECONDS = 120


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

    def relative(self, path: Path) -> str:
        return str(path.resolve().relative_to(self.root))


def _should_skip_workspace_path(root: Path, path: Path) -> bool:
    relative_parts = path.relative_to(root).parts
    if any(part in SKIP_DIRS for part in relative_parts):
        return True
    return path.name.startswith(SKIP_FILE_PREFIXES) or is_sensitive_path(path, root)


def _text_result(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


DANGEROUS_SHELL_PATTERNS = (
    (r"\bremove-item\b", "remove-item"),
    (r"\brm\b", "rm"),
    (r"\brmdir\b", "rmdir"),
    (r"\bdel\b", "del"),
    (r"\bformat\b", "format"),
    (r"\breg(?:edit)?\b", "reg"),
    (r"\bset-executionpolicy\b", "set-executionpolicy"),
    (r"\binvoke-(?:webrequest|restmethod)\b", "invoke-webrequest"),
    (r"\b(?:iwr|irm|curl|wget)\b", "download command"),
    (r"\bstart-process\b", "start-process"),
    (r"\bschtasks\b", "schtasks"),
    (r"\bnet\s+user\b", "net user"),
    (r"\bicacls\b", "icacls"),
    (r"\btakeown\b", "takeown"),
)


def bounded_int(value: object, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))


def assess_shell_risk(command: str) -> dict[str, Any]:
    lowered = command.lower()
    hits = [label for pattern, label in DANGEROUS_SHELL_PATTERNS if re.search(pattern, lowered)]
    if hits:
        return {
            "level": "high",
            "allowed": False,
            "reasons": [f"dangerous token: {token}" for token in hits],
        }
    if ".." in command or re.search(r"(?:^|[;&|]\s*)(?:cd|set-location|push-location)\b", lowered):
        return {
            "level": "medium",
            "allowed": False,
            "reasons": ["command attempts to change or escape the workspace"],
        }
    return {
        "level": "medium",
        "allowed": False,
        "reasons": ["PowerShell is not filesystem-sandboxed and requires explicit approval"],
    }


def assess_write_risk(relative_path: str, content: str, exists: bool) -> dict[str, Any]:
    reasons: list[str] = []
    suffix = Path(relative_path).suffix.lower()
    if suffix in {".exe", ".dll", ".ps1", ".bat", ".cmd", ".reg"}:
        reasons.append(f"sensitive executable/script extension: {suffix}")
    if len(content) > 500_000:
        reasons.append("large write over 500KB")
    if exists:
        reasons.append("overwrites an existing file")
    level = "medium" if reasons else "low"
    return {"level": level, "allowed": True, "reasons": reasons or ["workspace path guard passed"]}


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
    permission_mode: str = "risk",
    change_store: ChangeStore | None = None,
) -> dict[str, Tool]:
    ws = Workspace(workspace)

    def desktop_dir() -> Path:
        home = Path(os.environ.get("USERPROFILE") or Path.home())
        return home / "Desktop"

    def list_files(args: dict[str, Any]) -> Any:
        start = ws.resolve(args.get("path", "."))
        max_files = bounded_int(args.get("max_files"), 200, 1, MAX_LIST_FILES)
        if not start.exists():
            return {"error": "path does not exist"}
        files = []
        candidates = [start] if start.is_file() else start.rglob("*")
        for path in candidates:
            if len(files) >= max_files:
                break
            if _should_skip_workspace_path(ws.root, path):
                continue
            files.append(ws.relative(path))
        return {"files": files, "truncated": len(files) >= max_files}

    def read_file(args: dict[str, Any]) -> Any:
        path = ws.resolve(args["path"])
        relative = ws.relative(path)
        max_chars = bounded_int(args.get("max_chars"), 20000, 1, MAX_READ_CHARS)
        if is_sensitive_path(path, ws.root):
            return {"error": "reading sensitive credential files is blocked", "path": relative}
        if not path.exists():
            return {"error": "file does not exist", "path": args["path"]}
        if path.is_dir():
            return {"error": "path is a directory; use list_files to inspect it", "path": relative}
        if not path.is_file():
            return {"error": "path is not a regular file", "path": relative}
        text = path.read_text(encoding="utf-8", errors="replace")
        return {
            "path": relative,
            "content": text[:max_chars],
            "truncated": len(text) > max_chars,
        }

    def write_file(args: dict[str, Any]) -> Any:
        path = ws.resolve(args["path"])
        content = args["content"]
        run_id = str(args.get("_hoya_run_id", ""))
        relative = ws.relative(path)
        if is_sensitive_path(path, ws.root):
            return {"error": "writing sensitive credential or repository-control files is blocked", "path": relative}
        risk = assess_write_risk(relative, content, path.exists())
        should_approve = require_write_approval or permission_mode == "strict" or (
            permission_mode == "risk" and risk.get("level") != "low"
        )
        if should_approve:
            old = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
            diff = "\n".join(
                difflib.unified_diff(
                    old.splitlines(),
                    content.splitlines(),
                    fromfile=relative,
                    tofile=relative,
                    lineterm="",
                )
            )
            pending_id = uuid.uuid4().hex[:8]
            append_pending_operation(
                pending_writes_path,
                {
                    "id": pending_id,
                    "operation": "write_file",
                    "path": relative,
                    "content": content,
                    "diff": diff,
                    "risk": risk,
                    "run_id": run_id,
                    "created_at": datetime.now().isoformat(timespec="seconds"),
                },
            )
            return {
                "ok": False,
                "pending": True,
                "id": pending_id,
                "path": relative,
                "message": "Write is pending approval. Use /pending and /apply <id> in the TUI.",
                "diff": diff,
                "risk": risk,
                "run_id": run_id,
            }
        if change_store is not None:
            return change_store.write_text(relative, content, run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return {"ok": True, "path": relative, "bytes": len(content.encode("utf-8"))}

    def read_document(args: dict[str, Any]) -> Any:
        path = ws.resolve(args["path"])
        relative = ws.relative(path)
        max_chars = bounded_int(args.get("max_chars"), 30000, 1, MAX_READ_CHARS)
        if is_sensitive_path(path, ws.root):
            return {"error": "reading sensitive credential files is blocked", "path": relative}
        if not path.exists():
            return {"error": "file does not exist", "path": args["path"]}
        if path.is_dir():
            return {"error": "path is a directory; use list_files to inspect it", "path": relative}
        if not path.is_file():
            return {"error": "path is not a regular file", "path": relative}
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
            "path": relative,
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
        path = desktop / file_name
        content = args.get("content", "")
        run_id = str(args.get("_hoya_run_id", ""))
        risk = {
            "level": "high",
            "allowed": True,
            "reasons": ["writes outside the selected workspace"],
        }
        if require_write_approval or permission_mode != "yolo":
            pending_id = uuid.uuid4().hex[:8]
            append_pending_operation(
                pending_writes_path,
                {
                    "id": pending_id,
                    "operation": "write_desktop_file",
                    "file_name": file_name,
                    "content": content,
                    "path": str(path),
                    "risk": risk,
                    "run_id": run_id,
                    "created_at": datetime.now().isoformat(timespec="seconds"),
                },
            )
            return {
                "ok": False,
                "pending": True,
                "id": pending_id,
                "path": str(path),
                "message": "Desktop write is pending approval.",
                "risk": risk,
                "run_id": run_id,
            }
        desktop.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return {
            "ok": True,
            "path": str(path),
            "bytes": len(content.encode("utf-8")),
            "risk": risk,
        }

    def search_text(args: dict[str, Any]) -> Any:
        query = args["query"]
        start = ws.resolve(args.get("path", "."))
        max_results = bounded_int(args.get("max_results"), 50, 1, MAX_SEARCH_RESULTS)
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
            relative = ws.relative(path)
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError as exc:
                results.append({"path": relative, "error": str(exc)})
                continue
            for line_no, line in enumerate(text.splitlines(), start=1):
                if query.lower() in line.lower():
                    results.append(
                        {
                            "path": relative,
                            "line": line_no,
                            "text": line[:300],
                        }
                    )
                    if len(results) >= max_results:
                        break
        return {"results": results}

    def index_files(args: dict[str, Any]) -> Any:
        max_files = bounded_int(args.get("max_files"), 1000, 1, MAX_INDEX_FILES)
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
        limit = int(args.get("limit", 8))
        query = str(args.get("query", "")).strip()
        return {"memory": memory.relevant(query, limit) if query else memory.recent(limit)}

    def list_skills(args: dict[str, Any]) -> Any:
        return {"skills": discover_skills(ws.root)}

    def read_skill(args: dict[str, Any]) -> Any:
        name = str(args.get("name", "")).strip()
        if not name:
            return {"error": "name is required"}
        skills = discover_skills(ws.root)
        selected = next((skill for skill in skills if skill.get("name") == name or Path(skill.get("path", "")).parent.name == name), None)
        if selected is None:
            return {"error": f"skill not found: {name}", "skills": skills}
        path = Path(selected["path"]).resolve()
        skills_root = (ws.root / ".agents" / "skills").resolve()
        if skills_root not in path.parents:
            return {"error": "skill path is outside the workspace skills directory"}
        text = path.read_text(encoding="utf-8", errors="replace")
        return {"skill": selected, "content": text[:MAX_READ_CHARS], "truncated": len(text) > MAX_READ_CHARS}

    def list_mcp_servers(args: dict[str, Any]) -> Any:
        return {"servers": discover_mcp_servers(ws.root)}

    def run_powershell(args: dict[str, Any]) -> Any:
        if not allow_shell:
            return {"error": "shell execution is disabled. Set HOYA_ALLOW_SHELL=1 to enable it."}
        command = args["command"]
        timeout_seconds = bounded_int(args.get("timeout_seconds"), 30, 1, MAX_SHELL_TIMEOUT_SECONDS)
        run_id = str(args.get("_hoya_run_id", ""))
        risk = assess_shell_risk(command)
        should_approve = require_shell_approval or permission_mode == "strict" or (
            permission_mode == "risk" and risk.get("level") != "low"
        )
        if not risk.get("allowed", False) and permission_mode == "yolo":
            risk = {**risk, "allowed": True, "reasons": [*risk.get("reasons", []), "YOLO permission granted by user"]}
        elif not risk.get("allowed", False) and not should_approve:
            return {
                "error": "command rejected by risk check",
                "command": command,
                "risk": risk,
            }
        if should_approve:
            pending_id = uuid.uuid4().hex[:8]
            append_pending_operation(
                pending_writes_path,
                {
                    "id": pending_id,
                    "operation": "run_powershell",
                    "command": command,
                    "timeout_seconds": timeout_seconds,
                    "risk": risk,
                    "run_id": run_id,
                    "created_at": datetime.now().isoformat(timespec="seconds"),
                },
            )
            return {
                "ok": False,
                "pending": True,
                "id": pending_id,
                "operation": "run_powershell",
                "command": command,
                "message": "Shell command is pending approval. Use /pending and /apply <id> in the TUI, or approve it in the desktop app.",
                "risk": risk,
                "run_id": run_id,
            }
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            cwd=ws.root,
            env=sanitized_subprocess_environment(),
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
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
                    "description": "Recall durable memories relevant to the current task.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Keywords describing the current task."},
                            "limit": {"type": "integer", "default": 8},
                        },
                    },
                },
            },
            handler=recall_memory,
        ),
        "list_skills": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "list_skills",
                    "description": "List installed workspace skills from .agents/skills.",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            handler=list_skills,
        ),
        "read_skill": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "read_skill",
                    "description": "Read an installed workspace skill's SKILL.md by name before applying that skill.",
                    "parameters": {
                        "type": "object",
                        "required": ["name"],
                        "properties": {"name": {"type": "string"}},
                    },
                },
            },
            handler=read_skill,
        ),
        "list_mcp_servers": Tool(
            schema={
                "type": "function",
                "function": {
                    "name": "list_mcp_servers",
                    "description": "List detected MCP server configuration for this workspace.",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            handler=list_mcp_servers,
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


def run_tool(tools: dict[str, Tool], name: str, raw_args: str, context: dict[str, Any] | None = None) -> str:
    if name not in tools:
        return _text_result({"error": f"unknown tool: {name}"})
    try:
        args = json.loads(raw_args or "{}")
        if context:
            for key, value in context.items():
                args[f"_hoya_{key}"] = value
        return _text_result(tools[name].handler(args))
    except Exception as exc:
        return _text_result({"error": str(exc)})
