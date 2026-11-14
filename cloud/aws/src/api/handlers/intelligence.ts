import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { collectAllMachines, type MachineRepository } from "../../storage/contracts";
import type { IntelligenceProvider } from "../../intelligence/contracts";
import { handleRequest } from "../http";
import type { RequestAuthorizer } from "../request-authorizer";
import { listAgents } from "../../supervisor/registry";

export function createIntelligenceHandlers(provider: IntelligenceProvider, machines: MachineRepository, auth: RequestAuthorizer) {
  return {
    intelligence: (event: APIGatewayProxyEventV2) => handleRequest(event, "intelligence.recommend", async (telemetry) => provider.recommend({ machines: await collectAllMachines(machines, (await auth.tenant(event, telemetry)).tenantId) })),
    agents: (event: APIGatewayProxyEventV2) => handleRequest(event, "intelligence.agents", async (telemetry) => { await auth.tenant(event, telemetry); return listAgents(); }),
  };
}
