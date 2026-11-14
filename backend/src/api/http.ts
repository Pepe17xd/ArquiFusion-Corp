import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { ValidationError } from "../core/machine";
import { NotFoundError } from "../core/errors";
import { AuthenticationError, TenantAccessError } from "../tenancy/contracts";

export function jsonResponse(statusCode: number, data: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: statusCode === 204 ? "" : JSON.stringify({ data }),
  };
}

export function requestBody(event: APIGatewayProxyEventV2): string {
  const body = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
}

export async function handleRequest(operation: () => Promise<unknown>): Promise<APIGatewayProxyResultV2> {
  try { return jsonResponse(200, await operation()); }
  catch (error) {
    if (error instanceof ValidationError) return jsonResponse(400, { error: "Validation error", details: error.issues });
    if (error instanceof NotFoundError) return jsonResponse(404, { error: error.message });
    if (error instanceof AuthenticationError) return jsonResponse(401, { error: error.message });
    if (error instanceof TenantAccessError) return jsonResponse(403, { error: error.message });
    console.error("api_request_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return jsonResponse(500, { error: "Internal server error" });
  }
}
