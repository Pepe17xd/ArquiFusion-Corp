import { createHash } from "node:crypto";
import { ValidationError } from "../core/machine";
import type { Machine } from "../core/machine";
import type { MachineRepository } from "../storage/contracts";
import { TenantConflictError } from "../tenancy/contracts";
import type { IntelligenceProvider } from "../intelligence/contracts";
import { DuplicateOperationalRecordError, OperationalConflictError, OperationalWorkflowDispatchError, type AnomalyCondition, type AnomalyEvidence, type AnomalyRule, type OperationalRecord, type OperationalRepository, type TelemetryMetrics, type TelemetryReading } from "./contracts";
import { idempotencyHash } from "./validation";

const DEFAULT_RULES: AnomalyRule[] = [
  { ruleId: "temperature-high-v1", title: "Temperatura elevada", explanation: "Temperatura supera el umbral base; confirmar el límite del fabricante para este modelo.", severity: "warning", match: "all", conditions: [{ metric: "temperatureC", operator: "gte", threshold: 105 }], enabled: true },
  { ruleId: "vibration-high-v1", title: "Vibración elevada", explanation: "La lectura de vibración supera el umbral base; contrastar con la línea base del equipo.", severity: "warning", match: "all", conditions: [{ metric: "vibrationMmS", operator: "gte", threshold: 20 }], enabled: true },
  { ruleId: "overload-v1", title: "Carga fuera del rango nominal", explanation: "La carga reportada supera 100% de la capacidad nominal.", severity: "critical", match: "all", conditions: [{ metric: "loadPercent", operator: "gt", threshold: 100 }], enabled: true },
];

export interface WorkflowDispatcher { dispatch(input: { tenantId: string; anomalyId: string }): Promise<void> }

export class OperationsService {
  constructor(private readonly repository: OperationalRepository, private readonly machines: MachineRepository, private readonly workflow?: WorkflowDispatcher, private readonly intelligence?: IntelligenceProvider) {}

  async rules(tenantId: string) {
    const configured = await this.repository.get(tenantId, "RULE_SET", "active");
    return { version: Number(configured?.version ?? 0), rules: (configured?.rules as AnomalyRule[] | undefined) ?? DEFAULT_RULES, configured: Boolean(configured), defaults: configured ? undefined : "starter-thresholds-require-validation-against-manufacturer-specifications" };
  }

  async saveRules(tenantId: string, rules: AnomalyRule[]) {
    const current = await this.repository.get(tenantId, "RULE_SET", "active");
    const now = new Date().toISOString();
    const record = { tenantId, entityType: "RULE_SET" as const, entityId: "active", createdAt: current?.createdAt ?? now, updatedAt: now, version: Number(current?.version ?? 0) + 1, rules };
    await this.repository.save(record, current ? Number(current.version) : null);
    return { version: record.version, rules: record.rules, configured: true };
  }

