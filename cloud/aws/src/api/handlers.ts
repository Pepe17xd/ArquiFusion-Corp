import { ValidationError } from "../core/machine";
import { createStorage } from "../storage";
import { IngestionService } from "../ingestion/service";
import { FleetService } from "../fleet/service";
import { LangGraphFleetIntelligence } from "../intelligence/fleet-graph";
import { AgentSupervisor } from "../supervisor/supervisor";
import { LocalTaskStore } from "../supervisor/local-task-store";
import type { TaskDispatcher, TaskStore } from "../supervisor/contracts";
import type { MachineRepository, OriginalFileStore } from "../storage/contracts";
import type { TenantDirectory } from "../tenancy/contracts";
import type { AccessTokenVerifier } from "../security/cognito-token-verifier";
import { LocalTenantDirectory } from "../tenancy/local-tenant-directory";
import { resolve } from "node:path";
import { createRequestAuthorizer } from "./request-authorizer";
import { createHealthHandlers } from "./handlers/health";
import { createIngestionHandlers } from "./handlers/ingestion";
import { createFleetHandlers } from "./handlers/fleet";
import { createMetricsHandlers } from "./handlers/metrics";
import { createIntelligenceHandlers } from "./handlers/intelligence";
import { createTenantHandlers } from "./handlers/tenants";
import { createSupervisorHandlers } from "./handlers/supervisor";

export interface ApiServices {
  machines: MachineRepository;
  originals: OriginalFileStore;
  tenants?: TenantDirectory;
  authMode?: "local" | "cognito";
  storageMode?: "local" | "cloud";
  tasks?: TaskStore;
  dispatcher?: TaskDispatcher;
  tokenVerifier?: AccessTokenVerifier;
}

/** Composition root only: domain HTTP adapters live in separate handler modules. */
export function createApiHandlers(services: ApiServices = createStorage()) {
  const authMode = services.authMode ?? "local";
  if (authMode === "cognito" && (!services.tenants || !services.tokenVerifier)) throw new Error("Cognito mode requires persistent tenant storage and a cryptographic access token verifier");
  if (services.storageMode === "cloud" && (!services.tasks || !services.dispatcher || authMode !== "cognito")) throw new Error("Cloud mode requires persistent task storage, a durable dispatcher and Cognito authentication");
  const tenants = services.tenants ?? new LocalTenantDirectory(resolve(__dirname, "../../data/tenants.json"));
  const machines = services.machines;
  const originals = services.originals;
  const ingestion = new IngestionService(machines, originals);
  const fleet = new FleetService(machines);
  const intelligence = new LangGraphFleetIntelligence();
  const tasks = services.tasks ?? new LocalTaskStore();
  const supervisor = new AgentSupervisor(tasks, machines, intelligence, undefined, services.dispatcher);
  const auth = createRequestAuthorizer({ authMode, tenants, tokenVerifier: services.tokenVerifier });

  return Object.assign(
    createHealthHandlers(),
    createIngestionHandlers(ingestion, auth),
    createFleetHandlers(fleet, auth),
    createMetricsHandlers(machines, auth),
    createIntelligenceHandlers(intelligence, machines, auth),
    createTenantHandlers(tenants, auth),
    createSupervisorHandlers(supervisor, machines, tasks, auth),
  );
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

export { ValidationError };
