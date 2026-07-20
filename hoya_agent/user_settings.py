from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import normalize_provider, normalize_reasoning_effort


def default_settings_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "Hoya Agent" / "settings.json"
    return Path.home() / ".hoya_agent" / "settings.json"


@dataclass
class UserSettingsStore:
    path: Path

    def load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"models": [], "active_model_id": "", "last_workspace": "", "projects": []}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"models": [], "active_model_id": "", "last_workspace": "", "projects": []}
        if not isinstance(data, dict):
            return {"models": [], "active_model_id": "", "last_workspace": "", "projects": []}
        data.setdefault("models", [])
        data.setdefault("active_model_id", "")
        data.setdefault("last_workspace", "")
        data.setdefault("projects", [])
        return data

    def save(self, data: dict[str, Any]) -> dict[str, Any]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data

    def list_models(self) -> list[dict[str, Any]]:
        return [item for item in self.load().get("models", []) if isinstance(item, dict)]

    def list_projects(self) -> list[dict[str, Any]]:
        projects = [item for item in self.load().get("projects", []) if isinstance(item, dict) and item.get("path")]
        return sorted(projects, key=lambda item: item.get("updated_at", ""), reverse=True)

    def remember_project(self, project_path: Path, name: str | None = None) -> dict[str, Any]:
        data = self.load()
        projects = self.list_projects()
        resolved = project_path.expanduser().resolve()
        now = datetime.now().isoformat(timespec="seconds")
        normalized_path = os.path.normcase(str(resolved))
        selected: dict[str, Any] | None = None
        for project in projects:
            if os.path.normcase(str(project.get("path", ""))) == normalized_path:
                project["name"] = (name or str(project.get("name", "")) or resolved.name or str(resolved)).strip()
                project["path"] = str(resolved)
                project["updated_at"] = now
                selected = project
                break
        if selected is None:
            selected = {
                "id": uuid.uuid4().hex[:10],
                "name": (name or resolved.name or str(resolved)).strip(),
                "path": str(resolved),
                "created_at": now,
                "updated_at": now,
            }
            projects.append(selected)
        data["projects"] = projects
        data["last_workspace"] = str(resolved)
        self.save(data)
        return selected

    def upsert_model(self, model: dict[str, Any]) -> dict[str, Any]:
        data = self.load()
        models = self.list_models()
        model_id = str(model.get("id") or uuid.uuid4().hex[:10])
        clean = {
            "id": model_id,
            "name": str(model.get("name") or model.get("model") or "Model preset"),
            "provider": normalize_provider(str(model.get("provider") or "openai-compatible")),
            "base_url": str(model.get("base_url") or ""),
            "model": str(model.get("model") or ""),
            "wire_api": str(model.get("wire_api") or "chat"),
            "reasoning_effort": normalize_reasoning_effort(str(model.get("reasoning_effort") or "medium")),
            "show_reasoning": bool(model.get("show_reasoning", True)),
        }
        replaced = False
        for index, existing in enumerate(models):
            if existing.get("id") == model_id:
                models[index] = clean
                replaced = True
                break
        if not replaced:
            models.append(clean)
        data["models"] = models
        data["active_model_id"] = model_id
        self.save(data)
        return clean

    def delete_model(self, model_id: str) -> None:
        data = self.load()
        data["models"] = [item for item in self.list_models() if item.get("id") != model_id]
        if data.get("active_model_id") == model_id:
            data["active_model_id"] = ""
        self.save(data)

    def select_model(self, model_id: str) -> dict[str, Any]:
        data = self.load()
        for model in self.list_models():
            if model.get("id") == model_id:
                data["active_model_id"] = model_id
                self.save(data)
                return model
        raise KeyError(f"model preset not found: {model_id}")
