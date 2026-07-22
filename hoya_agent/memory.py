from __future__ import annotations

import json
import re
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


_PATH_LOCKS_GUARD = threading.Lock()
_PATH_LOCKS: dict[str, threading.RLock] = {}


def _shared_path_lock(path: Path) -> threading.RLock:
    key = str(path.expanduser().resolve()).casefold()
    with _PATH_LOCKS_GUARD:
        return _PATH_LOCKS.setdefault(key, threading.RLock())


@dataclass
class MemoryStore:
    path: Path
    _lock: threading.RLock = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._lock = _shared_path_lock(self.path)

    def _load(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
        if not isinstance(data, list):
            return []
        return [entry for entry in data if isinstance(entry, dict)]

    def _save(self, entries: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + f".{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.path)

    def load(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._load()

    def add(self, text: str) -> dict[str, Any]:
        with self._lock:
            entries = self._load()
            entry = {
                "id": uuid.uuid4().hex,
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "text": text,
            }
            entries.append(entry)
            self._save(entries)
        return entry

    def delete(self, identifier: str) -> bool:
        with self._lock:
            entries = self._load()
            removed = False
            kept: list[dict[str, Any]] = []
            for entry in entries:
                matches = identifier and identifier in {
                    str(entry.get("id", "")),
                    str(entry.get("created_at", "")),
                }
                if matches and not removed:
                    removed = True
                    continue
                kept.append(entry)
            if removed:
                self._save(kept)
            return removed

    def recent(self, limit: int = 8) -> list[dict[str, Any]]:
        return self.load()[-limit:]

    def relevant(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        terms = _relevance_terms(query)
        if not terms:
            return []
        scored: list[tuple[int, int, dict[str, Any]]] = []
        for index, entry in enumerate(self.load()):
            text = str(entry.get("text", "")).lower()
            score = sum((3 if term in text else 0) + text.count(term) for term in terms)
            if score:
                scored.append((score, index, entry))
        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [entry for _, _, entry in scored[: max(1, limit)]]


def _relevance_terms(value: str) -> set[str]:
    lowered = value.lower()
    terms = set(re.findall(r"[a-z0-9_./-]{2,}", lowered))
    for sequence in re.findall(r"[\u3400-\u9fff]+", lowered):
        if len(sequence) <= 2:
            terms.add(sequence)
        else:
            terms.update(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return {term for term in terms if term.strip()}
