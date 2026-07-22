import { SessionError } from "@earendil-works/pi-agent-core";
function parseMetadata(metadata, sessionId) {
    if (metadata === null)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(metadata);
    }
    catch (error) {
        throw new SessionError("invalid_session", `Invalid SQLite session ${sessionId}: metadata is not valid JSON`, error instanceof Error ? error : undefined);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new SessionError("invalid_session", `Invalid SQLite session ${sessionId}: metadata must be an object`);
    }
    return parsed;
}
export function rowToMetadata(row, path) {
    return {
        id: row.id,
        createdAt: row.created_at,
        cwd: row.cwd,
        path,
        parentSessionId: row.parent_session_id ?? undefined,
        metadata: parseMetadata(row.metadata, row.id),
    };
}
//# sourceMappingURL=sessions.js.map