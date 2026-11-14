import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { AgentEvent, TaskRecord, TaskStore } from "./contracts";

interface TaskRow { pk: string; sk: string; kind: "TASK"; task: TaskRecord }
interface EventRow { pk: string; sk: string; kind: "EVENT"; event: AgentEvent }
interface IdempotencyRow { pk: string; sk: string; kind: "IDEMPOTENCY"; taskId: string }

/** Durable tenant-partitioned task history. No table scans are used. */
export class DynamoTaskStore implements TaskStore {
  private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  constructor(private readonly table: string) {}

  async create(task: TaskRecord, event: AgentEvent) {
    const markerKey = `IDEMPOTENCY#${createHash("sha256").update(task.idempotencyKey).digest("hex")}`;
    const taskRow: TaskRow = { pk: task.tenantId, sk: `TASK#${task.taskId}`, kind: "TASK", task };
    const marker: IdempotencyRow = { pk: task.tenantId, sk: markerKey, kind: "IDEMPOTENCY", taskId: task.taskId };
    const eventRow = this.eventRow(event);
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.table, Item: marker, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
        { Put: { TableName: this.table, Item: taskRow, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
        { Put: { TableName: this.table, Item: eventRow } },
      ] }));
      return { task, created: true };
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
    return (result.Item as TaskRow | undefined)?.task;
  }

  async list(tenantId: string) {
    const rows = await this.queryTenant(tenantId);
    return rows.filter((row): row is TaskRow => row.kind === "TASK").map((row) => row.task).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async events(tenantId: string, taskId?: string) {
    const rows = await this.queryTenant(tenantId);
    return rows.filter((row): row is EventRow => row.kind === "EVENT").map((row) => row.event).filter((event) => !taskId || event.taskId === taskId).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async update(task: TaskRecord, event: AgentEvent) {
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: this.table, Item: { pk: task.tenantId, sk: `TASK#${task.taskId}`, kind: "TASK", task }, ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)" } },
      { Put: { TableName: this.table, Item: this.eventRow(event) } },
    ] }));
  }

  private eventRow(event: AgentEvent): EventRow {
    return { pk: event.tenantId, sk: `EVENT#${event.timestamp}#${event.eventId}`, kind: "EVENT", event };
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
