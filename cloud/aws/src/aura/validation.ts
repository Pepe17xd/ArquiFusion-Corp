import { ValidationError } from "../core/machine";

const idPattern = /^[a-zA-Z0-9._:-]{1,100}$/;
const skillCodePattern = /^[a-zA-Z0-9._:-]{1,64}$/;

export interface Coordinates { latitude: number; longitude: number; datum: "WGS84" }
export interface TechnicianInput {
  technicianId: string; displayName: string; specialties: string[]; skills: Array<{ code: string; level: number }>;
  availability: "available" | "unavailable"; maxConcurrentAssignments: number;
  shifts: Array<{ daysOfWeek: number[]; startTime: string; endTime: string; timeZone: string }>;
  coordinates?: Coordinates; cognitoSub?: string;
}

export function validateTechnician(value: unknown): TechnicianInput {
  const row = object(value, "body");
  allowed(row, ["technicianId", "displayName", "specialties", "skills", "availability", "maxConcurrentAssignments", "shifts", "coordinates", "cognitoSub"], "body");
  const technicianId = safeId(row.technicianId, "technicianId");
  const displayName = text(row.displayName, "displayName", 1, 120);
  const specialties = stringList(row.specialties, "specialties", 1, 20, 64);
  if (!Array.isArray(row.skills) || row.skills.length < 1 || row.skills.length > 30) throw new ValidationError(["skills must contain 1 to 30 skill entries"]);
  const skills = row.skills.map((item, index) => {
    const skill = object(item, `skills[${index}]`);
    allowed(skill, ["code", "level"], `skills[${index}]`);
    const code = typeof skill.code === "string" && skillCodePattern.test(skill.code) ? skill.code : "";
    if (!code) throw new ValidationError([`skills[${index}].code is invalid`]);
    if (!Number.isInteger(skill.level) || Number(skill.level) < 1 || Number(skill.level) > 5) throw new ValidationError([`skills[${index}].level must be an integer from 1 to 5`]);
    return { code, level: Number(skill.level) };
  });
  if (new Set(skills.map((skill) => skill.code)).size !== skills.length) throw new ValidationError(["skills contains duplicate codes"]);
  if (row.availability !== "available" && row.availability !== "unavailable") throw new ValidationError(["availability must be available or unavailable"]);
  if (!Number.isInteger(row.maxConcurrentAssignments) || Number(row.maxConcurrentAssignments) < 1 || Number(row.maxConcurrentAssignments) > 20) throw new ValidationError(["maxConcurrentAssignments must be an integer from 1 to 20"]);
  if (!Array.isArray(row.shifts) || row.shifts.length < 1 || row.shifts.length > 7) throw new ValidationError(["shifts must contain 1 to 7 weekly shift windows"]);
  const shifts = row.shifts.map((value, index) => {
    const shift = object(value, `shifts[${index}]`);
    allowed(shift, ["daysOfWeek", "startTime", "endTime", "timeZone"], `shifts[${index}]`);
    if (!Array.isArray(shift.daysOfWeek) || shift.daysOfWeek.length < 1 || shift.daysOfWeek.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) throw new ValidationError([`shifts[${index}].daysOfWeek must contain weekdays 0 (Sunday) through 6 (Saturday)`]);
    const daysOfWeek = [...new Set(shift.daysOfWeek as number[])];
    const startTime = text(shift.startTime, `shifts[${index}].startTime`, 5, 5);
    const endTime = text(shift.endTime, `shifts[${index}].endTime`, 5, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) || startTime === endTime) throw new ValidationError([`shifts[${index}] requires distinct 24-hour startTime/endTime values`]);
    const timeZone = text(shift.timeZone, `shifts[${index}].timeZone`, 1, 64);
    try { new Intl.DateTimeFormat("en", { timeZone }).format(); } catch { throw new ValidationError([`shifts[${index}].timeZone must be a valid IANA time zone`]); }
    return { daysOfWeek, startTime, endTime, timeZone };
  });
  const coordinates = row.coordinates === undefined ? undefined : validateCoordinates(row.coordinates, "coordinates");
  const cognitoSub = row.cognitoSub === undefined ? undefined : text(row.cognitoSub, "cognitoSub", 1, 128);
  return { technicianId, displayName, specialties, skills, availability: row.availability, maxConcurrentAssignments: Number(row.maxConcurrentAssignments), shifts, ...(coordinates ? { coordinates } : {}), ...(cognitoSub ? { cognitoSub } : {}) };
}

