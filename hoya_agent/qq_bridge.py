from __future__ import annotations

import hmac
import json
import os
import queue
import re
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from .agent import HoyaAgent
from .config import Config
from .workspace_ops import HistoryStore, RunLog


CQ_CODE_RE = re.compile(r"\[CQ:[^\]]+\]")


def _env_bool(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip() == "1"


def _env_int(name: str, default: str) -> int:
    value = os.getenv(name, default).strip()
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer.") from exc


def _split_csv(value: str) -> set[str]:
    return {part.strip() for part in value.split(",") if part.strip()}


@dataclass(frozen=True)
class QQBridgeConfig:
    host: str
    port: int
    webhook_path: str
    webhook_token: str
    allowed_users: set[str]
    onebot_api_url: str
    onebot_token: str
    max_message_chars: int
    reply_chunk_chars: int
    queue_size: int
    request_timeout: int
    send_status: bool

    @classmethod
    def from_env(cls) -> "QQBridgeConfig":
        host = os.getenv("HOYA_QQ_HOST", "127.0.0.1").strip() or "127.0.0.1"
        port = _env_int("HOYA_QQ_PORT", "8765")
        webhook_path = os.getenv("HOYA_QQ_WEBHOOK_PATH", "/onebot").strip() or "/onebot"
        webhook_token = os.getenv("HOYA_QQ_WEBHOOK_TOKEN", "").strip()
        allowed_users = _split_csv(os.getenv("HOYA_QQ_ALLOWED_USERS", ""))
        onebot_api_url = os.getenv("HOYA_QQ_ONEBOT_API_URL", "").strip().rstrip("/")
        onebot_token = os.getenv("HOYA_QQ_ONEBOT_TOKEN", "").strip()
        max_message_chars = _env_int("HOYA_QQ_MAX_MESSAGE_CHARS", "4000")
        reply_chunk_chars = _env_int("HOYA_QQ_REPLY_CHUNK_CHARS", "1500")
        queue_size = _env_int("HOYA_QQ_QUEUE_SIZE", "1")
        request_timeout = _env_int("HOYA_QQ_REQUEST_TIMEOUT", "10")
        send_status = _env_bool("HOYA_QQ_SEND_STATUS", "1")

        if port <= 0 or port > 65535:
            raise ValueError("HOYA_QQ_PORT must be between 1 and 65535.")
        if not webhook_path.startswith("/"):
            raise ValueError("HOYA_QQ_WEBHOOK_PATH must start with '/'.")
        if not webhook_token:
            raise ValueError("Missing HOYA_QQ_WEBHOOK_TOKEN. Set a strong random token for inbound webhook validation.")
        if not allowed_users:
            raise ValueError("Missing HOYA_QQ_ALLOWED_USERS. Add your QQ user ID, for example: HOYA_QQ_ALLOWED_USERS=123456789")
        if not onebot_api_url:
            raise ValueError("Missing HOYA_QQ_ONEBOT_API_URL. Example: http://127.0.0.1:3000")
        if max_message_chars <= 0:
            raise ValueError("HOYA_QQ_MAX_MESSAGE_CHARS must be positive.")
        if max_message_chars > 20000:
            raise ValueError("HOYA_QQ_MAX_MESSAGE_CHARS must not exceed 20000.")
        if reply_chunk_chars <= 0:
            raise ValueError("HOYA_QQ_REPLY_CHUNK_CHARS must be positive.")
        if reply_chunk_chars > 4000:
            raise ValueError("HOYA_QQ_REPLY_CHUNK_CHARS must not exceed 4000.")
        if queue_size <= 0:
            raise ValueError("HOYA_QQ_QUEUE_SIZE must be positive.")
        if queue_size > 50:
            raise ValueError("HOYA_QQ_QUEUE_SIZE must not exceed 50.")
        if request_timeout <= 0:
            raise ValueError("HOYA_QQ_REQUEST_TIMEOUT must be positive.")
        if request_timeout > 120:
            raise ValueError("HOYA_QQ_REQUEST_TIMEOUT must not exceed 120 seconds.")

        return cls(
            host=host,
            port=port,
            webhook_path=webhook_path,
            webhook_token=webhook_token,
            allowed_users=allowed_users,
            onebot_api_url=onebot_api_url,
            onebot_token=onebot_token,
            max_message_chars=max_message_chars,
            reply_chunk_chars=reply_chunk_chars,
            queue_size=queue_size,
            request_timeout=request_timeout,
            send_status=send_status,
        )


@dataclass(frozen=True)
class QQTask:
    user_id: str
    message_id: str
    text: str


class OneBotClient:
    def __init__(self, api_url: str, token: str, timeout: int):
        self.api_url = api_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def call(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(
            f"{self.api_url}/{action}",
            data=data,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            if not body.strip():
                return {}
            return json.loads(body)

    def send_private_message(self, user_id: str, message: str) -> None:
        self.call(
            "send_private_msg",
            {
                "user_id": int(user_id) if user_id.isdigit() else user_id,
                "message": message,
                "auto_escape": True,
            },
        )


class QQBridge:
    def __init__(self, hoya_config: Config, qq_config: QQBridgeConfig):
        self.hoya_config = hoya_config
        self.qq_config = qq_config
        self.agent = HoyaAgent(hoya_config)
        self.history = HistoryStore(hoya_config.history_path)
        self.run_log = RunLog(hoya_config.run_log_path)
        self.onebot = OneBotClient(qq_config.onebot_api_url, qq_config.onebot_token, qq_config.request_timeout)
        self.tasks: queue.Queue[QQTask] = queue.Queue(maxsize=qq_config.queue_size)
        self._recent_message_ids: list[str] = []
        self._recent_lock = threading.Lock()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True)
        self._worker.start()

    def validate_token(self, headers: Any) -> bool:
        auth = str(headers.get("Authorization", "")).strip()
        token = ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        header_token = str(headers.get("X-Hoya-QQ-Token", "")).strip()
        return hmac.compare_digest(token, self.qq_config.webhook_token) or hmac.compare_digest(
            header_token,
            self.qq_config.webhook_token,
        )

    def is_duplicate(self, message_id: str) -> bool:
        if not message_id:
            return False
        with self._recent_lock:
            if message_id in self._recent_message_ids:
                return True
            self._recent_message_ids.append(message_id)
            del self._recent_message_ids[:-200]
            return False

    def handle_event(self, event: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if event.get("post_type") != "message":
            self.run_log.append({"type": "ignored_event", "ui": "qq", "reason": "not_message"})
            return 200, {"ok": True, "ignored": True}

        if event.get("message_type") != "private":
            self.run_log.append({"type": "ignored_event", "ui": "qq", "reason": "not_private_message"})
            return 200, {"ok": True, "ignored": True}

        user_id = str(event.get("user_id", "")).strip()
        message_id = str(event.get("message_id", "")).strip()
        if user_id not in self.qq_config.allowed_users:
            self.run_log.append({"type": "security_reject", "ui": "qq", "reason": "user_not_allowed", "qq_user_id": user_id})
            return 403, {"ok": False, "error": "user not allowed"}

        if self.is_duplicate(message_id):
            self.run_log.append({"type": "ignored_event", "ui": "qq", "reason": "duplicate_message", "qq_user_id": user_id, "message_id": message_id})
            return 200, {"ok": True, "ignored": True}

        text = extract_text_message(event).strip()
        if not text:
            self._safe_send(user_id, "暂时只支持 QQ 私聊文本消息。")
            return 200, {"ok": True, "ignored": True, "reason": "empty_text"}

        if len(text) > self.qq_config.max_message_chars:
            self._safe_send(user_id, f"这条消息太长了，请缩短后再发。当前限制是 {self.qq_config.max_message_chars} 字符。")
            self.run_log.append({"type": "security_reject", "ui": "qq", "reason": "message_too_long", "qq_user_id": user_id, "message_id": message_id})
            return 200, {"ok": False, "error": "message too long"}

        task = QQTask(user_id=user_id, message_id=message_id, text=text)
        try:
            self.tasks.put_nowait(task)
        except queue.Full:
            self._safe_send(user_id, "Hoya 正在处理上一个任务，请稍后再发。")
            return 200, {"ok": False, "error": "busy"}

        return 200, {"ok": True, "queued": True}

    def _safe_send(self, user_id: str, message: str) -> None:
        try:
            self.onebot.send_private_message(user_id, message)
        except Exception as exc:
            self.run_log.append({"type": "qq_send_error", "ui": "qq", "qq_user_id": user_id, "error": str(exc)[:500]})

    def _send_chunks(self, user_id: str, text: str) -> None:
        chunks = split_text(text, self.qq_config.reply_chunk_chars)
        for chunk in chunks or ["Hoya 没有生成回复。"]:
            self._safe_send(user_id, chunk)

    def _worker_loop(self) -> None:
        while True:
            task = self.tasks.get()
            try:
                self._run_task(task)
            finally:
                self.tasks.task_done()

    def _run_task(self, task: QQTask) -> None:
        meta = {"ui": "qq", "qq_user_id": task.user_id, "message_id": task.message_id}
        self._safe_send(task.user_id, "已收到，Hoya 开始处理。")
        self.history.append("user", task.text, meta=meta)
        self.run_log.append({"type": "task_start", "task": task.text, **meta})

        answer_parts: list[str] = []
        try:
            for event in self.agent.run_stream(task.text):
                event_type = event.get("type")
                if event_type in {"status", "tool_start", "tool_result", "error", "done"}:
                    self.run_log.append({"type": "agent_event", "event": sanitize_event(event), **meta})

                if event_type == "token":
                    text = str(event.get("text", ""))
                    if text:
                        answer_parts.append(text)
                    continue

                if event_type == "tool_start" and self.qq_config.send_status:
                    name = str(event.get("name", "unknown_tool"))
                    self._safe_send(task.user_id, f"[tool] {name}")
                    continue

                if event_type == "done" and not answer_parts:
                    done_text = str(event.get("text", ""))
                    if done_text:
                        answer_parts.append(done_text)
                    continue

                if event_type == "error":
                    error_text = str(event.get("text", "Hoya 处理任务时出错。"))
                    self._safe_send(task.user_id, f"Hoya 出错：{error_text[:500]}")
                    continue

            answer = "".join(answer_parts).strip()
            if answer:
                self.history.append("assistant", answer, meta=meta)
            self.run_log.append({"type": "task_done", "task": task.text, **meta})
            self._send_chunks(task.user_id, answer)
        except Exception as exc:
            self.run_log.append({"type": "error", "task": task.text, "error": str(exc), **meta})
            self._safe_send(task.user_id, f"Hoya 处理任务时出错：{str(exc)[:500]}")


class QQBridgeHTTPServer(ThreadingHTTPServer):
    bridge: QQBridge


class QQBridgeHandler(BaseHTTPRequestHandler):
    server_version = "HoyaQQBridge/1.0"

    @property
    def bridge(self) -> QQBridge:
        return self.server.bridge  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            json_response(self, {"ok": True, "service": "hoya-qq-bridge"})
            return
        json_response(self, {"error": "not found"}, 404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != self.bridge.qq_config.webhook_path:
            json_response(self, {"error": "not found"}, 404)
            return

        if not self.bridge.validate_token(self.headers):
            self.bridge.run_log.append({"type": "security_reject", "ui": "qq", "reason": "bad_webhook_token"})
            json_response(self, {"ok": False, "error": "unauthorized"}, 401)
            return

        try:
            payload = read_json(self, self.bridge.qq_config.max_message_chars)
            status, response = self.bridge.handle_event(payload)
            json_response(self, response, status)
        except json.JSONDecodeError:
            json_response(self, {"ok": False, "error": "invalid json"}, 400)
        except ValueError as exc:
            json_response(self, {"ok": False, "error": str(exc)}, 413)
        except Exception as exc:
            self.bridge.run_log.append({"type": "error", "ui": "qq", "error": str(exc)[:500]})
            json_response(self, {"ok": False, "error": "internal error"}, 500)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[qq] {self.address_string()} - {fmt % args}")


def read_json(handler: BaseHTTPRequestHandler, max_message_chars: int) -> dict[str, Any]:
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError as exc:
        raise ValueError("Content-Length must be an integer") from exc
    if length < 0:
        raise ValueError("Content-Length must not be negative")
    max_body = max(65536, max_message_chars * 4 + 4096)
    if length > max_body:
        raise ValueError("request body too large")
    raw = handler.rfile.read(length)
    if not raw:
        return {}
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise json.JSONDecodeError("expected object", raw.decode("utf-8", errors="replace"), 0)
    return data


def json_response(handler: BaseHTTPRequestHandler, payload: dict[str, Any], status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def extract_text_message(event: dict[str, Any]) -> str:
    message = event.get("message")
    if isinstance(message, list):
        parts = []
        for segment in message:
            if not isinstance(segment, dict) or segment.get("type") != "text":
                continue
            data = segment.get("data") or {}
            if isinstance(data, dict) and data.get("text"):
                parts.append(str(data["text"]))
        return CQ_CODE_RE.sub("", "".join(parts)).strip()

    raw_message = event.get("raw_message")
    text = raw_message if isinstance(raw_message, str) else message
    return CQ_CODE_RE.sub("", str(text or "")).strip()


def sanitize_event(event: dict[str, Any]) -> dict[str, Any]:
    sanitized = dict(event)
    if "result" in sanitized:
        result = str(sanitized["result"])
        sanitized["result_preview"] = result[:2000]
        sanitized["result_truncated"] = len(result) > 2000
        del sanitized["result"]
    return sanitized


def split_text(text: str, limit: int) -> list[str]:
    if not text:
        return []
    chunks: list[str] = []
    current = text
    while current:
        if len(current) <= limit:
            chunks.append(current)
            break
        cut = current.rfind("\n", 0, limit)
        if cut < max(200, limit // 3):
            cut = limit
        chunks.append(current[:cut].strip())
        current = current[cut:].strip()
    return [chunk for chunk in chunks if chunk]


def main() -> None:
    try:
        hoya_config = Config.from_env()
        qq_config = QQBridgeConfig.from_env()
    except ValueError as exc:
        print(f"[error] Hoya QQ Bridge 配置错误: {exc}")
        return

    bridge = QQBridge(hoya_config, qq_config)
    server = QQBridgeHTTPServer((qq_config.host, qq_config.port), QQBridgeHandler)
    server.bridge = bridge
    print(f"Hoya QQ Bridge 已启动: http://{qq_config.host}:{qq_config.port}{qq_config.webhook_path}")
    print("仅支持 QQ 私聊；按 Ctrl+C 停止服务。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nHoya QQ Bridge 已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
