import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { LangGraphFleetIntelligence } from "../../intelligence/fleet-graph";
import { createIntelligenceHandlers } from "../handlers/intelligence";
import { createDomainRuntime } from "./runtime";

let handlers: ReturnType<typeof createHandlers> | undefined;
function createHandlers() {
  const runtime = createDomainRuntime("intelligence");
  return createIntelligenceHandlers(new LangGraphFleetIntelligence(), runtime.machines(), runtime.auth);
}
function getHandlers() { return handlers ??= createHandlers(); }
export const intelligence = (event: APIGatewayProxyEventV2) => getHandlers().intelligence(event);
export const agents = (event: APIGatewayProxyEventV2) => getHandlers().agents(event);
