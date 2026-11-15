import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ValidationError } from "../../core/machine";
import { NotFoundError } from "../../core/errors";
import { TenantConflictError } from "../../tenancy/contracts";
import type { OperationsService } from "../../operations/service";
import type { RequestAuthorizer } from "../request-authorizer";
import { handleRequest, requestBody } from "../http";
import { normalizeIdempotencyKey, validateBatch, validatePageQuery, validateRules } from "../../operations/validation";

const MAX_BODY_BYTES = 256 * 1024;

export function createOperationsHandlers(service: OperationsService, auth: RequestAuthorizer) {
  return {
    telemetryBatch: (event: APIGatewayProxyEventV2) => handleRequest(event, "operations.telemetry.batch", async (telemetry) => {
      const tenantId = (await auth.tenant(event, telemetry, "operator", "arquifusion/write")).tenantId;
      const raw = requestBody(event);
      if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new ValidationError(["Request body exceeds the 256 KiB limit"]);
      const key = header(event, "idempotency-key");
      const readings = validateBatch(parseJson(raw));
      return service.ingestBatch(tenantId, normalizeIdempotencyKey(key), readings);
    }),
    telemetry: (event: APIGatewayProxyEventV2) => handleRequest(event, "operations.telemetry.list", async (telemetry) => {
      const tenantId = (await auth.tenant(event, telemetry)).tenantId;
      const query = event.queryStringParameters ?? {};
      assertQuery(query, ["machineId", "limit", "cursor"]);
      const { limit, cursor } = validatePageQuery(query);
      const machineId = query.machineId?.trim();
      if (!machineId) throw new ValidationError(["machineId query parameter is required for telemetry history"]);
      return service.list(tenantId, "TELEMETRY", limit, cursor, machineId);
    }),
    latestTelemetry: (event: APIGatewayProxyEventV2) => handleRequest(event, "operations.telemetry.latest", async (telemetry) => {
      const tenantId = (await auth.tenant(event, telemetry)).tenantId;
      const query = event.queryStringParameters ?? {};
      assertQuery(query, ["machineId"]);
      const machineId = query.machineId?.trim();
      if (!machineId) throw new ValidationError(["machineId query parameter is required"]);
      return service.list(tenantId, "TELEMETRY", 1, undefined, machineId).then((page) => page.items[0] ?? null);
    }),
    anomalies: (event: APIGatewayProxyEventV2) => listByType(event, auth, service, "ANOMALY", "operations.anomalies.list"),
    getAnomaly: (event: APIGatewayProxyEventV2) => handleRequest(event, "operations.anomalies.get", async (telemetry) => {
      const tenantId = (await auth.tenant(event, telemetry)).tenantId;
      const anomalyId = event.pathParameters?.anomalyId;
      if (!anomalyId) throw new ValidationError(["anomalyId is required"]);
      const anomaly = await service.get(tenantId, "ANOMALY", anomalyId);
      if (!anomaly) throw new NotFoundError("Anomaly not found");
      return anomaly;
    }),
    explainAnomaly: (event: APIGatewayProxyEventV2) => handleRequest(event, "operations.anomalies.explain", async (telemetry) => {
      const tenantId = (await auth.tenant(event, telemetry, "operator", "arquifusion/write")).tenantId;
      if (requestBody(event).trim() && requestBody(event).trim() !== "{}") throw new ValidationError(["Explanation request does not accept a body"]);
      const anomalyId = event.pathParameters?.anomalyId;
      if (!anomalyId) throw new ValidationError(["anomalyId is required"]);
      return service.explainAnomaly(tenantId, anomalyId);
    }),
    getAnomalyRules: (event: APIGatewayProxyEventV2) => handleRequest(event, "operations.anomaly-rules.get", async (telemetry) => {
      const tenantId = (await auth.tenant(event, telemetry)).tenantId;
      return service.rules(tenantId);
    }),
    putAnomalyRules: (event: APIGatewayProxyEventV2) => handleRequest(event, "operations.anomaly-rules.put", async (telemetry) => {
      const tenantId = (await auth.tenant(event, telemetry, "admin", "arquifusion/write")).tenantId;
      const raw = requestBody(event);
      if (Buffer.byteLength(raw, "utf8") > 32 * 1024) throw new ValidationError(["Request body exceeds the 32 KiB limit"]);
      return service.saveRules(tenantId, validateRules(parseJson(raw)));
    }),
    incidents: (event: APIGatewayProxyEventV2) => listByType(event, auth, service, "INCIDENT", "operations.incidents.list"),
    updateIncident: (event: APIGatewayProxyEventV2) => handleRequest(event, "operations.incidents.update", async (telemetry) => {
      const tenantId = (await auth.tenant(event, telemetry, "operator", "arquifusion/write")).tenantId;
      const incidentId = event.pathParameters?.incidentId;
      if (!incidentId) throw new ValidationError(["incidentId is required"]);
      const body = parseUpdateBody(requestBody(event), ["status", "assignedTo", "resolution"]);
      const expectedVersion = parseVersion(header(event, "if-match"));
      if (body.status !== undefined && !["open", "acknowledged", "resolved"].includes(String(body.status))) throw new ValidationError(["status must be open, acknowledged or resolved"]);
      if (body.assignedTo !== undefined && body.assignedTo !== null && (typeof body.assignedTo !== "string" || body.assignedTo.length > 128)) throw new ValidationError(["assignedTo must be a string, null or omitted"]);
      if (body.resolution !== undefined && (typeof body.resolution !== "string" || body.resolution.length > 2000)) throw new ValidationError(["resolution must be at most 2000 characters"]);
      return service.updateIncident(tenantId, incidentId, { expectedVersion, status: body.status as "open" | "acknowledged" | "resolved" | undefined, assignedTo: body.assignedTo as string | null | undefined, resolution: body.resolution as string | undefined });
    }),
    maintenanceOrders: (event: APIGatewayProxyEventV2) => listByType(event, auth, service, "WORK_ORDER", "operations.maintenance.list"),
    updateMaintenanceOrder: (event: APIGatewayProxyEventV2) => handleRequest(event, "operations.maintenance.update", async (telemetry) => {
      const tenantId = (await auth.tenant(event, telemetry, "operator", "arquifusion/write")).tenantId;
      const workOrderId = event.pathParameters?.workOrderId;
      if (!workOrderId) throw new ValidationError(["workOrderId is required"]);
      const body = parseUpdateBody(requestBody(event), ["status", "assignedTechnicianId", "intervention"]);
      const expectedVersion = parseVersion(header(event, "if-match"));
      if (body.status !== undefined && !["planned", "in_progress", "completed", "cancelled"].includes(String(body.status))) throw new ValidationError(["status must be planned, in_progress, completed or cancelled"]);
      if (body.assignedTechnicianId !== undefined && body.assignedTechnicianId !== null && (typeof body.assignedTechnicianId !== "string" || body.assignedTechnicianId.length > 128)) throw new ValidationError(["assignedTechnicianId must be a string, null or omitted"]);
      const intervention = body.intervention === undefined ? undefined : validateIntervention(body.intervention);
      return service.updateWorkOrder(tenantId, workOrderId, { expectedVersion, status: body.status as "planned" | "in_progress" | "completed" | "cancelled" | undefined, assignedTechnicianId: body.assignedTechnicianId as string | null | undefined, intervention });
    }),
    operationalEvents: (event: APIGatewayProxyEventV2) => listByType(event, auth, service, "EVENT", "operations.events.list"),
    processAnomaly: async (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError(["workflow input must be an object"]);
      const value = input as Record<string, unknown>;
      if (Object.keys(value).some((key) => !["tenantId", "anomalyId"].includes(key)) || typeof value.tenantId !== "string" || typeof value.anomalyId !== "string") throw new ValidationError(["workflow input is invalid"]);
      return service.processAnomaly(value.tenantId, value.anomalyId);
    },
  };
}

