import { randomUUID } from "node:crypto";
import { collectAllMachines, type MachineRepository } from "../storage/contracts";
import { LangGraphFleetIntelligence } from "../intelligence/fleet-graph";
import type { IntelligenceProvider } from "../intelligence/contracts";
import { createEvent } from "./event-contract";
import { resolveAgent, listAgents } from "./registry";
import { PermanentTaskError, type TaskDispatcher, type TaskRecord, type TaskStore, type TaskType } from "./contracts";

export class AgentSupervisor {
  private readonly activeExecutions = new Set<string>();
  constructor(private readonly store: TaskStore, private readonly machines: MachineRepository, private readonly intelligence: IntelligenceProvider = new LangGraphFleetIntelligence(), private readonly retryDelay: (attempt: number) => Promise<void> = backoff, private readonly dispatcher?: TaskDispatcher) {}

  agents() { return listAgents(); }

  async submit(input: { tenantId: string; taskType: unknown; idempotencyKey?: string; correlationId?: string }) {
    if (input.taskType !== "fleet.recommendations") throw new PermanentTaskError("UNSUPPORTED_TASK", "El tipo de tarea no está disponible.");
    const taskType = input.taskType as TaskType;
    const agent = resolveAgent(taskType);
    const now = new Date().toISOString();
    const task: TaskRecord = {
      tenantId: input.tenantId,
      taskId: randomUUID(), executionId: randomUUID(), correlationId: input.correlationId?.trim() || randomUUID(),
      taskType, agentId: agent.id, payload: {}, createdAt: now, updatedAt: now, state: "QUEUED", attempts: 0,
      maxAttempts: 3, idempotencyKey: input.idempotencyKey?.trim() || randomUUID(),
    };
    const created = await this.store.create(task, createEvent({ eventType: "AgentTaskRequested", tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { taskType, agentId: agent.id } }));
    if (created.created) {
      await this.store.update(created.task, createEvent({ eventType: "AgentTaskAssigned", tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { agentId: agent.id } }));
      if (this.dispatcher) {
        try { await this.dispatcher.dispatch({ tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId }); }
        catch {
          const failed = { ...created.task, state: "FAILED" as const, updatedAt: new Date().toISOString(), error: { code: "DISPATCH_FAILURE", message: "No se pudo iniciar el workflow durable.", retryable: false } };
          await this.store.update(failed, createEvent({ eventType: "AgentTaskFailed", tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { code: "DISPATCH_FAILURE", state: "FAILED" } }));
          console.error(JSON.stringify({ event: "workflow.dispatch.failed", tenantId: task.tenantId, taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, errorCode: "DISPATCH_FAILURE" }));
          return { task: failed, created: true };
        }
      } else queueMicrotask(() => { void this.execute(task.tenantId, task.taskId); });
    }
    return { task: created.task, created: created.created };
  }

  get(tenantId: string, taskId: string) { return this.store.get(tenantId, taskId); }
  list(tenantId: string) { return this.store.list(tenantId); }
  events(tenantId: string, taskId?: string) { return this.store.events(tenantId, taskId); }

  async markWorkflowFailure(input: { tenantId: string; taskId: string; executionId: string; correlationId: string }) {
    const task = await this.store.get(input.tenantId, input.taskId);
    if (task && (task.executionId !== input.executionId || task.correlationId !== input.correlationId)) throw new PermanentTaskError("WORKFLOW_CONTEXT_MISMATCH", "El contexto de ejecución no coincide con la tarea persistida.");
    if (!task || ["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(task.state)) return task;
    const failed: TaskRecord = { ...task, state: "DEAD_LETTER", updatedAt: new Date().toISOString(), error: { code: "WORKFLOW_FAILURE", message: "El workflow durable terminó sin completar la tarea.", retryable: false } };
    await this.store.update(failed, createEvent({ eventType: "AgentTaskFailed", tenantId: failed.tenantId, taskId: failed.taskId, executionId: failed.executionId, correlationId: failed.correlationId, payload: { code: "WORKFLOW_FAILURE", state: "DEAD_LETTER" } }));
    return failed;
  }

  private async execute(tenantId: string, taskId: string) {
    try { await this.executeTask(tenantId, taskId); }
    catch (error) { console.error(JSON.stringify({ event: "supervisor.execution.failed", tenantId, taskId, errorName: error instanceof Error ? error.name : "UnknownError", code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined })); }
  }

  async executeTask(tenantId: string, taskId: string) {
    if (this.activeExecutions.has(taskId)) return;
    this.activeExecutions.add(taskId);
    try { await this.run(tenantId, taskId); }
    finally { this.activeExecutions.delete(taskId); }
  }

  private async run(tenantId: string, taskId: string) {
    let task = await this.store.get(tenantId, taskId);
    if (!task || ["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(task.state)) return;
    if (task.attempts >= task.maxAttempts) {
      const failure = { code: "ATTEMPTS_EXHAUSTED", message: "Se agotaron los intentos de ejecución.", retryable: false };
      task = { ...task, state: "DEAD_LETTER", updatedAt: new Date().toISOString(), error: failure };
      await this.store.update(task, createEvent({ eventType: "AgentTaskFailed", tenantId, taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { code: failure.code, state: task.state } }));
      return;
    }
    while (task.attempts < task.maxAttempts) {
      task = { ...task, state: task.attempts ? "RETRYING" : "RUNNING", attempts: task.attempts + 1, updatedAt: new Date().toISOString(), error: undefined };
      await this.store.update(task, createEvent({ eventType: "AgentTaskStarted", tenantId: task.tenantId, taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { attempt: task.attempts, agentId: task.agentId } }));
      let result: Awaited<ReturnType<IntelligenceProvider["recommend"]>>;
      try {
        if (task.taskType !== "fleet.recommendations" || task.agentId !== "fleet-intelligence") throw new PermanentTaskError("CAPABILITY_DENIED", "El agente no tiene capacidad autorizada para esta tarea.");
        result = await this.intelligence.recommend({ machines: await collectAllMachines(this.machines, task.tenantId) });
      } catch (error) {
        const permanent = error instanceof PermanentTaskError;
        const message = safeErrorMessage(error);
        const exhausted: boolean = permanent || task.attempts >= task.maxAttempts;
        const failure = { code: error instanceof PermanentTaskError ? error.code : "PROVIDER_FAILURE", message, retryable: !permanent };
        task = { ...task, state: exhausted ? (permanent ? "FAILED" : "DEAD_LETTER") : "RETRYING", updatedAt: new Date().toISOString(), error: failure };
        await this.store.update(task, createEvent({ eventType: "AgentTaskFailed", tenantId: task.tenantId, taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { attempt: task.attempts, code: failure.code, retryable: failure.retryable, state: task.state } }));
        if (exhausted) return;
        await this.retryDelay(task.attempts);
        continue;
      }
      task = { ...task, state: "SUCCEEDED", result, updatedAt: new Date().toISOString(), error: undefined };
      await this.store.update(task, createEvent({ eventType: "AgentTaskCompleted", tenantId: task.tenantId, taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { agentId: task.agentId, resultCount: result.recommendations.length } }));
      return;
    }
  }

}

function safeErrorMessage(error: unknown) {
  if (error instanceof PermanentTaskError) return error.message;
  return "Falló un proveedor durante la ejecución; revisa los logs protegidos del servicio.";
}
function backoff(attempt: number) { return new Promise<void>((resolve) => setTimeout(resolve, Math.min(100 * 2 ** (attempt - 1), 1000))); }
