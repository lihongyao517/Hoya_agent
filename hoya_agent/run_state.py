from __future__ import annotations

import ast
import hashlib
import json
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


def timestamp() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


DEFAULT_PLAN = (
    ("context", "检索并装配项目上下文"),
    ("execute", "执行局部修改或分析"),
    ("verify", "验证结果并纠正问题"),
    ("deliver", "整理结果与风险说明"),
)


class RunStore:
    """Durable task state used to pause and resume one model/tool loop."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()

    def _load(self) -> list[dict[str, Any]]:
        data = _read_json(self.path, [])
        return data if isinstance(data, list) else []

    def _save(self, entries: list[dict[str, Any]]) -> None:
        _write_json(self.path, entries[-200:])

    def create(self, run_id: str, conversation_id: str, task: str) -> dict[str, Any]:
        now = timestamp()
        entry = {
            "id": run_id,
            "conversation_id": conversation_id,
            "task": task,
            "status": "running",
            "created_at": now,
            "updated_at": now,
            "context_summary": "",
            "context_sources": [],
            "plan": [
                {"id": item_id, "title": title, "status": "pending", "note": ""}
                for item_id, title in DEFAULT_PLAN
            ],
            "changes": [],
            "pending_approval_id": "",
            "checkpoint": None,
            "approval_result": None,
        }
        with self._lock:
            entries = [item for item in self._load() if item.get("id") != run_id]
            entries.append(entry)
            self._save(entries)
        return entry

    def get(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            for entry in self._load():
                if entry.get("id") == run_id:
                    return entry
        return None

    def list(self, conversation_id: str = "", limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            entries = self._load()
        if conversation_id:
            entries = [item for item in entries if item.get("conversation_id") == conversation_id]
        return sorted(entries, key=lambda item: str(item.get("updated_at", "")), reverse=True)[: max(1, limit)]

    def _update(self, run_id: str, updater: Any) -> dict[str, Any]:
        with self._lock:
            entries = self._load()
            for entry in entries:
                if entry.get("id") == run_id:
                    updater(entry)
                    entry["updated_at"] = timestamp()
                    self._save(entries)
                    return entry
        raise KeyError(f"run not found: {run_id}")

    def set_context(self, run_id: str, summary: str, sources: list[dict[str, Any]]) -> dict[str, Any]:
        def update(entry: dict[str, Any]) -> None:
            entry["context_summary"] = summary
            entry["context_sources"] = sources
            self._set_phase(entry, "context", "completed", summary)
            self._set_phase(entry, "execute", "in_progress", "")

        return self._update(run_id, update)

    @staticmethod
    def _set_phase(entry: dict[str, Any], phase_id: str, status: str, note: str = "") -> None:
        for phase in entry.get("plan", []):
            if phase.get("id") == phase_id:
                phase["status"] = status
                if note:
                    phase["note"] = note
                return

    def set_phase(self, run_id: str, phase_id: str, status: str, note: str = "") -> dict[str, Any]:
        return self._update(run_id, lambda entry: self._set_phase(entry, phase_id, status, note))

    def add_change(self, run_id: str, change: dict[str, Any]) -> dict[str, Any]:
        def update(entry: dict[str, Any]) -> None:
            version_id = str(change.get("version_id", ""))
            existing = next((item for item in entry.get("changes", []) if item.get("version_id") == version_id), None)
            if existing is not None:
                existing.update(change)
            else:
                entry.setdefault("changes", []).append(change)
            verification = change.get("verification") or {}
            status = "completed" if verification.get("ok") else "failed"
            self._set_phase(entry, "verify", status, str(verification.get("summary", "")))

        return self._update(run_id, update)

    def pause(self, run_id: str, pending_id: str, checkpoint: dict[str, Any]) -> dict[str, Any]:
        def update(entry: dict[str, Any]) -> None:
            entry["status"] = "waiting_approval"
            entry["pending_approval_id"] = pending_id
            entry["checkpoint"] = checkpoint
            entry["approval_result"] = None
            self._set_phase(entry, "execute", "waiting", "等待用户审批")

        return self._update(run_id, update)

    def resolve_approval(self, run_id: str, decision: str, result: dict[str, Any]) -> dict[str, Any]:
        def update(entry: dict[str, Any]) -> None:
            if entry.get("status") != "waiting_approval":
                raise ValueError("run is not waiting for approval")
            entry["status"] = "ready_to_resume"
            entry["approval_result"] = {"decision": decision, "result": result, "resolved_at": timestamp()}
            entry["pending_approval_id"] = ""
            self._set_phase(entry, "execute", "in_progress", f"审批结果: {decision}")

        return self._update(run_id, update)

    def mark(self, run_id: str, status: str, note: str = "") -> dict[str, Any]:
        def update(entry: dict[str, Any]) -> None:
            entry["status"] = status
            if status == "completed":
                self._set_phase(entry, "execute", "completed")
                if not entry.get("changes"):
                    self._set_phase(entry, "verify", "completed", "无需文件校验")
                self._set_phase(entry, "deliver", "completed", note)
                verify_phase = next((item for item in entry.get("plan", []) if item.get("id") == "verify"), None)
                if verify_phase and verify_phase.get("status") == "failed":
                    entry["status"] = "completed_with_errors"
                entry["completed_at"] = timestamp()
                entry["checkpoint"] = None
                entry["approval_result"] = None
            elif status in {"cancelled", "failed"}:
                current = next((item for item in entry.get("plan", []) if item.get("status") in {"in_progress", "waiting"}), None)
                if current:
                    current["status"] = status
                    current["note"] = note

        return self._update(run_id, update)


class ChangeStore:
    """Content-addressed snapshots for verified, conflict-aware local rollback."""

    def __init__(self, workspace: Path, index_path: Path, blobs_dir: Path):
        self.workspace = workspace.resolve()
        self.index_path = index_path
        self.blobs_dir = blobs_dir
        self._lock = threading.RLock()

    def _load(self) -> list[dict[str, Any]]:
        data = _read_json(self.index_path, [])
        return data if isinstance(data, list) else []

    def _save(self, entries: list[dict[str, Any]]) -> None:
        _write_json(self.index_path, entries[-500:])

    def _target(self, relative_path: str) -> Path:
        target = (self.workspace / relative_path.replace("\\", "/")).resolve()
        if target != self.workspace and self.workspace not in target.parents:
            raise ValueError("version target is outside workspace")
        return target

    @staticmethod
    def verify_text(path: Path, expected_sha: str) -> dict[str, Any]:
        checks: list[dict[str, Any]] = []
        try:
            content = path.read_text(encoding="utf-8")
            checks.append({"name": "utf8_readback", "ok": True})
        except (OSError, UnicodeError) as exc:
            return {"ok": False, "summary": f"read-back failed: {exc}", "checks": [{"name": "utf8_readback", "ok": False}]}

        digest = _sha256(content)
        checks.append({"name": "content_hash", "ok": digest == expected_sha})
        syntax_error = ""
        try:
            if path.suffix.lower() == ".json":
                json.loads(content)
                checks.append({"name": "json_syntax", "ok": True})
            elif path.suffix.lower() == ".py":
                ast.parse(content, filename=str(path))
                checks.append({"name": "python_syntax", "ok": True})
        except (json.JSONDecodeError, SyntaxError) as exc:
            syntax_error = str(exc)
            checks.append({"name": "syntax", "ok": False, "detail": syntax_error})

        ok = all(bool(item.get("ok")) for item in checks)
        summary = "读取、哈希与语法校验通过" if ok else f"校验失败: {syntax_error or 'content hash mismatch'}"
        return {"ok": ok, "summary": summary, "sha256": digest, "checks": checks}

    def write_text(self, relative_path: str, content: str, run_id: str = "") -> dict[str, Any]:
        target = self._target(relative_path)
        existed = target.exists()
        old_content = target.read_text(encoding="utf-8", errors="replace") if existed else ""
        version_id = uuid.uuid4().hex[:12]
        self.blobs_dir.mkdir(parents=True, exist_ok=True)
        blob_path = self.blobs_dir / f"{version_id}.before"
        blob_path.write_text(old_content, encoding="utf-8")
        expected_sha = _sha256(content)

        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        verification = self.verify_text(target, expected_sha)
        entry = {
            "id": version_id,
            "run_id": run_id,
            "path": str(target.relative_to(self.workspace)),
            "created_at": timestamp(),
            "before_exists": existed,
            "before_sha256": _sha256(old_content) if existed else "",
            "after_sha256": expected_sha,
            "verification": verification,
            "rolled_back_at": "",
        }
        with self._lock:
            entries = self._load()
            entries.append(entry)
            self._save(entries)

        result = {
            "ok": bool(verification.get("ok")),
            "path": entry["path"],
            "bytes": len(content.encode("utf-8")),
            "version_id": version_id,
            "verification": verification,
        }
        if not verification.get("ok"):
            rollback = self.rollback(version_id, force=True)
            result.update(
                {
                    "error": "change failed verification and was rolled back",
                    "auto_rollback": rollback,
                    "rolled_back_at": rollback.get("rolled_back_at", ""),
                }
            )
        return result

    def list(self, run_id: str = "", limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            entries = self._load()
        if run_id:
            entries = [item for item in entries if item.get("run_id") == run_id]
        return list(reversed(entries[-max(1, limit) :]))

    def get(self, version_id: str) -> dict[str, Any] | None:
        with self._lock:
            return next((item for item in self._load() if item.get("id") == version_id), None)

    def rollback(self, version_id: str, *, force: bool = False) -> dict[str, Any]:
        with self._lock:
            entries = self._load()
            entry = next((item for item in entries if item.get("id") == version_id), None)
            if entry is None:
                return {"ok": False, "error": f"version not found: {version_id}"}
            target = self._target(str(entry.get("path", "")))
            if target.exists() and not force:
                current_sha = _sha256(target.read_text(encoding="utf-8", errors="replace"))
                if current_sha != entry.get("after_sha256"):
                    return {"ok": False, "error": "file changed after this version; refusing to overwrite newer work", "conflict": True}
            blob_path = self.blobs_dir / f"{version_id}.before"
            if entry.get("before_exists"):
                if not blob_path.exists():
                    return {"ok": False, "error": "rollback snapshot is missing"}
                previous = blob_path.read_text(encoding="utf-8")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(previous, encoding="utf-8")
                restored_sha = _sha256(previous)
            else:
                if target.exists():
                    target.unlink()
                restored_sha = ""
            entry["rolled_back_at"] = timestamp()
            self._save(entries)
        return {
            "ok": True,
            "version_id": version_id,
            "path": entry["path"],
            "restored_sha256": restored_sha,
            "rolled_back_at": entry["rolled_back_at"],
        }
