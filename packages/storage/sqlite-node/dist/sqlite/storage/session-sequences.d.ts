import type { SqliteDatabase } from "../types.ts";
export declare function getNextSequence(db: SqliteDatabase, sessionId: string): Promise<number>;
export declare function advanceSequence(db: SqliteDatabase, sessionId: string, nextSeq: number): Promise<void>;
//# sourceMappingURL=session-sequences.d.ts.map