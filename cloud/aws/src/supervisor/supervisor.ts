import { randomUUID } from "node:crypto";
import { collectAllMachines, type MachineRepository } from "../storage/contracts";
import { LangGraphFleetIntelligence } from "../intelligence/fleet-graph";
import type { IntelligenceProvider } from "../intelligence/contracts";
import { createEvent } from "./event-contract";
import { resolveAgent, listAgents } from "./registry";
import { PermanentTaskError, TaskConflictError, type TaskDispatcher, type TaskRecord, type TaskStore, type TaskType } from "./contracts";
import { isTerminalTaskState } from "./task-state";

/** Lambda is capped at 300s; the lease allows the platform a small timeout margin. */
export const TASK_CLAIM_LEASE_MS = 315_000;

export class AgentSupervisor {
  private readonly activeExecutions = new Set<string>();
  constructor(private readonly store: TaskStore, private readonly machines: MachineRepository, private readonly intelligence: IntelligenceProvider = new LangGraphFleetIntelligence(), private readonly retryDelay: (attempt: number) => Promise<void> = backoff, private readonly dispatcher?: TaskDispatcher, private readonly notify?: (task: TaskRecord) => Promise<void>) {}
  private async alert(task: TaskRecord) {
    try { await this.notify?.(task); } catch { /* an alert failure must never change task state */ }
  }
  agents() { return listAgents(); }

  async submit(input: { tenantId: string; taskType: unknown; idempotencyKey?: string; correlationId?: string }) {
    if (input.taskType !== "fleet.recommendations") throw new PermanentTaskError("UNSUPPORTED_TASK", "El tipo de tarea no esta disponible.");
    const taskType = input.taskType as TaskType;
    const agent = resolveAgent(taskType);
    const now = new Date().toISOString();
    const task: TaskRecord = {
      tenantId: input.tenantId,
      taskId: randomUUID(), executionId: randomUUID(), correlationId: input.correlationId?.trim() || randomUUID(),
      taskType, agentId: agent.id, payload: {}, createdAt: now, updatedAt: now, state: "QUEUED", attempts: 0,
      version: 1, maxAttempts: 3, idempotencyKey: input.idempotencyKey?.trim() || randomUUID(),
    };
    const created = await this.store.create(task, createEvent({ eventType: "AgentTaskRequested", tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { taskType, agentId: agent.id } }));
    if (!created.created) return { task: created.task, created: false };

    let persisted = await this.store.update(created.task, createEvent({ eventType: "AgentTaskAssigned", tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { agentId: agent.id } }));
    if (this.dispatcher) {
      try { await this.dispatcher.dispatch({ tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId }); }
      catch {
        persisted = await this.store.update({ ...persisted, state: "FAILED", updatedAt: new Date().toISOString(), error: { code: "DISPATCH_FAILURE", message: "No se pudo iniciar el workflow durable.", retryable: false } }, createEvent({ eventType: "AgentTaskFailed", tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { code: "DISPATCH_FAILURE", state: "FAILED" } }));
        console.error(JSON.stringify({ event: "workflow.dispatch.failed", tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, errorCode: "DISPATCH_FAILURE" }));
        return { task: persisted, created: true };
      }
    } else queueMicrotask(() => { void this.execute(task.tenantId, task.taskId, randomUUID()); });
    return { task: persisted, created: true };
  }

  get(tenantId: string, taskId: string) { return this.store.get(tenantId, taskId); }
  list(tenantId: string) { return this.store.list(tenantId); }
  events(tenantId: string, taskId?: string) { return this.store.events(tenantId, taskId); }

  async markWorkflowFailure(input: { tenantId: string; taskId: string; executionId: string; correlationId: string }) {
    const task = await this.store.get(input.tenantId, input.taskId);
    if (task && (task.executionId !== input.executionId || task.correlationId !== input.correlationId)) throw new PermanentTaskError("WORKFLOW_CONTEXT_MISMATCH", "El contexto de ejecucion no coincide con la tarea persistida.");
    if (!task || isTerminalTaskState(task.state)) return task;
    // A late failure callback cannot overwrite a worker that still owns a live lease.
    if (task.claim && task.claim.leaseExpiresAt > Date.now()) return task;
    const updated = await this.store.update({ ...task, state: "DEAD_LETTER", updatedAt: new Date().toISOString(), error: { code: "WORKFLOW_FAILURE", message: "El workflow durable termino sin completar la tarea.", retryable: false } }, createEvent({ eventType: "AgentTaskFailed", tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { code: "WORKFLOW_FAILURE", state: "DEAD_LETTER" } }));
    await this.alert(updated);
    return updated;
  }

