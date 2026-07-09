from __future__ import annotations

import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree


class DocumentParseError(Exception):
    """Raised when a document cannot be parsed into text."""


SUPPORTED_EXTENSIONS = {".txt", ".md", ".markdown", ".docx", ".pdf"}


def load_document_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise DocumentParseError(f"暂不支持 {suffix or '无扩展名'} 文件，请上传 txt、md、docx 或 pdf")
    if suffix in {".txt", ".md", ".markdown"}:
        text = read_text_file(path)
    elif suffix == ".docx":
        text = read_docx(path)
    else:
        text = read_pdf(path)
    text = normalize_text(text)
    if not text:
        raise DocumentParseError("没有从文档中解析到可检索文本")
    return text


def read_text_file(path: Path) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    raise DocumentParseError("文本文件编码无法识别，请使用 UTF-8 或 GB18030")


def read_docx(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            xml_bytes = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile) as exc:
        raise DocumentParseError("DOCX 文件解析失败，请确认文件未损坏") from exc

    root = ElementTree.fromstring(xml_bytes)
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs: list[str] = []
    for para in root.findall(".//w:p", namespace):
        texts = [node.text or "" for node in para.findall(".//w:t", namespace)]
        paragraph = "".join(texts).strip()
        if paragraph:
            paragraphs.append(paragraph)
    return "\n\n".join(paragraphs)


def read_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError as exc:
        raise DocumentParseError(
            "当前环境未安装 pypdf，PDF 解析不可用。可先上传 txt/md/docx，或执行：python -m pip install pypdf"
        ) from exc

    try:
        reader = PdfReader(str(path))
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
    except Exception as exc:  # pragma: no cover - depends on external PDF parser
        raise DocumentParseError("PDF 文件解析失败，请尝试换成可复制文本的 PDF") from exc
    return "\n\n".join(page for page in pages if page)


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_into_chunks(text: str, chunk_size: int = 700, overlap: int = 120) -> list[str]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        if len(paragraph) > chunk_size:
            if current:
                chunks.append(current.strip())
                current = ""
            start = 0
            while start < len(paragraph):
                end = min(start + chunk_size, len(paragraph))
                chunks.append(paragraph[start:end].strip())
                if end == len(paragraph):
                    break
                start = max(end - overlap, start + 1)
            continue

        if len(current) + len(paragraph) + 2 <= chunk_size:
            current = f"{current}\n\n{paragraph}" if current else paragraph
        else:
            if current:
                chunks.append(current.strip())
            current = paragraph

    if current:
        chunks.append(current.strip())
    return chunks
