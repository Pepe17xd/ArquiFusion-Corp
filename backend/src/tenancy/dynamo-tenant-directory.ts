import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Tenant, TenantContext, TenantDirectory, TenantMembership } from "./contracts";
import { isTenantRole, TenantAccessError } from "./contracts";

interface TenantRow { pk: string; sk: string; entity: "TENANT"; tenant: Tenant }
interface MembershipRow { pk: string; sk: string; entity: "MEMBERSHIP"; membership: TenantMembership; gsi1pk: string; gsi1sk: string }

/** DynamoDB membership directory. The authenticated Cognito subject is the only user key. */
export class DynamoTenantDirectory implements TenantDirectory {
  private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  constructor(private readonly table: string) {}

  async resolve(userSub: string, requestedTenantId?: string): Promise<TenantContext> {
    const memberships = await this.listForUser(userSub);
    const membership = requestedTenantId
      ? memberships.find((item) => item.membership.tenantId === requestedTenantId)?.membership
      : memberships.length === 1 ? memberships[0].membership : undefined;
    if (!membership || !isTenantRole(membership.role)) throw new TenantAccessError(memberships.length > 1 && !requestedTenantId ? "Select a tenant membership before accessing tenant data" : undefined);
    const result = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `TENANT#${membership.tenantId}`, sk: "META" } }));
    const tenant = (result.Item as TenantRow | undefined)?.tenant;
    if (!tenant || tenant.status !== "active") throw new TenantAccessError("The requested tenant is unavailable");
    return { tenantId: tenant.tenantId, userSub, role: membership.role, authMode: "cognito" };
  }

  async listForUser(userSub: string) {
    const result = await this.db.send(new QueryCommand({
      TableName: this.table, IndexName: "ByUser", KeyConditionExpression: "gsi1pk = :user",
      ExpressionAttributeValues: { ":user": `USER#${userSub}` },
    }));
    const rows = (result.Items ?? []) as MembershipRow[];
    return (await Promise.all(rows.map(async (row) => {
      const tenantResult = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: row.pk, sk: "META" } }));
      const tenant = (tenantResult.Item as TenantRow | undefined)?.tenant;
      return row.membership && tenant ? { tenant, membership: row.membership } : undefined;
    }))).filter((item): item is { tenant: Tenant; membership: TenantMembership } => Boolean(item));
  }

  async createTenant(userSub: string, name: string) {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 120) throw new TenantAccessError("Tenant name must contain 1 to 120 characters");
    const now = new Date().toISOString();
    const tenant: Tenant = { tenantId: randomUUID(), name: cleanName, createdAt: now, status: "active" };
    const membership: TenantMembership = { tenantId: tenant.tenantId, userSub, role: "owner", createdAt: now };
    const tenantRow: TenantRow = { pk: `TENANT#${tenant.tenantId}`, sk: "META", entity: "TENANT", tenant };
    const membershipRow: MembershipRow = {
      pk: `TENANT#${tenant.tenantId}`, sk: `MEMBER#${userSub}`, entity: "MEMBERSHIP", membership,
      gsi1pk: `USER#${userSub}`, gsi1sk: `TENANT#${tenant.tenantId}`,
    };
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: this.table, Item: tenantRow, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: this.table, Item: membershipRow, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
    return { tenant, membership };
  }
}
