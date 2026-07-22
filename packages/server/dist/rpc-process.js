import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isBunBinary } from "./config.js";
const require = createRequire(import.meta.url);
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
export class RpcProcessInstance {
    process;
    exited = false;
    nextRequestId = 0;
    stdoutBuffer = "";
    stderrBuffer = "";
    pendingRequests = new Map();
    eventListeners = new Set();
    exitListeners = new Set();
    uiRequestHandler;
    constructor(options) {
        const rpcCommand = this.getSpawnCommand();
        this.process = spawn(rpcCommand.command, rpcCommand.args, {
            cwd: options.cwd,
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        if (!this.process.stdin || !this.process.stdout) {
            throw new Error("Failed to create RPC process stdio");
        }
        this.attachListeners();
    }
    getSpawnCommand() {
        if (isBunBinary) {
            return {
                command: join(dirname(process.execPath), process.platform === "win32" ? "pi.exe" : "pi"),
                args: ["--mode", "rpc"],
            };
        }
        return {
            command: process.execPath,
            args: [require.resolve("@earendil-works/pi-coding-agent/rpc-entry")],
        };
    }
    attachListeners() {
        this.process.stdout?.setEncoding("utf8");
        this.process.stdout?.on("data", (chunk) => {
            this.stdoutBuffer += chunk;
            while (true) {
                const newlineIndex = this.stdoutBuffer.indexOf("\n");
                if (newlineIndex === -1) {
                    break;
                }
                const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
                this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
                if (!line) {
                    continue;
                }
                this.handleLine(line);
            }
        });
        this.process.stderr?.setEncoding("utf8");
        this.process.stderr?.on("data", (chunk) => {
            this.stderrBuffer += chunk;
        });
        this.process.once("error", (error) => {
            this.exited = true;
            const wrapped = new Error(`RPC process error: ${error.message}. Stderr: ${this.stderrBuffer}`);
            this.rejectAllPending(wrapped);
            this.notifyExit(wrapped);
        });
        this.process.once("exit", (code, signal) => {
            this.exited = true;
            const error = new Error(`RPC process exited (code=${code} signal=${signal}). Stderr: ${this.stderrBuffer}`);
            this.rejectAllPending(error);
            this.notifyExit(error);
        });
    }
    handleLine(line) {
        const parsed = JSON.parse(line);
        switch (parsed.type) {
            case "response": {
                if (!parsed.id) {
                    return;
                }
                const pending = this.pendingRequests.get(parsed.id);
                if (!pending) {
                    return;
                }
                this.pendingRequests.delete(parsed.id);
                pending.resolve(parsed);
                return;
            }
            case "extension_ui_request": {
                this.uiRequestHandler?.(parsed);
                return;
            }
            default: {
                for (const listener of this.eventListeners) {
                    listener(parsed);
                }
            }
        }
    }
    rejectAllPending(error) {
        for (const [id, pending] of this.pendingRequests) {
            this.pendingRequests.delete(id);
            pending.reject(error);
        }
    }
    notifyExit(error) {
        for (const listener of this.exitListeners) {
            listener(error);
        }
    }
    send(command) {
        if (this.exited) {
            throw new Error(`RPC process is not running. Stderr: ${this.stderrBuffer}`);
        }
        const id = command.id ?? `server_${++this.nextRequestId}_${randomUUID()}`;
        const fullCommand = { ...command, id };
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.process.stdin?.write(`${JSON.stringify(fullCommand)}\n`, (error) => {
                if (!error) {
                    return;
                }
                this.pendingRequests.delete(id);
                reject(toError(error));
            });
        });
    }
    handleUiResponse(response) {
        if (this.exited) {
            return;
        }
        this.process.stdin?.write(`${JSON.stringify(response)}\n`);
    }
    setUiRequestHandler(handler) {
        this.uiRequestHandler = handler;
    }
    onEvent(listener) {
        this.eventListeners.add(listener);
        return () => {
            this.eventListeners.delete(listener);
        };
    }
    onExit(listener) {
        this.exitListeners.add(listener);
        return () => {
            this.exitListeners.delete(listener);
        };
    }
    async dispose() {
        this.uiRequestHandler = undefined;
        this.rejectAllPending(new Error("RPC process disposed"));
        if (this.exited) {
            return;
        }
        this.process.kill("SIGTERM");
        await new Promise((resolve) => {
            this.process.once("exit", () => resolve());
        });
    }
}
export function createRpcProcessInstance(options) {
    return new RpcProcessInstance(options);
}
//# sourceMappingURL=rpc-process.js.map