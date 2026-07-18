from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
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
            return {"models": [], "active_model_id": "", "last_workspace": ""}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"models": [], "active_model_id": "", "last_workspace": ""}
        if not isinstance(data, dict):
            return {"models": [], "active_model_id": "", "last_workspace": ""}
        data.setdefault("models", [])
        data.setdefault("active_model_id", "")
        data.setdefault("last_workspace", "")
        return data

    def save(self, data: dict[str, Any]) -> dict[str, Any]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data

    def list_models(self) -> list[dict[str, Any]]:
        return [item for item in self.load().get("models", []) if isinstance(item, dict)]

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
