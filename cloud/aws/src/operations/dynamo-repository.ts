import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ValidationError } from "../core/machine";
import { DuplicateOperationalRecordError, OperationalConflictError, type OperationalEntityType, type OperationalPage, type OperationalRecord, type OperationalRepository } from "./contracts";

const tenantPk = (tenantId: string) => `TENANT#${tenantId}`;
const typePk = (tenantId: string, entityType: OperationalEntityType) => `${tenantPk(tenantId)}#TYPE#${entityType}`;
const machinePk = (tenantId: string, machineId: string) => `${tenantPk(tenantId)}#MACHINE#${machineId}`;
const keyOf = (type: OperationalEntityType, id: string) => `${type}#${id}`;

export class DynamoOperationalRepository implements OperationalRepository {
  private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  constructor(private readonly table: string) {}

  async get(tenantId: string, entityType: OperationalEntityType, entityId: string) {
    const result = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: tenantPk(tenantId), sk: keyOf(entityType, entityId) }, ConsistentRead: true }));
    return result.Item ? stripKeys(result.Item) : undefined;
  }

  async createMany(records: OperationalRecord[]): Promise<void> {
    if (!records.length) return;
    try {
      await this.db.send(new TransactWriteCommand({
        TransactItems: records.map((record) => ({
          Put: {
            TableName: this.table,
            Item: {
              ...record,
              pk: tenantPk(record.tenantId), sk: keyOf(record.entityType, record.entityId),
              ...(record.machineId ? { gsi1pk: machinePk(record.tenantId, record.machineId), gsi1sk: `${record.entityType}#${record.createdAt}#${record.entityId}` } : {}),
              gsi2pk: typePk(record.tenantId, record.entityType), gsi2sk: `${record.createdAt}#${record.entityId}`,
            },
            ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          },
        })),
      }));
    } catch (error) {
      if (isConditionalFailure(error)) throw new DuplicateOperationalRecordError();
      if (error && typeof error === "object" && "name" in error && (error as { name: unknown }).name === "TransactionCanceledException") {
        const existing = await Promise.all(records.map((record) => this.get(record.tenantId, record.entityType, record.entityId)));
        if (existing.some(Boolean)) throw new DuplicateOperationalRecordError();
      }
      throw error;
    }
  }

  async save(record: OperationalRecord, expectedVersion: number | null): Promise<void> {
    try {
      await this.db.send(new PutCommand({
        TableName: this.table,
        Item: {
          ...record, pk: tenantPk(record.tenantId), sk: keyOf(record.entityType, record.entityId),
          ...(record.machineId ? { gsi1pk: machinePk(record.tenantId, record.machineId), gsi1sk: `${record.entityType}#${record.createdAt}#${record.entityId}` } : {}),
          gsi2pk: typePk(record.tenantId, record.entityType), gsi2sk: `${record.createdAt}#${record.entityId}`,
        },
        ConditionExpression: expectedVersion === null ? "attribute_not_exists(pk) AND attribute_not_exists(sk)" : "#version = :expectedVersion",
        ExpressionAttributeNames: expectedVersion === null ? undefined : { "#version": "version" },
        ExpressionAttributeValues: expectedVersion === null ? undefined : { ":expectedVersion": expectedVersion },
      }));
    } catch (error) {
      if (isConditionalFailure(error)) throw new OperationalConflictError();
      throw error;
    }
  }

  async updateWithEvents(record: OperationalRecord, expectedVersion: number, events: OperationalRecord[]): Promise<void> {
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.table, Item: toItem(record), ConditionExpression: "#version = :expectedVersion", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expectedVersion": expectedVersion } } },
        ...events.map((event) => ({ Put: { TableName: this.table, Item: toItem(event), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } })),
      ] }));
    } catch (error) {
      if (isConditionalFailure(error)) throw new OperationalConflictError();
      throw error;
    }
  }

  queryByType(tenantId: string, entityType: OperationalEntityType, limit: number, cursor?: string) {
    return this.query("ByTenantType", typePk(tenantId, entityType), limit, cursor, tenantId, entityType);
  }

  queryByMachine(tenantId: string, machineId: string, entityType: OperationalEntityType, limit: number, cursor?: string) {
    return this.query("ByTenantMachine", machinePk(tenantId, machineId), limit, cursor, tenantId, entityType, `${entityType}#`);
  }

  private async query(index: string, partition: string, limit: number, cursor: string | undefined, tenantId: string, entityType: OperationalEntityType, beginsWith?: string): Promise<OperationalPage> {
    const startKey = cursor ? decodeCursor(cursor, partition, beginsWith) : undefined;
    const result = await this.db.send(new QueryCommand({
      TableName: this.table, IndexName: index, KeyConditionExpression: beginsWith ? "#partition = :partition AND begins_with(#sort, :prefix)" : "#partition = :partition",
      ExpressionAttributeNames: { "#partition": index === "ByTenantType" ? "gsi2pk" : "gsi1pk", ...(beginsWith ? { "#sort": "gsi1sk" } : {}) },
      ExpressionAttributeValues: { ":partition": partition, ...(beginsWith ? { ":prefix": beginsWith } : {}) },
      Limit: limit, ScanIndexForward: false, ExclusiveStartKey: startKey,
    }));
    const nextKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (nextKey && (nextKey.pk !== tenantPk(tenantId) || (index === "ByTenantType" ? nextKey.gsi2pk !== partition : nextKey.gsi1pk !== partition))) throw new ValidationError(["Invalid operational pagination cursor"]);
    const items = (result.Items ?? []).map(stripKeys).filter((record) => record.tenantId === tenantId && record.entityType === entityType);
    return { items, nextCursor: nextKey ? Buffer.from(JSON.stringify(nextKey)).toString("base64url") : undefined };
  }
}

function stripKeys(item: Record<string, unknown>): OperationalRecord {
  const { pk: _pk, sk: _sk, gsi1pk: _gsi1pk, gsi1sk: _gsi1sk, gsi2pk: _gsi2pk, gsi2sk: _gsi2sk, ...record } = item;
  return record as OperationalRecord;
}
function toItem(record: OperationalRecord) {
  return {
    ...record, pk: tenantPk(record.tenantId), sk: keyOf(record.entityType, record.entityId),
    ...(record.machineId ? { gsi1pk: machinePk(record.tenantId, record.machineId), gsi1sk: `${record.entityType}#${record.createdAt}#${record.entityId}` } : {}),
    gsi2pk: typePk(record.tenantId, record.entityType), gsi2sk: `${record.createdAt}#${record.entityId}`,
  };
}
function decodeCursor(cursor: string, expectedPartition: string, sortPrefix?: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const key = value as Record<string, unknown>;
    if (typeof key.pk !== "string" || typeof key.sk !== "string" || (key.gsi1pk !== expectedPartition && key.gsi2pk !== expectedPartition)
      || (sortPrefix && (typeof key.gsi1sk !== "string" || !key.gsi1sk.startsWith(sortPrefix)))) throw new Error();
    return key;
  } catch { throw new ValidationError(["Invalid operational pagination cursor"]); }
}
function isConditionalFailure(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  const value = error as { name: unknown; CancellationReasons?: Array<{ Code?: string }> };
  return value.name === "ConditionalCheckFailedException" || (value.name === "TransactionCanceledException" && value.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed"));
}
