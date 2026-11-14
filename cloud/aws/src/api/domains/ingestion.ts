import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { IngestionService } from "../../ingestion/service";
import { createIngestionHandlers } from "../handlers/ingestion";
import { createDomainRuntime } from "./runtime";

let handlers: ReturnType<typeof createHandlers> | undefined;
function createHandlers() {
  const runtime = createDomainRuntime("ingestion");
  return createIngestionHandlers(new IngestionService(runtime.machines(), runtime.originals()), runtime.auth);
}
function getHandlers() { return handlers ??= createHandlers(); }
export const ingestCsv = (event: APIGatewayProxyEventV2) => getHandlers().ingestCsv(event);
export const ingestJson = (event: APIGatewayProxyEventV2) => getHandlers().ingestJson(event);
