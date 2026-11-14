import { randomUUID } from "node:crypto";
import { collectAllMachines, type MachineRepository } from "../storage/contracts";
import { LangGraphFleetIntelligence } from "../intelligence/fleet-graph";
import type { IntelligenceProvider } from "../intelligence/contracts";
import { createEvent } from "./event-contract";
import { resolveAgent, listAgents } from "./registry";
import { PermanentTaskError, type TaskRecord, type TaskStore, type TaskType } from "./contracts";

export class AgentSupervisor {
  constructor(private readonly store: TaskStore, private readonly machines: MachineRepository, private readonly intelligence: IntelligenceProvider = new LangGraphFleetIntelligence(), private readonly retryDelay: (attempt: number) => Promise<void> = backoff) {}

  agents() { return listAgents(); }

  async submit(input: { taskType: unknown; idempotencyKey?: string; correlationId?: string }) {
    if (input.taskType !== "fleet.recommendations") throw new PermanentTaskError("UNSUPPORTED_TASK", "El tipo de tarea no está disponible.");
    const taskType = input.taskType as TaskType;
    const agent = resolveAgent(taskType);
    const now = new Date().toISOString();
    const task: TaskRecord = {
      taskId: randomUUID(), executionId: randomUUID(), correlationId: input.correlationId?.trim() || randomUUID(),
      taskType, agentId: agent.id, payload: {}, createdAt: now, updatedAt: now, state: "QUEUED", attempts: 0,
      maxAttempts: 3, idempotencyKey: input.idempotencyKey?.trim() || randomUUID(),
    };
    const created = await this.store.create(task, createEvent({ eventType: "AgentTaskRequested", taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { taskType, agentId: agent.id } }));
    if (created.created) {
      await this.store.update(created.task, createEvent({ eventType: "AgentTaskAssigned", taskId: task.taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { agentId: agent.id } }));
      queueMicrotask(() => { void this.execute(task.taskId); });
    }
    return { task: created.task, created: created.created };
  }

  get(taskId: string) { return this.store.get(taskId); }
  list() { return this.store.list(); }
  events(taskId?: string) { return this.store.events(taskId); }

  private async execute(taskId: string) {
    let task = await this.store.get(taskId);
    if (!task || task.state !== "QUEUED") return;
    while (task.attempts < task.maxAttempts) {
      task = { ...task, state: task.attempts ? "RETRYING" : "RUNNING", attempts: task.attempts + 1, updatedAt: new Date().toISOString(), error: undefined };
      await this.store.update(task, createEvent({ eventType: "AgentTaskStarted", taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { attempt: task.attempts, agentId: task.agentId } }));
      try {
        if (task.taskType !== "fleet.recommendations" || task.agentId !== "fleet-intelligence") throw new PermanentTaskError("CAPABILITY_DENIED", "El agente no tiene capacidad autorizada para esta tarea.");
        const result = await this.intelligence.recommend({ machines: await collectAllMachines(this.machines) });
        task = { ...task, state: "SUCCEEDED", result, updatedAt: new Date().toISOString(), error: undefined };
        await this.store.update(task, createEvent({ eventType: "AgentTaskCompleted", taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { agentId: task.agentId, resultCount: result.recommendations.length } }));
        return;
      } catch (error) {
        const permanent = error instanceof PermanentTaskError;
        const message = safeErrorMessage(error);
        const exhausted: boolean = permanent || task.attempts >= task.maxAttempts;
        const failure = { code: error instanceof PermanentTaskError ? error.code : "PROVIDER_FAILURE", message, retryable: !permanent };
        task = { ...task, state: exhausted ? (permanent ? "FAILED" : "DEAD_LETTER") : "RETRYING", updatedAt: new Date().toISOString(), error: failure };
        await this.store.update(task, createEvent({ eventType: "AgentTaskFailed", taskId, executionId: task.executionId, correlationId: task.correlationId, payload: { attempt: task.attempts, code: failure.code, retryable: failure.retryable, state: task.state } }));
        if (exhausted) return;
        await this.retryDelay(task.attempts);
      }
    }
  }
}

function safeErrorMessage(error: unknown) {
  if (error instanceof PermanentTaskError) return error.message;
  return "Falló un proveedor durante la ejecución; revisa los logs protegidos del servicio.";
}
function backoff(attempt: number) { return new Promise<void>((resolve) => setTimeout(resolve, Math.min(100 * 2 ** (attempt - 1), 1000))); }