export function validateCoordinates(value: unknown, field = "coordinates"): Coordinates {
  const row = object(value, field);
  allowed(row, ["latitude", "longitude", "datum"], field);
  if (typeof row.latitude !== "number" || !Number.isFinite(row.latitude) || row.latitude < -90 || row.latitude > 90) throw new ValidationError([`${field}.latitude must be a WGS84 number from -90 to 90`]);
  if (typeof row.longitude !== "number" || !Number.isFinite(row.longitude) || row.longitude < -180 || row.longitude > 180) throw new ValidationError([`${field}.longitude must be a WGS84 number from -180 to 180`]);
  if (row.datum !== "WGS84") throw new ValidationError([`${field}.datum must be WGS84`]);
  return { latitude: row.latitude, longitude: row.longitude, datum: "WGS84" };
}

export function validatePart(value: unknown) {
  const row = object(value, "body");
  allowed(row, ["partId", "name", "sku", "unit", "minimumStock"], "body");
  if (typeof row.minimumStock !== "number" || !Number.isFinite(row.minimumStock) || row.minimumStock < 0 || row.minimumStock > 1_000_000) throw new ValidationError(["minimumStock must be a finite number from 0 to 1000000"]);
  return { partId: safeId(row.partId, "partId"), name: text(row.name, "name", 1, 160), sku: text(row.sku, "sku", 1, 80), unit: text(row.unit, "unit", 1, 32), minimumStock: row.minimumStock };
}

export function validateMovement(value: unknown) {
  const row = object(value, "body");
  allowed(row, ["partId", "locationId", "quantity", "kind", "reason"], "body");
  const quantity = row.quantity;
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity === 0 || Math.abs(quantity) > 1_000_000) throw new ValidationError(["quantity must be non-zero and within 1000000 units"]);
  if (row.kind !== "receipt" && row.kind !== "adjustment") throw new ValidationError(["kind must be receipt or adjustment"]);
  if (row.kind === "receipt" && quantity < 0) throw new ValidationError(["receipt quantity must be positive"]);
  return { partId: safeId(row.partId, "partId"), locationId: safeId(row.locationId, "locationId"), quantity, kind: row.kind, reason: text(row.reason, "reason", 1, 500) };
}

export function validateReservation(value: unknown) {
  const row = object(value, "body");
  allowed(row, ["partId", "locationId", "quantity", "reason"], "body");
  if (typeof row.quantity !== "number" || !Number.isFinite(row.quantity) || row.quantity <= 0 || row.quantity > 1_000_000) throw new ValidationError(["quantity must be a positive finite number no greater than 1000000"]);
  return { partId: safeId(row.partId, "partId"), locationId: safeId(row.locationId, "locationId"), quantity: row.quantity, reason: text(row.reason, "reason", 1, 500) };
}

export function validateOptimization(value: unknown) {
  const row = object(value, "body");
  allowed(row, ["incidentIds", "requirements", "dispatch"], "body");
  if (row.dispatch !== undefined && typeof row.dispatch !== "boolean") throw new ValidationError(["dispatch must be a boolean"]);
  if (!Array.isArray(row.incidentIds) || row.incidentIds.length < 1 || row.incidentIds.length > 25) throw new ValidationError(["incidentIds must contain 1 to 25 incident identifiers"]);
  const incidentIds = row.incidentIds.map((id, index) => safeId(id, `incidentIds[${index}]`));
  if (new Set(incidentIds).size !== incidentIds.length) throw new ValidationError(["incidentIds must be unique"]);
  const requirements: Record<string, Array<{ code: string; minLevel: number }>> = {};
  if (row.requirements !== undefined) {
    const input = object(row.requirements, "requirements");
    if (Object.keys(input).some((id) => !incidentIds.includes(id))) throw new ValidationError(["requirements may only refer to requested incidents"]);
    for (const [incidentId, values] of Object.entries(input)) {
      if (!Array.isArray(values) || values.length > 12) throw new ValidationError([`requirements.${incidentId} must contain at most 12 skills`]);
      requirements[incidentId] = values.map((item, index) => {
        const skill = object(item, `requirements.${incidentId}[${index}]`);
        allowed(skill, ["code", "minLevel"], `requirements.${incidentId}[${index}]`);
        const code = typeof skill.code === "string" && skillCodePattern.test(skill.code) ? skill.code : "";
        if (!code || !Number.isInteger(skill.minLevel) || Number(skill.minLevel) < 1 || Number(skill.minLevel) > 5) throw new ValidationError([`requirements.${incidentId}[${index}] has an invalid code or minLevel`]);
        return { code, minLevel: Number(skill.minLevel) };
      });
      if (new Set(requirements[incidentId].map((skill) => skill.code)).size !== requirements[incidentId].length) throw new ValidationError([`requirements.${incidentId} has duplicate skill codes`]);
    }
  }
  return { incidentIds, requirements, dispatch: row.dispatch as boolean | undefined };
}

