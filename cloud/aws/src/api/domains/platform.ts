import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createHealthHandlers } from "../handlers/health";
import { createTenantHandlers } from "../handlers/tenants";
import { createDomainRuntime } from "./runtime";

let handlers: ReturnType<typeof createHandlers> | undefined;
function createHandlers() {
  const runtime = createDomainRuntime("platform");
  return { ...createHealthHandlers(), ...createTenantHandlers(runtime.tenants, runtime.auth) };
}
function getHandlers() { return handlers ??= createHandlers(); }
export const health = (event: APIGatewayProxyEventV2) => getHandlers().health(event);
export const listTenants = (event: APIGatewayProxyEventV2) => getHandlers().listTenants(event);
export const createTenant = (event: APIGatewayProxyEventV2) => getHandlers().createTenant(event);
