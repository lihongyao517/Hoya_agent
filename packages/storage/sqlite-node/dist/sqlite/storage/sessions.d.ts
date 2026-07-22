import type { SqliteSessionMetadata } from "../types.ts";
export interface SessionRow {
    id: string;
    created_at: string;
    metadata: string | null;
    cwd: string;
    parent_session_id: string | null;
    active_leaf_id: string | null;
}
export declare function rowToMetadata(row: SessionRow, path: string): SqliteSessionMetadata;
//# sourceMappingURL=sessions.d.ts.map