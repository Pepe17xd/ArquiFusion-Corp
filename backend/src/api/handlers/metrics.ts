import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handleRequest } from "../http";
import type { RequestAuthorizer } from "../request-authorizer";
import { getFleetMetrics } from "../../metrics/service";
import type { MachineRepository } from "../../storage/contracts";

export function createMetricsHandlers(machines: MachineRepository, auth: RequestAuthorizer) {
  return { metrics: (event: APIGatewayProxyEventV2) => handleRequest(event, "metrics.read", async (telemetry) => getFleetMetrics(machines, (await auth.tenant(event, telemetry)).tenantId)) };
}
