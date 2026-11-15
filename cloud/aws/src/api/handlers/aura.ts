import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { NotFoundError } from "../../core/errors";
import { TenantAccessError } from "../../tenancy/contracts";
import { ValidationError } from "../../core/machine";
import type { AuraService } from "../../aura/service";
import { safeId, validateCoordinates, validateMovement, validateOptimization, validatePage, validatePart, validatePolicy, validateReservation, validateTechnician } from "../../aura/validation";
import type { RequestAuthorizer } from "../request-authorizer";
import { handleRequest, requestBody, type RequestTelemetry } from "../http";

const MAX_BODY = 64 * 1024;

export function createAuraHandlers(service: AuraService, auth: RequestAuthorizer) {
  const tenant = async (event: APIGatewayProxyEventV2, telemetry: RequestTelemetry, role: "viewer" | "operator" | "admin" = "viewer") => {
    const context = await auth.tenant(event, telemetry, role, role === "viewer" ? "arquifusion/read" : "arquifusion/write");
    if (context.role === "technician") throw new TenantAccessError("Technicians may access only their assigned-work endpoints");
    return context;
  };
  const technician = (event: APIGatewayProxyEventV2, telemetry: RequestTelemetry) => auth.tenant(event, telemetry, "technician", "arquifusion/read");
  const list = (type: "TECHNICIAN" | "PART" | "STOCK" | "MOVEMENT" | "RESERVATION" | "ASSIGNMENT" | "EVENT") => (event: APIGatewayProxyEventV2) => handleRequest(event, `aura.${type.toLowerCase()}.list`, async (telemetry) => {
    const tenantId = (await tenant(event, telemetry)).tenantId;
    const query = event.queryStringParameters ?? {};
    if (Object.keys(query).some((key) => !["limit", "cursor"].includes(key))) throw new ValidationError(["Query contains unsupported parameters"]);
    const page = validatePage(query);
    return service.list(tenantId, type, page.limit, page.cursor);
  });
  return {
    technicians: list("TECHNICIAN"),
    technicianMe: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technician.me", async (telemetry) => {
      const context = await technician(event, telemetry);
      return service.technicianForUser(context.tenantId, context.userSub);
    }),
    technicianWorkOrders: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technician.work-orders", async (telemetry) => {
      const context = await technician(event, telemetry);
      const query = event.queryStringParameters ?? {};
      if (Object.keys(query).some((key) => !["limit", "cursor"].includes(key))) throw new ValidationError(["Query contains unsupported parameters"]);
      const page = validatePage(query);
      return service.technicianWorkOrders(context.tenantId, context.userSub, page.limit, page.cursor);
    }),
    technicianWorkOrderAnalysis: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technician.work-order.analysis", async (telemetry) => {
      const context = await technician(event, telemetry);
      return service.explainTechnicianWorkOrder(context.tenantId, context.userSub, requiredPath(event, "workOrderId"));
    }),
    technicianStartWorkOrder: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technician.work-order.start", async (telemetry) => {
      const context = await technician(event, telemetry);
      return service.updateTechnicianWorkOrder(context.tenantId, context.userSub, requiredPath(event, "workOrderId"), { action: "start" });
    }),
    technicianBlockWorkOrder: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technician.work-order.block", async (telemetry) => {
      const context = await technician(event, telemetry), body = json(event);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body as object).some((key) => key !== "notes") || typeof (body as Record<string, unknown>).notes !== "string") throw new ValidationError(["Body must contain notes"]);
      return service.updateTechnicianWorkOrder(context.tenantId, context.userSub, requiredPath(event, "workOrderId"), { action: "block", notes: (body as { notes: string }).notes });
    }),
    technicianCompleteWorkOrder: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technician.work-order.complete", async (telemetry) => {
      const context = await technician(event, telemetry), body = json(event);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body as object).some((key) => key !== "notes") || typeof (body as Record<string, unknown>).notes !== "string") throw new ValidationError(["Body must contain notes"]);
      return service.completeTechnicianWorkOrder(context.tenantId, context.userSub, requiredPath(event, "workOrderId"), (body as { notes: string }).notes);
    }),
    technicianReservePart: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technician.work-order.reserve", async (telemetry) => {
      const context = await technician(event, telemetry);
      return service.technicianReservePart(context.tenantId, context.userSub, requiredPath(event, "workOrderId"), validateReservation(json(event)), requiredIdempotency(event));
    }),
    technicianConsumeReservation: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technician.work-order.consume", async (telemetry) => {
      const context = await technician(event, telemetry);
      return service.technicianConsumeReservation(context.tenantId, context.userSub, requiredPath(event, "workOrderId"), requiredPath(event, "reservationId"));
    }),
    saveTechnician: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technicians.save", async (telemetry) => {
      const context = await tenant(event, telemetry, "admin");
      const input = validateTechnician(json(event));
      if (input.cognitoSub) throw new ValidationError(["Technician identity must be linked through the Cognito invitation workflow"]);
      const version = optionalVersion(header(event, "if-match"));
      return service.saveTechnician(context.tenantId, input as unknown as Record<string, unknown>, version ?? null);
    }),
    inviteTechnician: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technicians.invite", async (telemetry) => {
      const context = await tenant(event, telemetry, "admin");
      if (event.pathParameters?.tenantId !== context.tenantId) throw new ValidationError(["Path tenant does not match the authenticated membership"]);
      const body = json(event);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError(["Body must be an object"]);
      const value = body as Record<string, unknown>;
      if (typeof value.email !== "string" || value.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim()) || value.cognitoSub !== undefined) throw new ValidationError(["A valid email is required; Cognito subject is assigned by the invitation flow"]);
      const { email: _email, ...profile } = value;
      const technician = validateTechnician(profile);
      return service.inviteTechnician(context.tenantId, { ...technician, email: value.email.trim().toLowerCase() }, requiredIdempotency(event));
    }),
    updateTechnician: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.technicians.update", async (telemetry) => {
      const context = await tenant(event, telemetry, "admin");
      const technicianId = requiredPath(event, "technicianId");
      const rawBody = requestBody(event);
      if (!rawBody.trim() || rawBody.trim() === '{"action":"deactivate"}') return service.archiveTechnician(context.tenantId, technicianId, requiredVersion(header(event, "if-match")));
      const input = validateTechnician(json(event));
      if (input.technicianId !== technicianId || input.cognitoSub) throw new ValidationError(["technicianId must match the path and cognitoSub cannot be changed"]);
      return service.saveTechnician(context.tenantId, input as unknown as Record<string, unknown>, requiredVersion(header(event, "if-match")));
    }),
    getTechnician: (event: APIGatewayProxyEventV2) => getRecord(event, telemetry => tenant(event, telemetry), service, "TECHNICIAN", "technicianId"),
    putMachineCoordinates: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.machine-coordinates.put", async (telemetry) => {
      const context = await tenant(event, telemetry, "admin");
      const input = json(event);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input as object).some((key) => key !== "coordinates")) throw new ValidationError(["Body must contain only coordinates"]);
      return service.setMachineCoordinates(context.tenantId, requiredPath(event, "machineId"), validateCoordinates((input as Record<string, unknown>).coordinates), optionalVersion(header(event, "if-match")) ?? undefined);
    }),
    parts: list("PART"),
    createPart: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.inventory.part.create", async (telemetry) => service.createPart((await tenant(event, telemetry, "admin")).tenantId, validatePart(json(event)))),
    updatePart: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.inventory.part.update", async (telemetry) => {
      const context = await tenant(event, telemetry, "admin"), partId = requiredPath(event, "partId"), input = validatePart(json(event));
      if (input.partId !== partId) throw new ValidationError(["partId must match the path"]);
      return service.updatePart(context.tenantId, partId, input, requiredVersion(header(event, "if-match")));
    }),
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
      const context = await tenantOrTechnician(event, telemetry, auth);
      const userSub = await auth.authenticatedUser(event, "arquifusion/write");
      const body = json(event);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError(["Body must be an object"]);
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some((key) => !["phase", "decision", "reason", "occurredAt", "notes"].includes(key)) || (value.phase !== "confirmation" && value.phase !== "intervention")) throw new ValidationError(["phase and response fields are invalid"]);
      return service.respondToAssignment(context.tenantId, requiredPath(event, "assignmentId"), value.phase, { userSub, role: context.role }, value as never);
    }),
    approveAssignment: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.assignment.approve", async (telemetry) => {
      const context = await tenant(event, telemetry, "admin");
      const body = json(event);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body as object).some((key) => key !== "technicianId")) throw new ValidationError(["Body may contain only technicianId"]);
      const technicianId = (body as Record<string, unknown>).technicianId;
      if (technicianId !== undefined && typeof technicianId !== "string") throw new ValidationError(["technicianId must be a string"]);
      return service.approveAssignment(context.tenantId, context.userSub, requiredPath(event, "assignmentId"), technicianId as string | undefined, optionalVersion(header(event, "if-match")), requiredIdempotency(event));
    }),
    reviewWorkOrder: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.maintenance.review", async (telemetry) => {
      const context = await tenant(event, telemetry, "admin"), body = json(event);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError(["Body must be an object"]);
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some((key) => !["decision", "notes"].includes(key)) || (value.decision !== "approve" && value.decision !== "return") || typeof value.notes !== "string" || !value.notes.trim() || value.notes.length > 2000) throw new ValidationError(["decision and review notes are required"]);
      return service.reviewWorkOrder(context.tenantId, context.userSub, requiredPath(event, "workOrderId"), value.decision, value.notes);
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
    events: (event: APIGatewayProxyEventV2) => handleRequest(event, "aura.events.list", async (telemetry) => {
      const tenantId = (await tenant(event, telemetry)).tenantId, query = event.queryStringParameters ?? {};
      const allowed = ["limit", "cursor", "from", "to", "eventType", "status", "error", "search"];
      if (Object.keys(query).some((key) => !allowed.includes(key))) throw new ValidationError(["Query contains unsupported parameters"]);
      const page = validatePage(query);
      for (const field of ["from", "to"] as const) if (query[field] && (!/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(query[field]!) || Number.isNaN(Date.parse(query[field]!)))) throw new ValidationError([`${field} must be an ISO date or UTC timestamp`]);
      if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) throw new ValidationError(["from must not be after to"]);
      if (query.error !== undefined && !["true", "false"].includes(query.error)) throw new ValidationError(["error must be true or false"]);
      const text = (key: string, max: number) => { const value = query[key]?.trim(); if (value && value.length > max) throw new ValidationError([`${key} is too long`]); return value || undefined; };
      return service.listEvents(tenantId, { from: query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? `${query.from}T00:00:00.000Z` : query.from, to: query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? `${query.to}T23:59:59.999Z` : query.to, eventType: text("eventType", 128), status: text("status", 64), error: query.error === undefined ? undefined : query.error === "true", search: text("search", 128) }, page.limit, page.cursor);
    }),
    workflowCapture: async (input: unknown) => {
      const value = workflowInput(input);
      if (typeof value.taskToken !== "string" || typeof value.executionArn !== "string" || (value.phase !== "confirmation" && value.phase !== "intervention") || !Number.isSafeInteger(value.attempt)) throw new ValidationError(["Invalid internal callback state input"]);
      return service.captureCallback({ tenantId: value.tenantId as string, assignmentId: value.assignmentId as string, phase: value.phase, attempt: value.attempt as number, taskToken: value.taskToken, executionArn: value.executionArn });
    },
    workflowNext: async (input: unknown) => { const value = workflowInput(input); return service.nextCandidate(value.tenantId as string, value.assignmentId as string, String(value.reason ?? "Callback timeout or rejection"), Number.isSafeInteger(value.expectedAttempt) ? Number(value.expectedAttempt) : undefined); },
    workflowAccept: async (input: unknown) => { const value = workflowInput(input); const assignment = await service.get(value.tenantId as string, "ASSIGNMENT", value.assignmentId as string); if (!assignment?.technicianId) throw new ValidationError(["Assignment has no technician candidate"]); return service.markAccepted(value.tenantId as string, value.assignmentId as string, String(assignment.technicianId)); },
    workflowClose: async (input: unknown) => { const value = workflowInput(input); return service.closeIntervention(value.tenantId as string, value.assignmentId as string, { occurredAt: value.occurredAt as string, notes: value.notes as string }); },
    workflowFail: async (input: unknown) => { const value = workflowInput(input); return service.failAssignment(value.tenantId as string, value.assignmentId as string, String(value.reason ?? "Workflow timed out"), value.phase === "intervention" ? "intervention" : "confirmation"); },
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
async function tenantOrTechnician(event: APIGatewayProxyEventV2, telemetry: RequestTelemetry, auth: RequestAuthorizer) {
  try { return await auth.tenant(event, telemetry, "operator", "arquifusion/write"); }
  catch (error) { if (!(error instanceof TenantAccessError)) throw error; return auth.tenant(event, telemetry, "technician", "arquifusion/write"); }
}
function isIsoTimestamp(value: string) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)); }
