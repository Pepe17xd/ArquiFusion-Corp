import type { AgentEvent, TaskRecord, TaskState } from "./contracts";
import { TaskConflictError } from "./contracts";

const transitions: Record<TaskState, readonly TaskState[]> = {
  PENDING: ["QUEUED", "FAILED", "DEAD_LETTER"],
  QUEUED: ["QUEUED", "RUNNING", "FAILED", "DEAD_LETTER"],
  RUNNING: ["RUNNING", "RETRYING", "SUCCEEDED", "FAILED", "DEAD_LETTER"],
  RETRYING: ["RUNNING", "FAILED", "DEAD_LETTER"],
  SUCCEEDED: [], FAILED: [], DEAD_LETTER: [],
};

export function normalizeTask(task: TaskRecord): TaskRecord {
  const version = (task as TaskRecord & { version?: number }).version;
  if (version === undefined) return { ...task, version: 1 };
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Persisted task has an invalid version");
  return task;
}

export function createTaskUpdate(current: TaskRecord, candidate: TaskRecord, event: AgentEvent): { task: TaskRecord; event: AgentEvent } {
  const currentTask = normalizeTask(current);
  if (candidate.version !== currentTask.version) throw new TaskConflictError("VERSION_CONFLICT", "Task version changed; reload before updating");
  if (candidate.tenantId !== currentTask.tenantId || candidate.taskId !== currentTask.taskId || candidate.executionId !== currentTask.executionId || candidate.idempotencyKey !== currentTask.idempotencyKey) {
    throw new TaskConflictError("INVALID_TRANSITION", "Task identity fields are immutable");
  }
  if (!transitions[currentTask.state].includes(candidate.state)) throw new TaskConflictError("INVALID_TRANSITION", `Invalid task state transition ${currentTask.state} -> ${candidate.state}`);
  if (currentTask.state === "QUEUED" && candidate.state === "QUEUED" && event.eventType !== "AgentTaskAssigned") {
    throw new TaskConflictError("INVALID_TRANSITION", "QUEUED may only remain QUEUED for its assignment event");
  }
  if (currentTask.state === "RUNNING" && candidate.state === "RUNNING" && event.eventType !== "AgentTaskStarted") {
    throw new TaskConflictError("INVALID_TRANSITION", "RUNNING may only remain RUNNING while recovering an expired claim");
  }
  if (event.tenantId !== currentTask.tenantId || event.taskId !== currentTask.taskId || event.executionId !== currentTask.executionId || event.correlationId !== currentTask.correlationId) {
    throw new TaskConflictError("INVALID_TRANSITION", "Task event context does not match the task");
  }
  const nextVersion = currentTask.version + 1;
  const task = normalizeTask({ ...candidate, version: nextVersion, claim: candidate.state === "RUNNING" ? candidate.claim : undefined });
  const stableEvent: AgentEvent = { ...event, eventId: `${currentTask.taskId}:v${nextVersion}:${event.eventType}` };
  return { task, event: stableEvent };
}

export function assertClaimable(current: TaskRecord, input: { executionId: string; workerId: string; now: number; leaseDurationMs: number }): { task: TaskRecord; event: AgentEvent } | "already-claimed" {
  const task = normalizeTask(current);
  if (task.executionId !== input.executionId) throw new TaskConflictError("VERSION_CONFLICT", "Workflow execution does not match the task");
  if (!input.workerId || !Number.isFinite(input.now) || !Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) throw new TaskConflictError("INVALID_TRANSITION", "Invalid worker claim parameters");
  if (task.state === "RUNNING" && task.claim?.workerId === input.workerId && task.claim.executionId === input.executionId && task.claim.leaseExpiresAt > input.now) return "already-claimed";
  if (task.claim && task.claim.leaseExpiresAt > input.now) throw new TaskConflictError("CLAIM_CONFLICT", "Task is already claimed by another active worker");
  const recoveringExpiredClaim = task.state === "RUNNING" && Boolean(task.claim && task.claim.leaseExpiresAt <= input.now);
  if (!(task.state === "QUEUED" || task.state === "RETRYING" || recoveringExpiredClaim)) throw new TaskConflictError("INVALID_TRANSITION", `Task in ${task.state} cannot be claimed`);
  if (task.attempts >= task.maxAttempts) throw new TaskConflictError("INVALID_TRANSITION", "Task has exhausted its execution attempts");
  const next: TaskRecord = {
    ...task,
    state: "RUNNING",
    attempts: task.attempts + 1,
    updatedAt: new Date(input.now).toISOString(),
    claim: { workerId: input.workerId, executionId: input.executionId, leaseExpiresAt: input.now + input.leaseDurationMs },
    error: undefined,
  };
  const event: AgentEvent = {
    tenantId: task.tenantId,
    taskId: task.taskId,
    executionId: task.executionId,
    correlationId: task.correlationId,
    eventId: "pending",
    eventType: "AgentTaskStarted",
    schemaVersion: "1.0",
    timestamp: new Date(input.now).toISOString(),
    source: "arquifusion-supervisor",
    payload: { attempt: next.attempts, workerId: input.workerId, recoveredClaim: recoveringExpiredClaim },
  };
  const updated = createTaskUpdate(task, next, event);
  return updated;
}

export function isTerminalTaskState(state: TaskState) { return state === "SUCCEEDED" || state === "FAILED" || state === "DEAD_LETTER"; }
