import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { ValidationError } from "../core/machine";
import { NotFoundError } from "../core/errors";
import { AuthenticationError, TenantAccessError, TenantConflictError } from "../tenancy/contracts";
import { TaskDispatchError } from "../supervisor/contracts";
import { randomUUID } from "node:crypto";
import { OperationalConflictError, OperationalWorkflowDispatchError } from "../operations/contracts";

export function jsonResponse(statusCode: number, data: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    body: statusCode === 204 ? "" : JSON.stringify({ data }),
  };
}

export function requestBody(event: APIGatewayProxyEventV2): string {
  const body = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
}

export interface RequestTelemetry {
  requestId: string;
  correlationId: string;
  operation: string;
  tenantId?: string;
}

export async function handleRequest(
  event: APIGatewayProxyEventV2,
  operation: string,
  action: (telemetry: RequestTelemetry) => Promise<unknown>,
): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId || randomUUID();
  const incomingCorrelation = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "x-correlation-id")?.[1];
  const correlationId = typeof incomingCorrelation === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(incomingCorrelation) ? incomingCorrelation : requestId;
  const telemetry: RequestTelemetry = { requestId, correlationId, operation };
  const startedAt = performance.now();
  const responseHeaders = { "x-request-id": requestId, "x-correlation-id": correlationId };
  try {
    const result = await action(telemetry);
    console.info(JSON.stringify({ event: "api.request.completed", requestId, correlationId, operation, tenantId: telemetry.tenantId, status: 200, durationMs: Math.round(performance.now() - startedAt) }));
    return jsonResponse(200, result, responseHeaders);
  }
  catch (error) {
    let status = 500;
    let body: Record<string, unknown> = { error: "Internal server error" };
    if (error instanceof ValidationError) { status = 400; body = { error: "Validation error", details: error.issues }; }
    else if (error instanceof NotFoundError) { status = 404; body = { error: "Resource not found" }; }
    else if (error instanceof AuthenticationError) { status = 401; body = { error: "Authentication is required" }; }
    else if (error instanceof TenantAccessError) { status = 403; body = { error: "Access to this organization or operation is not permitted" }; }
    else if (error instanceof TenantConflictError) { status = 409; body = { error: error.message }; }
    else if (error instanceof TaskDispatchError) { status = 503; body = { error: error.message }; }
    else if (error instanceof OperationalConflictError) { status = 409; body = { error: error.message }; }
    else if (error instanceof OperationalWorkflowDispatchError) { status = 503; body = { error: error.message }; }
    const log = { requestId, correlationId, operation, tenantId: telemetry.tenantId, status, durationMs: Math.round(performance.now() - startedAt), errorName: error instanceof Error ? error.name : "UnknownError" };
    if (status === 401 || status === 403) console.warn(JSON.stringify({ event: "security.authorization.rejected", ...log }));
    else console.error(JSON.stringify({ event: "api.request.failed", ...log }));
    return jsonResponse(status, body, responseHeaders);
  }
}
