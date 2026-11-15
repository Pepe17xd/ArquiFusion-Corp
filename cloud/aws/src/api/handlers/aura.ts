import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { NotFoundError } from "../../core/errors";
import { ValidationError } from "../../core/machine";
import type { AuraService } from "../../aura/service";
import { safeId, validateCoordinates, validateMovement, validateOptimization, validatePage, validatePart, validatePolicy, validateReservation, validateTechnician } from "../../aura/validation";
import type { RequestAuthorizer } from "../request-authorizer";
import { handleRequest, requestBody, type RequestTelemetry } from "../http";

const MAX_BODY = 64 * 1024;

export function createAuraHandlers(service: AuraService, auth: RequestAuthorizer) {
  const tenant = (event: APIGatewayProxyEventV2, telemetry: RequestTelemetry, role: "viewer" | "operator" | "admin" = "viewer") => auth.tenant(event, telemetry, role, role === "viewer" ? "arquifusion/read" : "arquifusion/write");
  const list = (type: "TECHNICIAN" | "PART" | "STOCK" | "MOVEMENT" | "RESERVATION" | "ASSIGNMENT" | "EVENT") => (event: APIGatewayProxyEventV2) => handleRequest(event, `aura.${type.toLowerCase()}.list`, async (telemetry) => {
    const tenantId = (await tenant(event, telemetry)).tenantId;
    const query = event.queryStringParameters ?? {};
    if (Object.keys(query).some((key) => !["limit", "cursor"].includes(key))) throw new ValidationError(["Query contains unsupported parameters"]);
    const page = validatePage(query);
    return service.list(tenantId, type, page.limit, page.cursor);
  });
  return {
    technicians: list("TECHNICIAN"),
    saveTechnician: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technicians.save", async (telemetry) => {
      const context = await tenant(event, telemetry, "operator");
      const input = validateTechnician(json(event));
      if (input.cognitoSub && context.role !== "admin" && context.role !== "owner") throw new ValidationError(["Only a tenant administrator may bind a Cognito subject to a technician"]);
      const version = optionalVersion(header(event, "if-match"));
      return service.saveTechnician(context.tenantId, input as unknown as Record<string, unknown>, version ?? null);
    }),
    getTechnician: (event: APIGatewayProxyEventV2) => getRecord(event, telemetry => tenant(event, telemetry), service, "TECHNICIAN", "technicianId"),
    archiveTechnician: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technicians.archive", async (telemetry) => {
      const context = await tenant(event, telemetry, "admin");
      return service.archiveTechnician(context.tenantId, requiredPath(event, "technicianId"), requiredVersion(header(event, "if-match")));
    }),
    putMachineCoordinates: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.machine-coordinates.put", async (telemetry) => {
      const context = await tenant(event, telemetry, "admin");
      const input = json(event);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input as object).some((key) => key !== "coordinates")) throw new ValidationError(["Body must contain only coordinates"]);
      return service.setMachineCoordinates(context.tenantId, requiredPath(event, "machineId"), validateCoordinates((input as Record<string, unknown>).coordinates), optionalVersion(header(event, "if-match")) ?? undefined);
    }),
    parts: list("PART"),
    createPart: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.inventory.part.create", async (telemetry) => service.createPart((await tenant(event, telemetry, "admin")).tenantId, validatePart(json(event)))),
    stock: list("STOCK"),
    inventoryAlerts: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.inventory.alerts", async (telemetry) => {
      const tenantId = (await tenant(event, telemetry)).tenantId, query = event.queryStringParameters ?? {};
      if (Object.keys(query).some((key) => !["limit", "cursor"].includes(key))) throw new ValidationError(["Query contains unsupported parameters"]);
      const page = validatePage(query);
      return service.inventoryAlerts(tenantId, page.limit, page.cursor);
    }),
    movements: list("MOVEMENT"),
    createMovement: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.inventory.movement.create", async (telemetry) => {
      const input = validateMovement(json(event));
      const context = await tenant(event, telemetry, input.kind === "adjustment" ? "admin" : "operator");
      return service.applyStockMovement(context.tenantId, input, requiredIdempotency(event));
    }),
    reserve: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.inventory.reservation.create", async (telemetry) => {
      const tenantId = (await tenant(event, telemetry, "operator")).tenantId;
      return service.reservePart(tenantId, requiredPath(event, "workOrderId"), validateReservation(json(event)), requiredIdempotency(event));
    }),
    releaseReservation: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.inventory.reservation.release", async (telemetry) => service.settleReservation((await tenant(event, telemetry, "operator")).tenantId, requiredPath(event, "reservationId"), "release")),
    optimize: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.assignment.optimize", async (telemetry) => {
      const tenantId = (await tenant(event, telemetry, "operator")).tenantId;
      return service.optimize(tenantId, validateOptimization(json(event)), requiredIdempotency(event));
    }),
    assignments: list("ASSIGNMENT"),
    assignment: (event: APIGatewayProxyEventV2) => getRecord(event, telemetry => tenant(event, telemetry), service, "ASSIGNMENT", "assignmentId"),
    assignmentResponse: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.assignment.respond", async (telemetry) => {
      const context = await tenant(event, telemetry, "operator");
      const userSub = await auth.authenticatedUser(event, "arquifusion/write");
      const body = json(event);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError(["Body must be an object"]);
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some((key) => !["phase", "decision", "reason", "occurredAt", "notes"].includes(key)) || (value.phase !== "confirmation" && value.phase !== "intervention")) throw new ValidationError(["phase and response fields are invalid"]);
      return service.respondToAssignment(context.tenantId, requiredPath(event, "assignmentId"), value.phase, { userSub, role: context.role }, value as never);
    }),
    intervention: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.assignment.intervention", async (telemetry) => {
      const context = await tenant(event, telemetry, "operator");
      const value = json(event) as Record<string, unknown>;
      if (!value || typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt)) || typeof value.notes !== "string" || !value.notes.trim() || Object.keys(value).some((key) => !["occurredAt", "notes"].includes(key))) throw new ValidationError(["occurredAt and notes are required"]);
      return service.closeIntervention(context.tenantId, requiredPath(event, "assignmentId"), { occurredAt: value.occurredAt, notes: value.notes.trim() });
    }),
    policy: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.assignment-policy.get", async (telemetry) => service.policy((await tenant(event, telemetry)).tenantId)),
    savePolicy: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.assignment-policy.save", async (telemetry) => service.savePolicy((await tenant(event, telemetry, "admin")).tenantId, validatePolicy(json(event)), optionalVersion(header(event, "if-match")) ?? null)),
    kpis: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.kpis.get", async (telemetry) => {
      const tenantId = (await tenant(event, telemetry)).tenantId;
      const query = event.queryStringParameters ?? {};
      if (Object.keys(query).some((key) => !["from", "to"].includes(key))) throw new ValidationError(["Query supports only from and to"]);
      if (!query.from || !query.to || !isIsoTimestamp(query.from) || !isIsoTimestamp(query.to) || Date.parse(query.from) >= Date.parse(query.to)) throw new ValidationError(["from and to must be explicit ISO 8601 timestamps with timezone"]);
      return service.kpis(tenantId, query.from, query.to);
    }),
    events: list("EVENT"),
    workflowCapture: async (input: unknown) => {
      const value = workflowInput(input);
      if (typeof value.taskToken !== "string" || typeof value.executionArn !== "string" || (value.phase !== "confirmation" && value.phase !== "intervention") || !Number.isSafeInteger(value.attempt)) throw new ValidationError(["Invalid internal callback state input"]);
      return service.captureCallback({ tenantId: value.tenantId as string, assignmentId: value.assignmentId as string, phase: value.phase, attempt: value.attempt as number, taskToken: value.taskToken, executionArn: value.executionArn });
    },
    workflowNext: async (input: unknown) => { const value = workflowInput(input); return service.nextCandidate(value.tenantId as string, value.assignmentId as string, String(value.reason ?? "Callback timeout or rejection"), Number.isSafeInteger(value.expectedAttempt) ? Number(value.expectedAttempt) : undefined); },
    workflowAccept: async (input: unknown) => { const value = workflowInput(input); const assignment = await service.get(value.tenantId as string, "ASSIGNMENT", value.assignmentId as string); if (!assignment?.technicianId) throw new ValidationError(["Assignment has no technician candidate"]); return service.markAccepted(value.tenantId as string, value.assignmentId as string, String(assignment.technicianId)); },
    workflowClose: async (input: unknown) => { const value = workflowInput(input); return service.closeIntervention(value.tenantId as string, value.assignmentId as string, { occurredAt: value.occurredAt as string, notes: value.notes as string }); },
    workflowFail: async (input: unknown) => { const value = workflowInput(input); return service.failAssignment(value.tenantId as string, value.assignmentId as string, String(value.reason ?? "Workflow timed out")); },
  };
}