export function validatePolicy(value: unknown) {
  const row = object(value, "body");
  allowed(row, ["weights", "maxDistanceKm", "unmatchedPenalty"], "body");
  const weights = object(row.weights, "weights");
  allowed(weights, ["skill", "workload", "distance"], "weights");
  const parsedWeights = { skill: unitWeight(weights.skill, "weights.skill"), workload: unitWeight(weights.workload, "weights.workload"), distance: unitWeight(weights.distance, "weights.distance") };
  if (parsedWeights.skill + parsedWeights.workload + parsedWeights.distance <= 0) throw new ValidationError(["At least one assignment cost weight must be greater than zero"]);
  if (typeof row.maxDistanceKm !== "number" || !Number.isFinite(row.maxDistanceKm) || row.maxDistanceKm <= 0 || row.maxDistanceKm > 20_000) throw new ValidationError(["maxDistanceKm must be between 0 and 20000"]);
  const unmatchedPenalty = object(row.unmatchedPenalty, "unmatchedPenalty");
  allowed(unmatchedPenalty, ["info", "warning", "critical"], "unmatchedPenalty");
  const parsedPenalty = { info: unitWeight(unmatchedPenalty.info, "unmatchedPenalty.info"), warning: unitWeight(unmatchedPenalty.warning, "unmatchedPenalty.warning"), critical: unitWeight(unmatchedPenalty.critical, "unmatchedPenalty.critical") };
  if (parsedPenalty.info > parsedPenalty.warning || parsedPenalty.warning > parsedPenalty.critical) throw new ValidationError(["unmatchedPenalty must be non-decreasing from info to critical"]);
  return { weights: parsedWeights, maxDistanceKm: row.maxDistanceKm, unmatchedPenalty: parsedPenalty };
}

export function validatePage(query: Record<string, string | undefined>) {
  const limitText = query.limit ?? "25";
  if (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 100) throw new ValidationError(["limit must be an integer from 1 to 100"]);
  if (query.cursor && query.cursor.length > 4096) throw new ValidationError(["cursor is too long"]);
  return { limit: Number(limitText), cursor: query.cursor };
}

export function safeId(value: unknown, field: string) {
  if (typeof value !== "string" || !idPattern.test(value.trim())) throw new ValidationError([`${field} must contain 1 to 100 safe characters`]);
  return value.trim();
}
function text(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw new ValidationError([`${field} must contain ${min} to ${max} characters`]);
  return value.trim();
}
function stringList(value: unknown, field: string, min: number, max: number, itemMax: number) {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > itemMax)) throw new ValidationError([`${field} must contain ${min} to ${max} non-empty strings`]);
  const values = value.map((item) => (item as string).trim());
  if (new Set(values).size !== values.length) throw new ValidationError([`${field} contains duplicates`]);
  return values;
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError([`${field} must be an object`]);
  return value as Record<string, unknown>;
}
function allowed(value: Record<string, unknown>, keys: string[], field: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new ValidationError([`${field} contains unsupported fields`]);
}
function unitWeight(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new ValidationError([`${field} must be a finite number from 0 to 1`]);
  return value;
}
