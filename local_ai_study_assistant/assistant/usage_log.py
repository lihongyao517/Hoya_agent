from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_LOCK = threading.Lock()
LOG_PAYMENT_FIELDS = {"ok", "mode", "status", "payment_id", "payer", "error"}


def new_request_id() -> str:
    return f"req_{uuid.uuid4().hex[:12]}"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_payment_log(payment: dict[str, Any] | None, fallback_mode: str) -> dict[str, Any]:
    if not payment:
        return {"mode": fallback_mode, "status": "not_checked"}
    return {key: value for key, value in payment.items() if key in LOG_PAYMENT_FIELDS}


def build_usage_event(
    *,
    request_id: str,
    endpoint: str,
    client_ip: str,
    user_agent: str,
    question_chars: int,
    top_k: int,
    payment: dict[str, Any] | None,
    fallback_payment_mode: str,
    status: int,
    latency_ms: int,
    mode: str = "",
    source_count: int = 0,
    error: str | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "ts": now_iso(),
        "request_id": request_id,
        "endpoint": endpoint,
        "client_ip": client_ip,
        "user_agent": user_agent,
        "question_chars": question_chars,
        "top_k": top_k,
        "payment": safe_payment_log(payment, fallback_payment_mode),
        "status": status,
        "latency_ms": latency_ms,
        "source_count": source_count,
    }
    if mode:
        event["mode"] = mode
    if error:
        event["error"] = error
    return event


def append_usage_event(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    with _LOCK:
        with path.open("a", encoding="utf-8") as file:
            file.write(line + "\n")
