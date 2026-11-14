import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ValidationError } from "../core/machine";
import { IngestionService } from "../ingestion/service";
import { FleetService } from "../fleet/service";
import { getFleetMetrics } from "../metrics/service";
import { LangGraphFleetIntelligence } from "../intelligence/fleet-graph";
import { collectAllMachines, type MachineRepository, type OriginalFileStore } from "../storage/contracts";
import { createStorage } from "../storage";
import { handleRequest, jsonResponse, requestBody } from "./http";

export interface ApiServices { machines: MachineRepository; originals: OriginalFileStore }

export function createApiHandlers(services: ApiServices = createStorage()) {
  const ingestion = new IngestionService(services.machines, services.originals);
  const fleet = new FleetService(services.machines);
  const intelligenceService = new LangGraphFleetIntelligence();

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

  return { health, ingestCsv, ingestJson, listMachines, getMachine, metrics, intelligence };
}

const defaultHandlers = createApiHandlers();
export const health = defaultHandlers.health;
export const ingestCsv = defaultHandlers.ingestCsv;
export const ingestJson = defaultHandlers.ingestJson;
export const listMachines = defaultHandlers.listMachines;
export const getMachine = defaultHandlers.getMachine;
export const metrics = defaultHandlers.metrics;
export const intelligence = defaultHandlers.intelligence;
