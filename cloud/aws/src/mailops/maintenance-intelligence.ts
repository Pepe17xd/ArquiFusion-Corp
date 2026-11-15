import type { Machine, MachineStatus } from "../core/machine";

export type MaintenancePriority = "CRITICAL" | "HIGH" | "MEDIUM" | "NORMAL" | "INSUFFICIENT_DATA";
export type MaintenanceMetric = "temperature" | "vibration" | "pressure" | "fuelConsumption" | "operatingHours" | "load" | "rpm";
/** Current ingestion has no historical readings or service history; these remain explicit optional inputs. */
export interface MachineReading { tenantId: string; machineId: string; timestamp: string; temperature?: number; vibration?: number; pressure?: number; fuelConsumption?: number; operatingHours?: number; load?: number; rpm?: number }
export interface MaintenanceRecord { tenantId: string; machineId: string; maintainedAt: string; operatingHoursAtMaintenance?: number; intervalHours?: number }
export interface MachineThresholds {
  model?: string; category?: string;
  ranges?: Partial<Record<MaintenanceMetric, { min?: number; max?: number }>>;
  operatingHoursHigh?: number;
  combined?: Array<{ metrics: MaintenanceMetric[]; minSignals?: number; severity: "HIGH" | "CRITICAL"; label: string }>;
  historyChangePercent?: Partial<Record<MaintenanceMetric, number>>;
  comparableSigma?: number;
  maintenanceIntervalHours?: number; maintenanceDueSoonHours?: number;
}
export interface MaintenanceAnomaly {
  tenantId: string; machineId: string; type: string; severity: "MEDIUM" | "HIGH" | "CRITICAL";
  variables: MaintenanceMetric[]; observed: Partial<Record<MaintenanceMetric, number | string>> & { status?: string };
  rule: string; timestamp: string; explanation: string;
}
export interface MaintenanceEvaluation {
  tenantId: string; machineId: string; priority: MaintenancePriority; anomalies: MaintenanceAnomaly[];
  preventive: { status: "ON_TRACK" | "DUE_SOON" | "OVERDUE" | "INSUFFICIENT_DATA"; hoursSinceLastMaintenance?: number; hoursRemaining?: number; reasons: string[]; missingData: string[] };
  assessedAt: string; explanation: string;
}
export interface MaintenanceFleetResult { tenantId: string; evaluations: MaintenanceEvaluation[] }
export interface MaintenanceInput { tenantId: string; machines: Machine[]; readings?: MachineReading[]; maintenanceHistory?: MaintenanceRecord[]; assessedAt?: string }