  async ingestBatch(tenantId: string, idempotencyKey: string, readings: TelemetryReading[]) {
    const requestHash = idempotencyHash(readings);
    const ledgerId = idempotencyKey;
    const previousRequest = await this.repository.get(tenantId, "IDEMPOTENCY", ledgerId);
    if (previousRequest) return this.replay(previousRequest, requestHash);

    const uniqueMachines = [...new Set(readings.map((reading) => reading.machineId))];
    const machineMap = new Map<string, Machine>();
    for (const machineId of uniqueMachines) {
      const machine = await this.machines.get(tenantId, machineId);
      if (!machine) throw new ValidationError([`Unknown machineId for this organization: ${machineId}`]);
      machineMap.set(machineId, machine);
    }
    const { rules } = await this.rules(tenantId);
    const historyByMachine = new Map<string, Array<{ timestamp: string; metrics?: TelemetryMetrics }>>();
    for (const machineId of uniqueMachines) {
      const history = await this.repository.queryByMachine(tenantId, machineId, "TELEMETRY", 10);
      historyByMachine.set(machineId, history.items as Array<OperationalRecord & { timestamp: string; metrics?: TelemetryMetrics }>);
    }

    const now = new Date().toISOString();
    const records: OperationalRecord[] = [];
    const anomalies: Array<{ anomalyId: string; machineId: string; severity: string }> = [];
    for (const reading of [...readings].sort((left, right) => left.timestamp.localeCompare(right.timestamp))) {
      const readingId = stableId(`${reading.machineId}|${reading.timestamp}`);
      records.push({ tenantId, entityType: "TELEMETRY", entityId: readingId, machineId: reading.machineId, timestamp: reading.timestamp, metrics: reading.metrics, createdAt: reading.timestamp, updatedAt: now });
      const history = historyByMachine.get(reading.machineId) ?? [];
      const previous = history.filter((item) => item.timestamp < reading.timestamp).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.metrics;
      for (const rule of rules.filter((item) => item.enabled)) {
        const evidence = evaluateRule(rule, reading.metrics, previous);
        if (!evidence) continue;
        const anomalyId = stableId(`${reading.machineId}|${reading.timestamp}|${rule.ruleId}`);
        const anomaly = { tenantId, entityType: "ANOMALY" as const, entityId: anomalyId, machineId: reading.machineId, timestamp: reading.timestamp, severity: rule.severity, title: rule.title, explanation: rule.explanation, ruleId: rule.ruleId, evidence, status: "open", createdAt: reading.timestamp, updatedAt: now };
        records.push(anomaly);
        records.push(makeEvent(tenantId, "OperationalAnomalyDetected", anomalyId, reading.machineId, { severity: rule.severity, title: rule.title, ruleId: rule.ruleId }, reading.timestamp));
        anomalies.push({ anomalyId, machineId: reading.machineId, severity: rule.severity });
      }
      history.push({ timestamp: reading.timestamp, metrics: reading.metrics });
      historyByMachine.set(reading.machineId, history);
    }
    const response = { accepted: readings.length, anomalyCount: anomalies.length, anomalies };
    records.push({ tenantId, entityType: "IDEMPOTENCY", entityId: ledgerId, requestHash, response, createdAt: now, updatedAt: now, expiresAt: Math.floor(Date.now() / 1000) + 604800 });
    try { await this.repository.createMany(records); }
    catch (error) {
      const racedLedger = await this.repository.get(tenantId, "IDEMPOTENCY", ledgerId);
      if (racedLedger) return this.replay(racedLedger, requestHash);
      if (error instanceof DuplicateOperationalRecordError) throw new TenantConflictError("A telemetry reading with the same machineId and timestamp already exists");
      throw error;
    }
    await this.dispatchAnomalies(tenantId, anomalies);
    return { ...response, replayed: false };
  }

  private async replay(ledger: OperationalRecord, requestHash: string) {
    if (ledger.requestHash !== requestHash) throw new TenantConflictError("Idempotency key was already used with a different request body");
    const response = ledger.response as { accepted: number; anomalyCount: number; anomalies: Array<{ anomalyId: string; machineId: string; severity: string }> };
    await this.dispatchAnomalies(ledger.tenantId, response.anomalies);
    return { ...response, replayed: true };
  }

  private async dispatchAnomalies(tenantId: string, anomalies: Array<{ anomalyId: string }>) {
    if (!this.workflow) return;
    try { for (const anomaly of anomalies) await this.workflow.dispatch({ tenantId, anomalyId: anomaly.anomalyId }); }
    catch { throw new OperationalWorkflowDispatchError(); }
  }

  async list(tenantId: string, entityType: "TELEMETRY" | "ANOMALY" | "INCIDENT" | "WORK_ORDER" | "EVENT", limit: number, cursor?: string, machineId?: string) {
    return machineId
      ? this.repository.queryByMachine(tenantId, machineId, entityType, limit, cursor)
      : this.repository.queryByType(tenantId, entityType, limit, cursor);
  }

  get(tenantId: string, entityType: "ANOMALY" | "INCIDENT" | "WORK_ORDER", entityId: string) {
    return this.repository.get(tenantId, entityType, entityId);
  }

