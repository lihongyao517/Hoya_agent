import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { SessionError } from "@earendil-works/pi-agent-core";
export declare function generateEntryId(byId: {
    has(id: string): boolean;
}): string;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function invalidSession(message: string, cause?: Error): SessionError;
export declare function invalidEntry(message: string, cause?: Error): SessionError;
export declare function leafIdAfterEntry(entry: SessionTreeEntry): string | null;
//# sourceMappingURL=shared.d.ts.map