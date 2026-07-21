from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .llm import connection_error_message, urlopen_with_ollama_retry


def _models_endpoint(base_url: str) -> str:
    raw = base_url.strip().rstrip("/")
    if raw.endswith("/models"):
        return raw
    parts = urlsplit(raw)
    path = parts.path.rstrip("/")
    for suffix in ("/chat/completions", "/responses", "/messages"):
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break
    if not path.endswith("/v1"):
        path = f"{path}/v1" if path else "/v1"
    return urlunsplit((parts.scheme, parts.netloc, f"{path}/models", "", ""))


def _model_id(item: Any) -> str:
    if isinstance(item, str):
        return item.strip()
    if not isinstance(item, dict):
        return ""
    for key in ("id", "name", "model"):
        value = str(item.get(key, "")).strip()
        if value:
            return value
    return ""


def discover_models(
    base_url: str,
    api_key: str = "",
    provider: str = "openai-compatible",
    *,
    timeout: int = 15,
) -> dict[str, Any]:
    endpoint = _models_endpoint(base_url)
    headers = {"Accept": "application/json", "User-Agent": "Hoya-Agent/0.1"}
    if provider == "anthropic":
        if api_key:
            headers["x-api-key"] = api_key
            headers["Authorization"] = f"Bearer {api_key}"
        headers["anthropic-version"] = "2023-06-01"
    elif provider != "ollama" and api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    request = urllib.request.Request(endpoint, headers=headers, method="GET")
    try:
        with urlopen_with_ollama_retry(request, base_url=base_url, provider=provider, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        return {"ok": False, "error": f"model discovery returned HTTP {exc.code}: {detail}", "endpoint": endpoint}
    except urllib.error.URLError as exc:
        return {"ok": False, "error": connection_error_message(provider, base_url, exc.reason), "endpoint": endpoint}
    except (TimeoutError, json.JSONDecodeError, OSError) as exc:
        return {"ok": False, "error": f"model discovery failed: {exc}", "endpoint": endpoint}

    items: Any
    if isinstance(payload, dict):
        items = payload.get("data", payload.get("models", payload.get("model", [])))
    else:
        items = payload
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list):
        return {"ok": False, "error": "model discovery response does not contain a model list", "endpoint": endpoint}

    models = []
    seen: set[str] = set()
    for item in items:
        model_id = _model_id(item)
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        models.append({"id": model_id, "name": model_id, "owned_by": item.get("owned_by", "") if isinstance(item, dict) else ""})
    return {"ok": True, "endpoint": endpoint, "models": models}
