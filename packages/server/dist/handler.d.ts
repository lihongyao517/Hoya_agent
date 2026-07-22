import type { AgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import type { ErrorResponse, ListRequest, ListResponse, RpcBridgeResponse, RpcReadyResponse, RpcRequest, RpcStreamRequest, ServerRequest, ServerResponse, SpawnRequest, SpawnResponse, StatusRequest, StatusResponse, StopRequest, StopResponse } from "./ipc/protocol.ts";
export declare function handleIpcRequest(request: SpawnRequest): Promise<SpawnResponse | ErrorResponse>;
export declare function handleIpcRequest(request: ListRequest): Promise<ListResponse | ErrorResponse>;
export declare function handleIpcRequest(request: StopRequest): Promise<StopResponse | ErrorResponse>;
export declare function handleIpcRequest(request: StatusRequest): Promise<StatusResponse | ErrorResponse>;
export declare function handleIpcRequest(request: RpcRequest): Promise<RpcBridgeResponse | ErrorResponse>;
export declare function handleIpcRequest(request: RpcStreamRequest): Promise<RpcReadyResponse | ErrorResponse>;
export declare function handleIpcRequest(request: ServerRequest): Promise<ServerResponse>;
export declare function openRpcStream(instanceId: string, onResponse: (response: RpcResponse) => void, onSessionEvent: (event: AgentSessionEvent) => void, onUiRequest: (request: RpcExtensionUIRequest) => void): {
    handleRequest(request: RpcCommand | RpcExtensionUIResponse): Promise<void>;
    close(): void;
} | undefined;
//# sourceMappingURL=handler.d.ts.map