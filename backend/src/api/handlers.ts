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

export interface ApiServices { machines: MachineRepository; originals: OriginalFileStore; tasks?: TaskStore }

export function createApiHandlers(services: ApiServices = createStorage()) {
  const ingestion = new IngestionService(services.machines, services.originals);
  const fleet = new FleetService(services.machines);
  const intelligenceService = new LangGraphFleetIntelligence();
  const supervisor = new AgentSupervisor(services.tasks ?? new LocalTaskStore(), services.machines, intelligenceService);

  async function health() { return jsonResponse(200, { status: "ok" }); }

  async function ingestCsv(event: APIGatewayProxyEventV2) {
    return handleRequest(() => ingestion.ingest(requestBody(event), "csv", "text/csv"));
  }

  async function ingestJson(event: APIGatewayProxyEventV2) {
    return handleRequest(() => ingestion.ingest(requestBody(event), "json", "application/json"));
  }

  async function listMachines(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => {
      return fleet.list(event.queryStringParameters ?? {});
    });
  }

  async function getMachine(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => {
      const id = event.pathParameters?.machineId;
      if (!id) throw new ValidationError(["machineId is required"]);
      return fleet.get(id);
    });
  }

  async function metrics() { return handleRequest(() => getFleetMetrics(services.machines)); }

  async function intelligence() {
    return handleRequest(async () => intelligenceService.recommend({ machines: await collectAllMachines(services.machines) }));
  }

  async function agents() { return jsonResponse(200, listAgents()); }
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
      try { return await supervisor.submit({ taskType: input.taskType, idempotencyKey: input.idempotencyKey as string | undefined, correlationId: input.correlationId as string | undefined }); }
      catch (error) { if (error instanceof PermanentTaskError) throw new ValidationError([error.message]); throw error; }
    });
  }
  async function tasks() { return jsonResponse(200, await supervisor.list()); }
  async function getTask(event: APIGatewayProxyEventV2) {
    return handleRequest(async () => {
      const taskId = event.pathParameters?.taskId;
      if (!taskId) throw new ValidationError(["taskId is required"]);
      const task = await supervisor.get(taskId);
      if (!task) throw new NotFoundError("Task not found");
      return task;
    });
  }
  async function taskEvents(event: APIGatewayProxyEventV2) { return handleRequest(async () => supervisor.events(event.queryStringParameters?.taskId)); }
  async function operationsOverview() {
    return handleRequest(async () => {
      const [fleetMetrics, taskList, eventList] = await Promise.all([getFleetMetrics(services.machines), supervisor.list(), supervisor.events()]);
      return {
        generatedAt: new Date().toISOString(), fleet: fleetMetrics,
        agents: supervisor.agents().map(({ id, name, specialty, status, version, capabilities }) => ({ id, name, specialty, status, version, capabilities })),
        tasks: { total: taskList.length, pending: taskList.filter((task) => ["PENDING", "QUEUED", "RUNNING", "RETRYING"].includes(task.state)).length, succeeded: taskList.filter((task) => task.state === "SUCCEEDED").length, failed: taskList.filter((task) => ["FAILED", "DEAD_LETTER"].includes(task.state)).length, deadLetter: taskList.filter((task) => task.state === "DEAD_LETTER").length },
        recentEvents: eventList.slice(-20).reverse(), domains: { inventory: "planned", technicianAssignment: "planned", incidents: "planned" },
      };
    });
  }

  return { health, ingestCsv, ingestJson, listMachines, getMachine, metrics, intelligence, agents, submitTask, tasks, getTask, taskEvents, operationsOverview };
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
