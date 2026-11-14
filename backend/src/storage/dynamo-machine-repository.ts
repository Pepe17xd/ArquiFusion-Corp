import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ValidationError, type Machine, type MachineFilters } from "../core/machine";
import type { MachineRepository, Page } from "./contracts";

export function encodeDynamoKey(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

export function decodeDynamoKey(cursor: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).machineId !== "string") throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ValidationError(["Invalid pagination cursor"]);
  }
}

export class DynamoMachineRepository implements MachineRepository {
  private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  constructor(private readonly table: string) {}

  async upsert(machine: Machine): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: machine }));
  }

  async get(machineId: string): Promise<Machine | undefined> {
    const result = await this.db.send(new GetCommand({ TableName: this.table, Key: { machineId } }));
    return result.Item as Machine | undefined;
  }

  async list(limit: number, cursor?: string, filters: MachineFilters = {}): Promise<Page<Machine>> {
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
    const result = await this.db.send(new ScanCommand({
      TableName: this.table,
      Limit: limit,
      ExclusiveStartKey: cursor ? decodeDynamoKey(cursor) : undefined,
      FilterExpression: expressions.length ? expressions.join(" AND ") : undefined,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
    }));
    const lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    return { items: (result.Items ?? []) as Machine[], nextCursor: lastKey ? encodeDynamoKey(lastKey) : undefined };
  }
}
