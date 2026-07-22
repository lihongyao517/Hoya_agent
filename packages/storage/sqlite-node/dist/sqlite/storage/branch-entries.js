import { decodeEntry } from "./session-entries.js";
import { invalidSession } from "./shared.js";
export async function getMaterializedBranchPathOrCompaction(db, sessionId, branchId, byId) {
    const branchRows = await db
        .prepare("SELECT entry_id, entry_seq FROM branch_entries WHERE session_id = ? AND branch_id = ? ORDER BY entry_seq")
        .all(sessionId, branchId);
    if (branchRows.length === 0) {
        return [];
    }
    const entryIds = branchRows.map((row) => row.entry_id);
    const placeholders = entryIds.map(() => "?").join(", ");
    const entryRows = await db
        .prepare(`SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND id IN (${placeholders})`)
        .all(sessionId, ...entryIds);
    const entryRowsById = new Map(entryRows.map((row) => [row.id, row]));
    const entries = [];
    for (const branchRow of branchRows) {
        // leaf entries are navigation markers used to mark which branch became active;
        // they are not part of the model/context path reconstructed from branch_entries.
        const cached = byId.get(branchRow.entry_id);
        if (cached) {
            if (cached.type !== "leaf") {
                entries.push(cached);
            }
            continue;
        }
        const entryRow = entryRowsById.get(branchRow.entry_id);
        if (!entryRow)
            throw invalidSession(`missing entry row for branch entry ${branchRow.entry_id}`);
        try {
            const entry = decodeEntry(entryRow);
            byId.set(entry.id, entry);
            if (entry.type !== "leaf") {
                entries.push(entry);
            }
        }
        catch {
            throw invalidSession(`invalid entry row for branch entry ${branchRow.entry_id}`);
        }
    }
    return entries;
}
//# sourceMappingURL=branch-entries.js.map