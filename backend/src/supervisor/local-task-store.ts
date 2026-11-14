import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentEvent, TaskRecord, TaskStore } from "./contracts";
import { validateEvent } from "./event-contract";

interface StoreData { tasks: TaskRecord[]; events: AgentEvent[] }

/** Single-process local adapter; it is intentionally not presented as SQS/DynamoDB. */
export class LocalTaskStore implements TaskStore {
  private readonly path: string;
  private pending: Promise<void> = Promise.resolve();
  constructor(path = resolve(process.env.SUPERVISOR_DATA_FILE || resolve(__dirname, "../../data/supervisor.json"))) { this.path = resolve(path); }

  async create(task: TaskRecord, event: AgentEvent) {
    return this.serial(async () => {
      const data = await this.read();
      const existing = data.tasks.find((item) => item.idempotencyKey === task.idempotencyKey);
      if (existing) return { task: existing, created: false };
      data.tasks.push(task); data.events.push(event); await this.write(data);
      return { task, created: true };
    });
  }
  async get(taskId: string) { return (await this.read()).tasks.find((task) => task.taskId === taskId); }
  async list() { return (await this.read()).tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async events(taskId?: string) { const events = (await this.read()).events; return taskId ? events.filter((event) => event.taskId === taskId) : events; }
  async update(task: TaskRecord, event: AgentEvent) {
    return this.serial(async () => {
      const data = await this.read();
      const index = data.tasks.findIndex((item) => item.taskId === task.taskId);
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
      if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.events) || parsed.events.some((event) => !validateEvent(event))) throw new Error("Invalid supervisor state file");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tasks: [], events: [] };
      throw error;
    }
  }
  private async write(data: StoreData) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
