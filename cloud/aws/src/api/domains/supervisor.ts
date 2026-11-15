import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { randomUUID } from "node:crypto";
import { createIntelligenceProvider } from "../../intelligence/factory";
import { AgentSupervisor } from "../../supervisor/supervisor";
import { createSupervisorHandlers } from "../handlers/supervisor";
import { createDomainRuntime } from "./runtime";
import { GmailApiNotifier } from "../../notifications/gmail";
import { GoogleRefreshTokenProvider } from "../../notifications/google-refresh-token-provider";
import type { TaskRecord } from "../../supervisor/contracts";

let handlers: ReturnType<typeof createHandlers> | undefined;
function createNotifier() {
  const { GMAIL_ALERT_RECIPIENT: to, GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret, GMAIL_REFRESH_TOKEN: refreshToken } = process.env;
  if (!to || !clientId || !clientSecret || !refreshToken) return undefined;
  const notifier = new GmailApiNotifier(to, new GoogleRefreshTokenProvider({ clientId, clientSecret, refreshToken }));
  return async (task: TaskRecord) => {
    await notifier.send(`task:${task.taskId}:${task.executionId}`, {
      type: "Tarea fallida", occurredAt: task.updatedAt, resource: task.taskType, agent: task.agentId,
      executionId: task.executionId, description: task.error?.message ?? "La tarea termino en DEAD_LETTER.", attempts: task.attempts,
    });
  };
}
function createHandlers() {
  const runtime = createDomainRuntime("supervisor");
  const machines = runtime.machines();
  const tasks = runtime.tasks();
  const dispatcher = runtime.dispatcher();
  if (!tasks || !dispatcher) throw new Error("Supervisor cloud runtime requires task storage and Step Functions");
    const supervisor = new AgentSupervisor(tasks, machines, createIntelligenceProvider(), undefined, dispatcher, createNotifier());
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
