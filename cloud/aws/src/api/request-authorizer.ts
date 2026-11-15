import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { RequestTelemetry } from "./http";
import type { AccessTokenVerifier } from "../security/cognito-token-verifier";
import { AuthenticationError, TenantAccessError, type TenantDirectory, type TenantRole, type TenantContext } from "../tenancy/contracts";
import { LOCAL_USER_SUB } from "../tenancy/local-tenant-directory";

export type ApiScope = "arquifusion/read" | "arquifusion/write";

export interface RequestAuthorizer {
  authenticatedUser(event: APIGatewayProxyEventV2, scope: ApiScope): Promise<string>;
  tenant(event: APIGatewayProxyEventV2, telemetry: RequestTelemetry, requiredRole?: TenantRole, scope?: ApiScope): Promise<TenantContext>;
}

export function createRequestAuthorizer(input: {
  authMode: "local" | "cognito";
  tenants: TenantDirectory;
  tokenVerifier?: AccessTokenVerifier;
}): RequestAuthorizer {
  async function authenticatedUser(event: APIGatewayProxyEventV2, scope: ApiScope) {
    if (input.authMode === "local") return LOCAL_USER_SUB;
    const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1];
    const token = typeof authorization === "string" ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] : undefined;
    if (!token || !input.tokenVerifier) throw new AuthenticationError();
    try {
      const claims = await input.tokenVerifier.verify(token);
      if (!claims.scope.split(/\s+/).includes(scope)) throw new TenantAccessError();
      await input.tenants.assertUserActive(claims.sub);
      return claims.sub;
    } catch (error) {
      if (error instanceof TenantAccessError) throw error;
      throw new AuthenticationError();
    }
  }

  async function tenant(event: APIGatewayProxyEventV2, telemetry: RequestTelemetry, requiredRole: TenantRole = "viewer", scope: ApiScope = "arquifusion/read") {
    const userSub = await authenticatedUser(event, scope);
    const requestedTenantId = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "x-tenant-id")?.[1];
    const resolved = await input.tenants.resolve(userSub, typeof requestedTenantId === "string" && requestedTenantId ? requestedTenantId : undefined);
    telemetry.tenantId = resolved.tenantId;
    // Technician memberships are deliberately isolated from tenant-wide APIs.
    // A technician must use handlers that also prove assignment ownership.
    if (resolved.role === "technician" && requiredRole !== "technician") throw new TenantAccessError();
    if (requiredRole === "technician" && resolved.role !== "technician") throw new TenantAccessError();
    const roleLevel: Record<TenantRole, number> = { viewer: 0, technician: 1, operator: 1, admin: 2, owner: 3 };
    if (!(resolved.role in roleLevel) || roleLevel[resolved.role] < roleLevel[requiredRole]) throw new TenantAccessError();
    return resolved;
  }

  return { authenticatedUser, tenant };
}