  async processAnomaly(tenantId: string, anomalyId: string) {
    const anomaly = await this.repository.get(tenantId, "ANOMALY", anomalyId);
    if (!anomaly) throw new ValidationError(["Anomaly does not exist in this organization"]);
    const records: OperationalRecord[] = [];
    if (anomaly.severity === "critical") {
      const incidentId = stableId(`incident|${anomalyId}`);
      const workOrderId = stableId(`work-order|${anomalyId}`);
      const now = new Date().toISOString();
      records.push({ tenantId, entityType: "INCIDENT", entityId: incidentId, machineId: anomaly.machineId, anomalyId, severity: "critical", status: "open", title: anomaly.title, cause: anomaly.explanation, occurredAt: anomaly.timestamp, history: [{ status: "open", at: now, source: "anomaly-workflow" }], version: 1, createdAt: now, updatedAt: now });
      records.push({ tenantId, entityType: "WORK_ORDER", entityId: workOrderId, machineId: anomaly.machineId, incidentId, anomalyId, type: "corrective", priority: "high", status: "planned", assignedTechnicianId: null, interventions: [], partsUsed: [], history: [{ status: "planned", at: now, source: "anomaly-workflow" }], version: 1, createdAt: now, updatedAt: now });
      records.push(makeEvent(tenantId, "IncidentCreated", incidentId, String(anomaly.machineId), { anomalyId, severity: anomaly.severity }, now));
      records.push(makeEvent(tenantId, "MaintenanceOrderCreated", workOrderId, String(anomaly.machineId), { anomalyId, priority: "high", type: "corrective" }, now));
      records.push(makeEvent(tenantId, "NotificationRequested", incidentId, String(anomaly.machineId), { anomalyId, incidentId, workOrderId, notificationKey: `critical-anomaly:${anomalyId}` }, now));
    }
    records.push(makeEvent(tenantId, "AnomalyWorkflowProcessed", anomalyId, String(anomaly.machineId), { severity: anomaly.severity, automaticAction: anomaly.severity === "critical" ? "incident-and-work-order-created" : "event-recorded" }, new Date().toISOString()));
    try { await this.repository.createMany(records); }
    catch (error) {
      if (!(error instanceof DuplicateOperationalRecordError)) throw error;
      const event = await this.repository.get(tenantId, "EVENT", stableId(`AnomalyWorkflowProcessed|${anomalyId}|`));
      if (!event) throw error;
    }
    return { tenantId, anomalyId, incidentCreated: anomaly.severity === "critical", workOrderCreated: anomaly.severity === "critical" };
  }

  async explainAnomaly(tenantId: string, anomalyId: string) {
    const anomaly = await this.repository.get(tenantId, "ANOMALY", anomalyId);
    if (!anomaly) throw new ValidationError(["Anomaly does not exist in this organization"]);
    if (!this.intelligence) throw new Error("Intelligence provider is not configured");
    const machine = await this.machines.get(tenantId, String(anomaly.machineId));
    if (!machine) throw new ValidationError(["Machine for anomaly is unavailable"]);
    const enriched = machineForProvider(machine, anomaly);
    const result = await this.intelligence.recommend({ machines: [enriched] });
    return { anomalyId, source: result.source, generatedAt: result.generatedAt, recommendations: result.recommendations.filter((item) => item.machineId === anomaly.machineId), evidence: anomaly.evidence };
  }