const metrics: MaintenanceMetric[] = ["temperature", "vibration", "pressure", "fuelConsumption", "operatingHours", "load", "rpm"];
const severityScore: Record<MaintenanceAnomaly["severity"], number> = { MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
function recordKey(record: { tenantId: string; machineId: string }) { return record.tenantId + "\0" + record.machineId; }
function timestampValid(value: string) { return Number.isFinite(Date.parse(value)); }
function matches(rule: MachineThresholds, machine: Machine) { return (!rule.model || rule.model === machine.model) && (!rule.category || rule.category === machine.category); }

export class MaintenanceIntelligenceEngine {
  constructor(private readonly rules: MachineThresholds[] = [], private readonly now: () => string = () => new Date().toISOString()) {
    for (const rule of rules) {
      if (!rule || typeof rule !== "object" || (rule.model !== undefined && typeof rule.model !== "string") || (rule.category !== undefined && typeof rule.category !== "string")) throw new Error("Invalid maintenance rule selector");
      for (const number of [rule.operatingHoursHigh, rule.comparableSigma, rule.maintenanceIntervalHours, rule.maintenanceDueSoonHours]) if (number !== undefined && (!Number.isFinite(number) || number < 0)) throw new Error("Invalid maintenance rule number");
      if (rule.comparableSigma !== undefined && rule.comparableSigma <= 0) throw new Error("comparableSigma must be positive");
      for (const [metric, range] of Object.entries(rule.ranges ?? {})) {
        if (!metrics.includes(metric as MaintenanceMetric) || !range || typeof range !== "object") throw new Error("Invalid maintenance range");
        if (range.min !== undefined && !Number.isFinite(range.min) || range.max !== undefined && !Number.isFinite(range.max)) throw new Error("Invalid maintenance range bound");
        if (range.min !== undefined && range.max !== undefined && range.min > range.max) throw new Error("Invalid maintenance range");
      }
      for (const [metric, threshold] of Object.entries(rule.historyChangePercent ?? {})) if (!metrics.includes(metric as MaintenanceMetric) || !Number.isFinite(threshold) || threshold <= 0) throw new Error("Invalid historical change threshold");
      for (const combo of rule.combined ?? []) {
        if (!combo || typeof combo.label !== "string" || !combo.label.trim() || !["HIGH", "CRITICAL"].includes(combo.severity) || !Array.isArray(combo.metrics) || !combo.metrics.length || combo.metrics.some(metric => !metrics.includes(metric)) || (combo.minSignals !== undefined && (!Number.isInteger(combo.minSignals) || combo.minSignals < 1 || combo.minSignals > combo.metrics.length))) throw new Error("Invalid combined maintenance rule");
      }
    }
  }
  evaluate(input: MaintenanceInput): MaintenanceFleetResult {
    if (!input.tenantId.trim() || input.machines.some(machine => machine.tenantId !== input.tenantId)) throw new Error("Maintenance tenant boundary violation");
    const assessedAt = input.assessedAt ?? this.now();
    if (!timestampValid(assessedAt)) throw new Error("Invalid assessment timestamp");
    const readings = new Map<string, MachineReading[]>();
    for (const reading of input.readings ?? []) {
      if (reading.tenantId !== input.tenantId || !timestampValid(reading.timestamp) || Date.parse(reading.timestamp) > Date.parse(assessedAt)) continue;
      const id = recordKey(reading); readings.set(id, [...(readings.get(id) ?? []), reading]);
    }
    const services = (input.maintenanceHistory ?? []).filter(item => item.tenantId === input.tenantId && timestampValid(item.maintainedAt) && Date.parse(item.maintainedAt) <= Date.parse(assessedAt));
    return { tenantId: input.tenantId, evaluations: input.machines.map(machine => this.evaluateMachine(machine, readings.get(recordKey(machine)) ?? [], services.filter(item => recordKey(item) === recordKey(machine)), assessedAt, input.machines)) };
  }
  private evaluateMachine(machine: Machine, history: MachineReading[], services: MaintenanceRecord[], assessedAt: string, fleet: Machine[]): MaintenanceEvaluation {
    const applicable = this.rules.filter(rule => matches(rule, machine));
    const values: Partial<Record<MaintenanceMetric, number>> = {};
    for (const metric of metrics) { const value = machine[metric as keyof Machine]; if (typeof value === "number" && Number.isFinite(value)) values[metric] = value; }
    const orderedHistory = [...history].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const latest = orderedHistory[0];
    for (const metric of metrics) if (values[metric] === undefined && typeof latest?.[metric] === "number") values[metric] = latest[metric] as number;
    const anomalies: MaintenanceAnomaly[] = [];
    const anomaly = (type: string, severity: MaintenanceAnomaly["severity"], vars: MaintenanceMetric[], observed: MaintenanceAnomaly["observed"], rule: string, explanation: string) => anomalies.push({ tenantId: machine.tenantId, machineId: machine.machineId, type, severity, variables: vars, observed, rule, timestamp: assessedAt, explanation });
    for (const rule of applicable) {
      for (const metric of metrics) {
        const range = rule.ranges?.[metric], value = values[metric]; if (!range || value === undefined) continue;
        if ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max)) {
          const bound = range.min !== undefined && value < range.min ? "mínimo " + range.min : "máximo " + range.max;
          anomaly(metric + "-out-of-range", "HIGH", [metric], { [metric]: value }, "configured-range:" + metric, metric + "=" + value + " excede el " + bound + " configurado; este umbral local no es una especificación del fabricante.");
        }
      }
      if (rule.operatingHoursHigh !== undefined && values.operatingHours !== undefined && values.operatingHours >= rule.operatingHoursHigh)
        anomaly("high-operating-hours", "MEDIUM", ["operatingHours"], { operatingHours: values.operatingHours }, "configured-operating-hours", "Horas de operación (" + values.operatingHours + ") alcanzan el umbral local (" + rule.operatingHoursHigh + ").");
      for (const combo of rule.combined ?? []) {
        const present = combo.metrics.filter(metric => values[metric] !== undefined);
        const required = combo.minSignals ?? combo.metrics.length;
        const triggered = present.filter(metric => { const range = rule.ranges?.[metric], value = values[metric]!; return Boolean(range && ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max))); });
        if (triggered.length >= required) {
          const observed: MaintenanceAnomaly["observed"] = {}; for (const metric of present) observed[metric] = values[metric]!;
          anomaly("combined-signal", combo.severity, present, observed, "configured-combination:" + combo.label, "Combinación " + combo.label + " activada con " + present.map(metric => metric + "=" + values[metric]).join(", ") + ".");
        }
      }
      for (const metric of metrics) {
        const threshold = rule.historyChangePercent?.[metric], value = values[metric];
        const prior = orderedHistory.map(reading => reading[metric]).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
        if (threshold === undefined || value === undefined || prior.length < 3) continue;
        const average = prior.reduce((sum, n) => sum + n, 0) / prior.length;
        const change = average === 0 ? 0 : Math.abs(value - average) / Math.abs(average) * 100;
        if (change >= threshold) anomaly("historical-change", "MEDIUM", [metric], { [metric]: value }, "configured-history-change:" + metric, metric + " difiere " + Math.round(change) + "% de la media de " + prior.length + " lecturas anteriores (" + average.toFixed(2) + ").");
      }
      if (rule.comparableSigma) for (const metric of metrics) {
        const value = values[metric];
        const peers = fleet.filter(other => other.tenantId === machine.tenantId && other.machineId !== machine.machineId && other.model === machine.model && other.category === machine.category).map(other => other[metric as keyof Machine]).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
        if (value === undefined || peers.length < 3) continue;
        const average = peers.reduce((sum, n) => sum + n, 0) / peers.length;
        const deviation = Math.sqrt(peers.reduce((sum, n) => sum + (n - average) ** 2, 0) / peers.length);
        if ((deviation === 0 && value !== average) || (deviation > 0 && Math.abs(value - average) >= rule.comparableSigma * deviation)) anomaly("peer-deviation", "MEDIUM", [metric], { [metric]: value }, "configured-peer-sigma:" + rule.comparableSigma, metric + " se desvía al menos " + rule.comparableSigma + " desviaciones estándar de " + peers.length + " máquinas comparables del mismo tenant/modelo/tipo.");
      }
    }
    // The imported state is reported as source evidence, not interpreted as a sensor measurement.
    if (machine.status === "stopped") anomaly("reported-stopped", "CRITICAL", [], { status: machine.status }, "reported-machine-status", "El registro normalizado informa que la máquina está detenida.");
    else if (machine.status === "alert") anomaly("reported-alert", "HIGH", [], { status: machine.status }, "reported-machine-status", "El registro informa estado de alerta; no identifica por sí solo la causa.");
    else if (machine.status === "maintenance") anomaly("reported-maintenance", "MEDIUM", [], { status: machine.status }, "reported-machine-status", "El registro normalizado informa que la máquina está en mantenimiento.");
    const preventiveRule = [...applicable].reverse().find(item => item.maintenanceIntervalHours !== undefined || item.maintenanceDueSoonHours !== undefined) ?? applicable.at(-1);
    const preventive = this.preventive(machine, services, preventiveRule);
    if (preventive.status === "OVERDUE") anomaly("preventive-maintenance-overdue", "HIGH", [], values.operatingHours === undefined ? {} : { operatingHours: values.operatingHours }, "configured-maintenance-interval", preventive.reasons.join(" "));
    if (preventive.status === "DUE_SOON" && values.operatingHours !== undefined) anomaly("preventive-maintenance-due-soon", "MEDIUM", ["operatingHours"], { operatingHours: values.operatingHours }, "configured-maintenance-interval", preventive.reasons.join(" "));
    const highest = anomalies.reduce<MaintenanceAnomaly["severity"] | undefined>((top, item) => !top || severityScore[item.severity] > severityScore[top] ? item.severity : top, undefined);
    const hasConfiguredCoverage = applicable.some(rule =>
      metrics.some(metric => values[metric] !== undefined && rule.ranges?.[metric] !== undefined) ||
      (rule.operatingHoursHigh !== undefined && values.operatingHours !== undefined) ||
      preventive.status !== "INSUFFICIENT_DATA" ||
      metrics.some(metric => rule.historyChangePercent?.[metric] !== undefined && values[metric] !== undefined && history.filter(reading => typeof reading[metric] === "number").length >= 3) ||
      metrics.some(metric => rule.comparableSigma !== undefined && values[metric] !== undefined && fleet.filter(other => other.tenantId === machine.tenantId && other.machineId !== machine.machineId && other.model === machine.model && other.category === machine.category && typeof other[metric as keyof Machine] === "number").length >= 3)
    );
    const priority: MaintenancePriority = highest ?? (machine.status === "maintenance" ? "MEDIUM" : hasConfiguredCoverage ? "NORMAL" : "INSUFFICIENT_DATA");
    const explanation = anomalies.length ? "Prioridad " + priority + ": " + anomalies.map(item => item.type).join(", ") + "." : priority === "INSUFFICIENT_DATA" ? "Datos insuficientes para evaluar señales o mantenimiento preventivo con reglas configuradas." : "No se activó ninguna regla determinista configurada con los datos disponibles.";
    return { tenantId: machine.tenantId, machineId: machine.machineId, priority, anomalies, preventive, assessedAt, explanation };
  }
  private preventive(machine: Machine, services: MaintenanceRecord[], rule?: MachineThresholds): MaintenanceEvaluation["preventive"] {
    const last = services.filter(item => timestampValid(item.maintainedAt)).sort((a, b) => Date.parse(b.maintainedAt) - Date.parse(a.maintainedAt))[0];
    const interval = last?.intervalHours ?? rule?.maintenanceIntervalHours;
    const missingData: string[] = [];
    if (!last) missingData.push("historial de mantenimiento");
    if (machine.operatingHours === undefined) missingData.push("horas de operación actuales");
    if (interval === undefined) missingData.push("intervalo de mantenimiento configurado");
    if (last?.operatingHoursAtMaintenance === undefined) missingData.push("horas en el último mantenimiento");
    if (!last || machine.operatingHours === undefined || interval === undefined || last.operatingHoursAtMaintenance === undefined)
      return { status: "INSUFFICIENT_DATA", reasons: ["No se calcula el vencimiento sin historial, lecturas e intervalo verificable."], missingData };
    const elapsed = Math.max(0, machine.operatingHours - last.operatingHoursAtMaintenance), remaining = interval - elapsed;
    const dueSoon = rule?.maintenanceDueSoonHours ?? interval * 0.1;
    if (remaining <= 0) return { status: "OVERDUE", hoursSinceLastMaintenance: elapsed, hoursRemaining: remaining, reasons: ["Mantenimiento vencido por " + Math.abs(remaining) + " horas según intervalo configurado de " + interval + " h."], missingData };
    if (remaining <= dueSoon) return { status: "DUE_SOON", hoursSinceLastMaintenance: elapsed, hoursRemaining: remaining, reasons: ["Quedan " + remaining + " horas según intervalo configurado de " + interval + " h."], missingData };
    return { status: "ON_TRACK", hoursSinceLastMaintenance: elapsed, hoursRemaining: remaining, reasons: ["Quedan " + remaining + " horas según intervalo configurado de " + interval + " h."], missingData };
  }
}
export function parseMaintenanceRules(json: string | undefined): MachineThresholds[] {
  if (!json) return [];
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Maintenance rules must be a JSON array of rule objects");
  new MaintenanceIntelligenceEngine(parsed as MachineThresholds[]);
  return parsed as MachineThresholds[];
}
