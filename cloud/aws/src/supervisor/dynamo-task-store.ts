import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { AgentEvent, TaskRecord, TaskStore } from "./contracts";
import { TaskConflictError } from "./contracts";
import { assertClaimable, createTaskUpdate, normalizeTask } from "./task-state";

interface TaskRow { pk: string; sk: string; kind: "TASK"; task: TaskRecord }
interface EventRow { pk: string; sk: string; kind: "EVENT"; event: AgentEvent }
interface IdempotencyRow { pk: string; sk: string; kind: "IDEMPOTENCY"; taskId: string }

/** Minimal command boundary also makes DynamoDB conditional writes testable without AWS. */
export interface TaskDocumentClient { send(command: any): Promise<any> }

/** Durable tenant-partitioned task history. Updates and event records are transactional. */
export class DynamoTaskStore implements TaskStore {
  private readonly db: TaskDocumentClient;
  constructor(private readonly table: string, client?: TaskDocumentClient) {
    this.db = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  }

  async create(task: TaskRecord, event: AgentEvent) {
    const normalized = normalizeTask(task);
    const markerKey = `IDEMPOTENCY#${createHash("sha256").update(task.idempotencyKey).digest("hex")}`;
    const taskRow: TaskRow = { pk: task.tenantId, sk: `TASK#${task.taskId}`, kind: "TASK", task: normalized };
    const marker: IdempotencyRow = { pk: task.tenantId, sk: markerKey, kind: "IDEMPOTENCY", taskId: task.taskId };
    const eventRow = this.eventRow(event);
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.table, Item: marker, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
        { Put: { TableName: this.table, Item: taskRow, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
        { Put: { TableName: this.table, Item: eventRow, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
      ] }));
      return { task: normalized, created: true };
    } catch (error) {
      const existingMarker = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: task.tenantId, sk: markerKey }, ConsistentRead: true }));
      const existingTaskId = (existingMarker.Item as IdempotencyRow | undefined)?.taskId;
      if (!existingTaskId) throw error;
      const existing = await this.get(task.tenantId, existingTaskId);
      if (!existing) throw error;
      return { task: existing, created: false };
    }
  }

  async get(tenantId: string, taskId: string) {
    const result = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: tenantId, sk: `TASK#${taskId}` }, ConsistentRead: true }));
    const task = (result.Item as TaskRow | undefined)?.task;
    return task ? normalizeTask(task) : undefined;
  }

  async list(tenantId: string) {
    const rows = await this.queryTenant(tenantId);
    return rows.filter((row): row is TaskRow => row.kind === "TASK").map((row) => normalizeTask(row.task)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async events(tenantId: string, taskId?: string) {
    const rows = await this.queryTenant(tenantId);
    return rows.filter((row): row is EventRow => row.kind === "EVENT").map((row) => row.event).filter((event) => !taskId || event.taskId === taskId).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async update(candidate: TaskRecord, event: AgentEvent) {
    const eventId = `${candidate.taskId}:v${candidate.version + 1}:${event.eventType}`;
    const stableEvent = { ...event, eventId };
    const eventKey = { pk: candidate.tenantId, sk: `EVENT#${candidate.taskId}#${eventId}` };
    const priorEvent = await this.readEvent(eventKey);
    if (priorEvent) {
      if (!sameTransition(priorEvent, event)) throw new TaskConflictError("VERSION_CONFLICT", "Transition version already has different event data");
      const task = await this.get(candidate.tenantId, candidate.taskId);
      if (!task) throw new TaskConflictError("TASK_NOT_FOUND", "Task not found");
      return task;
    }
    const current = await this.get(candidate.tenantId, candidate.taskId);
    if (!current) throw new TaskConflictError("TASK_NOT_FOUND", "Task not found");
    const next = createTaskUpdate(current, candidate, stableEvent);
    try {
      await this.writeTransition(current, next.task, next.event);
      return next.task;
    } catch (error) {
      return this.resolveTransitionFailure(error, eventKey, next.event, current, candidate);
    }
  }

  async claim(input: { tenantId: string; taskId: string; executionId: string; workerId: string; now: number; leaseDurationMs: number }) {
    const current = await this.get(input.tenantId, input.taskId);
    if (!current) throw new TaskConflictError("TASK_NOT_FOUND", "Task not found");
    const claim = assertClaimable(current, input);
    if (claim === "already-claimed") return { task: current, acquired: false };
    const eventKey = { pk: input.tenantId, sk: `EVENT#${input.taskId}#${claim.event.eventId}` };
    try {
      await this.writeTransition(current, claim.task, claim.event, input);
      return { task: claim.task, acquired: true };
    } catch (error) {
      const latest = await this.get(input.tenantId, input.taskId);
      const committedEvent = await this.readEvent(eventKey);
      if (committedEvent && sameTransition(committedEvent, claim.event) && latest) return { task: latest, acquired: false };
      if (latest?.claim && latest.claim.leaseExpiresAt > input.now) {
        if (latest.claim.workerId === input.workerId && latest.claim.executionId === input.executionId) return { task: latest, acquired: false };
        throw new TaskConflictError("CLAIM_CONFLICT", "Task is already claimed by another active worker");
      }
      if (latest && latest.version !== current.version) throw new TaskConflictError("VERSION_CONFLICT", "Task version changed while acquiring its claim");
      throw error;
    }
  }

  private async writeTransition(current: TaskRecord, task: TaskRecord, event: AgentEvent, claim?: { workerId: string; executionId: string; now: number }) {
    const names: Record<string, string> = { "#task": "task", "#state": "state", "#version": "version" };
    const values: Record<string, unknown> = { ":expected": current.version, ":initial": 1, ":state": current.state, ":next": task };
    let condition = "attribute_exists(pk) AND attribute_exists(sk) AND #task.#state = :state AND (#task.#version = :expected OR (attribute_not_exists(#task.#version) AND :expected = :initial))";
    if (claim) {
      Object.assign(names, { "#claim": "claim", "#lease": "leaseExpiresAt", "#worker": "workerId", "#execution": "executionId" });
      Object.assign(values, { ":now": claim.now, ":worker": claim.workerId, ":execution": claim.executionId });
      condition += " AND (attribute_not_exists(#task.#claim) OR #task.#claim.#lease <= :now OR (#task.#claim.#worker = :worker AND #task.#claim.#execution = :execution))";
    } else if (current.claim) {
      Object.assign(names, { "#claim": "claim", "#worker": "workerId", "#execution": "executionId" });
      Object.assign(values, { ":worker": current.claim.workerId, ":execution": current.claim.executionId });
      condition += " AND #task.#claim.#worker = :worker AND #task.#claim.#execution = :execution";
    }
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: this.table, Key: { pk: task.tenantId, sk: `TASK#${task.taskId}` }, UpdateExpression: "SET #task = :next", ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
      { Put: { TableName: this.table, Item: this.eventRow(event), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
    ] }));
  }

  private async resolveTransitionFailure(error: unknown, eventKey: { pk: string; sk: string }, event: AgentEvent, current: TaskRecord, candidate: TaskRecord): Promise<TaskRecord> {
    if (!isTransactionConflict(error)) throw error;
    const priorEvent = await this.readEvent(eventKey);
    const latest = await this.get(candidate.tenantId, candidate.taskId);
    if (priorEvent && sameTransition(priorEvent, event) && latest) return latest;
    if (latest && latest.version !== current.version) throw new TaskConflictError("VERSION_CONFLICT", "Task version changed before update could be committed");
    throw error;
  }

  private async readEvent(key: { pk: string; sk: string }) {
    const result = await this.db.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
    return (result.Item as EventRow | undefined)?.event;
  }

  private eventRow(event: AgentEvent): EventRow {
    return { pk: event.tenantId, sk: `EVENT#${event.taskId}#${event.eventId}`, kind: "EVENT", event };
  }

  private async queryTenant(tenantId: string): Promise<Array<TaskRow | EventRow | IdempotencyRow>> {
    const rows: Array<TaskRow | EventRow | IdempotencyRow> = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.db.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "pk = :tenant", ExpressionAttributeValues: { ":tenant": tenantId }, ExclusiveStartKey, ConsistentRead: true }));
      rows.push(...((result.Items ?? []) as Array<TaskRow | EventRow | IdempotencyRow>));
      ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (ExclusiveStartKey);
    return rows;
  }
}

function isTransactionConflict(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && ["TransactionCanceledException", "ConditionalCheckFailedException"].includes(String(error.name)));
}
function sameTransition(left: AgentEvent, right: AgentEvent) {
  return left.eventType === right.eventType && left.tenantId === right.tenantId && left.taskId === right.taskId
    && left.executionId === right.executionId && left.correlationId === right.correlationId
    && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}
