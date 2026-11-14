import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ValidationError } from "../core/machine";
import { IngestionService } from "../ingestion/service";
import { FleetService } from "../fleet/service";
import { getFleetMetrics } from "../metrics/service";
import { LangGraphFleetIntelligence } from "../intelligence/fleet-graph";
import { collectAllMachines, type MachineRepository, type OriginalFileStore } from "../storage/contracts";
import { createStorage } from "../storage";
import { handleRequest, jsonResponse, requestBody } from "./http";
import { AgentSupervisor } from "../supervisor/supervisor";
import { LocalTaskStore } from "../supervisor/local-task-store";
import { PermanentTaskError, type TaskStore } from "../supervisor/contracts";
import { listAgents } from "../supervisor/registry";
import { NotFoundError } from "../core/errors";
import { AuthenticationError, TenantAccessError, type TenantDirectory, type TenantRole } from "../tenancy/contracts";
import { LocalTenantDirectory, LOCAL_USER_SUB } from "../tenancy/local-tenant-directory";
import { resolve } from "node:path";

export interface ApiServices { machines: MachineRepository; originals: OriginalFileStore; tenants?: TenantDirectory; authMode?: "local" | "cognito"; storageMode?: "local" | "cloud"; tasks?: TaskStore; dispatcher?: import("../supervisor/contracts").TaskDispatcher }

