import { supervisor } from "./supervisor.js";
function toInstanceSummary(instance) {
    return {
        id: instance.id,
        status: instance.status,
        cwd: instance.cwd,
        label: instance.label,
        sessionId: instance.sessionId,
        sessionFile: instance.sessionFile,
        radiusPiId: instance.radiusPiId,
    };
}
function unknownInstanceError(instanceId) {
    return {
        type: "error",
        ok: false,
        error: `Unknown instance: ${instanceId}`,
    };
}
export async function handleIpcRequest(request) {
    switch (request.type) {
        case "spawn": {
            const instance = await supervisor.spawnInstance({
                cwd: request.cwd,
                label: request.label,
            });
            return {
                type: "spawn_result",
                ok: true,
                instance: toInstanceSummary(instance),
            };
        }
        case "list": {
            return {
                type: "list_result",
                ok: true,
                instances: supervisor.listInstances().map(toInstanceSummary),
            };
        }
        case "status": {
            const instance = supervisor.getInstance(request.instanceId);
            if (!instance) {
                return unknownInstanceError(request.instanceId);
            }
            return {
                type: "status_result",
                ok: true,
                instance: toInstanceSummary(instance),
            };
        }
        case "stop": {
            const instance = await supervisor.stopInstance(request.instanceId);
            if (!instance) {
                return unknownInstanceError(request.instanceId);
            }
            return {
                type: "stop_result",
                ok: true,
                instanceId: request.instanceId,
            };
        }
        case "rpc": {
            const response = await supervisor.handleRpc(request.instanceId, request.command);
            if (!response) {
                return unknownInstanceError(request.instanceId);
            }
            return {
                type: "rpc_result",
                ok: true,
                response,
            };
        }
        case "rpc_stream": {
            const instance = supervisor.getInstance(request.instanceId);
            if (!instance) {
                return unknownInstanceError(request.instanceId);
            }
            return {
                type: "rpc_ready",
                ok: true,
                instance: toInstanceSummary(instance),
            };
        }
    }
}
export function openRpcStream(instanceId, onResponse, onSessionEvent, onUiRequest) {
    const handle = supervisor.openRpcStream(instanceId, onSessionEvent, onUiRequest);
    if (!handle) {
        return undefined;
    }
    return {
        async handleRequest(request) {
            if (request.type === "extension_ui_response") {
                handle.handleUiResponse(request);
                return;
            }
            const response = await handle.handleRpc(request);
            onResponse(response);
        },
        close() {
            handle.close();
        },
    };
}
//# sourceMappingURL=handler.js.map