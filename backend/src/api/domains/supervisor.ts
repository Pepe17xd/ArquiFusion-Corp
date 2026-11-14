import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { randomUUID } from "node:crypto";
import { LangGraphFleetIntelligence } from "../../intelligence/fleet-graph";
import { AgentSupervisor } from "../../supervisor/supervisor";
import { createSupervisorHandlers } from "../handlers/supervisor";
import { createDomainRuntime } from "./runtime";

let handlers: ReturnType<typeof createHandlers> | undefined;
function createHandlers() {
  const runtime = createDomainRuntime("supervisor");
  const machines = runtime.machines();
  const tasks = runtime.tasks();
  const dispatcher = runtime.dispatcher();
  if (!tasks || !dispatcher) throw new Error("Supervisor cloud runtime requires task storage and Step Functions");
  const supervisor = new AgentSupervisor(tasks, machines, new LangGraphFleetIntelligence(), undefined, dispatcher);
  return createSupervisorHandlers(supervisor, machines, tasks, runtime.auth);
}
function getHandlers() { return handlers ??= createHandlers(); }
export const submitTask = (event: APIGatewayProxyEventV2) => getHandlers().submitTask(event);
export const tasks = (event: APIGatewayProxyEventV2) => getHandlers().tasks(event);
export const getTask = (event: APIGatewayProxyEventV2) => getHandlers().getTask(event);
export const taskEvents = (event: APIGatewayProxyEventV2) => getHandlers().taskEvents(event);
export const operationsOverview = (event: APIGatewayProxyEventV2) => getHandlers().operationsOverview(event);
export const runTask = (input: unknown, context?: Context) => getHandlers().runTask(input, context?.awsRequestId ?? randomUUID());
export const markTaskDeadLetter = (input: unknown) => getHandlers().markTaskDeadLetter(input);
