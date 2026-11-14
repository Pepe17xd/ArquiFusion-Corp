import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handleRequest, requestBody } from "../http";
import type { RequestAuthorizer } from "../request-authorizer";
import type { IngestionService } from "../../ingestion/service";

export function createIngestionHandlers(service: IngestionService, auth: RequestAuthorizer) {
  return {
    ingestCsv(event: APIGatewayProxyEventV2) {
      return handleRequest(event, "ingestion.csv", async (telemetry) => service.ingest(requestBody(event), "csv", "text/csv", (await auth.tenant(event, telemetry, "operator", "arquifusion/write")).tenantId));
    },
    ingestJson(event: APIGatewayProxyEventV2) {
      return handleRequest(event, "ingestion.json", async (telemetry) => service.ingest(requestBody(event), "json", "application/json", (await auth.tenant(event, telemetry, "operator", "arquifusion/write")).tenantId));
    },
  };
}
