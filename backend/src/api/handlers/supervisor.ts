import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ValidationError } from "../../core/machine";
import { NotFoundError } from "../../core/errors";
import { getFleetMetrics } from "../../metrics/service";
import type { MachineRepository } from "../../storage/contracts";
import { PermanentTaskError, TaskDispatchError, type TaskRecord, type TaskStore } from "../../supervisor/contracts";
import type { AgentSupervisor } from "../../supervisor/supervisor";
import type { RequestAuthorizer } from "../request-authorizer";
import { handleRequest, requestBody } from "../http";

export function createSupervisorHandlers(supervisor: AgentSupervisor, machines: MachineRepository, tasks: TaskStore, auth: RequestAuthorizer) {
  return {
    submitTask: (event: APIGatewayProxyEventV2) => handleRequest(event, "supervisor.submit", async (telemetry) => {
      let body: unknown;
      try { body = JSON.parse(requestBody(event)); } catch { throw new ValidationError(["Body must be valid JSON"]); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError(["Body must be an object"]);
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some((key) => !["taskType", "idempotencyKey", "correlationId"].includes(key))) throw new ValidationError(["Body contains unsupported fields"]);
      if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200)) throw new ValidationError(["idempotencyKey must be a non-empty string of at most 200 characters"]);
      if (input.correlationId !== undefined && (typeof input.correlationId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.correlationId))) throw new ValidationError(["correlationId must contain 1 to 128 safe characters"]);
      const tenantId = (await auth.tenant(event, telemetry, "operator", "arquifusion/write")).tenantId;
      if (typeof input.correlationId === "string") telemetry.correlationId = input.correlationId;
      try {
        const result = await supervisor.submit({ tenantId, taskType: input.taskType, idempotencyKey: input.idempotencyKey as string | undefined, correlationId: input.correlationId as string | undefined });
        if (result.task.error?.code === "DISPATCH_FAILURE") throw new TaskDispatchError();
        return result;
      }
      catch (error) { if (error instanceof PermanentTaskError) throw new ValidationError([error.message]); throw error; }
    }),
    tasks: (event: APIGatewayProxyEventV2) => handleRequest(event, "supervisor.list", async (telemetry) => supervisor.list((await auth.tenant(event, telemetry)).tenantId)),
    getTask: (event: APIGatewayProxyEventV2) => handleRequest(event, "supervisor.get", async (telemetry) => {
      const taskId = event.pathParameters?.taskId;
      if (!taskId) throw new ValidationError(["taskId is required"]);
      const task = await supervisor.get((await auth.tenant(event, telemetry)).tenantId, taskId);
      if (!task) throw new NotFoundError("Task not found");
      return task;
    }),
    taskEvents: (event: APIGatewayProxyEventV2) => handleRequest(event, "supervisor.events", async (telemetry) => supervisor.events((await auth.tenant(event, telemetry)).tenantId, event.queryStringParameters?.taskId)),
    operationsOverview: (event: APIGatewayProxyEventV2) => handleRequest(event, "operations.overview", async (telemetry) => {
      const tenantId = (await auth.tenant(event, telemetry)).tenantId;
      const [fleet, taskList, eventList] = await Promise.all([getFleetMetrics(machines, tenantId), supervisor.list(tenantId), supervisor.events(tenantId)]);
      return {
        generatedAt: new Date().toISOString(), fleet,
        agents: supervisor.agents().map(({ id, name, specialty, status, version, capabilities }) => ({ id, name, specialty, status, version, capabilities })),
        tasks: { total: taskList.length, pending: taskList.filter((task) => ["PENDING", "QUEUED", "RUNNING", "RETRYING"].includes(task.state)).length, succeeded: taskList.filter((task) => task.state === "SUCCEEDED").length, failed: taskList.filter((task) => ["FAILED", "DEAD_LETTER"].includes(task.state)).length, deadLetter: taskList.filter((task) => task.state === "DEAD_LETTER").length },
        recentEvents: eventList.slice(-20).reverse(), domains: { inventory: "planned", technicianAssignment: "planned", incidents: "planned" },
      };
    }),
    runTask: async (input: unknown) => {
      const payload = requireWorkflowContext(input);
      const existing = await tasks.get(payload.tenantId, payload.taskId);
      if (!matchesWorkflow(existing, payload)) throw new Error("Workflow context does not match a persisted task");
      await supervisor.executeTask(payload.tenantId, payload.taskId);
      const final = await tasks.get(payload.tenantId, payload.taskId);
      if (!matchesWorkflow(final, payload) || final?.state !== "SUCCEEDED") throw new Error("Task did not complete successfully");
      return final;
    },
    markTaskDeadLetter: async (input: unknown) => {
      const payload = requireWorkflowContext(input);
      return supervisor.markWorkflowFailure(payload);
    },
  };
}

interface WorkflowContext { tenantId: string; taskId: string; executionId: string; correlationId: string }
function requireWorkflowContext(value: unknown): WorkflowContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workflow input");
  const input = value as Record<string, unknown>;
  if (["tenantId", "taskId", "executionId", "correlationId"].some((key) => typeof input[key] !== "string" || !input[key])) throw new Error("Invalid workflow input");
  return input as unknown as WorkflowContext;
}
function matchesWorkflow(task: TaskRecord | undefined, context: WorkflowContext): task is TaskRecord {
  return Boolean(task && task.tenantId === context.tenantId && task.taskId === context.taskId && task.executionId === context.executionId && task.correlationId === context.correlationId);
}
