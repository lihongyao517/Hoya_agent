from __future__ import annotations

import base64
import json
import mimetypes
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from assistant.agent_tool import (
    AgentRequestError,
    build_agent_error_response,
    build_agent_schema,
    build_agent_success_response,
    clamp_top_k,
    parse_agent_ask_request,
)
from assistant.config import Settings
from assistant.documents import DocumentParseError, load_document_text
from assistant.knowledge_base import KnowledgeBase
from assistant.llm_client import LLMClient
from assistant.payment import create_payment_verifier, payment_result_to_public_dict
from assistant.rag import build_answer
from assistant.usage_log import append_usage_event, build_usage_event, new_request_id


BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
INDEX_PATH = DATA_DIR / "index.json"

settings = Settings.load(BASE_DIR / ".env")
knowledge_base = KnowledgeBase(INDEX_PATH)
llm_client = LLMClient(settings)
payment_verifier = create_payment_verifier(settings)


def json_response(handler: BaseHTTPRequestHandler, payload: dict, status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length)
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def safe_filename(name: str) -> str:
    cleaned = "".join(ch for ch in Path(name).name if ch.isalnum() or ch in "._-()[] ")
    return cleaned.strip() or "document.txt"


class StudyAssistantHandler(BaseHTTPRequestHandler):
    server_version = "LocalAIStudyAssistant/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.serve_file(WEB_DIR / "index.html")
            return
        if parsed.path == "/api/documents":
            json_response(self, {"documents": knowledge_base.list_documents()})
            return
        if parsed.path == "/api/agent/schema":
            self.agent_schema()
            return
        if parsed.path.startswith("/static/"):
            self.serve_file(WEB_DIR / parsed.path.lstrip("/"))
            return
        self.send_error(404, "Not found")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/documents":
                self.upload_document()
                return
            if parsed.path == "/api/ask":
                self.ask_question()
                return
            if parsed.path == "/api/agent/ask":
                self.agent_ask_question()
                return
            if parsed.path == "/api/rebuild":
                self.rebuild_index()
                return
        except json.JSONDecodeError:
            json_response(self, {"error": "请求 JSON 格式不正确"}, 400)
            return
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)
            return
        self.send_error(404, "Not found")

    def upload_document(self) -> None:
        payload = read_json(self)
        filename = safe_filename(str(payload.get("filename", "")))
        encoded = str(payload.get("content_base64", ""))
        if not filename or not encoded:
            json_response(self, {"error": "缺少文件名或文件内容"}, 400)
            return

        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        file_path = UPLOAD_DIR / filename
        file_path.write_bytes(base64.b64decode(encoded))

        try:
            text = load_document_text(file_path)
        except DocumentParseError as exc:
            json_response(self, {"error": str(exc)}, 400)
            return

        document = knowledge_base.add_document(filename=filename, path=file_path, text=text)
        json_response(self, {"message": "文档已入库", "document": document.to_public_dict()})

    def answer_question(self, question: str, top_k: int) -> dict:
        results = knowledge_base.search(question, top_k=top_k)
        return build_answer(
            question=question,
            search_results=results,
            llm_client=llm_client,
            max_context_chars=settings.max_context_chars,
        )

    def ask_question(self) -> None:
        payload = read_json(self)
        question = str(payload.get("question", "")).strip()
        top_k = clamp_top_k(payload.get("top_k"), settings.agent_default_top_k, settings.agent_max_top_k)
        if not question:
            json_response(self, {"error": "问题不能为空"}, 400)
            return
        json_response(self, self.answer_question(question, top_k))

    def agent_schema(self) -> None:
        if not self.agent_tool_available():
            return
        json_response(self, build_agent_schema(settings))

    def agent_ask_question(self) -> None:
        request_id = new_request_id()
        started = time.monotonic()
        if not self.agent_tool_available():
            return

        payload = read_json(self)
        try:
            agent_request = parse_agent_ask_request(payload, settings)
        except AgentRequestError as exc:
            self.write_agent_log(request_id, started, exc.status, error=exc.message)
            json_response(self, build_agent_error_response(request_id, exc.code, exc.message), exc.status)
            return

        payment_result = payment_verifier.verify(self.headers, payload)
        payment_payload = payment_result_to_public_dict(payment_result)
        if not payment_result.ok:
            self.write_agent_log(
                request_id,
                started,
                402,
                question=agent_request.question,
                top_k=agent_request.top_k,
                payment=payment_payload,
                error=payment_result.error,
            )
            json_response(
                self,
                build_agent_error_response(
                    request_id,
                    "payment_required",
                    payment_result.error or "Payment required to call this knowledge tool.",
                    payment=payment_payload,
                ),
                402,
            )
            return

        answer = self.answer_question(agent_request.question, agent_request.top_k)
        response, source_count = build_agent_success_response(
            request_id=request_id,
            payment=payment_payload,
            answer=answer,
            include_sources=agent_request.include_sources,
            paid=settings.payment_mode != "off",
            top_k=agent_request.top_k,
            question_chars=len(agent_request.question),
        )
        self.write_agent_log(
            request_id,
            started,
            200,
            question=agent_request.question,
            top_k=agent_request.top_k,
            payment=payment_payload,
            mode=str(answer.get("mode", "")),
            source_count=source_count,
        )
        json_response(self, response)

    def agent_tool_available(self) -> bool:
        if settings.agent_tool_enabled:
            return True
        self.send_error(404, "Not found")
        return False

    def write_agent_log(
        self,
        request_id: str,
        started: float,
        status: int,
        question: str = "",
        top_k: int | None = None,
        payment: dict | None = None,
        mode: str = "",
        source_count: int = 0,
        error: str | None = None,
    ) -> None:
        event = build_usage_event(
            request_id=request_id,
            endpoint=settings.payment_resource,
            client_ip=self.client_address[0] if self.client_address else "",
            user_agent=self.headers.get("User-Agent", ""),
            question_chars=len(question),
            top_k=top_k if top_k is not None else settings.agent_default_top_k,
            payment=payment,
            fallback_payment_mode=settings.payment_mode,
            status=status,
            latency_ms=round((time.monotonic() - started) * 1000),
            mode=mode,
            source_count=source_count,
            error=error,
        )
        append_usage_event(settings.usage_log_path, event)

    def rebuild_index(self) -> None:
        rebuilt = 0
        for file_path in sorted(UPLOAD_DIR.glob("*")):
            if not file_path.is_file():
                continue
            try:
                text = load_document_text(file_path)
            except DocumentParseError:
                continue
            knowledge_base.add_document(filename=file_path.name, path=file_path, text=text)
            rebuilt += 1
        json_response(self, {"message": f"已重建 {rebuilt} 个文档"})

    def serve_file(self, file_path: Path) -> None:
        if not file_path.exists() or not file_path.is_file():
            self.send_error(404, "Not found")
            return
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[server] {self.address_string()} - {fmt % args}")


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((settings.host, settings.port), StudyAssistantHandler)
    print(f"AI 学习助手已启动: http://{settings.host}:{settings.port}")
    print(f"Agent paid endpoint: {settings.payment_resource} · payment={settings.payment_mode}")
    print("按 Ctrl+C 停止服务")
    server.serve_forever()


if __name__ == "__main__":
    main()
