import { createSessionId, getEntriesToFork, getFileSystemResultOrThrow, SessionError, toSession, } from "@earendil-works/pi-agent-core";
import { applyMigrations } from "./migrations.js";
import { SqliteSessionStorage } from "./storage/index.js";
import { rowToMetadata } from "./storage/sessions.js";
function getParentPath(path) {
    const normalized = path.replace(/[\\/]+$/, "");
    const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    if (lastSlash < 0)
        return ".";
    if (lastSlash === 0)
        return normalized.slice(0, 1);
    return normalized.slice(0, lastSlash);
}
async function configureSqliteDatabase(db) {
    await db.exec("PRAGMA journal_mode=WAL");
    await db.exec("PRAGMA synchronous=FULL");
    await db.exec("PRAGMA busy_timeout=5000");
}
async function cleanupSessionStorage(storage) {
    const maybeClosable = storage;
    if (typeof maybeClosable.cleanup === "function") {
        await maybeClosable.cleanup();
    }
}
export class SqliteSessionRepo {
    env;
    sqlite;
    databasePathInput;
    databasePath;
    constructor(options) {
        this.env = options.env;
        this.sqlite = options.sqlite;
        this.databasePathInput = options.databasePath;
    }
    async getDatabasePath() {
        if (!this.databasePath) {
            this.databasePath = getFileSystemResultOrThrow(await this.env.absolutePath(this.databasePathInput), `Failed to resolve SQLite sessions database ${this.databasePathInput}`);
        }
        return this.databasePath;
    }
    async ensureDatabaseDir() {
        const path = await this.getDatabasePath();
        const directory = getParentPath(path);
        getFileSystemResultOrThrow(await this.env.createDir(directory, { recursive: true }), `Failed to create SQLite sessions directory ${directory}`);
    }
    async openDatabase() {
        await this.ensureDatabaseDir();
        const db = await this.sqlite.open(await this.getDatabasePath());
        try {
            await configureSqliteDatabase(db);
            await applyMigrations(db);
            return db;
        }
        catch (error) {
            await db.close();
            throw error;
        }
    }
    async create(options) {
        const db = await this.openDatabase();
        try {
            const id = options.id ?? createSessionId();
            const storage = await SqliteSessionStorage.create(db, await this.getDatabasePath(), {
                cwd: options.cwd,
                sessionId: id,
                parentSessionId: options.parentSessionId,
                metadata: options.metadata,
            });
            return toSession(storage);
        }
        catch (error) {
            await db.close();
            throw error;
        }
    }
    async open(metadata) {
        if (!getFileSystemResultOrThrow(await this.env.exists(metadata.path), `Failed to check database ${metadata.path}`)) {
            throw new SessionError("not_found", `Session not found: ${metadata.id}`);
        }
        const db = await this.openDatabase();
        try {
            const storage = await SqliteSessionStorage.open(db, metadata);
            return toSession(storage);
        }
        catch (error) {
            await db.close();
            throw error;
        }
    }
    async list(options = {}) {
        const path = await this.getDatabasePath();
        if (!getFileSystemResultOrThrow(await this.env.exists(path), `Failed to check database ${path}`)) {
            return [];
        }
        const db = await this.openDatabase();
        try {
            const rows = options.cwd
                ? await db
                    .prepare("SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions WHERE cwd = ? ORDER BY created_at DESC")
                    .all(options.cwd)
                : await db
                    .prepare("SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions ORDER BY created_at DESC")
                    .all();
            return rows.map((row) => rowToMetadata(row, path));
        }
        finally {
            await db.close();
        }
    }
    async delete(metadata) {
        const db = await this.openDatabase();
        try {
            await db.transaction(async () => {
                await db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run(metadata.id);
                await db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(metadata.id);
                await db.prepare("DELETE FROM entry_materialized WHERE session_id = ?").run(metadata.id);
                await db.prepare("DELETE FROM session_materialized WHERE session_id = ?").run(metadata.id);
                await db.prepare("DELETE FROM session_sequences WHERE session_id = ?").run(metadata.id);
                const result = await db.prepare("DELETE FROM sessions WHERE id = ?").run(metadata.id);
                if (result.changes === 0) {
                    throw new SessionError("not_found", `Session not found: ${metadata.id}`);
                }
            });
        }
        finally {
            await db.close();
        }
    }
    async fork(sourceMetadata, options) {
        const source = await this.open(sourceMetadata);
        let forkedEntries;
        try {
            forkedEntries = await getEntriesToFork(source.getStorage(), options);
        }
        finally {
            await cleanupSessionStorage(source.getStorage());
        }
        const db = await this.openDatabase();
        try {
            const id = options.id ?? createSessionId();
            const storage = await SqliteSessionStorage.create(db, await this.getDatabasePath(), {
                cwd: options.cwd,
                sessionId: id,
                parentSessionId: options.parentSessionId ?? sourceMetadata.id,
                metadata: options.metadata ?? sourceMetadata.metadata,
            });
            for (const entry of forkedEntries) {
                await storage.appendEntry(entry);
            }
            return toSession(storage);
        }
        catch (error) {
            await db.close();
            throw error;
        }
    }
}
//# sourceMappingURL=repo.js.map