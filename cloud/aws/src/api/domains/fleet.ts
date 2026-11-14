import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { FleetService } from "../../fleet/service";
import { createFleetHandlers } from "../handlers/fleet";
import { createMetricsHandlers } from "../handlers/metrics";
import { createDomainRuntime } from "./runtime";

let handlers: ReturnType<typeof createHandlers> | undefined;
function createHandlers() {
  const runtime = createDomainRuntime("fleet");
  const machines = runtime.machines();
  return { ...createFleetHandlers(new FleetService(machines), runtime.auth), ...createMetricsHandlers(machines, runtime.auth) };
}
function getHandlers() { return handlers ??= createHandlers(); }
export const listMachines = (event: APIGatewayProxyEventV2) => getHandlers().listMachines(event);
export const getMachine = (event: APIGatewayProxyEventV2) => getHandlers().getMachine(event);
export const metrics = (event: APIGatewayProxyEventV2) => getHandlers().metrics(event);
