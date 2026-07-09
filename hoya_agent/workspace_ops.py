from __future__ import annotations

import json
import shutil
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
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def apply_pending_write(workspace: Path, pending_path: Path, pending_id: str) -> dict[str, Any]:
    entries = load_pending_writes(pending_path)
    remaining = []
    selected: dict[str, Any] | None = None
    for entry in entries:
        if entry.get("id") == pending_id:
            selected = entry
        else:
            remaining.append(entry)

    if selected is None:
        return {"ok": False, "error": f"pending write not found: {pending_id}"}

    target = (workspace / selected["path"]).resolve()
    if target != workspace and workspace not in target.parents:
        return {"ok": False, "error": "pending write target is outside workspace"}

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(selected.get("content", ""), encoding="utf-8")
    pending_path.write_text(json.dumps(remaining, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "path": str(target.relative_to(workspace)), "id": pending_id}
