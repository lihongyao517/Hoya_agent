/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export declare const isBunBinary: boolean;
export declare const VERSION: string;
export declare function getServerDir(): string;
export declare function getAuthPath(): string;
export declare function getMachinePath(): string;
export declare function getInstancesPath(): string;
export declare function getSocketPath(): string;
//# sourceMappingURL=config.d.ts.map