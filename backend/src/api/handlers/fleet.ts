import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ValidationError } from "../../core/machine";
import type { FleetService } from "../../fleet/service";
import { handleRequest } from "../http";
import type { RequestAuthorizer } from "../request-authorizer";

export function createFleetHandlers(service: FleetService, auth: RequestAuthorizer) {
  return {
    listMachines(event: APIGatewayProxyEventV2) {
      return handleRequest(event, "fleet.list", async (telemetry) => service.list((await auth.tenant(event, telemetry)).tenantId, event.queryStringParameters ?? {}));
    },
    getMachine(event: APIGatewayProxyEventV2) {
      return handleRequest(event, "fleet.get", async (telemetry) => {
        const machineId = event.pathParameters?.machineId;
        if (!machineId) throw new ValidationError(["machineId is required"]);
        return service.get((await auth.tenant(event, telemetry)).tenantId, machineId);
      });
    },
  };
}
