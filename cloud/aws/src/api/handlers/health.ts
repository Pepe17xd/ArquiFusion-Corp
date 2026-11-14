import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handleRequest } from "../http";

export function createHealthHandlers() {
  return { health: (event: APIGatewayProxyEventV2) => handleRequest(event, "system.health", async () => ({ status: "ok" })) };
}
