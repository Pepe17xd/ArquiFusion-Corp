export type OperationalEntityType = "TELEMETRY" | "ANOMALY" | "INCIDENT" | "WORK_ORDER" | "EVENT" | "RULE_SET" | "IDEMPOTENCY";
export type MetricName = "temperatureC" | "vibrationMmS" | "pressureKPa" | "fuelConsumptionLph" | "operatingHours" | "loadPercent" | "speedKph" | "rpm";
export type AnomalySeverity = "info" | "warning" | "critical";
export type RuleOperator = "gt" | "gte" | "lt" | "lte" | "changePctGte";

export interface TelemetryMetrics {
  temperatureC?: number;
  vibrationMmS?: number;
  pressureKPa?: number;
  fuelConsumptionLph?: number;
  operatingHours?: number;
  loadPercent?: number;
  speedKph?: number;
  rpm?: number;
}
export interface TelemetryReading { machineId: string; timestamp: string; metrics: TelemetryMetrics }
export interface AnomalyCondition { metric: MetricName; operator: RuleOperator; threshold: number }
export interface AnomalyRule {
  ruleId: string; title: string; explanation: string; severity: AnomalySeverity;
  match: "all" | "any"; conditions: AnomalyCondition[]; enabled: boolean;
}
export interface AnomalyEvidence { metric: MetricName; observed: number; operator: RuleOperator; threshold: number; previous?: number; changePercent?: number }
export interface OperationalRecord {
  tenantId: string; entityType: OperationalEntityType; entityId: string;
  createdAt: string; updatedAt: string; machineId?: string;
  [key: string]: unknown;
}
export interface OperationalPage<T extends OperationalRecord = OperationalRecord> { items: T[]; nextCursor?: string }
export interface OperationalRepository {
  get(tenantId: string, entityType: OperationalEntityType, entityId: string): Promise<OperationalRecord | undefined>;
  createMany(records: OperationalRecord[]): Promise<void>;
  save(record: OperationalRecord, expectedVersion: number | null): Promise<void>;
  updateWithEvents(record: OperationalRecord, expectedVersion: number, events: OperationalRecord[]): Promise<void>;
  queryByType(tenantId: string, entityType: OperationalEntityType, limit: number, cursor?: string): Promise<OperationalPage>;
  queryByMachine(tenantId: string, machineId: string, entityType: OperationalEntityType, limit: number, cursor?: string): Promise<OperationalPage>;
}
export class DuplicateOperationalRecordError extends Error {
  constructor() { super("An operational record already exists"); this.name = "DuplicateOperationalRecordError"; }
}
export class OperationalConflictError extends Error {
  constructor() { super("Operational record changed; reload before updating"); this.name = "OperationalConflictError"; }
}
export class OperationalWorkflowDispatchError extends Error {
  constructor() { super("Telemetry was persisted, but anomaly workflow dispatch failed. Retry the same idempotency key to resume."); this.name = "OperationalWorkflowDispatchError"; }
}
