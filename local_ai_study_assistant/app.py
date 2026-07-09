from __future__ import annotations

import base64
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from assistant.config import Settings
from assistant.documents import DocumentParseError, load_document_text
from assistant.knowledge_base import KnowledgeBase
from assistant.llm_client import LLMClient
from assistant.rag import build_answer


BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
INDEX_PATH = DATA_DIR / "index.json"

settings = Settings.load(BASE_DIR / ".env")
knowledge_base = KnowledgeBase(INDEX_PATH)
llm_client = LLMClient(settings)


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
            if parsed.path == "/api/rebuild":
                self.rebuild_index()
                return
        except json.JSONDecodeError:
            json_response(self, {"error": "请求 JSON 格式不正确"}, 400)
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)
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
        json_response(
            self,
            {
                "message": "文档已入库",
                "document": document.to_public_dict(),
            },
        )

    def ask_question(self) -> None:
        payload = read_json(self)
        question = str(payload.get("question", "")).strip()
        top_k = int(payload.get("top_k", 5))
        if not question:
            json_response(self, {"error": "问题不能为空"}, 400)
            return

        results = knowledge_base.search(question, top_k=top_k)
        answer = build_answer(
            question=question,
            search_results=results,
            llm_client=llm_client,
            max_context_chars=settings.max_context_chars,
        )
        json_response(self, answer)

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
    print("按 Ctrl+C 停止服务")
    server.serve_forever()


if __name__ == "__main__":
    main()
