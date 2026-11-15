import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../storage/local-file";
import { DuplicateOperationalRecordError, OperationalConflictError, type OperationalEntityType, type OperationalPage, type OperationalRecord, type OperationalRepository } from "./contracts";
import { ValidationError } from "../core/machine";

export class LocalOperationalRepository implements OperationalRepository {
  private writeChain: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  private async all(): Promise<OperationalRecord[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(value)) throw new Error("Operational data must be a JSON array");
      return value as OperationalRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(tenantId: string, entityType: OperationalEntityType, entityId: string) {
    return (await this.all()).find((item) => item.tenantId === tenantId && item.entityType === entityType && item.entityId === entityId);
  }

  async createMany(records: OperationalRecord[]): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const items = await this.all();
      const known = new Set(items.map((item) => `${item.tenantId}\u0000${item.entityType}\u0000${item.entityId}`));
      const incoming = new Set<string>();
      for (const item of records) {
        const key = `${item.tenantId}\u0000${item.entityType}\u0000${item.entityId}`;
        if (known.has(key) || incoming.has(key)) throw new DuplicateOperationalRecordError();
        incoming.add(key);
      }
      await atomicWriteFile(this.file, JSON.stringify([...items, ...records], null, 2), 0o600);
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async save(record: OperationalRecord, expectedVersion: number | null): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const items = await this.all();
      const index = items.findIndex((item) => item.tenantId === record.tenantId && item.entityType === record.entityType && item.entityId === record.entityId);
      const current = index >= 0 ? items[index] : undefined;
      if (expectedVersion === null ? Boolean(current) : current?.version !== expectedVersion) throw new OperationalConflictError();
      if (index >= 0) items[index] = record;
      else items.push(record);
      await atomicWriteFile(this.file, JSON.stringify(items, null, 2), 0o600);
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async updateWithEvents(record: OperationalRecord, expectedVersion: number, events: OperationalRecord[]): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const items = await this.all();
      const index = items.findIndex((item) => item.tenantId === record.tenantId && item.entityType === record.entityType && item.entityId === record.entityId);
      if (index < 0 || items[index].version !== expectedVersion) throw new OperationalConflictError();
      const keys = new Set(items.map((item) => `${item.tenantId}\u0000${item.entityType}\u0000${item.entityId}`));
      if (events.some((item) => keys.has(`${item.tenantId}\u0000${item.entityType}\u0000${item.entityId}`))) throw new DuplicateOperationalRecordError();
      items[index] = record;
      await atomicWriteFile(this.file, JSON.stringify([...items, ...events], null, 2), 0o600);
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async createWorkOrderForIncident(incident: OperationalRecord, expectedVersion: number, workOrder: OperationalRecord, events: OperationalRecord[]): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const items = await this.all();
      const incidentIndex = items.findIndex((item) => item.tenantId === incident.tenantId && item.entityType === "INCIDENT" && item.entityId === incident.entityId);
      if (incidentIndex < 0 || items[incidentIndex].version !== expectedVersion) throw new OperationalConflictError();
      const keys = new Set(items.map((item) => `${item.tenantId}\u0000${item.entityType}\u0000${item.entityId}`));
      const incoming = [workOrder, ...events];
      if (incoming.some((item) => keys.has(`${item.tenantId}\u0000${item.entityType}\u0000${item.entityId}`))) throw new DuplicateOperationalRecordError();
      items[incidentIndex] = incident;
      await atomicWriteFile(this.file, JSON.stringify([...items, ...incoming], null, 2), 0o600);
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  private async query(tenantId: string, entityType: OperationalEntityType, limit: number, cursor?: string, machineId?: string): Promise<OperationalPage> {
    const items = (await this.all()).filter((item) => item.tenantId === tenantId && item.entityType === entityType && (!machineId || item.machineId === machineId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.entityId.localeCompare(a.entityId));
    let offset = 0;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { tenantId?: string; entityType?: string; machineId?: string; offset?: number };
        if (value.tenantId !== tenantId || value.entityType !== entityType || value.machineId !== machineId || !Number.isSafeInteger(value.offset) || (value.offset ?? -1) < 0) throw new Error();
        offset = value.offset!;
      } catch { throw new ValidationError(["Invalid operational pagination cursor"]); }
    }
    const page = items.slice(offset, offset + limit);
    const next = offset + page.length;
    return { items: page, nextCursor: next < items.length ? Buffer.from(JSON.stringify({ tenantId, entityType, machineId, offset: next })).toString("base64url") : undefined };
  }

  queryByType(tenantId: string, entityType: OperationalEntityType, limit: number, cursor?: string) { return this.query(tenantId, entityType, limit, cursor); }
  queryByMachine(tenantId: string, machineId: string, entityType: OperationalEntityType, limit: number, cursor?: string) { return this.query(tenantId, entityType, limit, cursor, machineId); }
  async queryByAssignee(tenantId: string, technicianId: string, limit: number, cursor?: string) {
    const all = (await this.all()).filter((item) => item.tenantId === tenantId && item.entityType === "WORK_ORDER" && item.assignedTechnicianId === technicianId)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || right.entityId.localeCompare(left.entityId));
    let offset = 0;
    if (cursor) {
      try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { tenantId?: string; technicianId?: string; offset?: number }; if (value.tenantId !== tenantId || value.technicianId !== technicianId || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) throw new Error(); offset = Number(value.offset); }
      catch { throw new ValidationError(["Invalid technician work-order cursor"]); }
    }
    const items = all.slice(offset, offset + limit), next = offset + items.length;
    return { items, nextCursor: next < all.length ? Buffer.from(JSON.stringify({ tenantId, technicianId, offset: next })).toString("base64url") : undefined };
  }
}