  async updateIncident(tenantId: string, incidentId: string, input: { expectedVersion: number; status?: "open" | "acknowledged" | "resolved"; assignedTo?: string | null; resolution?: string }) {
    const current = await this.repository.get(tenantId, "INCIDENT", incidentId);
    if (!current) throw new ValidationError(["Incident does not exist in this organization"]);
    if (current.version !== input.expectedVersion) throw new OperationalConflictError();
    if (input.status && !({ open: ["open", "acknowledged", "resolved"], acknowledged: ["acknowledged", "open", "resolved"], resolved: ["resolved"] } as Record<string, string[]>)[String(current.status)]?.includes(input.status)) throw new ValidationError(["Invalid incident status transition"]);
    if (input.status === "resolved" && !input.resolution?.trim()) throw new ValidationError(["resolution is required when status is resolved"]);
    const now = new Date().toISOString();
    const updated = { ...current, ...(input.status ? { status: input.status } : {}), ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo } : {}), ...(input.resolution ? { resolution: input.resolution.trim() } : {}), history: [...(current.history as unknown[]), { status: input.status ?? current.status, at: now, assignedTo: input.assignedTo }], version: input.expectedVersion + 1, updatedAt: now };
    await this.repository.updateWithEvents(updated, input.expectedVersion, [makeEvent(tenantId, "IncidentUpdated", incidentId, String(current.machineId), { status: updated.status, version: updated.version }, now, String(updated.version))]);
    return updated;
  }

  async updateWorkOrder(tenantId: string, workOrderId: string, input: { expectedVersion: number; status?: "planned" | "in_progress" | "completed" | "cancelled"; assignedTechnicianId?: string | null; intervention?: { occurredAt: string; notes: string } }) {
    const current = await this.repository.get(tenantId, "WORK_ORDER", workOrderId);
    if (!current) throw new ValidationError(["Maintenance order does not exist in this organization"]);
    if (current.version !== input.expectedVersion) throw new OperationalConflictError();
    const allowed: Record<string, string[]> = { planned: ["planned", "in_progress", "cancelled"], in_progress: ["in_progress", "completed", "cancelled"], completed: ["completed"], cancelled: ["cancelled"] };
    if (input.status && !allowed[String(current.status)]?.includes(input.status)) throw new ValidationError(["Invalid maintenance order status transition"]);
    const now = new Date().toISOString();
    const history = [...(current.history as unknown[]), ...(input.status ? [{ status: input.status, at: now }] : [])];
    const interventions = [...(current.interventions as unknown[]), ...(input.intervention ? [input.intervention] : [])];
    const updated = { ...current, ...(input.status ? { status: input.status } : {}), ...(input.assignedTechnicianId !== undefined ? { assignedTechnicianId: input.assignedTechnicianId } : {}), history, interventions, version: input.expectedVersion + 1, updatedAt: now };
    await this.repository.updateWithEvents(updated, input.expectedVersion, [makeEvent(tenantId, "MaintenanceOrderUpdated", workOrderId, String(current.machineId), { status: updated.status, version: updated.version }, now, String(updated.version))]);
    return updated;
  }
}

function evaluateRule(rule: AnomalyRule, metrics: TelemetryMetrics, previous?: TelemetryMetrics): AnomalyEvidence[] | undefined {
  const evidence: AnomalyEvidence[] = [];
  for (const condition of rule.conditions) {
    const observed = metrics[condition.metric];
    if (observed === undefined) { if (rule.match === "all") return undefined; continue; }
    const prior = previous?.[condition.metric];
    const matched = compare(condition, observed, prior);
    if (matched === undefined) { if (rule.match === "all") return undefined; continue; }
    if (matched) evidence.push({ metric: condition.metric, observed, operator: condition.operator, threshold: condition.threshold, ...(prior === undefined ? {} : { previous: prior }), ...(condition.operator === "changePctGte" && prior !== undefined && prior !== 0 ? { changePercent: ((observed - prior) / Math.abs(prior)) * 100 } : {}) });
    else if (rule.match === "all") return undefined;
  }
  if (!evidence.length) return undefined;
  return rule.match === "all" && evidence.length !== rule.conditions.length ? undefined : evidence;
}

function compare(condition: AnomalyCondition, observed: number, previous?: number): boolean | undefined {
  switch (condition.operator) {
    case "gt": return observed > condition.threshold;
    case "gte": return observed >= condition.threshold;
    case "lt": return observed < condition.threshold;
    case "lte": return observed <= condition.threshold;
    case "changePctGte": return previous === undefined || previous === 0 ? undefined : ((observed - previous) / Math.abs(previous)) * 100 >= condition.threshold;
  }
}

function stableId(value: string) { return createHash("sha256").update(value).digest("hex"); }
function makeEvent(tenantId: string, eventType: string, resourceId: string, machineId: string, payload: Record<string, unknown>, timestamp: string, idempotencySuffix = ""): OperationalRecord {
  const entityId = stableId(`${eventType}|${resourceId}|${idempotencySuffix}`);
  return { tenantId, entityType: "EVENT", entityId, eventId: entityId, eventType, resourceId, machineId, timestamp, payload, createdAt: timestamp, updatedAt: timestamp };
}
function machineForProvider(machine: Machine, anomaly: OperationalRecord): Machine {
  const evidence = anomaly.evidence as AnomalyEvidence[];
  return {
    ...machine,
    ...(evidence.some((item) => item.metric === "temperatureC") ? { temperature: evidence.find((item) => item.metric === "temperatureC")!.observed } : {}),
    ...(evidence.some((item) => item.metric === "vibrationMmS") ? { vibration: evidence.find((item) => item.metric === "vibrationMmS")!.observed } : {}),
    ...(anomaly.severity === "critical" ? { status: "alert" as const } : {}),
  };
}
