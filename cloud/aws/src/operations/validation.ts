import { createHash } from "node:crypto";
import { ValidationError } from "../core/machine";
import type { AnomalyRule, MetricName, TelemetryMetrics, TelemetryReading } from "./contracts";

const metricRanges: Record<MetricName, [number, number]> = {
  temperatureC: [-50, 250], vibrationMmS: [0, 100], pressureKPa: [0, 100_000], fuelConsumptionLph: [0, 2_000],
  operatingHours: [0, 1_000_000], loadPercent: [0, 200], speedKph: [0, 200], rpm: [0, 10_000],
};
const metricNames = Object.keys(metricRanges) as MetricName[];
const operators = ["gt", "gte", "lt", "lte", "changePctGte"] as const;
const severities = ["info", "warning", "critical"] as const;
const safeId = /^[a-zA-Z0-9._:-]{1,100}$/;

export function validateBatch(input: unknown): TelemetryReading[] {
  const issues: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError(["body must be an object"]);
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "readings")) issues.push("body contains unsupported fields");
  if (!Array.isArray(body.readings) || body.readings.length < 1 || body.readings.length > 10) throw new ValidationError(["readings must contain between 1 and 10 items"]);
  const seen = new Set<string>();
  const readings = body.readings.map((value, index) => {
    const prefix = `readings[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) { issues.push(`${prefix} must be an object`); return undefined; }
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["machineId", "timestamp", "metrics"].includes(key))) issues.push(`${prefix} contains unsupported fields`);
    const machineId = typeof row.machineId === "string" ? row.machineId.trim() : "";
    if (!machineId || machineId.length > 128) issues.push(`${prefix}.machineId must be 1 to 128 characters`);
    if (typeof row.timestamp !== "string" || !isStrictTimestamp(row.timestamp)) issues.push(`${prefix}.timestamp must be a valid ISO 8601 timestamp with timezone`);
    else if (Date.parse(row.timestamp) > Date.now() + 5 * 60_000) issues.push(`${prefix}.timestamp cannot be more than 5 minutes in the future`);
    const normalizedTimestamp = typeof row.timestamp === "string" && isStrictTimestamp(row.timestamp) ? new Date(row.timestamp).toISOString() : String(row.timestamp);
    const duplicateKey = `${machineId}\u0000${normalizedTimestamp}`;
    if (seen.has(duplicateKey)) issues.push(`${prefix} duplicates a machineId and timestamp in this batch`);
    seen.add(duplicateKey);
    const metricsInput = row.metrics;
    if (!metricsInput || typeof metricsInput !== "object" || Array.isArray(metricsInput)) { issues.push(`${prefix}.metrics must be an object`); return undefined; }
    const metrics: TelemetryMetrics = {};
    const metricRecord = metricsInput as Record<string, unknown>;
    for (const key of Object.keys(metricRecord)) {
      if (!metricNames.includes(key as MetricName)) { issues.push(`${prefix}.metrics.${key} is unsupported; metric field names define units`); continue; }
      const [min, max] = metricRanges[key as MetricName];
      const metric = metricRecord[key];
      if (typeof metric !== "number" || !Number.isFinite(metric) || metric < min || metric > max) issues.push(`${prefix}.metrics.${key} must be a finite number from ${min} to ${max}`);
      else metrics[key as MetricName] = metric;
    }
    if (!Object.keys(metrics).length) issues.push(`${prefix}.metrics must contain at least one supported reading`);
    return { machineId, timestamp: normalizedTimestamp, metrics };
  }).filter((reading): reading is TelemetryReading => Boolean(reading));
  if (issues.length) throw new ValidationError(issues);
  return readings;
}

export function validateRules(input: unknown): AnomalyRule[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError(["body must be an object"]);
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "rules")) throw new ValidationError(["body contains unsupported fields"]);
  if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 4) throw new ValidationError(["rules must contain between 1 and 4 items"]);
  const ids = new Set<string>();
  const issues: string[] = [];
  const rules: AnomalyRule[] = [];
  for (const [index, value] of body.rules.entries()) {
    const prefix = `rules[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) { issues.push(`${prefix} must be an object`); continue; }
    const rule = value as Record<string, unknown>;
    if (Object.keys(rule).some((key) => !["ruleId", "title", "explanation", "severity", "match", "conditions", "enabled"].includes(key))) issues.push(`${prefix} contains unsupported fields`);
    const ruleId = typeof rule.ruleId === "string" ? rule.ruleId.trim() : "";
    if (!safeId.test(ruleId)) issues.push(`${prefix}.ruleId must contain 1 to 100 safe characters`);
    if (ids.has(ruleId)) issues.push(`${prefix}.ruleId is duplicated`);
    ids.add(ruleId);
    const title = typeof rule.title === "string" ? rule.title.trim() : "";
    const explanation = typeof rule.explanation === "string" ? rule.explanation.trim() : "";
    if (!title || title.length > 160) issues.push(`${prefix}.title must contain 1 to 160 characters`);
    if (!explanation || explanation.length > 500) issues.push(`${prefix}.explanation must contain 1 to 500 characters`);
    if (!severities.includes(rule.severity as typeof severities[number])) issues.push(`${prefix}.severity must be info, warning or critical`);
    if (rule.match !== "all" && rule.match !== "any") issues.push(`${prefix}.match must be all or any`);
    if (typeof rule.enabled !== "boolean") issues.push(`${prefix}.enabled must be boolean`);
    if (!Array.isArray(rule.conditions) || rule.conditions.length < 1 || rule.conditions.length > 3) { issues.push(`${prefix}.conditions must contain between 1 and 3 items`); continue; }
    const conditions = rule.conditions.map((item, conditionIndex) => {
      const conditionPrefix = `${prefix}.conditions[${conditionIndex}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) { issues.push(`${conditionPrefix} must be an object`); return undefined; }
      const condition = item as Record<string, unknown>;
      if (Object.keys(condition).some((key) => !["metric", "operator", "threshold"].includes(key))) issues.push(`${conditionPrefix} contains unsupported fields`);
      if (!metricNames.includes(condition.metric as MetricName)) issues.push(`${conditionPrefix}.metric is unsupported`);
      if (!operators.includes(condition.operator as typeof operators[number])) issues.push(`${conditionPrefix}.operator is unsupported`);
      const thresholdValid = typeof condition.threshold === "number" && Number.isFinite(condition.threshold) && (
        condition.operator === "changePctGte"
          ? condition.threshold >= 0 && condition.threshold <= 100_000
          : metricRanges[condition.metric as MetricName] !== undefined && condition.threshold >= metricRanges[condition.metric as MetricName][0] && condition.threshold <= metricRanges[condition.metric as MetricName][1]
      );
      if (!thresholdValid) issues.push(`${conditionPrefix}.threshold must be finite and within the selected metric's range (or 0 to 100000 for changePctGte)`);
      return { metric: condition.metric as MetricName, operator: condition.operator as AnomalyRule["conditions"][number]["operator"], threshold: condition.threshold as number };
    }).filter((condition): condition is AnomalyRule["conditions"][number] => Boolean(condition));
    rules.push({ ruleId, title, explanation, severity: rule.severity as AnomalyRule["severity"], match: rule.match as "all" | "any", conditions, enabled: rule.enabled as boolean });
  }
  if (issues.length) throw new ValidationError(issues);
  return rules;
}

export function idempotencyHash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function normalizeIdempotencyKey(value: string | undefined) {
  if (!value || value.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(value)) throw new ValidationError(["idempotency-key header must contain 1 to 200 safe characters"]);
  return createHash("sha256").update(value).digest("hex");
}
export function validatePageQuery(query: Record<string, string | undefined> | undefined) {
  const limitText = query?.limit ?? "25";
  if (!/^\d{1,3}$/.test(limitText)) throw new ValidationError(["limit must be an integer from 1 to 100"]);
  const limit = Number(limitText);
  if (limit < 1 || limit > 100) throw new ValidationError(["limit must be an integer from 1 to 100"]);
  const cursor = query?.cursor;
  if (cursor && cursor.length > 4096) throw new ValidationError(["cursor is too long"]);
  return { limit, cursor };
}

function isStrictTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}
