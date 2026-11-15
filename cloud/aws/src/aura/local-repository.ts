import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../storage/local-file";
import { ValidationError } from "../core/machine";
import { AuraConflictError, AuraDuplicateError, AuraStockError, type AuraEntityType, type AuraPage, type AuraRecord, type AuraRepository } from "./contracts";

export class LocalAuraRepository implements AuraRepository {
  private writeChain: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  private async all(): Promise<AuraRecord[]> {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(data)) throw new Error("AURA data must be an array");
      return data as AuraRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(tenantId: string, entityType: AuraEntityType, entityId: string) {
    return (await this.all()).find((item) => item.tenantId === tenantId && item.entityType === entityType && item.entityId === entityId);
  }

  async createMany(records: AuraRecord[]) {
    await this.write(async (items) => {
      const keys = new Set(items.map(keyOf));
      const incoming = new Set<string>();
      for (const record of records) {
        const key = keyOf(record);
        if (keys.has(key) || incoming.has(key)) throw new AuraDuplicateError();
        incoming.add(key);
      }
      return [...items, ...records];
    });
  }

  async save(record: AuraRecord, expectedVersion: number | null) {
    await this.write((items) => {
      const index = items.findIndex((item) => keyOf(item) === keyOf(record));
      const current = index < 0 ? undefined : items[index];
      if (expectedVersion === null ? Boolean(current) : current?.version !== expectedVersion) throw new AuraConflictError();
      if (index < 0) items.push(record); else items[index] = record;
      return items;
    });
  }

  async queryByType(tenantId: string, entityType: AuraEntityType, limit: number, cursor?: string): Promise<AuraPage> {
    const all = (await this.all()).filter((item) => item.tenantId === tenantId && item.entityType === entityType)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.entityId.localeCompare(left.entityId));
    let offset = 0;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { tenantId?: string; entityType?: string; offset?: number };
        if (value.tenantId !== tenantId || value.entityType !== entityType || !Number.isSafeInteger(value.offset) || (value.offset ?? -1) < 0) throw new Error();
        offset = value.offset!;
      } catch { throw new ValidationError(["Invalid AURA pagination cursor"]); }
    }
    const items = all.slice(offset, offset + limit);
    const next = offset + items.length;
    return { items, nextCursor: next < all.length ? Buffer.from(JSON.stringify({ tenantId, entityType, offset: next })).toString("base64url") : undefined };
  }

  async adjustStock(input: { tenantId: string; stockId: string; expectedVersion: number; nextOnHand: number; movement: AuraRecord }) {
    await this.write((items) => {
      const stock = find(items, input.tenantId, "STOCK", input.stockId);
      if (!stock || stock.version !== input.expectedVersion) throw new AuraConflictError();
      if (input.nextOnHand < Number(stock.reserved ?? 0)) throw new AuraStockError("Stock adjustment cannot reduce on-hand quantity below active reservations");
      assertNew(items, input.movement);
      const updated = { ...stock, onHand: input.nextOnHand, version: input.expectedVersion + 1, updatedAt: input.movement.createdAt };
      items[items.indexOf(stock)] = updated;
      items.push(input.movement);
      return items;
    });
    const result = await this.get(input.tenantId, "STOCK", input.stockId);
    if (!result) throw new AuraConflictError();
    return result;
  }

  async reserveStock(input: { tenantId: string; stockId: string; expectedVersion: number; quantity: number; reservation: AuraRecord; movement: AuraRecord; idempotency: AuraRecord }) {
    await this.write((items) => {
      const stock = find(items, input.tenantId, "STOCK", input.stockId);
      if (!stock || stock.version !== input.expectedVersion) throw new AuraConflictError();
      if (Number(stock.onHand) - Number(stock.reserved) < input.quantity) throw new AuraStockError();
      assertNew(items, input.reservation, input.movement, input.idempotency);
      items[items.indexOf(stock)] = { ...stock, reserved: Number(stock.reserved) + input.quantity, version: input.expectedVersion + 1, updatedAt: input.reservation.createdAt };
      items.push(input.reservation, input.movement, input.idempotency);
      return items;
    });
  }

  async settleReservation(input: { tenantId: string; stockId: string; expectedStockVersion: number; reservationId: string; expectedReservationVersion: number; quantity: number; nextOnHand: number; nextReserved: number; status: "released" | "consumed"; movement: AuraRecord }) {
    await this.write((items) => {
      const stock = find(items, input.tenantId, "STOCK", input.stockId);
      const reservation = find(items, input.tenantId, "RESERVATION", input.reservationId);
      if (!stock || !reservation || stock.version !== input.expectedStockVersion || reservation.version !== input.expectedReservationVersion) throw new AuraConflictError();
      if (reservation.status !== "active" || Number(reservation.quantity) !== input.quantity) throw new AuraConflictError("Reservation is not active or quantity does not match");
      if (input.nextOnHand < input.nextReserved || input.nextReserved < 0 || input.nextOnHand < 0) throw new AuraStockError();
      assertNew(items, input.movement);
      const now = input.movement.createdAt;
      items[items.indexOf(stock)] = { ...stock, onHand: input.nextOnHand, reserved: input.nextReserved, version: input.expectedStockVersion + 1, updatedAt: now };
      items[items.indexOf(reservation)] = { ...reservation, status: input.status, version: input.expectedReservationVersion + 1, updatedAt: now, settledAt: now };
      items.push(input.movement);
      return items;
    });
  }

  private async write(transform: (items: AuraRecord[]) => AuraRecord[] | Promise<AuraRecord[]>) {
    const task = this.writeChain.then(async () => {
      const next = await transform(await this.all());
      await atomicWriteFile(this.file, JSON.stringify(next, null, 2), 0o600);
    });
    this.writeChain = task.catch(() => undefined);
    await task;
  }
}

function keyOf(record: AuraRecord) { return `${record.tenantId}\u0000${record.entityType}\u0000${record.entityId}`; }
function find(items: AuraRecord[], tenantId: string, type: AuraEntityType, id: string) { return items.find((item) => item.tenantId === tenantId && item.entityType === type && item.entityId === id); }
function assertNew(items: AuraRecord[], ...records: AuraRecord[]) {
  const known = new Set(items.map(keyOf));
  const incoming = new Set<string>();
  for (const record of records) {
    const key = keyOf(record);
    if (known.has(key) || incoming.has(key)) throw new AuraDuplicateError();
    incoming.add(key);
  }
}
