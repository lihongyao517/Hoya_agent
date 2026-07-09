from __future__ import annotations

import math
import re
from collections import Counter


ENGLISH_WORD = re.compile(r"[a-zA-Z0-9_]{2,}")
CJK_BLOCK = re.compile(r"[\u4e00-\u9fff]+")

STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "are",
    "was",
    "were",
    "一个",
    "这个",
    "那个",
    "以及",
    "可以",
    "什么",
    "怎么",
    "如何",
    "进行",
}


def tokenize(text: str) -> list[str]:
    lowered = text.lower()
    tokens: list[str] = []
    for word in ENGLISH_WORD.findall(lowered):
        if word not in STOPWORDS:
            tokens.append(word)
    for block in CJK_BLOCK.findall(text):
        chars = [ch for ch in block if ch.strip()]
        tokens.extend(chars)
        tokens.extend("".join(chars[i : i + 2]) for i in range(max(0, len(chars) - 1)))
    return [token for token in tokens if token not in STOPWORDS]


def token_counts(text: str) -> dict[str, int]:
    return dict(Counter(tokenize(text)))


def cosine_similarity(
    query_counts: dict[str, int],
    doc_counts: dict[str, int],
    doc_frequency: dict[str, int],
    total_docs: int,
) -> float:
    if not query_counts or not doc_counts:
        return 0.0

    dot = 0.0
    query_norm = 0.0
    doc_norm = 0.0
    vocabulary = set(query_counts) | set(doc_counts)

    for token in vocabulary:
        idf = math.log((total_docs + 1) / (doc_frequency.get(token, 0) + 1)) + 1.0
        query_weight = query_counts.get(token, 0) * idf
        doc_weight = doc_counts.get(token, 0) * idf
        dot += query_weight * doc_weight
        query_norm += query_weight * query_weight
        doc_norm += doc_weight * doc_weight

    if query_norm == 0.0 or doc_norm == 0.0:
        return 0.0
    return dot / (math.sqrt(query_norm) * math.sqrt(doc_norm))
