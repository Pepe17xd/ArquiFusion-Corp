import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ValidationError } from "../../core/machine";
import type { TenantDirectory } from "../../tenancy/contracts";
import { TenantConflictError } from "../../tenancy/contracts";
import type { RequestAuthorizer } from "../request-authorizer";
import { handleRequest, requestBody } from "../http";

export function createTenantHandlers(tenants: TenantDirectory, auth: RequestAuthorizer) {
  return {
    listTenants: (event: APIGatewayProxyEventV2) => handleRequest(event, "tenants.list", async () => tenants.listForUser(await auth.authenticatedUser(event, "arquifusion/read"))),
    createTenant: (event: APIGatewayProxyEventV2) => handleRequest(event, "tenants.create", async () => {
      const userSub = await auth.authenticatedUser(event, "arquifusion/write");
      const idempotencyKey = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "idempotency-key")?.[1];
      if (typeof idempotencyKey !== "string") throw new ValidationError(["Idempotency-Key header is required"]);
      let body: unknown;
      try { body = JSON.parse(requestBody(event)); } catch { throw new ValidationError(["Body must be valid JSON"]); }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "name") || typeof (body as Record<string, unknown>).name !== "string") throw new ValidationError(["Body must contain only a tenant name"]);
      return tenants.createTenant(userSub, (body as { name: string }).name, idempotencyKey);
    }),
    addTechnician: (event: APIGatewayProxyEventV2) => handleRequest(event, "tenants.members.add-technician", async (telemetry) => {
      const context = await auth.tenant(event, telemetry, "admin", "arquifusion/write");
      if (event.pathParameters?.tenantId !== context.tenantId) throw new ValidationError(["Path tenant does not match the authenticated membership"]);
      // A caller-supplied Cognito subject proves no consent or ownership. Keep
      // this legacy route reserved, but require the managed invitation flow.
      throw new TenantConflictError("Direct Cognito subject linking is disabled; invite the technician by email instead");
    }),
  };
}
