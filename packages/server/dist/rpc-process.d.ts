import { type ChildProcess } from "node:child_process";
import type { AgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
export declare class RpcProcessInstance {
    readonly process: ChildProcess;
    private exited;
    private nextRequestId;
    private stdoutBuffer;
    private stderrBuffer;
    private readonly pendingRequests;
    private readonly eventListeners;
    private readonly exitListeners;
    private uiRequestHandler;
    constructor(options: {
        cwd: string;
    });
    private getSpawnCommand;
    private attachListeners;
    private handleLine;
    private rejectAllPending;
    private notifyExit;
    send(command: RpcCommand): Promise<RpcResponse>;
    handleUiResponse(response: RpcExtensionUIResponse): void;
    setUiRequestHandler(handler?: (request: RpcExtensionUIRequest) => void): void;
    onEvent(listener: (event: AgentSessionEvent) => void): () => void;
    onExit(listener: (error?: Error) => void): () => void;
    dispose(): Promise<void>;
}
export declare function createRpcProcessInstance(options: {
    cwd: string;
}): RpcProcessInstance;
//# sourceMappingURL=rpc-process.d.ts.map