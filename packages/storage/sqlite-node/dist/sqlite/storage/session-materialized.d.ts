import type { SessionStats, SessionTreeEntry, ThinkingLevel } from "@earendil-works/pi-agent-core";
export interface SessionMaterializedRow {
    session_id: string;
    payload: string;
}
export interface EntryMaterializedRow {
    session_id: string;
    entry_seq: number;
    type: string;
    payload: string;
}
export interface ModelThinkingConfig {
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
}
export interface SessionMaterializedState {
    name: string | undefined;
    messageCount: number;
    cachedTokens: number;
    uncachedTokens: number;
    totalTokens: number;
    costTotal: number;
    labelsById: Map<string, string>;
    modelThinkingConfigs: ModelThinkingConfig[];
    currentModel: {
        provider: string;
        modelId: string;
    } | null;
    currentThinkingLevel: ThinkingLevel | null;
}
export declare function isThinkingLevel(value: unknown): value is ThinkingLevel;
export declare function createEmptyMaterializedState(): SessionMaterializedState;
export declare function applyEntryToMaterializedState(state: SessionMaterializedState, entry: SessionTreeEntry): void;
export declare function serializeSummary(state: SessionMaterializedState): string;
export declare function materializedStateFromRows(summaryRow: SessionMaterializedRow, entryRows: EntryMaterializedRow[]): SessionMaterializedState;
export declare function sessionStatsFromMaterializedState(state: SessionMaterializedState): SessionStats;
export declare function materializedStateValues(sessionId: string, state: SessionMaterializedState): [sessionId: string, payload: string];
export declare function entryMaterializedValues(entry: SessionTreeEntry): Array<{
    type: EntryMaterializedRow["type"];
    payload: string;
}>;
//# sourceMappingURL=session-materialized.d.ts.map