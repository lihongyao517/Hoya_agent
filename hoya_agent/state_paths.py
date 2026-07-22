from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import threading
from pathlib import Path


APP_DIRECTORY_NAME = "Hoya Agent"


def app_data_dir() -> Path:
    """Return the per-user directory used for Hoya's private application data."""
    override = os.environ.get("HOYA_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        return Path(appdata).expanduser() / APP_DIRECTORY_NAME
    return Path.home() / ".hoya_agent"


def workspace_key(workspace: Path) -> str:
    resolved = workspace.expanduser().resolve()
    normalized = os.path.normcase(str(resolved))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:20]


def workspace_state_dir(workspace: Path) -> Path:
    """Return a stable private state directory without modifying the project."""
    resolved = workspace.expanduser().resolve()
    state_dir = app_data_dir() / "workspaces" / workspace_key(resolved)
    state_dir.mkdir(parents=True, exist_ok=True)
    manifest = state_dir / "workspace.json"
    if not manifest.exists():
        _write_json_atomic(manifest, {"path": str(resolved), "schema_version": 1})
    return state_dir


def workspace_config_path(workspace: Path) -> Path:
    return workspace_state_dir(workspace) / "config.env"


def migrate_workspace_state(
    workspace: Path,
    new_name: str,
    *legacy_names: str,
) -> Path:
    """Move legacy Hoya state out of the project, copying when a move is blocked.

    The legacy path is used only as a last-resort compatibility fallback. This
    keeps existing data readable without needlessly continuing to write new
    private state into the user's project.
    """
    workspace = workspace.expanduser().resolve()
    state_dir = workspace_state_dir(workspace)
    current = state_dir / new_name
    if current.exists():
        for legacy_name in legacy_names:
            legacy = _safe_legacy_path(workspace, legacy_name)
            if legacy is not None and legacy.exists():
                try:
                    _merge_existing_state(legacy, current)
                except OSError:
                    pass
        return current

    for legacy_name in legacy_names:
        legacy = _safe_legacy_path(workspace, legacy_name)
        if legacy is None or not legacy.exists():
            continue
        try:
            current.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(legacy), str(current))
            return current
        except OSError:
            try:
                return current if _merge_existing_state(legacy, current) else legacy
            except OSError:
                return legacy
    return current


def _safe_legacy_path(workspace: Path, legacy_name: str) -> Path | None:
    """Return an in-workspace legacy path only when its tree contains no links."""
    relative = Path(legacy_name)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        return None
    legacy = workspace.joinpath(relative)
    try:
        legacy.relative_to(workspace)
    except ValueError:
        return None
    cursor = workspace
    for part in relative.parts:
        cursor /= part
        if not cursor.exists() and not cursor.is_symlink():
            break
        if _path_is_link(cursor):
            return None
    if not legacy.exists() and not legacy.is_symlink():
        return legacy
    if _tree_contains_link(legacy):
        return None
    try:
        legacy.resolve().relative_to(workspace)
    except (OSError, ValueError):
        return None
    return legacy


def _tree_contains_link(root: Path) -> bool:
    """Detect symlinks, Windows junctions/reparse points, and hard-linked files."""
    stack = [root]
    while stack:
        path = stack.pop()
        try:
            info = path.lstat()
        except OSError:
            return True
        if _path_is_link(path, info):
            return True
        if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
            return True
        if not stat.S_ISDIR(info.st_mode):
            continue
        try:
            children = list(path.iterdir())
        except OSError:
            return True
        stack.extend(children)
    return False


def _path_is_link(path: Path, info: os.stat_result | None = None) -> bool:
    try:
        details = info or path.lstat()
    except OSError:
        return True
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return path.is_symlink() or bool(
        reparse_flag and getattr(details, "st_file_attributes", 0) & reparse_flag
    )


def _merge_existing_state(legacy: Path, current: Path) -> bool:
    """Merge a split legacy/private state without overwriting newer entries."""
    if legacy.is_symlink() or current.is_symlink():
        return False
    if not current.exists():
        current.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(legacy, current) if legacy.is_dir() else shutil.copy2(legacy, current)
        _remove_legacy_path(legacy)
        return True
    if legacy.is_dir() and current.is_dir():
        merged = all(
            _merge_existing_state(child, current / child.name)
            for child in list(legacy.iterdir())
        )
        if merged:
            _remove_legacy_path(legacy)
        return merged
    if not legacy.is_file() or not current.is_file() or legacy.suffix.lower() != current.suffix.lower():
        return False

    suffix = current.suffix.lower()
    if suffix == ".json":
        try:
            legacy_data = json.loads(legacy.read_text(encoding="utf-8"))
            current_data = json.loads(current.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return False
        if isinstance(legacy_data, list) and isinstance(current_data, list):
            current_identities = {_json_identity(item) for item in current_data}
            merged_data = [
                *(item for item in legacy_data if _json_identity(item) not in current_identities),
                *current_data,
            ]
            _write_json_atomic(current, merged_data)
        elif isinstance(legacy_data, dict) and isinstance(current_data, dict):
            _write_json_atomic(current, {**legacy_data, **current_data})
        else:
            return False
    elif suffix == ".jsonl":
        legacy_lines = legacy.read_text(encoding="utf-8", errors="replace").splitlines()
        current_lines = current.read_text(encoding="utf-8", errors="replace").splitlines()
        seen_lines = set(legacy_lines)
        merged_lines = [*legacy_lines, *(line for line in current_lines if line not in seen_lines)]
        _write_text_atomic(current, ("\n".join(merged_lines) + "\n") if merged_lines else "")
    else:
        return False

    _remove_legacy_path(legacy)
    return True


def _json_identity(value: object) -> str:
    if isinstance(value, dict) and value.get("id"):
        return f"id:{value['id']}"
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _remove_legacy_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def _write_json_atomic(path: Path, payload: object) -> None:
    _write_text_atomic(path, json.dumps(payload, ensure_ascii=False, indent=2))


def _write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)
