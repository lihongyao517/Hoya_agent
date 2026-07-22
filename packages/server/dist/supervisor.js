import { randomUUID } from "node:crypto";
import { radiusPresence } from "./radius.js";
import { createRpcProcessInstance } from "./rpc-process.js";
import { getInstance, loadInstances, removeInstance, saveInstances, upsertInstance } from "./storage.js";
function cloneInstance(record) {
    return { ...record };
}
// Only refresh persisted session metadata after commands that can plausibly change
// the instance identity/details we store in instances.json. Most RPCs mutate transient
// runtime state only, so forcing a follow-up get_state after every command is wasted IO.
//
// - new_session / switch_session / fork / clone can change sessionId/sessionFile
// - set_session_name changes a persisted session detail we may want reflected externally
// - prompt can materialize or advance persisted session state after the child processes it
const SESSION_METADATA_COMMANDS = new Set([
    "new_session",
    "switch_session",
    "fork",
    "clone",
    "set_session_name",
    "prompt",
]);
function shouldRefreshSessionMetadata(command) {
    return SESSION_METADATA_COMMANDS.has(command.type);
}
function isGetStateSuccess(response) {
    return response.success === true && response.command === "get_state" && "data" in response;
}
export class ServerSupervisor {
    liveInstances = new Map();
    setStatus(live, status) {
        live.record = {
            ...live.record,
            status,
            lastSeenAt: new Date().toISOString(),
        };
        upsertInstance(live.record);
    }
    updateRecord(live, updates) {
        live.record = {
            ...live.record,
            ...updates,
            lastSeenAt: new Date().toISOString(),
        };
        if (updates.radiusPiId !== undefined) {
            live.resources.radiusPiId = updates.radiusPiId;
        }
        if (updates.sessionId !== undefined) {
            live.resources.sessionId = updates.sessionId;
        }
        upsertInstance(live.record);
    }
    clearBindings(live) {
        live.unsubscribeEvents?.();
        live.unsubscribeExit?.();
        live.unsubscribeEvents = undefined;
        live.unsubscribeExit = undefined;
        live.onUiRequest = undefined;
        live.resources.rpcProcess?.setUiRequestHandler(undefined);
    }
    bindRpcProcess(live, rpcProcess) {
        this.clearBindings(live);
        live.resources.rpcProcess = rpcProcess;
        live.unsubscribeEvents = rpcProcess.onEvent((event) => {
            for (const subscriber of live.subscribers) {
                subscriber(event);
            }
        });
        live.unsubscribeExit = rpcProcess.onExit((error) => {
            void this.handleUnexpectedRpcExit(live, error);
        });
        rpcProcess.setUiRequestHandler((request) => {
            live.onUiRequest?.(request);
        });
    }
    async handleUnexpectedRpcExit(live, _error) {
        if (this.liveInstances.get(live.record.id) !== live) {
            return;
        }
        if (live.record.status === "stopping" || live.record.status === "stopped") {
            return;
        }
        this.setStatus(live, "error");
        this.clearBindings(live);
        live.resources.rpcProcess = undefined;
        if (live.resources.radiusPiId) {
            try {
                await radiusPresence.disconnectPi(live.record);
                this.updateRecord(live, { radiusPiId: undefined });
            }
            catch (error) {
                console.error(`Failed to disconnect Radius Pi ${live.record.id}: ${String(error)}`);
            }
        }
        this.liveInstances.delete(live.record.id);
    }
    getRpcProcess(live) {
        return live.resources.rpcProcess;
    }
    async syncInstanceRecord(live) {
        const rpcProcess = this.getRpcProcess(live);
        if (!rpcProcess) {
            this.updateRecord(live, {});
            return;
        }
        const response = await rpcProcess.send({ type: "get_state" });
        if (!isGetStateSuccess(response)) {
            this.updateRecord(live, {});
            return;
        }
        this.updateRecord(live, {
            sessionId: response.data.sessionId,
            sessionFile: response.data.sessionFile,
        });
    }
    async cleanupAcquiredResources(live) {
        const rpcProcess = live.resources.rpcProcess;
        this.clearBindings(live);
        if (live.resources.radiusPiId) {
            await radiusPresence.disconnectPi(live.record);
            live.resources.radiusPiId = undefined;
            live.record = {
                ...live.record,
                radiusPiId: undefined,
                lastSeenAt: new Date().toISOString(),
            };
        }
        live.resources.sessionId = undefined;
        if (rpcProcess) {
            live.resources.rpcProcess = undefined;
            await rpcProcess.dispose();
        }
    }
    async failSpawn(live, error) {
        this.setStatus(live, "error");
        try {
            await this.cleanupAcquiredResources(live);
        }
        finally {
            this.setStatus(live, "stopped");
            this.liveInstances.delete(live.record.id);
        }
        throw error;
    }
    updateInstance(instance) {
        const live = this.liveInstances.get(instance.id);
        if (live) {
            live.record = instance;
            live.resources.radiusPiId = instance.radiusPiId;
            live.resources.sessionId = instance.sessionId;
        }
        upsertInstance(instance);
    }
    openRpcStream(instanceId, onEvent, onUiRequest) {
        const live = this.liveInstances.get(instanceId);
        const rpcProcess = live ? this.getRpcProcess(live) : undefined;
        if (!live || !rpcProcess) {
            return undefined;
        }
        live.subscribers.add(onEvent);
        live.onUiRequest = onUiRequest;
        return {
            handleRpc: async (command) => {
                const response = await rpcProcess.send(command);
                if (shouldRefreshSessionMetadata(command)) {
                    await this.syncInstanceRecord(live);
                }
                return response;
            },
            handleUiResponse: (response) => {
                rpcProcess.handleUiResponse(response);
            },
            close: () => {
                if (live.onUiRequest === onUiRequest) {
                    live.onUiRequest = undefined;
                }
                live.subscribers.delete(onEvent);
            },
        };
    }
    getLiveInstance(instanceId) {
        const live = this.liveInstances.get(instanceId);
        return live ? cloneInstance(live.record) : undefined;
    }
    listLiveInstances() {
        return [...this.liveInstances.values()].map((live) => cloneInstance(live.record));
    }
    async recoverAfterRestart() {
        const recoveredAt = new Date().toISOString();
        const instances = loadInstances().map((instance) => ({
            ...instance,
            status: instance.status === "online" || instance.status === "starting" ? "stopped" : instance.status,
            lastSeenAt: recoveredAt,
        }));
        for (const instance of instances) {
            await radiusPresence.disconnectPi(instance);
        }
        saveInstances(instances);
    }
    listInstances() {
        return loadInstances().map(cloneInstance);
    }
    getInstance(instanceId) {
        const live = this.liveInstances.get(instanceId);
        if (live) {
            return cloneInstance(live.record);
        }
        const stored = getInstance(instanceId);
        return stored ? cloneInstance(stored) : undefined;
    }
    async spawnInstance(options) {
        const now = new Date().toISOString();
        const live = {
            record: {
                id: randomUUID(),
                status: "starting",
                cwd: options.cwd,
                createdAt: now,
                lastSeenAt: now,
                label: options.label,
            },
            resources: {},
            subscribers: new Set(),
        };
        this.liveInstances.set(live.record.id, live);
        upsertInstance(live.record);
        try {
            const rpcProcess = createRpcProcessInstance({ cwd: options.cwd });
            this.bindRpcProcess(live, rpcProcess);
            await this.syncInstanceRecord(live);
            const registeredRecord = await radiusPresence.registerPi(live.record);
            this.updateRecord(live, { radiusPiId: registeredRecord.radiusPiId });
            this.setStatus(live, "online");
            return cloneInstance(live.record);
        }
        catch (error) {
            return await this.failSpawn(live, error);
        }
    }
    async stopInstance(instanceId) {
        const live = this.liveInstances.get(instanceId);
        if (!live) {
            return undefined;
        }
        this.setStatus(live, "stopping");
        try {
            await this.cleanupAcquiredResources(live);
        }
        finally {
            live.record = {
                ...live.record,
                status: "stopped",
                lastSeenAt: new Date().toISOString(),
            };
            this.liveInstances.delete(instanceId);
            removeInstance(instanceId);
        }
        return cloneInstance(live.record);
    }
    async handleRpc(instanceId, command) {
        const live = this.liveInstances.get(instanceId);
        const rpcProcess = live ? this.getRpcProcess(live) : undefined;
        if (!live || !rpcProcess) {
            return undefined;
        }
        const response = await rpcProcess.send(command);
        if (shouldRefreshSessionMetadata(command)) {
            await this.syncInstanceRecord(live);
        }
        return response;
    }
    async shutdown() {
        for (const instanceId of [...this.liveInstances.keys()]) {
            await this.stopInstance(instanceId);
        }
    }
}
export const supervisor = new ServerSupervisor();
radiusPresence.setCoordinator({
    getLiveInstance(instanceId) {
        return supervisor.getLiveInstance(instanceId);
    },
    listLiveInstances() {
        return supervisor.listLiveInstances();
    },
    updateInstance(instance) {
        supervisor.updateInstance(instance);
    },
});
//# sourceMappingURL=supervisor.js.map