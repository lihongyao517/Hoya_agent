import { SessionError } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
export function generateEntryId(byId) {
    for (let i = 0; i < 100; i++) {
        // The uuidv7 prefix is timestamp-derived and nearly constant between calls,
        // so short ids must come from the random tail.
        const id = uuidv7().slice(0, 8);
        if (!byId.has(id))
            return id;
    }
    return uuidv7();
}
export function isRecord(value) {
    return typeof value === "object" && value !== null;
}
export function invalidSession(message, cause) {
    return new SessionError("invalid_session", `Invalid SQLite session: ${message}`, cause);
}
export function invalidEntry(message, cause) {
    return new SessionError("invalid_entry", `Invalid SQLite session entry: ${message}`, cause);
}
export function leafIdAfterEntry(entry) {
    return entry.type === "leaf" ? entry.targetId : entry.id;
}
//# sourceMappingURL=shared.js.map