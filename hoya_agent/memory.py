from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass
class MemoryStore:
    path: Path

    def load(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
        if not isinstance(data, list):
            return []
        return [entry for entry in data if isinstance(entry, dict)]

    def add(self, text: str) -> dict[str, Any]:
        entries = self.load()
        entry = {
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "text": text,
        }
        entries.append(entry)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        return entry

    def delete(self, created_at: str) -> None:
        entries = [entry for entry in self.load() if str(entry.get("created_at", "")) != created_at]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")

    def recent(self, limit: int = 8) -> list[dict[str, Any]]:
        return self.load()[-limit:]
