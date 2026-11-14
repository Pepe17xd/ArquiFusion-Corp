import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ValidationError, type Machine, type MachineFilters } from "../core/machine";
import type { MachineRepository, Page } from "./contracts";

export function encodeDynamoKey(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

export function decodeDynamoKey(cursor: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).pk !== "string" || typeof (value as Record<string, unknown>).sk !== "string") throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ValidationError(["Invalid pagination cursor"]);
  }
}

export class DynamoMachineRepository implements MachineRepository {
  private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  constructor(private readonly table: string) {}

  async upsert(machine: Machine): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { ...machine, pk: machine.tenantId, sk: machine.machineId } }));
  }

  async get(tenantId: string, machineId: string): Promise<Machine | undefined> {
    const result = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: tenantId, sk: machineId } }));
    if (!result.Item) return undefined;
    const { pk: _pk, sk: _sk, ...machine } = result.Item;
    return machine as Machine;
  }

  async list(tenantId: string, limit: number, cursor?: string, filters: MachineFilters = {}): Promise<Page<Machine>> {
    const exclusiveStartKey = cursor ? decodeDynamoKey(cursor) : undefined;
    if (exclusiveStartKey && exclusiveStartKey.pk !== tenantId) throw new ValidationError(["Invalid pagination cursor"]);
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const expressions: string[] = [];
    if (filters.status) { names["#status"] = "status"; values[":status"] = filters.status; expressions.push("#status = :status"); }
    if (filters.category) { names["#category"] = "category"; values[":category"] = filters.category; expressions.push("#category = :category"); }
    if (filters.search) {
      names["#machineId"] = "machineId"; names["#model"] = "model"; names["#category"] = "category"; names["#location"] = "location";
      values[":search"] = filters.search;
      expressions.push("(contains(#machineId, :search) OR contains(#model, :search) OR contains(#category, :search) OR contains(#location, :search))");
    }
    const result = await this.db.send(new QueryCommand({
      TableName: this.table,
      ConsistentRead: true,
      KeyConditionExpression: "#pk = :tenant",
      ExpressionAttributeNames: { ...names, "#pk": "pk" },
      ExpressionAttributeValues: { ...values, ":tenant": tenantId },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
      FilterExpression: expressions.length ? expressions.join(" AND ") : undefined,
    }));
    const lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    const items = (result.Items ?? []).map(({ pk: _pk, sk: _sk, ...machine }) => machine as Machine);
    return { items, nextCursor: lastKey ? encodeDynamoKey(lastKey) : undefined };
  }
}