  private async execute(tenantId: string, taskId: string, workerId: string) {
    try { await this.executeTask(tenantId, taskId, workerId); }
    catch (error) { console.error(JSON.stringify({ event: "supervisor.execution.failed", tenantId, taskId, errorName: error instanceof Error ? error.name : "UnknownError", code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined })); }
  }

  async executeTask(tenantId: string, taskId: string, workerId: string = randomUUID()) {
    if (this.activeExecutions.has(taskId)) return;
    this.activeExecutions.add(taskId);
    try { await this.run(tenantId, taskId, workerId); }
    finally { this.activeExecutions.delete(taskId); }
  }

  private async run(tenantId: string, taskId: string, workerId: string) {
    let task = await this.store.get(tenantId, taskId);
    if (!task || isTerminalTaskState(task.state)) return;
    if (task.attempts >= task.maxAttempts) {
      const failure = { code: "ATTEMPTS_EXHAUSTED", message: "Se agotaron los intentos de ejecucion.", retryable: false };
      await this.store.update({ ...task, state: "DEAD_LETTER", updatedAt: new Date().toISOString(), error: failure }, createEvent({ eventType: "AgentTaskFailed", tenantId, taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { code: failure.code, state: "DEAD_LETTER" } }));
      return;
    }
    while (task.attempts < task.maxAttempts) {
      let claim: Awaited<ReturnType<TaskStore["claim"]>>;
      try { claim = await this.store.claim({ tenantId, taskId, executionId: task.executionId, workerId, now: Date.now(), leaseDurationMs: TASK_CLAIM_LEASE_MS }); }
      catch (error) { if (error instanceof TaskConflictError && error.code === "CLAIM_CONFLICT") return; throw error; }
      if (!claim.acquired) return;
      task = claim.task;
      let result: Awaited<ReturnType<IntelligenceProvider["recommend"]>>;
      try {
        if (task.taskType !== "fleet.recommendations" || task.agentId !== "fleet-intelligence") throw new PermanentTaskError("CAPABILITY_DENIED", "El agente no tiene capacidad autorizada para esta tarea.");
        result = await this.intelligence.recommend({
          machines: await collectAllMachines(this.machines, task.tenantId),
          context: { tenantId: task.tenantId, taskId, executionId: task.executionId, correlationId: task.correlationId },
        });
      } catch (error) {
        const permanent = error instanceof PermanentTaskError;
        const message = safeErrorMessage(error);
        const exhausted = permanent || task.attempts >= task.maxAttempts;
        const state: TaskRecord["state"] = exhausted ? (permanent ? "FAILED" : "DEAD_LETTER") : "RETRYING";
        const failure = { code: error instanceof PermanentTaskError ? error.code : "PROVIDER_FAILURE", message, retryable: !permanent };
        task = await this.store.update({ ...task, state, updatedAt: new Date().toISOString(), error: failure }, createEvent({ eventType: "AgentTaskFailed", tenantId: task.tenantId, taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { attempt: task.attempts, code: failure.code, retryable: failure.retryable, state } }));
        if (exhausted) { await this.alert(task); return; }
        await this.retryDelay(task.attempts);
        continue;
      }
      await this.store.update({ ...task, state: "SUCCEEDED", result, updatedAt: new Date().toISOString(), error: undefined }, createEvent({ eventType: "AgentTaskCompleted", tenantId: task.tenantId, taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { agentId: task.agentId, resultCount: result.recommendations.length } }));
      return;
    }
  }
}

function safeErrorMessage(error: unknown) {
  if (error instanceof PermanentTaskError) return error.message;
  return "Fallo un proveedor durante la ejecucion; revisa los logs protegidos del servicio.";
}
function backoff(attempt: number) { return new Promise<void>((resolve) => setTimeout(resolve, Math.min(100 * 2 ** (attempt - 1), 1000))); }