async function listByType(event: APIGatewayProxyEventV2, auth: RequestAuthorizer, service: OperationsService, type: "ANOMALY" | "INCIDENT" | "WORK_ORDER" | "EVENT", operation: string) {
  return handleRequest(event, operation, async (telemetry) => {
    const tenantId = (await auth.tenant(event, telemetry)).tenantId;
    const query = event.queryStringParameters ?? {};
    assertQuery(query, ["machineId", "limit", "cursor"]);
    const { limit, cursor } = validatePageQuery(query);
    return service.list(tenantId, type, limit, cursor, query.machineId?.trim() || undefined);
  });
}
function parseJson(raw: string): unknown { try { return JSON.parse(raw); } catch { throw new ValidationError(["Body must be valid JSON"]); } }
function parseUpdateBody(raw: string, allowed: string[]) {
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024) throw new ValidationError(["Request body exceeds the 16 KiB limit"]);
  const value = parseJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(["Body must be an object"]);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new ValidationError(["Body contains unsupported fields"]);
  return body;
}
function validateIntervention(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(["intervention must be an object"]);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["occurredAt", "notes"].includes(key))) throw new ValidationError(["intervention contains unsupported fields"]);
  if (typeof item.occurredAt !== "string" || Number.isNaN(Date.parse(item.occurredAt)) || !/[zZ]|[+-]\d{2}:\d{2}$/.test(item.occurredAt)) throw new ValidationError(["intervention.occurredAt must be an ISO 8601 timestamp with timezone"]);
  if (typeof item.notes !== "string" || !item.notes.trim() || item.notes.length > 2000) throw new ValidationError(["intervention.notes must contain 1 to 2000 characters"]);
  return { occurredAt: item.occurredAt, notes: item.notes.trim() };
}
function parseVersion(value?: string) {
  const match = value && /^(?:W\/)?"?(\d+)"?$/.exec(value);
  if (!match) throw new ValidationError(["If-Match header with the current record version is required"]);
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) throw new ValidationError(["If-Match version is invalid"]);
  return version;
}
function header(event: APIGatewayProxyEventV2, name: string) { return Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]; }
function assertQuery(query: Record<string, string | undefined>, allowed: string[]) {
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw new ValidationError(["Query contains unsupported parameters"]);
}
