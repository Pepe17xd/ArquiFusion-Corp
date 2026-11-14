import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentEvent, TaskRecord, TaskStore } from "./contracts";
import { validateEvent } from "./event-contract";
import { atomicWriteFile } from "../storage/local-file";

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
      if (existing) return { task: existing, created: false };
      data.tasks.push(task); data.events.push(event); await this.write(data);
      return { task, created: true };
    });
  }
  async get(tenantId: string, taskId: string) { return (await this.read()).tasks.find((task) => task.tenantId === tenantId && task.taskId === taskId); }
  async list(tenantId: string) { return (await this.read()).tasks.filter((task) => task.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async events(tenantId: string, taskId?: string) { const events = (await this.read()).events.filter((event) => event.tenantId === tenantId); return taskId ? events.filter((event) => event.taskId === taskId) : events; }
  async update(task: TaskRecord, event: AgentEvent) {
    return this.serial(async () => {
      const data = await this.read();
      const index = data.tasks.findIndex((item) => item.tenantId === task.tenantId && item.taskId === task.taskId);
      if (index < 0) throw new Error("Task not found");
      data.tasks[index] = task; data.events.push(event); await this.write(data);
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
        tasks: parsed.tasks.map((task) => ({ ...task, tenantId: task.tenantId || "local-demo" })),
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
