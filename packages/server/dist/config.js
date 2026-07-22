import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const CONFIG_DIR_NAME = ".pi";
const ENV_SERVER_DIR = "PI_SERVER_DIR";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");
function getPackageJsonPath() {
    let dir = __dirname;
    while (dir !== dirname(dir)) {
        const packageJsonPath = join(dir, "package.json");
        if (existsSync(packageJsonPath)) {
            return packageJsonPath;
        }
        dir = dirname(dir);
    }
    return join(__dirname, "package.json");
}
let pkg = {};
try {
    pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));
}
catch (e) {
    const err = e;
    if (err.code !== "ENOENT")
        throw e;
}
export const VERSION = pkg.version || "0.0.0";
export function getServerDir() {
    const envDir = process.env[ENV_SERVER_DIR];
    if (envDir) {
        return envDir;
    }
    const piDir = process.env.PI_CONFIG_DIR || join(homedir(), CONFIG_DIR_NAME);
    return join(piDir, "server");
}
export function getAuthPath() {
    return join(getServerDir(), "auth.json");
}
export function getMachinePath() {
    return join(getServerDir(), "machine.json");
}
export function getInstancesPath() {
    return join(getServerDir(), "instances.json");
}
export function getSocketPath() {
    return join(getServerDir(), "server.sock");
}
//# sourceMappingURL=config.js.map