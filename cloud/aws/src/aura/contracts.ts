export type AuraEntityType = "TECHNICIAN" | "MACHINE_LOCATION" | "PART" | "STOCK" | "MOVEMENT" | "RESERVATION" | "ASSIGNMENT" | "CALLBACK" | "EVENT" | "IDEMPOTENCY" | "POLICY";

export interface AuraRecord {
  tenantId: string;
  entityType: AuraEntityType;
  entityId: string;
  createdAt: string;
  updatedAt: string;
  version?: number;
  [key: string]: unknown;
}

export interface AuraPage {
  items: AuraRecord[];
  nextCursor?: string;
}

export interface AuraRepository {
  get(tenantId: string, entityType: AuraEntityType, entityId: string): Promise<AuraRecord | undefined>;
  createMany(records: AuraRecord[]): Promise<void>;
  save(record: AuraRecord, expectedVersion: number | null): Promise<void>;
  queryByType(tenantId: string, entityType: AuraEntityType, limit: number, cursor?: string): Promise<AuraPage>;
  adjustStock(input: { tenantId: string; stockId: string; expectedVersion: number; nextOnHand: number; movement: AuraRecord }): Promise<AuraRecord>;
  reserveStock(input: { tenantId: string; stockId: string; expectedVersion: number; quantity: number; reservation: AuraRecord; movement: AuraRecord; idempotency: AuraRecord }): Promise<void>;
  settleReservation(input: { tenantId: string; stockId: string; expectedStockVersion: number; reservationId: string; expectedReservationVersion: number; quantity: number; nextOnHand: number; nextReserved: number; status: "released" | "consumed"; movement: AuraRecord }): Promise<void>;
}

export class AuraConflictError extends Error {
  constructor(message = "AURA record changed; reload before updating") { super(message); this.name = "AuraConflictError"; }
}
export class AuraDuplicateError extends Error {
  constructor(message = "AURA record already exists") { super(message); this.name = "AuraDuplicateError"; }
}
export class AuraStockError extends Error {
  constructor(message = "Insufficient available stock") { super(message); this.name = "AuraStockError"; }
}
export class AuraDispatchError extends Error {
  constructor() { super("AURA assignment proposal was persisted but workflow dispatch failed; retry with the same idempotency key"); this.name = "AuraDispatchError"; }
}
