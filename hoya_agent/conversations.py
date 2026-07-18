from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


def timestamp() -> str:
    return datetime.now().isoformat(timespec="seconds")


@dataclass
class ConversationStore:
    index_path: Path
    messages_dir: Path

    def _load_index(self) -> list[dict[str, Any]]:
        if not self.index_path.exists():
            return []
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
        return data if isinstance(data, list) else []

    def _save_index(self, entries: list[dict[str, Any]]) -> None:
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")

    def _message_path(self, conversation_id: str) -> Path:
        safe_id = "".join(ch for ch in conversation_id if ch.isalnum() or ch in "-_")
        return self.messages_dir / f"{safe_id}.jsonl"

    def ensure_default(self) -> dict[str, Any]:
        entries = self._load_index()
        if entries:
            return entries[0]
        return self.create_conversation("默认对话")

    def list_conversations(self) -> list[dict[str, Any]]:
        entries = self._load_index()
        if not entries:
            entries = [self.ensure_default()]
        return sorted(entries, key=lambda item: item.get("updated_at", ""), reverse=True)

    def create_conversation(self, title: str | None = None) -> dict[str, Any]:
        now = timestamp()
        entry = {
            "id": uuid.uuid4().hex[:12],
            "title": title or "新对话",
            "created_at": now,
            "updated_at": now,
        }
        entries = self._load_index()
        entries.append(entry)
        self._save_index(entries)
        self.messages_dir.mkdir(parents=True, exist_ok=True)
        self._message_path(entry["id"]).touch(exist_ok=True)
        return entry

    def rename_conversation(self, conversation_id: str, title: str) -> dict[str, Any]:
        entries = self._load_index()
        for entry in entries:
            if entry.get("id") == conversation_id:
                entry["title"] = title.strip() or entry.get("title") or "未命名对话"
                entry["updated_at"] = timestamp()
                self._save_index(entries)
                return entry
        raise KeyError(f"conversation not found: {conversation_id}")

    def delete_conversation(self, conversation_id: str) -> None:
        entries = [entry for entry in self._load_index() if entry.get("id") != conversation_id]
        self._save_index(entries)
        path = self._message_path(conversation_id)
        if path.exists():
            path.unlink()
        if not entries:
            self.ensure_default()

    def append_message(self, conversation_id: str, role: str, content: str, meta: dict[str, Any] | None = None) -> None:
        self.messages_dir.mkdir(parents=True, exist_ok=True)
        entry = {"created_at": timestamp(), "role": role, "content": content, "meta": meta or {}}
        with self._message_path(conversation_id).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        entries = self._load_index()
        for convo in entries:
            if convo.get("id") == conversation_id:
                if role == "user" and (not convo.get("title") or convo.get("title") == "新对话"):
                    convo["title"] = content.strip().splitlines()[0][:36] or "新对话"
                convo["updated_at"] = timestamp()
                break
        self._save_index(entries)

    def messages(self, conversation_id: str, limit: int | None = None) -> list[dict[str, Any]]:
        path = self._message_path(conversation_id)
        if not path.exists():
            return []
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        if limit is not None:
            lines = lines[-limit:]
        entries: list[dict[str, Any]] = []
        for line in lines:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries

    def recent_messages(self, conversation_id: str, limit: int) -> list[dict[str, Any]]:
        return self.messages(conversation_id, limit=limit)
