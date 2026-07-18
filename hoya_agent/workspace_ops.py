from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


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


def timestamp() -> str:
    return datetime.now().isoformat(timespec="seconds")


def unique_destination(directory: Path, name: str) -> Path:
    target = directory / Path(name).name
    if not target.exists():
        return target

    stem = target.stem
    suffix = target.suffix
    for index in range(1, 1000):
        candidate = directory / f"{stem}_{index}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Cannot find available destination for {name}")


def import_path(source: str, imports_dir: Path) -> dict[str, Any]:
    source_path = Path(source.strip().strip('"').strip("'")).expanduser().resolve()
    if not source_path.exists():
        return {"ok": False, "error": f"source does not exist: {source_path}"}

    imports_dir.mkdir(parents=True, exist_ok=True)
    target = unique_destination(imports_dir, source_path.name)
    if source_path.is_dir():
        shutil.copytree(source_path, target)
    else:
        shutil.copy2(source_path, target)

    return {
        "ok": True,
        "source": str(source_path),
        "imported": str(target),
        "relative": str(target.relative_to(imports_dir.parent)),
    }


@dataclass
class HistoryStore:
    path: Path

    def append(self, role: str, content: str, meta: dict[str, Any] | None = None) -> None:
        entry = {
            "created_at": timestamp(),
            "role": role,
            "content": content,
            "meta": meta or {},
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def recent(self, limit: int = 12) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8", errors="replace").splitlines()
        entries = []
        for line in lines[-limit:]:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries


@dataclass
class RunLog:
    path: Path

    def append(self, event: dict[str, Any]) -> None:
        payload = {"created_at": timestamp(), **event}
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def is_text_file(path: Path) -> bool:
    return path.suffix.lower() in TEXT_EXTENSIONS


def safe_read_text(path: Path, max_chars: int = 4000) -> str:
    return path.read_text(encoding="utf-8", errors="replace")[:max_chars]


def build_index(workspace: Path, index_path: Path, max_files: int = 1000) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    ignored_dirs = {".git", "__pycache__", ".venv", "venv", ".pytest_cache", "node_modules"}

    for path in workspace.rglob("*"):
        if len(records) >= max_files:
            break
        if not path.is_file():
            continue
        if any(part in ignored_dirs for part in path.relative_to(workspace).parts):
            continue
        if path.name.startswith(".hoya_"):
            continue

        relative = str(path.relative_to(workspace))
        record: dict[str, Any] = {
            "path": relative,
            "suffix": path.suffix.lower(),
            "size": path.stat().st_size,
        }
        if is_text_file(path):
            text = safe_read_text(path, 2500)
            record["preview"] = text
        records.append(record)

    payload = {
        "built_at": timestamp(),
        "workspace": str(workspace),
        "files": records,
        "truncated": len(records) >= max_files,
    }
    index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def search_index(index_path: Path, query: str, limit: int = 10) -> dict[str, Any]:
    if not index_path.exists():
        return {"ok": False, "error": "index does not exist. Run /index first."}
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    terms = [term.lower() for term in query.split() if term.strip()]
    scored = []

    for record in payload.get("files", []):
        haystack = f"{record.get('path', '')}\n{record.get('preview', '')}".lower()
        score = sum(haystack.count(term) for term in terms) if terms else 0
        if score:
            scored.append((score, record))

    scored.sort(key=lambda item: item[0], reverse=True)
    return {
        "ok": True,
        "built_at": payload.get("built_at"),
        "results": [{"score": score, **record} for score, record in scored[:limit]],
    }


def load_pending_writes(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    if not isinstance(entries, list):
        return []
    normalized: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        item = dict(entry)
        item.setdefault("operation", "write_file")
        normalized.append(item)
    return normalized


def _save_pending_writes(path: Path, entries: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


def _split_pending(entries: list[dict[str, Any]], pending_id: str) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    selected: dict[str, Any] | None = None
    remaining: list[dict[str, Any]] = []
    for entry in entries:
        if entry.get("id") == pending_id:
            selected = entry
        else:
            remaining.append(entry)
    return selected, remaining


def _workspace_target(workspace: Path, relative_path: str) -> Path:
    root = workspace.resolve()
    target = (root / str(relative_path).strip().replace("\\", "/")).resolve()
    if target != root and root not in target.parents:
        raise ValueError("pending operation target is outside workspace")
    return target


def apply_pending_operation(
    workspace: Path,
    pending_path: Path,
    pending_id: str,
    *,
    allow_shell: bool = False,
) -> dict[str, Any]:
    from .tools import assess_shell_risk, assess_write_risk

    entries = load_pending_writes(pending_path)
    selected, remaining = _split_pending(entries, pending_id)

    if selected is None:
        return {"ok": False, "error": f"pending operation not found: {pending_id}"}

    operation = selected.get("operation", "write_file")
    root = workspace.resolve()

    if operation == "write_file":
        target = _workspace_target(root, str(selected.get("path", "")))
        content = str(selected.get("content", ""))
        relative = str(target.relative_to(root))
        risk = assess_write_risk(relative, content, target.exists())
        if not risk.get("allowed", False):
            return {"ok": False, "error": "pending write rejected by risk check", "risk": risk}
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        _save_pending_writes(pending_path, remaining)
        return {"ok": True, "operation": operation, "path": relative, "id": pending_id, "risk": risk}

    if operation == "run_powershell":
        if not allow_shell:
            return {"ok": False, "error": "shell execution is disabled"}
        command = str(selected.get("command", ""))
        risk = assess_shell_risk(command)
        if not risk.get("allowed", False):
            return {"ok": False, "error": "pending shell command rejected by risk check", "risk": risk}
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            cwd=root,
            text=True,
            capture_output=True,
            timeout=int(selected.get("timeout_seconds", 30)),
            check=False,
        )
        _save_pending_writes(pending_path, remaining)
        return {
            "ok": True,
            "operation": operation,
            "id": pending_id,
            "returncode": completed.returncode,
            "stdout": completed.stdout[-12000:],
            "stderr": completed.stderr[-12000:],
            "risk": risk,
        }

    return {"ok": False, "error": f"unknown pending operation: {operation}"}


def apply_pending_write(workspace: Path, pending_path: Path, pending_id: str) -> dict[str, Any]:
    return apply_pending_operation(workspace, pending_path, pending_id)


def deny_pending_operation(pending_path: Path, pending_id: str) -> dict[str, Any]:
    entries = load_pending_writes(pending_path)
    selected, remaining = _split_pending(entries, pending_id)
    if selected is None:
        return {"ok": False, "error": f"pending operation not found: {pending_id}"}
    _save_pending_writes(pending_path, remaining)
    return {"ok": True, "id": pending_id, "operation": selected.get("operation", "write_file")}
