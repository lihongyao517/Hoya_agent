import type { InstanceRecord, MachineRecord } from "./types.ts";
export declare function loadMachine(): MachineRecord | undefined;
export declare function saveMachine(machine: MachineRecord): void;
export declare function deleteMachine(): void;
export declare function loadInstances(): InstanceRecord[];
export declare function saveInstances(instances: InstanceRecord[]): void;
export declare function getInstance(instanceId: string): InstanceRecord | undefined;
export declare function upsertInstance(instance: InstanceRecord): void;
export declare function removeInstance(instanceId: string): void;
//# sourceMappingURL=storage.d.ts.map