import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentEvent, TaskRecord, TaskStore } from "./contracts";
import { validateEvent } from "./event-contract";
import { atomicWriteFile } from "../storage/local-file";
import { assertClaimable, createTaskUpdate, normalizeTask } from "./task-state";
import { TaskConflictError } from "./contracts";

interface StoreData { tasks: TaskRecord[]; events: AgentEvent[] }

/** Single-process local adapter; it is intentionally not presented as SQS/DynamoDB. */
export class LocalTaskStore implements TaskStore {
  private readonly path: string;
  private pending: Promise<void> = Promise.resolve();
  constructor(path = resolve(process.env.SUPERVISOR_DATA_FILE || resolve(__dirname, "../../data/supervisor.json"))) { this.path = resolve(path); }

  async create(task: TaskRecord, event: AgentEvent) {
    return this.serial(async () => {
      const data = await this.read();
      const existing = data.tasks.find((item) => item.tenantId === task.tenantId && item.idempotencyKey === task.idempotencyKey);
      if (existing) return { task: normalizeTask(existing), created: false };
      const normalized = normalizeTask(task);
      data.tasks.push(normalized); data.events.push(event); await this.write(data);
      return { task: normalized, created: true };
    });
  }
  async get(tenantId: string, taskId: string) { const task = (await this.read()).tasks.find((item) => item.tenantId === tenantId && item.taskId === taskId); return task ? normalizeTask(task) : undefined; }
  async list(tenantId: string) { return (await this.read()).tasks.filter((task) => task.tenantId === tenantId).map(normalizeTask).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async events(tenantId: string, taskId?: string) { const events = (await this.read()).events.filter((event) => event.tenantId === tenantId); return taskId ? events.filter((event) => event.taskId === taskId) : events; }
  async update(task: TaskRecord, event: AgentEvent) {
    return this.serial(async () => {
      const data = await this.read();
      const index = data.tasks.findIndex((item) => item.tenantId === task.tenantId && item.taskId === task.taskId);
      if (index < 0) throw new TaskConflictError("TASK_NOT_FOUND", "Task not found");
      const current = normalizeTask(data.tasks[index]);
      const eventId = `${task.taskId}:v${task.version + 1}:${event.eventType}`;
      const priorEvent = data.events.find((item) => item.eventId === eventId);
      if (priorEvent) {
        if (!sameTransition(priorEvent, event)) throw new TaskConflictError("VERSION_CONFLICT", "Transition id was already used with different event data");
        return current;
      }
      const updated = createTaskUpdate(current, task, event);
      data.tasks[index] = updated.task;
      data.events.push(updated.event);
      await this.write(data);
      return updated.task;
    });
  }

  async claim(input: { tenantId: string; taskId: string; executionId: string; workerId: string; now: number; leaseDurationMs: number }) {
    return this.serial(async () => {
      const data = await this.read();
      const index = data.tasks.findIndex((task) => task.tenantId === input.tenantId && task.taskId === input.taskId);
      if (index < 0) throw new TaskConflictError("TASK_NOT_FOUND", "Task not found");
      const current = normalizeTask(data.tasks[index]);
      const claim = assertClaimable(current, input);
      if (claim === "already-claimed") return { task: current, acquired: false };
      data.tasks[index] = claim.task;
      if (!data.events.some((event) => event.eventId === claim.event.eventId)) data.events.push(claim.event);
      await this.write(data);
      return { task: claim.task, acquired: true };
    });
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolvePending) => { release = resolvePending; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  private async read(): Promise<StoreData> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as StoreData;
      if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.events)) throw new Error("Invalid supervisor state file");
      const normalized = {
        tasks: parsed.tasks.map((task) => normalizeTask({ ...task, tenantId: task.tenantId || "local-demo" })),
        events: parsed.events.map((event) => ({ ...event, tenantId: event.tenantId || "local-demo" })),
      };
      if (normalized.events.some((event) => !validateEvent(event))) throw new Error("Invalid supervisor state file");
      return normalized as StoreData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tasks: [], events: [] };
      throw error;
    }
  }
  private async write(data: StoreData) {
    await atomicWriteFile(this.path, JSON.stringify(data));
  }
}

function sameTransition(left: AgentEvent, right: AgentEvent) {
  return left.eventType === right.eventType && left.tenantId === right.tenantId && left.taskId === right.taskId
    && left.executionId === right.executionId && left.correlationId === right.correlationId
    && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}
