import type { Session } from "@earendil-works/pi-agent-core";
import type { SqliteDatabaseFactory, SqliteSessionCreateOptions, SqliteSessionListOptions, SqliteSessionMetadata, SqliteSessionRepoApi, SqliteSessionRepoEnv } from "./types.ts";
export declare class SqliteSessionRepo implements SqliteSessionRepoApi {
    private readonly env;
    private readonly sqlite;
    private readonly databasePathInput;
    private databasePath;
    constructor(options: {
        env: SqliteSessionRepoEnv;
        sqlite: SqliteDatabaseFactory;
        databasePath: string;
    });
    private getDatabasePath;
    private ensureDatabaseDir;
    private openDatabase;
    create(options: SqliteSessionCreateOptions): Promise<Session<SqliteSessionMetadata>>;
    open(metadata: SqliteSessionMetadata): Promise<Session<SqliteSessionMetadata>>;
    list(options?: SqliteSessionListOptions): Promise<SqliteSessionMetadata[]>;
    delete(metadata: SqliteSessionMetadata): Promise<void>;
    fork(sourceMetadata: SqliteSessionMetadata, options: SqliteSessionCreateOptions & {
        entryId?: string;
        position?: "before" | "at";
        id?: string;
    }): Promise<Session<SqliteSessionMetadata>>;
}
//# sourceMappingURL=repo.d.ts.map