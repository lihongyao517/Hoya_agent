from __future__ import annotations

import json
import re
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
