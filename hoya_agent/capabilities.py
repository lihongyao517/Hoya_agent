from __future__ import annotations

import json
from pathlib import Path
from typing import Any


MAX_SKILLS = 20
MAX_MCP_SERVERS = 30
MAX_DESCRIPTION_CHARS = 500


def _frontmatter_value(lines: list[str], key: str) -> str:
    prefix = f"{key}:"
    for line in lines:
        if line.strip().lower().startswith(prefix):
            value = line.split(":", 1)[1].strip()
            return value.strip('"').strip("'")
    return ""


def discover_skills(workspace: Path, *, limit: int = MAX_SKILLS) -> list[dict[str, str]]:
    skills_root = workspace.expanduser().resolve() / ".agents" / "skills"
    if not skills_root.is_dir():
        return []

    skills: list[dict[str, str]] = []
    for skill_file in sorted(skills_root.glob("*/SKILL.md"))[:limit]:
        try:
            text = skill_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = text.splitlines()
        name = _frontmatter_value(lines[:40], "name") or skill_file.parent.name
        description = _frontmatter_value(lines[:80], "description")
        if not description:
            description = next((line.strip("# ").strip() for line in lines if line.strip().startswith("#")), "")
        skills.append(
            {
                "name": name[:120],
                "description": description[:MAX_DESCRIPTION_CHARS],
                "path": str(skill_file),
            }
        )
    return skills


def _load_json_object(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def discover_mcp_servers(workspace: Path, *, limit: int = MAX_MCP_SERVERS) -> list[dict[str, str]]:
    root = workspace.expanduser().resolve()
    candidates = [
        root / ".mcp.json",
        root / "mcp.json",
        root / ".codex" / "mcp.json",
        root / ".agents" / "mcp.json",
    ]
    servers: list[dict[str, str]] = []
    seen: set[str] = set()

    for path in candidates:
        payload = _load_json_object(path)
        raw_servers = payload.get("mcpServers") or payload.get("servers") or {}
        if not isinstance(raw_servers, dict):
            continue
        for name, config in raw_servers.items():
            if len(servers) >= limit:
                return servers
            server_name = str(name).strip()
            if not server_name or server_name in seen:
                continue
            seen.add(server_name)
            command = ""
            if isinstance(config, dict):
                command = str(config.get("command") or config.get("url") or config.get("transport") or "")
            servers.append({"name": server_name[:120], "source": str(path), "command": command[:240]})
    return servers


def capability_guidance(workspace: Path) -> str:
    skills = discover_skills(workspace)
    mcp_servers = discover_mcp_servers(workspace)
    parts: list[str] = []
    if skills:
        lines = [f"- {item['name']}: {item['description']}".rstrip(": ") for item in skills]
        parts.append("Installed workspace skills are available as local guidance. Use list_skills/read_skill before relying on a skill:\n" + "\n".join(lines))
    if mcp_servers:
        lines = [f"- {item['name']} ({item['command'] or item['source']})" for item in mcp_servers]
        parts.append("MCP server configuration was detected. You can inspect it with list_mcp_servers, but direct MCP tool execution depends on the configured client runtime:\n" + "\n".join(lines))
    return "\n\n".join(parts)
