from __future__ import annotations

from pathlib import Path


SENSITIVE_DIRECTORY_NAMES = {".aws", ".azure", ".docker", ".git", ".gnupg", ".kube", ".ssh"}
SENSITIVE_FILE_NAMES = {
    ".envrc",
    ".git-credentials",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "credentials",
    "credentials.json",
    "id_dsa",
    "id_ed25519",
    "id_rsa",
    "secrets.json",
    "secrets.toml",
}
SENSITIVE_FILE_SUFFIXES = {".jks", ".key", ".p12", ".pem", ".pfx"}


def is_sensitive_path(path: Path, workspace: Path | None = None) -> bool:
    try:
        candidate = path.expanduser().resolve()
    except OSError:
        return True
    if workspace is not None:
        try:
            parts = candidate.relative_to(workspace.resolve()).parts
        except (OSError, ValueError):
            return True
    else:
        parts = candidate.parts
    lowered_parts = tuple(part.lower() for part in parts)
    if any(part in SENSITIVE_DIRECTORY_NAMES for part in lowered_parts[:-1]):
        return True
    name = candidate.name.lower()
    name_is_sensitive = (
        name == ".env"
        or name.startswith(".env.")
        or name in SENSITIVE_FILE_NAMES
        or candidate.suffix.lower() in SENSITIVE_FILE_SUFFIXES
    )
    if name_is_sensitive:
        return True
    try:
        return candidate.is_file() and candidate.stat().st_nlink > 1
    except OSError:
        return True
