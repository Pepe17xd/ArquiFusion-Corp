import { readFile } from "node:fs/promises";
import { ValidationError, type Machine, type MachineFilters } from "../core/machine";
import type { MachineRepository, Page } from "./contracts";
import { atomicWriteFile } from "./local-file";

function matches(machine: Machine, filters: MachineFilters): boolean {
  if (filters.status && machine.status !== filters.status) return false;
  if (filters.category && machine.category.toLowerCase() !== filters.category.toLowerCase()) return false;
  if (filters.search) {
    const query = filters.search.toLowerCase();
    if (![machine.machineId, machine.model, machine.category, machine.location].some((v) => v.toLowerCase().includes(query))) return false;
  }
  return true;
}

export class LocalMachineRepository implements MachineRepository {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async all(): Promise<Machine[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Local machine data must be a JSON array");
      // Legacy local records predate tenant isolation; keep them inside the explicit local demo tenant.
      return (parsed as Array<Machine & { tenantId?: string }>).map((machine) => ({ ...machine, tenantId: machine.tenantId || "local-demo" }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async upsert(machine: Machine): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const machines = await this.all();
      const index = machines.findIndex((item) => item.tenantId === machine.tenantId && item.machineId === machine.machineId);
      if (index >= 0) machines[index] = machine;
      else machines.push(machine);
      await atomicWriteFile(this.file, JSON.stringify(machines, null, 2), 0o600);
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async list(tenantId: string, limit: number, cursor?: string, filters: MachineFilters = {}): Promise<Page<Machine>> {
    const matching = (await this.all()).filter((machine) => machine.tenantId === tenantId && matches(machine, filters)).sort((a, b) => a.machineId.localeCompare(b.machineId));
    const cursorIndex = cursor ? matching.findIndex((machine) => machine.machineId === cursor) : -1;
    if (cursor && cursorIndex < 0) throw new ValidationError(["Invalid pagination cursor"]);
    const index = cursor ? cursorIndex + 1 : 0;
    const start = Math.max(index, 0);
    const items = matching.slice(start, start + limit);
    return { items, nextCursor: start + limit < matching.length ? items.at(-1)?.machineId : undefined };
  }

  async get(tenantId: string, machineId: string): Promise<Machine | undefined> {
    return (await this.all()).find((machine) => machine.tenantId === tenantId && machine.machineId === machineId);
  }
}
