import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createIntelligenceProvider } from "../../intelligence/factory";
import { OperationsService } from "../../operations/service";
import { createOperationsHandlers } from "../handlers/operations";
import { createDomainRuntime } from "./runtime";

let handlers: ReturnType<typeof createHandlers> | undefined;
function createHandlers() {
  const runtime = createDomainRuntime("operations");
  const service = new OperationsService(runtime.operations(), runtime.machines(), runtime.operationsDispatcher(), createIntelligenceProvider());
  return createOperationsHandlers(service, runtime.auth);
}
function getHandlers() { return handlers ??= createHandlers(); }
export const telemetryBatch = (event: APIGatewayProxyEventV2) => getHandlers().telemetryBatch(event);
export const telemetry = (event: APIGatewayProxyEventV2) => getHandlers().telemetry(event);
export const latestTelemetry = (event: APIGatewayProxyEventV2) => getHandlers().latestTelemetry(event);
export const anomalies = (event: APIGatewayProxyEventV2) => getHandlers().anomalies(event);
export const getAnomaly = (event: APIGatewayProxyEventV2) => getHandlers().getAnomaly(event);
export const explainAnomaly = (event: APIGatewayProxyEventV2) => getHandlers().explainAnomaly(event);
export const getAnomalyRules = (event: APIGatewayProxyEventV2) => getHandlers().getAnomalyRules(event);
export const putAnomalyRules = (event: APIGatewayProxyEventV2) => getHandlers().putAnomalyRules(event);
export const createIncident = (event: APIGatewayProxyEventV2) => getHandlers().createIncident(event);
export const incidents = (event: APIGatewayProxyEventV2) => getHandlers().incidents(event);
export const createIncidentMaintenanceOrder = (event: APIGatewayProxyEventV2) => getHandlers().createIncidentMaintenanceOrder(event);
export const updateIncident = (event: APIGatewayProxyEventV2) => getHandlers().updateIncident(event);
export const maintenanceOrders = (event: APIGatewayProxyEventV2) => getHandlers().maintenanceOrders(event);
export const updateMaintenanceOrder = (event: APIGatewayProxyEventV2) => getHandlers().updateMaintenanceOrder(event);
export const operationalEvents = (event: APIGatewayProxyEventV2) => getHandlers().operationalEvents(event);
export const processAnomaly = (input: unknown) => getHandlers().processAnomaly(input);
