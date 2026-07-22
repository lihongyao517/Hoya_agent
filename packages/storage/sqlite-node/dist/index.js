import { DatabaseSync } from "node:sqlite";
function isNamedParameters(value) {
    if (value === null || typeof value !== "object")
        return false;
    if (Array.isArray(value) || ArrayBuffer.isView(value))
        return false;
    return true;
}
class NodeSqliteStatement {
    statement;
    constructor(statement) {
        this.statement = statement;
    }
    async run(...params) {
        const [first, ...rest] = params;
        const result = isNamedParameters(first)
            ? this.statement.run(first, ...rest)
            : this.statement.run(...params);
        return {
            changes: Number(result.changes),
            lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
        };
    }
    async get(...params) {
        const [first, ...rest] = params;
        return (isNamedParameters(first)
            ? this.statement.get(first, ...rest)
            : this.statement.get(...params));
    }
    async all(...params) {
        const [first, ...rest] = params;
        return (isNamedParameters(first)
            ? this.statement.all(first, ...rest)
            : this.statement.all(...params));
    }
}
class NodeSqliteDatabase {
    db;
    constructor(db) {
        this.db = db;
    }
    async exec(sql) {
        this.db.exec(sql);
    }
    prepare(sql) {
        return new NodeSqliteStatement(this.db.prepare(sql));
    }
    async transaction(fn) {
        this.db.exec("BEGIN");
        try {
            const result = await fn();
            this.db.exec("COMMIT");
            return result;
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch {
                // Ignore rollback errors to rethrow original error.
            }
            throw error;
        }
    }
    async close() {
        this.db.close();
    }
}
export function wrapNodeSqliteDatabase(db) {
    return new NodeSqliteDatabase(db);
}
export function createNodeSqliteFactory() {
    return {
        async open(path) {
            return new NodeSqliteDatabase(new DatabaseSync(path));
        },
    };
}
// Re-export the SQLite session storage backend and types so this package is a complete node-sqlite backend.
export * from "./sqlite/index.js";
//# sourceMappingURL=index.js.map