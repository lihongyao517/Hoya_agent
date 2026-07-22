import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "../types.ts";
export interface BranchEntryRow {
    entry_id: string;
    entry_seq: number;
}
export declare function getMaterializedBranchPathOrCompaction(db: SqliteDatabase, sessionId: string, branchId: string, byId: Map<string, SessionTreeEntry>): Promise<SessionTreeEntry[]>;
//# sourceMappingURL=branch-entries.d.ts.map