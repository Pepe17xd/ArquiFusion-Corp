import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ValidationError } from "../core/machine";
import { AuraConflictError, AuraDuplicateError, AuraStockError, type AuraEntityType, type AuraPage, type AuraRecord, type AuraRepository } from "./contracts";

const pk = (tenantId: string) => `TENANT#${tenantId}`;
const sk = (type: AuraEntityType, id: string) => `AURA#${type}#${id}`;
const typePk = (tenantId: string, type: AuraEntityType) => `${pk(tenantId)}#TYPE#${type}`;

export class DynamoAuraRepository implements AuraRepository {
  private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  constructor(private readonly table: string) {}

  async get(tenantId: string, entityType: AuraEntityType, entityId: string) {
    const result = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: pk(tenantId), sk: sk(entityType, entityId) }, ConsistentRead: true }));
    return result.Item ? stripKeys(result.Item) : undefined;
  }

  async createMany(records: AuraRecord[]) {
    if (!records.length) return;
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: records.map((record) => ({ Put: { TableName: this.table, Item: toItem(record), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } })) }));
    } catch (error) {
      if (hasConditionalFailure(error)) throw new AuraDuplicateError();
      throw error;
    }
  }

  async save(record: AuraRecord, expectedVersion: number | null) {
    try {
      await this.db.send(new PutCommand({
        TableName: this.table, Item: toItem(record),
        ConditionExpression: expectedVersion === null ? "attribute_not_exists(pk) AND attribute_not_exists(sk)" : "#version = :expected",
        ExpressionAttributeNames: expectedVersion === null ? undefined : { "#version": "version" },
        ExpressionAttributeValues: expectedVersion === null ? undefined : { ":expected": expectedVersion },
      }));
    } catch (error) { if (hasConditionalFailure(error)) throw new AuraConflictError(); throw error; }
  }

  async queryByType(tenantId: string, entityType: AuraEntityType, limit: number, cursor?: string): Promise<AuraPage> {
    const startKey = cursor ? decodeCursor(cursor, tenantId, entityType) : undefined;
    const result = await this.db.send(new QueryCommand({
      TableName: this.table, IndexName: "ByTenantType", KeyConditionExpression: "#partition = :partition",
      ExpressionAttributeNames: { "#partition": "gsi1pk" }, ExpressionAttributeValues: { ":partition": typePk(tenantId, entityType) },
      Limit: limit, ScanIndexForward: false, ExclusiveStartKey: startKey,
    }));
    const items = (result.Items ?? []).map(stripKeys).filter((item) => item.tenantId === tenantId && item.entityType === entityType);
    const lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    return { items, nextCursor: lastKey ? Buffer.from(JSON.stringify(lastKey)).toString("base64url") : undefined };
  }

  async adjustStock(input: { tenantId: string; stockId: string; expectedVersion: number; nextOnHand: number; movement: AuraRecord }) {
    const stock = await this.get(input.tenantId, "STOCK", input.stockId);
    if (!stock || stock.version !== input.expectedVersion) throw new AuraConflictError();
    if (input.nextOnHand < Number(stock.reserved ?? 0)) throw new AuraStockError("Stock adjustment cannot reduce on-hand quantity below active reservations");
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: this.table, Key: key(input.tenantId, "STOCK", input.stockId), UpdateExpression: "SET #onHand = :onHand, #version = :nextVersion, updatedAt = :now", ConditionExpression: "#version = :expectedVersion AND #onHand >= :reserved", ExpressionAttributeNames: { "#onHand": "onHand", "#version": "version" }, ExpressionAttributeValues: { ":onHand": input.nextOnHand, ":nextVersion": input.expectedVersion + 1, ":expectedVersion": input.expectedVersion, ":reserved": Number(stock.reserved ?? 0), ":now": input.movement.createdAt } } },
        { Put: { TableName: this.table, Item: toItem(input.movement), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
      ] }));
    } catch (error) { if (hasConditionalFailure(error)) throw new AuraConflictError(); throw error; }
    const updated = await this.get(input.tenantId, "STOCK", input.stockId);
    if (!updated) throw new AuraConflictError();
    return updated;
  }

  async reserveStock(input: { tenantId: string; stockId: string; expectedVersion: number; quantity: number; reservation: AuraRecord; movement: AuraRecord; idempotency: AuraRecord }) {
    const stock = await this.get(input.tenantId, "STOCK", input.stockId);
    if (!stock || stock.version !== input.expectedVersion) throw new AuraConflictError();
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: this.table, Key: key(input.tenantId, "STOCK", input.stockId), UpdateExpression: "SET #reserved = #reserved + :quantity, #version = :nextVersion, updatedAt = :now", ConditionExpression: "#version = :expectedVersion AND #onHand >= :needed", ExpressionAttributeNames: { "#reserved": "reserved", "#onHand": "onHand", "#version": "version" }, ExpressionAttributeValues: { ":quantity": input.quantity, ":needed": Number(stock.reserved ?? 0) + input.quantity, ":nextVersion": input.expectedVersion + 1, ":expectedVersion": input.expectedVersion, ":now": input.reservation.createdAt } } },
        ...[input.reservation, input.movement, input.idempotency].map((record) => ({ Put: { TableName: this.table, Item: toItem(record), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } })),
      ] }));
    } catch (error) {
      if (hasConditionalFailure(error)) {
        const stockNow = await this.get(input.tenantId, "STOCK", input.stockId);
        if (stockNow && Number(stockNow.onHand) - Number(stockNow.reserved) < input.quantity) throw new AuraStockError();
        throw new AuraConflictError();
      }
      throw error;
    }
  }

  async settleReservation(input: { tenantId: string; stockId: string; expectedStockVersion: number; reservationId: string; expectedReservationVersion: number; quantity: number; nextOnHand: number; nextReserved: number; status: "released" | "consumed"; movement: AuraRecord }) {
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: this.table, Key: key(input.tenantId, "STOCK", input.stockId), UpdateExpression: "SET #onHand = :onHand, #reserved = :reserved, #version = :nextVersion, updatedAt = :now", ConditionExpression: "#version = :expectedVersion AND #reserved >= :quantity AND #onHand >= :onHand", ExpressionAttributeNames: { "#onHand": "onHand", "#reserved": "reserved", "#version": "version" }, ExpressionAttributeValues: { ":onHand": input.nextOnHand, ":reserved": input.nextReserved, ":nextVersion": input.expectedStockVersion + 1, ":expectedVersion": input.expectedStockVersion, ":quantity": input.quantity, ":now": input.movement.createdAt } } },
        { Update: { TableName: this.table, Key: key(input.tenantId, "RESERVATION", input.reservationId), UpdateExpression: "SET #status = :status, #version = :nextVersion, updatedAt = :now, settledAt = :now", ConditionExpression: "#version = :expectedVersion AND #status = :active AND quantity = :quantity AND stockId = :stockId", ExpressionAttributeNames: { "#status": "status", "#version": "version" }, ExpressionAttributeValues: { ":status": input.status, ":nextVersion": input.expectedReservationVersion + 1, ":expectedVersion": input.expectedReservationVersion, ":active": "active", ":quantity": input.quantity, ":stockId": input.stockId, ":now": input.movement.createdAt } } },
        { Put: { TableName: this.table, Item: toItem(input.movement), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
      ] }));
    } catch (error) { if (hasConditionalFailure(error)) throw new AuraConflictError("Reservation or stock changed; it may already be settled"); throw error; }
  }
}

function key(tenantId: string, type: AuraEntityType, id: string) { return { pk: pk(tenantId), sk: sk(type, id) }; }
function toItem(record: AuraRecord) { return { ...record, ...key(record.tenantId, record.entityType, record.entityId), gsi1pk: typePk(record.tenantId, record.entityType), gsi1sk: `${record.createdAt}#${record.entityId}` }; }
function stripKeys(item: Record<string, unknown>): AuraRecord {
  const { pk: _pk, sk: _sk, gsi1pk: _gsi1pk, gsi1sk: _gsi1sk, ...record } = item;
  return record as AuraRecord;
}
function decodeCursor(cursor: string, tenantId: string, entityType: AuraEntityType) {
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    const value = raw as Record<string, unknown>;
    if (value.pk !== pk(tenantId) || value.gsi1pk !== typePk(tenantId, entityType) || typeof value.sk !== "string") throw new Error();
    return value;
  } catch { throw new ValidationError(["Invalid AURA pagination cursor"]); }
}
function hasConditionalFailure(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  const value = error as { name: unknown; CancellationReasons?: Array<{ Code?: string }> };
  return value.name === "ConditionalCheckFailedException" || (value.name === "TransactionCanceledException" && value.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed"));
}
