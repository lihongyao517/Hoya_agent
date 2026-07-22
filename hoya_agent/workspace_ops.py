from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .path_security import is_sensitive_path
from .run_state import ChangeStore


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

_PENDING_LOCK = threading.RLock()
_LOG_LOCK = threading.RLock()
_INDEX_LOCK = threading.RLock()
SENSITIVE_ENV_MARKERS = ("ACCESS_KEY", "API_KEY", "CREDENTIAL", "PASSWORD", "SECRET", "TOKEN")


def bounded_int(value: object, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))


def sanitized_subprocess_environment() -> dict[str, str]:
    """Return a child-process environment without inherited credentials."""
    return {
        key: value
        for key, value in os.environ.items()
        if not any(marker in key.upper() for marker in SENSITIVE_ENV_MARKERS)
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
        with _LOG_LOCK:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def recent(self, limit: int = 12) -> list[dict[str, Any]]:
        with _LOG_LOCK:
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

    def delete_conversation(self, conversation_id: str) -> int:
        with _LOG_LOCK:
            if not self.path.exists():
                return 0
            kept: list[str] = []
            removed = 0
            for line in self.path.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    kept.append(line)
                    continue
                if str((entry.get("meta") or {}).get("conversation_id", "")) == conversation_id:
                    removed += 1
                else:
                    kept.append(line)
            temporary = self.path.with_suffix(self.path.suffix + f".{uuid.uuid4().hex}.tmp")
            temporary.write_text(("\n".join(kept) + "\n") if kept else "", encoding="utf-8")
            temporary.replace(self.path)
            return removed


@dataclass
class RunLog:
    path: Path

    def append(self, event: dict[str, Any]) -> None:
        payload = {"created_at": timestamp(), **event}
        with _LOG_LOCK:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def delete_conversation(self, conversation_id: str) -> int:
        with _LOG_LOCK:
            if not self.path.exists():
                return 0
            kept: list[str] = []
            removed = 0
            for line in self.path.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    kept.append(line)
                    continue
                if str(event.get("conversation_id", "")) == conversation_id:
                    removed += 1
                else:
                    kept.append(line)
            temporary = self.path.with_suffix(self.path.suffix + f".{uuid.uuid4().hex}.tmp")
            temporary.write_text(("\n".join(kept) + "\n") if kept else "", encoding="utf-8")
            temporary.replace(self.path)
            return removed


def is_text_file(path: Path) -> bool:
    return path.suffix.lower() in TEXT_EXTENSIONS


def safe_read_text(path: Path, max_chars: int = 4000) -> str:
    return path.read_text(encoding="utf-8", errors="replace")[:max_chars]


def build_index(workspace: Path, index_path: Path, max_files: int = 1000) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    ignored_dirs = {
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

    for path in workspace.rglob("*"):
        if len(records) >= max_files:
            break
        if not path.is_file():
            continue
        if any(part in ignored_dirs for part in path.relative_to(workspace).parts):
            continue
        if path.name.startswith(".hoya_"):
            continue
        if is_sensitive_path(path, workspace):
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
    with _INDEX_LOCK:
        index_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = index_path.with_suffix(index_path.suffix + f".{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(index_path)
    return payload


def search_index(index_path: Path, query: str, limit: int = 10) -> dict[str, Any]:
    with _INDEX_LOCK:
        if not index_path.exists():
            return {"ok": False, "error": "index does not exist. Run /index first."}
        payload = json.loads(index_path.read_text(encoding="utf-8"))
    workspace_text = str(payload.get("workspace", "")).strip()
    if not workspace_text:
        return {"ok": False, "error": "index is missing its workspace; rebuild it before searching"}
    workspace = Path(workspace_text).expanduser().resolve()
    terms = relevance_terms(query)
    scored = []

    for record in payload.get("files", []):
        path_text = str(record.get("path", "")).lower()
        if is_sensitive_path(workspace / path_text, workspace):
            continue
        preview = str(record.get("preview", "")).lower()
        score = sum(path_text.count(term) * 5 + preview.count(term) for term in terms)
        if score:
            scored.append((score, record))

    scored.sort(key=lambda item: item[0], reverse=True)
    return {
        "ok": True,
        "built_at": payload.get("built_at"),
        "results": [{"score": score, **record} for score, record in scored[:limit]],
    }


def relevance_terms(value: str) -> set[str]:
    lowered = value.lower()
    terms = set(re.findall(r"[a-z0-9_./-]{2,}", lowered))
    for sequence in re.findall(r"[\u3400-\u9fff]+", lowered):
        if len(sequence) <= 2:
            terms.add(sequence)
        else:
            terms.update(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return {term for term in terms if term.strip()}


def relevance_score(query: str, text: str) -> int:
    lowered = text.lower()
    return sum((3 if term in lowered else 0) + lowered.count(term) for term in relevance_terms(query))


def load_pending_writes(path: Path) -> list[dict[str, Any]]:
    with _PENDING_LOCK:
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
            item.setdefault("status", "pending")
            normalized.append(item)
        return normalized


def _save_pending_writes(path: Path, entries: list[dict[str, Any]]) -> None:
    with _PENDING_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)


def append_pending_operation(path: Path, entry: dict[str, Any]) -> None:
    with _PENDING_LOCK:
        entries = load_pending_writes(path)
        entries.append({"status": "pending", **entry})
        _save_pending_writes(path, entries)


def delete_pending_for_runs(path: Path, run_ids: list[str]) -> int:
    run_id_set = {run_id for run_id in run_ids if run_id}
    if not run_id_set:
        return 0
    with _PENDING_LOCK:
        entries = load_pending_writes(path)
        kept = [entry for entry in entries if str(entry.get("run_id", "")) not in run_id_set]
        _save_pending_writes(path, kept)
        return len(entries) - len(kept)


def update_pending_operation(path: Path, pending_id: str, **updates: Any) -> dict[str, Any] | None:
    with _PENDING_LOCK:
        entries = load_pending_writes(path)
        selected: dict[str, Any] | None = None
        for entry in entries:
            if entry.get("id") == pending_id:
                entry.update(updates)
                selected = entry
                break
        if selected is not None:
            _save_pending_writes(path, entries)
        return selected


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
    change_store: ChangeStore | None = None,
) -> dict[str, Any]:
    with _PENDING_LOCK:
        return _apply_pending_operation(
            workspace,
            pending_path,
            pending_id,
            allow_shell=allow_shell,
            change_store=change_store,
        )


def _apply_pending_operation(
    workspace: Path,
    pending_path: Path,
    pending_id: str,
    *,
    allow_shell: bool = False,
    change_store: ChangeStore | None = None,
) -> dict[str, Any]:
    from .tools import assess_shell_risk, assess_write_risk

    entries = load_pending_writes(pending_path)
    selected, remaining = _split_pending(entries, pending_id)

    if selected is None:
        return {"ok": False, "error": f"pending operation not found: {pending_id}"}

    status = str(selected.get("status", "pending"))
    if status == "applied" and isinstance(selected.get("result"), dict):
        return {**selected["result"], "consumed": True, "replayed": True}
    if status != "pending":
        return {
            "ok": False,
            "error": "该操作上次执行结果未知，请检查实际结果后拒绝并重新发起，不会自动重试。",
            "id": pending_id,
            "operation": selected.get("operation", "write_file"),
            "run_id": selected.get("run_id", ""),
            "status": status,
            "outcome_unknown": status in {"applying", "outcome_unknown"},
        }

    operation = selected.get("operation", "write_file")
    root = workspace.resolve()

    if operation == "write_file":
        target = _workspace_target(root, str(selected.get("path", "")))
        if is_sensitive_path(target, root):
            return {"ok": False, "error": "pending write targets a sensitive path", "id": pending_id}
        content = str(selected.get("content", ""))
        relative = str(target.relative_to(root))
        risk = assess_write_risk(relative, content, target.exists())
        if not risk.get("allowed", False):
            return {"ok": False, "error": "pending write rejected by risk check", "risk": risk}
        _mark_pending_applying(pending_path, entries, selected)
        try:
            if change_store is not None:
                result = change_store.write_text(relative, content, str(selected.get("run_id", "")))
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
                temporary.write_text(content, encoding="utf-8")
                temporary.replace(target)
                result = {"ok": True, "path": relative}
        except Exception as exc:
            return _mark_pending_unknown(pending_path, entries, selected, exc)
        applied_result = {
            **result,
            "consumed": True,
            "operation": operation,
            "path": relative,
            "id": pending_id,
            "risk": risk,
            "run_id": selected.get("run_id", ""),
        }
        _mark_pending_applied(pending_path, entries, selected, applied_result)
        return applied_result

    if operation == "write_desktop_file":
        home = Path(os.environ.get("USERPROFILE") or Path.home())
        desktop = (home / "Desktop").resolve()
        file_name = Path(str(selected.get("file_name", "hoya_agent.txt"))).name
        if not file_name.lower().endswith(".txt"):
            file_name += ".txt"
        target = (desktop / file_name).resolve()
        if target.parent != desktop:
            return {"ok": False, "error": "desktop write target is invalid"}
        content = str(selected.get("content", ""))
        _mark_pending_applying(pending_path, entries, selected)
        try:
            desktop.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
            temporary.write_text(content, encoding="utf-8")
            temporary.replace(target)
        except Exception as exc:
            return _mark_pending_unknown(pending_path, entries, selected, exc)
        applied_result = {
            "ok": True,
            "consumed": True,
            "operation": operation,
            "id": pending_id,
            "path": str(target),
            "bytes": len(content.encode("utf-8")),
            "risk": selected.get("risk", {}),
            "run_id": selected.get("run_id", ""),
        }
        _mark_pending_applied(pending_path, entries, selected, applied_result)
        return applied_result

    if operation == "run_powershell":
        if not allow_shell:
            return {"ok": False, "error": "shell execution is disabled"}
        command = str(selected.get("command", ""))
        risk = assess_shell_risk(command)
        # Reaching this path means the user explicitly approved the exact command.
        if not risk.get("allowed", False):
            risk = {**risk, "allowed": True, "reasons": [*risk.get("reasons", []), "explicitly approved by user"]}
        _mark_pending_applying(pending_path, entries, selected)
        try:
            completed = subprocess.run(
                ["powershell", "-NoProfile", "-Command", command],
                cwd=root,
                env=sanitized_subprocess_environment(),
                text=True,
                capture_output=True,
                timeout=int(selected.get("timeout_seconds", 30)),
                check=False,
            )
        except Exception as exc:
            return _mark_pending_unknown(pending_path, entries, selected, exc)
        applied_result = {
            "ok": completed.returncode == 0,
            "consumed": True,
            "operation": operation,
            "id": pending_id,
            "returncode": completed.returncode,
            "stdout": completed.stdout[-12000:],
            "stderr": completed.stderr[-12000:],
            "risk": risk,
            "run_id": selected.get("run_id", ""),
        }
        _mark_pending_applied(pending_path, entries, selected, applied_result)
        return applied_result

    return {"ok": False, "error": f"unknown pending operation: {operation}"}


def _mark_pending_applying(path: Path, entries: list[dict[str, Any]], selected: dict[str, Any]) -> None:
    selected.update({"status": "applying", "attempted_at": timestamp(), "last_error": ""})
    _save_pending_writes(path, entries)


def _mark_pending_applied(
    path: Path,
    entries: list[dict[str, Any]],
    selected: dict[str, Any],
    result: dict[str, Any],
) -> None:
    selected.update(
        {
            "status": "applied",
            "applied_at": timestamp(),
            "last_error": "",
            "result": dict(result),
        }
    )
    _save_pending_writes(path, entries)


def _mark_pending_unknown(
    path: Path,
    entries: list[dict[str, Any]],
    selected: dict[str, Any],
    error: Exception,
) -> dict[str, Any]:
    selected.update({"status": "outcome_unknown", "last_error": str(error)})
    _save_pending_writes(path, entries)
    return {
        "ok": False,
        "error": "操作执行被中断，实际结果未知；请检查后拒绝并重新发起。",
        "detail": str(error),
        "id": selected.get("id", ""),
        "operation": selected.get("operation", "write_file"),
        "run_id": selected.get("run_id", ""),
        "status": "outcome_unknown",
        "outcome_unknown": True,
    }


def apply_pending_write(workspace: Path, pending_path: Path, pending_id: str) -> dict[str, Any]:
    result = apply_pending_operation(workspace, pending_path, pending_id)
    if result.get("consumed"):
        finalize_pending_operation(pending_path, pending_id)
    return result


def finalize_pending_operation(pending_path: Path, pending_id: str) -> bool:
    """Remove a persisted approval result after its owning run is durable."""
    with _PENDING_LOCK:
        entries = load_pending_writes(pending_path)
        selected, remaining = _split_pending(entries, pending_id)
        if selected is None or selected.get("status") not in {"applied", "denied"}:
            return False
        _save_pending_writes(pending_path, remaining)
        return True


def deny_pending_operation(pending_path: Path, pending_id: str) -> dict[str, Any]:
    with _PENDING_LOCK:
        entries = load_pending_writes(pending_path)
        selected, _remaining = _split_pending(entries, pending_id)
        if selected is None:
            return {"ok": False, "error": f"pending operation not found: {pending_id}"}
        if selected.get("status") == "denied" and isinstance(selected.get("result"), dict):
            return {**selected["result"], "consumed": True, "replayed": True}
        result = {
            "ok": True,
            "consumed": True,
            "id": pending_id,
            "operation": selected.get("operation", "write_file"),
            "run_id": selected.get("run_id", ""),
        }
        selected.update({"status": "denied", "resolved_at": timestamp(), "result": dict(result)})
        _save_pending_writes(pending_path, entries)
        return result
