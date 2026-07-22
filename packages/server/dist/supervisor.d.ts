import type { AgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import type { InstanceRecord } from "./types.ts";
export declare class ServerSupervisor {
    private readonly liveInstances;
    private setStatus;
    private updateRecord;
    private clearBindings;
    private bindRpcProcess;
    private handleUnexpectedRpcExit;
    private getRpcProcess;
    private syncInstanceRecord;
    private cleanupAcquiredResources;
    private failSpawn;
    updateInstance(instance: InstanceRecord): void;
    openRpcStream(instanceId: string, onEvent: (event: AgentSessionEvent) => void, onUiRequest: (request: RpcExtensionUIRequest) => void): {
        handleRpc(command: RpcCommand): Promise<RpcResponse>;
        handleUiResponse(response: RpcExtensionUIResponse): void;
        close(): void;
    } | undefined;
    getLiveInstance(instanceId: string): InstanceRecord | undefined;
    listLiveInstances(): InstanceRecord[];
    recoverAfterRestart(): Promise<void>;
    listInstances(): InstanceRecord[];
    getInstance(instanceId: string): InstanceRecord | undefined;
    spawnInstance(options: {
        cwd: string;
        label?: string;
    }): Promise<InstanceRecord>;
    stopInstance(instanceId: string): Promise<InstanceRecord | undefined>;
    handleRpc(instanceId: string, command: RpcCommand): Promise<RpcResponse | undefined>;
    shutdown(): Promise<void>;
}
export declare const supervisor: ServerSupervisor;
//# sourceMappingURL=supervisor.d.ts.map