async function getRecord(event: APIGatewayProxyEventV2, authorize: (telemetry: RequestTelemetry) => Promise<{ tenantId: string }>, service: AuraService, type: "TECHNICIAN" | "ASSIGNMENT", path: string) {
  return handleRequest(event, `aura.${type.toLowerCase()}.get`, async (telemetry) => {
    const record = await service.get((await authorize(telemetry)).tenantId, type, requiredPath(event, path));
    if (!record) throw new NotFoundError(`${type} not found`);
    return record;
  });
}
function parseJson(raw: string): unknown { try { return JSON.parse(raw); } catch { throw new ValidationError(["Body must be valid JSON"]); } }
function json(event: APIGatewayProxyEventV2) { const raw = requestBody(event); if (Buffer.byteLength(raw, "utf8") > MAX_BODY) throw new ValidationError(["Request body exceeds the 64 KiB limit"]); return parseJson(raw); }
function requiredPath(event: APIGatewayProxyEventV2, key: string) { return safeId(event.pathParameters?.[key], key); }
function header(event: APIGatewayProxyEventV2, name: string) { return Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]; }
function requiredIdempotency(event: APIGatewayProxyEventV2) { const value = header(event, "idempotency-key"); if (!value || !/^[a-zA-Z0-9._:-]{8,128}$/.test(value)) throw new ValidationError(["idempotency-key header with 8 to 128 safe characters is required"]); return value; }
function requiredVersion(value?: string) { const version = optionalVersion(value); if (version === undefined) throw new ValidationError(["If-Match header with current version is required"]); return version; }
function optionalVersion(value?: string): number | undefined { if (!value) return undefined; const match = /^(?:W\/)??"?(\d+)"?$/.exec(value); if (!match || !Number.isSafeInteger(Number(match[1]))) throw new ValidationError(["If-Match must be an integer version"]); return Number(match[1]); }
function workflowInput(input: unknown) { if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError(["Invalid internal workflow input"]); const value = input as Record<string, unknown>; if (typeof value.tenantId !== "string" || typeof value.assignmentId !== "string") throw new ValidationError(["tenantId and assignmentId are required in trusted Step Functions input"]); return value; }
function isIsoTimestamp(value: string) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)); }
