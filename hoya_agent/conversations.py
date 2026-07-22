from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime
from functools import wraps
from pathlib import Path
from typing import Any, Callable, TypeVar


CONVERSATION_COLORS = {"", "blue", "green", "amber", "red", "purple", "pink"}
_STORE_LOCK = threading.RLock()
_Method = TypeVar("_Method", bound=Callable[..., Any])


def synchronized(method: _Method) -> _Method:
    @wraps(method)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        with _STORE_LOCK:
            return method(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


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
        temporary = self.index_path.with_suffix(self.index_path.suffix + ".tmp")
        temporary.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.index_path)

    def _message_path(self, conversation_id: str) -> Path:
        if not conversation_id or len(conversation_id) > 64 or any(
            not (character.isascii() and (character.isalnum() or character in "-_"))
            for character in conversation_id
        ):
            raise ValueError("conversation id is invalid")
        return self.messages_dir / f"{conversation_id}.jsonl"

    @synchronized
    def ensure_default(self) -> dict[str, Any]:
        entries = self._load_index()
        if entries:
            return entries[0]
        return self.create_conversation("默认对话")

    @synchronized
    def list_conversations(self, *, kind: str | None = None) -> list[dict[str, Any]]:
        entries = self._load_index()
        if not entries:
            entries = [self.ensure_default()] if kind in {None, "task"} else []
        normalized = [
            {**entry, "color": entry.get("color", ""), "kind": entry.get("kind", "task"), "status": entry.get("status", "open")}
            for entry in entries
        ]
        if kind is not None:
            normalized = [entry for entry in normalized if entry.get("kind", "task") == kind]
        return sorted(normalized, key=lambda item: item.get("updated_at", ""), reverse=True)

    @synchronized
    def contains(self, conversation_id: str) -> bool:
        self._message_path(conversation_id)
        return any(entry.get("id") == conversation_id for entry in self._load_index())

    @synchronized
    def create_conversation(self, title: str | None = None, *, kind: str = "task") -> dict[str, Any]:
        now = timestamp()
        entry = {
            "id": uuid.uuid4().hex[:12],
            "title": title or "新对话",
            "color": "",
            "kind": kind,
            "status": "open",
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
        return self.update_conversation(conversation_id, title=title)

    def set_conversation_color(self, conversation_id: str, color: str) -> dict[str, Any]:
        return self.update_conversation(conversation_id, color=color)

    @synchronized
    def update_conversation(
        self,
        conversation_id: str,
        *,
        title: str | None = None,
        color: str | None = None,
    ) -> dict[str, Any]:
        normalized_color = None if color is None else color.strip().lower()
        if normalized_color is not None and normalized_color not in CONVERSATION_COLORS:
            raise ValueError(f"unsupported conversation color: {normalized_color}")

        entries = self._load_index()
        for entry in entries:
            if entry.get("id") == conversation_id:
                if title is not None:
                    entry["title"] = title.strip()[:120] or entry.get("title") or "未命名对话"
                if normalized_color is not None:
                    entry["color"] = normalized_color
                entry["updated_at"] = timestamp()
                self._save_index(entries)
                return {
                    **entry,
                    "color": entry.get("color", ""),
                    "kind": entry.get("kind", "task"),
                    "status": entry.get("status", "open"),
                }
        raise KeyError(f"conversation not found: {conversation_id}")

    @synchronized
    def delete_conversation(self, conversation_id: str) -> None:
        self._message_path(conversation_id)
        current_entries = self._load_index()
        if not any(entry.get("id") == conversation_id for entry in current_entries):
            raise KeyError(f"conversation not found: {conversation_id}")
        entries = [entry for entry in current_entries if entry.get("id") != conversation_id]
        self._save_index(entries)
        path = self._message_path(conversation_id)
        if path.exists():
            path.unlink()
        if not entries:
            self.ensure_default()

    @synchronized
    def append_message(self, conversation_id: str, role: str, content: str, meta: dict[str, Any] | None = None) -> None:
        if not self.contains(conversation_id):
            raise KeyError(f"conversation not found: {conversation_id}")
        self.messages_dir.mkdir(parents=True, exist_ok=True)
        entry = {"created_at": timestamp(), "role": role, "content": content, "meta": meta or {}}
        with self._message_path(conversation_id).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        entries = self._load_index()
        for convo in entries:
            if convo.get("id") == conversation_id:
                if role == "user" and (not convo.get("title") or convo.get("title") in {"新对话", "新任务", "New task"}):
                    convo["title"] = content.strip().splitlines()[0][:36] or "新对话"
                convo["updated_at"] = timestamp()
                break
        self._save_index(entries)

    @synchronized
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

    @synchronized
    def compact_conversation(self, conversation_id: str, *, keep_last: int = 12) -> dict[str, Any]:
        if not self.contains(conversation_id):
            raise KeyError(f"conversation not found: {conversation_id}")
        messages = self.messages(conversation_id)
        keep_last = max(4, min(int(keep_last), 40))
        if len(messages) <= keep_last + 1:
            return {"ok": True, "compacted": False, "message_count": len(messages), "removed": 0}

        older = messages[:-keep_last]
        kept = messages[-keep_last:]
        user_turns = [entry for entry in older if entry.get("role") == "user"]
        assistant_turns = [entry for entry in older if entry.get("role") == "assistant"]
        compacted_at = timestamp()

        excerpts: list[str] = []
        for entry in older:
            role = str(entry.get("role", "message"))
            content = str(entry.get("content", "")).strip().replace("\n", " ")
            if not content:
                continue
            excerpts.append(f"- {role}: {content[:220]}")
            if len(excerpts) >= 10:
                break

        summary = (
            "上下文已压缩。以下是较早消息的简要摘录，供后续回复解析引用；如果最新用户请求与这些摘录冲突，以最新请求为准。\n"
            f"压缩时间：{compacted_at}\n"
            f"压缩范围：{len(older)} 条消息，其中用户 {len(user_turns)} 条，助手 {len(assistant_turns)} 条。\n"
            + ("\n".join(excerpts) if excerpts else "较早消息没有可用文本。")
        )
        compacted_messages = [
            {
                "created_at": compacted_at,
                "role": "system",
                "content": summary,
                "meta": {"compacted": True, "removed_messages": len(older)},
            },
            *kept,
        ]
        path = self._message_path(conversation_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in compacted_messages),
            encoding="utf-8",
        )
        temporary.replace(path)
        self.update_conversation(conversation_id)
        return {
            "ok": True,
            "compacted": True,
            "message_count": len(compacted_messages),
            "removed": len(older),
        }
