// Backward-compatible domain entry point; the shared contract lives in Core.
export { MACHINE_STATUSES as statuses, normalizeMachine as normalize, ValidationError } from "../core/machine";
export type { Machine, MachineStatus as Status } from "../core/machine";
