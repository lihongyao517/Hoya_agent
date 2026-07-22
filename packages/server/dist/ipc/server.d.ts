import { type Server } from "node:net";
import type { AgentSessionEvent, RpcExtensionUIRequest, RpcResponse } from "@earendil-works/pi-coding-agent";
import { type ErrorResponse, type ListRequest, type ListResponse, type RpcBridgeResponse, type RpcReadyResponse, type RpcRequest, type RpcStreamRequest, type ServerRequest, type ServerResponse, type SpawnRequest, type SpawnResponse, type StatusRequest, type StatusResponse, type StopRequest, type StopResponse } from "./protocol.ts";
export interface IpcRequestHandler {
    (request: SpawnRequest): Promise<SpawnResponse | ErrorResponse> | SpawnResponse | ErrorResponse;
    (request: ListRequest): Promise<ListResponse | ErrorResponse> | ListResponse | ErrorResponse;
    (request: StopRequest): Promise<StopResponse | ErrorResponse> | StopResponse | ErrorResponse;
    (request: StatusRequest): Promise<StatusResponse | ErrorResponse> | StatusResponse | ErrorResponse;
    (request: RpcRequest): Promise<RpcBridgeResponse | ErrorResponse> | RpcBridgeResponse | ErrorResponse;
    (request: RpcStreamRequest): Promise<RpcReadyResponse | ErrorResponse> | RpcReadyResponse | ErrorResponse;
    (request: ServerRequest): Promise<ServerResponse> | ServerResponse;
    openRpcStream(instanceId: string, onResponse: (response: RpcResponse) => void, onSessionEvent: (event: AgentSessionEvent) => void, onUiRequest: (request: RpcExtensionUIRequest) => void): {
        handleRequest(request: RpcRequest["command"] | {
            type: "extension_ui_response";
        }): Promise<void>;
        close(): void;
    } | undefined;
}
export declare function startIpcServer(handler: IpcRequestHandler): Promise<Server>;
//# sourceMappingURL=server.d.ts.map