export function createApiHandlers(services: ApiServices = createStorage()) {
  const authMode = services.authMode ?? "local";
  if (authMode === "cognito" && !services.tenants) throw new Error("Cognito mode requires a persistent tenant directory");
  if (services.storageMode === "cloud" && !services.tasks) throw new Error("Cloud mode requires a persistent task store");
  const ingestion = new IngestionService(services.machines, services.originals);
  const fleet = new FleetService(services.machines);
  const intelligenceService = new LangGraphFleetIntelligence();
  const supervisor = new AgentSupervisor(services.tasks ?? new LocalTaskStore(), services.machines, intelligenceService, undefined, services.dispatcher);
  const tenants = services.tenants ?? new LocalTenantDirectory(resolve(process.cwd(), "backend/data/tenants.json"));
  const authenticatedUser = async (event: APIGatewayProxyEventV2) => {
    const claims = (event.requestContext as unknown as { authorizer?: { jwt?: { claims?: Record<string, unknown> } } }).authorizer?.jwt?.claims;
    const userSub = authMode === "local" ? LOCAL_USER_SUB : typeof claims?.sub === "string" ? claims.sub : undefined;
    if (!userSub) throw new AuthenticationError();
    return userSub;
  };
  const context = async (event: APIGatewayProxyEventV2, requiredRole: TenantRole = "viewer") => {
    const userSub = await authenticatedUser(event);
    const requestedTenantId = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "x-tenant-id")?.[1];
    const resolved = await tenants.resolve(userSub, typeof requestedTenantId === "string" && requestedTenantId ? requestedTenantId : undefined);
    const roleLevel: Record<TenantRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
    if (!(resolved.role in roleLevel) || roleLevel[resolved.role] < roleLevel[requiredRole]) throw new TenantAccessError("This operation requires the " + requiredRole + " role or higher");
    return resolved;
  };

  async function health() { return jsonResponse(200, { status: "ok" }); }

  async function ingestCsv(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => ingestion.ingest(requestBody(event), "csv", "text/csv", (await context(event, "operator")).tenantId));
  }

  async function ingestJson(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => ingestion.ingest(requestBody(event), "json", "application/json", (await context(event, "operator")).tenantId));
  }

  async function listMachines(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => {
      return fleet.list((await context(event)).tenantId, event.queryStringParameters ?? {});
    });
  }

  async function getMachine(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => {
      const id = event.pathParameters?.machineId;
      if (!id) throw new ValidationError(["machineId is required"]);
      return fleet.get((await context(event)).tenantId, id);
    });
  }

  async function metrics(event: APIGatewayProxyEventV2) { return handleRequest(async () => getFleetMetrics(services.machines, (await context(event)).tenantId)); }

  async function intelligence(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => intelligenceService.recommend({ machines: await collectAllMachines(services.machines, (await context(event)).tenantId) }));
  }

  async function agents(event: APIGatewayProxyEventV2) { return handleRequest(async () => { await context(event); return listAgents(); }); }
  async function submitTask(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => {
      let body: unknown;
      try { body = JSON.parse(requestBody(event)); }
      catch { throw new ValidationError(["Body must be valid JSON"]); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError(["Body must be an object"]);
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some((key) => !["taskType", "idempotencyKey", "correlationId"].includes(key))) throw new ValidationError(["Body contains unsupported fields"]);
      if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200)) throw new ValidationError(["idempotencyKey must be a non-empty string of at most 200 characters"]);
      if (input.correlationId !== undefined && (typeof input.correlationId !== "string" || !input.correlationId.trim() || input.correlationId.length > 200)) throw new ValidationError(["correlationId must be a non-empty string of at most 200 characters"]);
      if (services.storageMode === "cloud" && !services.dispatcher) throw new Error("TASK_STATE_MACHINE_ARN is required for cloud task submission");
      try { return await supervisor.submit({ tenantId: (await context(event, "operator")).tenantId, taskType: input.taskType, idempotencyKey: input.idempotencyKey as string | undefined, correlationId: input.correlationId as string | undefined }); }
      catch (error) { if (error instanceof PermanentTaskError) throw new ValidationError([error.message]); throw error; }
    });
  }
  async function tasks(event: APIGatewayProxyEventV2) { return handleRequest(async () => supervisor.list((await context(event)).tenantId)); }
  async function getTask(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => {
      const taskId = event.pathParameters?.taskId;
      if (!taskId) throw new ValidationError(["taskId is required"]);
      const task = await supervisor.get((await context(event)).tenantId, taskId);
      if (!task) throw new NotFoundError("Task not found");
      return task;
    });
  }
  async function taskEvents(event: APIGatewayProxyEventV2) { return handleRequest(async () => supervisor.events((await context(event)).tenantId, event.queryStringParameters?.taskId)); }
  async function listTenants(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => tenants.listForUser(await authenticatedUser(event)));
  }
  async function createTenant(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => {
      const userSub = await authenticatedUser(event);
      let body: unknown;
      try { body = JSON.parse(requestBody(event)); } catch { throw new ValidationError(["Body must be valid JSON"]); }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "name") || typeof (body as Record<string, unknown>).name !== "string") throw new ValidationError(["Body must contain only a tenant name"]);
      return tenants.createTenant(userSub, (body as { name: string }).name);
    });
  }
  async function operationsOverview(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => {
      const tenantId = (await context(event)).tenantId;
      const [fleetMetrics, taskList, eventList] = await Promise.all([getFleetMetrics(services.machines, tenantId), supervisor.list(tenantId), supervisor.events(tenantId)]);
      return {
        generatedAt: new Date().toISOString(), fleet: fleetMetrics,
        agents: supervisor.agents().map(({ id, name, specialty, status, version, capabilities }) => ({ id, name, specialty, status, version, capabilities })),
        tasks: { total: taskList.length, pending: taskList.filter((task) => ["PENDING", "QUEUED", "RUNNING", "RETRYING"].includes(task.state)).length, succeeded: taskList.filter((task) => task.state === "SUCCEEDED").length, failed: taskList.filter((task) => ["FAILED", "DEAD_LETTER"].includes(task.state)).length, deadLetter: taskList.filter((task) => task.state === "DEAD_LETTER").length },
        recentEvents: eventList.slice(-20).reverse(), domains: { inventory: "planned", technicianAssignment: "planned", incidents: "planned" },
      };
    });
  }

  async function runTask(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid workflow input");
    const payload = input as Record<string, unknown>;
    if (typeof payload.tenantId !== "string" || typeof payload.taskId !== "string") throw new Error("Invalid workflow input");
    await supervisor.executeTask(payload.tenantId, payload.taskId);
    return supervisor.get(payload.tenantId, payload.taskId);
  }
  async function markTaskDeadLetter(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid workflow input");
    const payload = input as Record<string, unknown>;
    if (typeof payload.tenantId !== "string" || typeof payload.taskId !== "string") throw new Error("Invalid workflow input");
    return supervisor.markWorkflowFailure({ tenantId: payload.tenantId, taskId: payload.taskId });
  }

  return { health, ingestCsv, ingestJson, listMachines, getMachine, metrics, intelligence, agents, submitTask, tasks, getTask, taskEvents, operationsOverview, listTenants, createTenant, runTask, markTaskDeadLetter };
}

const defaultHandlers = createApiHandlers();
export const health = defaultHandlers.health;
export const ingestCsv = defaultHandlers.ingestCsv;
export const ingestJson = defaultHandlers.ingestJson;
export const listMachines = defaultHandlers.listMachines;
export const getMachine = defaultHandlers.getMachine;
export const metrics = defaultHandlers.metrics;
export const intelligence = defaultHandlers.intelligence;
export const agents = defaultHandlers.agents;
export const submitTask = defaultHandlers.submitTask;
export const tasks = defaultHandlers.tasks;
export const getTask = defaultHandlers.getTask;
export const taskEvents = defaultHandlers.taskEvents;
export const operationsOverview = defaultHandlers.operationsOverview;
export const listTenants = defaultHandlers.listTenants;
export const createTenant = defaultHandlers.createTenant;
export const runTask = defaultHandlers.runTask;
export const markTaskDeadLetter = defaultHandlers.markTaskDeadLetter;
