import type { InstanceRecord, MachineRecord } from "./types.ts";
interface RadiusPresenceCoordinator {
    getLiveInstance(instanceId: string): InstanceRecord | undefined;
    listLiveInstances(): InstanceRecord[];
    updateInstance(instance: InstanceRecord): void;
}
export declare function getRadiusUrl(): string;
export declare function getRadiusServerBaseUrl(): string;
export declare function getRadiusAccessToken(): string;
export declare function isRadiusEnabled(): boolean;
export declare class RadiusPresence {
    private machineHeartbeatTimer?;
    private machineHeartbeatIntervalMs;
    private machineConsecutiveNotFoundCount;
    private machineTransientFailureCount;
    private readonly piHeartbeatStates;
    private machine?;
    private coordinator?;
    setCoordinator(coordinator: RadiusPresenceCoordinator): void;
    start(label?: string): Promise<MachineRecord | undefined>;
    stop(): Promise<void>;
    registerPi(instance: InstanceRecord): Promise<InstanceRecord>;
    disconnectPi(instance: InstanceRecord): Promise<void>;
    private registerMachine;
    private startMachineHeartbeat;
    private scheduleMachineHeartbeat;
    private startPiHeartbeat;
    private schedulePiHeartbeat;
    private heartbeatMachine;
    private heartbeatPi;
    private reRegisterMachineAndPis;
    private reRegisterPi;
}
export declare const radiusPresence: RadiusPresence;
export {};
//# sourceMappingURL=radius.d.ts.map