import { invalidSession } from "./shared.js";
export async function getNextSequence(db, sessionId) {
    const sequenceRow = await db
        .prepare("SELECT next_seq FROM session_sequences WHERE session_id = ?")
        .get(sessionId);
    if (!sequenceRow) {
        throw invalidSession(`missing sequence row for session ${sessionId}`);
    }
    return sequenceRow.next_seq;
}
export async function advanceSequence(db, sessionId, nextSeq) {
    await db.prepare("UPDATE session_sequences SET next_seq = ? WHERE session_id = ?").run(nextSeq + 1, sessionId);
}
//# sourceMappingURL=session-sequences.js.map