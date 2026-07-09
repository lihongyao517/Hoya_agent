from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from assistant.documents import split_into_chunks
from assistant.retriever import cosine_similarity, token_counts


@dataclass
class DocumentRecord:
    filename: str
    path: str
    chunk_count: int
    created_at: str

    def to_public_dict(self) -> dict:
        return {
            "filename": self.filename,
            "chunk_count": self.chunk_count,
            "created_at": self.created_at,
        }


class KnowledgeBase:
    def __init__(self, index_path: Path) -> None:
        self.index_path = index_path
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        self.data = self._load()

    def _load(self) -> dict:
        if not self.index_path.exists():
            return {"documents": [], "chunks": []}
        return json.loads(self.index_path.read_text(encoding="utf-8"))

    def _save(self) -> None:
        self.index_path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")

    def add_document(self, filename: str, path: Path, text: str) -> DocumentRecord:
        chunks = split_into_chunks(text)
        created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.data["documents"] = [doc for doc in self.data["documents"] if doc["filename"] != filename]
        self.data["chunks"] = [chunk for chunk in self.data["chunks"] if chunk["filename"] != filename]

        for index, chunk_text in enumerate(chunks, start=1):
            self.data["chunks"].append(
                {
                    "id": f"{filename}#{index}",
                    "filename": filename,
                    "chunk_index": index,
                    "text": chunk_text,
                    "tokens": token_counts(chunk_text),
                }
            )

        record = DocumentRecord(
            filename=filename,
            path=str(path),
            chunk_count=len(chunks),
            created_at=created_at,
        )
        self.data["documents"].append(
            {
                "filename": record.filename,
                "path": record.path,
                "chunk_count": record.chunk_count,
                "created_at": record.created_at,
            }
        )
        self._save()
        return record

    def list_documents(self) -> list[dict]:
        return [
            {
                "filename": doc["filename"],
                "chunk_count": doc["chunk_count"],
                "created_at": doc["created_at"],
            }
            for doc in sorted(self.data["documents"], key=lambda item: item["created_at"], reverse=True)
        ]

    def search(self, question: str, top_k: int = 5) -> list[dict]:
        chunks = self.data.get("chunks", [])
        if not chunks:
            return []

        doc_frequency: dict[str, int] = {}
        for chunk in chunks:
            for token in chunk.get("tokens", {}):
                doc_frequency[token] = doc_frequency.get(token, 0) + 1

        query_counts = token_counts(question)
        scored = []
        for chunk in chunks:
            score = cosine_similarity(
                query_counts=query_counts,
                doc_counts=chunk.get("tokens", {}),
                doc_frequency=doc_frequency,
                total_docs=len(chunks),
            )
            if score > 0:
                scored.append(
                    {
                        "score": round(score, 4),
                        "filename": chunk["filename"],
                        "chunk_index": chunk["chunk_index"],
                        "text": chunk["text"],
                    }
                )

        scored.sort(key=lambda item: item["score"], reverse=True)
        return scored[: max(1, min(top_k, 10))]
