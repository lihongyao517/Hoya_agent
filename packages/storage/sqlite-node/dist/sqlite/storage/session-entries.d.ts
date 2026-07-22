import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
export interface SessionEntryRow {
    session_id: string;
    id: string;
    entry_seq: number;
    parent_id: string | null;
    type: SessionTreeEntry["type"];
    timestamp: string;
    payload: string;
}
export type EncodedEntry = {
    payload: string;
};
export declare function validateSessionTreeEntry(entry: SessionTreeEntry): void;
export declare function encodeEntry(entry: SessionTreeEntry): EncodedEntry;
export declare function decodeEntry(row: SessionEntryRow): SessionTreeEntry;
//# sourceMappingURL=session-entries.d.ts.map