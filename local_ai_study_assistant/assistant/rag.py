from __future__ import annotations

from assistant.llm_client import LLMClient


SYSTEM_PROMPT = """你是一个基于本地文档的 AI 学习助手。
你的回答必须优先依据给定的文档片段。
如果文档片段中没有答案，请直接说明“当前知识库中没有找到相关内容”。
回答要清晰、简洁，并在适合的位置标注来源，例如：[文档名 #片段编号]。
不要编造文档之外的事实。"""


def build_answer(
    question: str,
    search_results: list[dict],
    llm_client: LLMClient,
    max_context_chars: int,
) -> dict:
    if not search_results:
        return {
            "answer": "当前知识库中没有找到相关内容。你可以先上传课程资料、技术文档或学习笔记。",
            "sources": [],
            "mode": "no_context",
        }

    context = format_context(search_results, max_context_chars=max_context_chars)
    sources = [
        {
            "filename": result["filename"],
            "chunk_index": result["chunk_index"],
            "score": result["score"],
            "text": result["text"],
        }
        for result in search_results
    ]

    if not llm_client.enabled:
        return {
            "answer": fallback_answer(question, search_results),
            "sources": sources,
            "mode": "retrieval_only",
        }

    user_prompt = f"""用户问题：
{question}

检索到的本地文档片段：
{context}

请根据以上片段回答问题。"""

    answer = llm_client.chat(
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]
    )
    return {
        "answer": answer,
        "sources": sources,
        "mode": "llm",
    }


def format_context(results: list[dict], max_context_chars: int) -> str:
    parts: list[str] = []
    used = 0
    for result in results:
        header = f"[{result['filename']} #{result['chunk_index']} | score={result['score']}]"
        body = result["text"].strip()
        block = f"{header}\n{body}"
        if used + len(block) > max_context_chars:
            break
        parts.append(block)
        used += len(block)
    return "\n\n---\n\n".join(parts)


def fallback_answer(question: str, results: list[dict]) -> str:
    lines = [
        "已完成本地知识库检索，但当前没有配置大模型 API，所以先返回最相关的依据片段。",
        f"问题：{question}",
        "",
        "最相关内容：",
    ]
    for index, result in enumerate(results[:3], start=1):
        preview = result["text"].strip().replace("\n", " ")
        if len(preview) > 260:
            preview = preview[:260] + "..."
        lines.append(f"{index}. [{result['filename']} #{result['chunk_index']}] {preview}")
    return "\n".join(lines)
