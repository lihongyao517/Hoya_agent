from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from assistant.config import Settings
from assistant.payment import build_payment_requirement, payment_requirement_to_dict


TOOL_NAME = "local_ai_study_assistant.ask"
TOOL_VERSION = "1.0"


@dataclass(frozen=True)
class AgentAskRequest:
    question: str
    top_k: int
    include_sources: bool


class AgentRequestError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def clamp_top_k(value: object, default: int, maximum: int) -> int:
    try:
        top_k = int(value)
    except (TypeError, ValueError):
        top_k = default
    return max(1, min(top_k, maximum))


def parse_agent_ask_request(payload: dict[str, Any], settings: Settings) -> AgentAskRequest:
    question = str(payload.get("question", "")).strip()
    top_k = clamp_top_k(payload.get("top_k"), settings.agent_default_top_k, settings.agent_max_top_k)
    include_sources = bool(payload.get("include_sources", True))

    if not question:
        raise AgentRequestError("invalid_request", "question is required")
    if len(question) > settings.agent_max_question_chars:
        raise AgentRequestError(
            "question_too_long",
            f"question must be at most {settings.agent_max_question_chars} characters",
        )

    return AgentAskRequest(question=question, top_k=top_k, include_sources=include_sources)


def build_agent_schema(settings: Settings) -> dict[str, Any]:
    requirement = build_payment_requirement(settings)
    return {
        "name": TOOL_NAME,
        "description": "Ask a paid local RAG knowledge base built from uploaded documents. Returns an answer with source citations.",
        "endpoint": settings.payment_resource,
        "method": "POST",
        "version": TOOL_VERSION,
        "payment": {
            "required": settings.payment_mode != "off",
            "mode": settings.payment_mode,
            **payment_requirement_to_dict(requirement),
        },
        "input_schema": {
            "type": "object",
            "required": ["question"],
            "properties": {
                "question": {
                    "type": "string",
                    "description": "Question to answer from the local knowledge base.",
                    "maxLength": settings.agent_max_question_chars,
                },
                "top_k": {
                    "type": "integer",
                    "default": settings.agent_default_top_k,
                    "minimum": 1,
                    "maximum": settings.agent_max_top_k,
                },
                "include_sources": {"type": "boolean", "default": True},
                "payment": {
                    "type": "object",
                    "description": "Payment proof or mock token depending on configured payment mode.",
                },
            },
        },
    }


def build_agent_error_response(
    request_id: str,
    code: str,
    message: str,
    payment: dict[str, Any] | None = None,
) -> dict[str, Any]:
    response: dict[str, Any] = {
        "ok": False,
        "request_id": request_id,
        "error": {"code": code, "message": message},
    }
    if payment is not None:
        response["payment"] = payment
    return response


def build_agent_success_response(
    request_id: str,
    payment: dict[str, Any],
    answer: dict[str, Any],
    include_sources: bool,
    paid: bool,
    top_k: int,
    question_chars: int,
) -> tuple[dict[str, Any], int]:
    result = dict(answer)
    sources = result.get("sources") if isinstance(result.get("sources"), list) else []
    source_count = len(sources)
    if not include_sources:
        result["sources"] = []

    return (
        {
            "ok": True,
            "request_id": request_id,
            "tool": {"name": TOOL_NAME, "version": TOOL_VERSION, "paid": paid},
            "payment": payment,
            "result": result,
            "usage": {
                "question_chars": question_chars,
                "top_k": top_k,
                "source_count": source_count,
            },
        },
        source_count,
    )
