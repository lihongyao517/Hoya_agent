import type { SessionEntryCursorOptions, SessionStorage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase, SqliteSessionMetadata } from "../types.ts";
export declare class SqliteSessionStorage implements SessionStorage<SqliteSessionMetadata> {
    private readonly db;
    private readonly metadata;
    private byId;
    private labelsById;
    private currentLeafId;
    private activeBranchId;
    private materializedState;
    private getPathToRootOrCompactionEntries;
    private materializeBranch;
    private appendToActiveBranch;
    private constructor();
    static open(db: SqliteDatabase, metadata: SqliteSessionMetadata): Promise<SqliteSessionStorage>;
    static create(db: SqliteDatabase, path: string, options: {
        cwd: string;
        sessionId: string;
        parentSessionId?: string;
        metadata?: Record<string, unknown>;
    }): Promise<SqliteSessionStorage>;
    getMetadata(): Promise<SqliteSessionMetadata>;
    getLeafId(): Promise<string | null>;
    setLeafId(leafId: string | null): Promise<void>;
    createEntryId(): Promise<string>;
    appendEntry(entry: SessionTreeEntry): Promise<void>;
    getEntry(id: string): Promise<SessionTreeEntry | undefined>;
    findEntries<TType extends SessionTreeEntry["type"]>(type: TType): Promise<Array<Extract<SessionTreeEntry, {
        type: TType;
    }>>>;
    getLabel(id: string): Promise<string | undefined>;
    getSessionName(): Promise<string | undefined>;
    getSessionStats(): Promise<import("@earendil-works/pi-agent-core").SessionStats>;
    getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]>;
    getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]>;
    cleanup(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map