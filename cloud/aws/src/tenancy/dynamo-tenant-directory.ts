import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Tenant, TenantContext, TenantDirectory, TenantMembership } from "./contracts";
import { isTenantRole, TenantAccessError, TenantConflictError } from "./contracts";

interface TenantRow { pk: string; sk: string; entity: "TENANT"; tenant: Tenant }
interface MembershipRow { pk: string; sk: string; entity: "MEMBERSHIP"; membership: TenantMembership; gsi1pk: string; gsi1sk: string }
interface CreationRow { pk: string; sk: string; entity: "TENANT_CREATION"; tenantId: string; idempotencyHash: string }

/** DynamoDB membership directory. The authenticated Cognito subject is the only user key. */
export class DynamoTenantDirectory implements TenantDirectory {
  private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  constructor(private readonly table: string) {}

  async assertUserActive(userSub: string) {
    const result = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `USER#${userSub}`, sk: "STATUS" }, ConsistentRead: true }));
    if ((result.Item as { disabled?: boolean } | undefined)?.disabled) throw new TenantAccessError("The user account is disabled");
  }

  async resolve(userSub: string, requestedTenantId?: string): Promise<TenantContext> {
    const memberships = await this.listForUser(userSub);
    const candidate = requestedTenantId
      ? memberships.find((item) => item.membership.tenantId === requestedTenantId)?.membership
      : memberships.length === 1 ? memberships[0].membership : undefined;
    // The GSI used to enumerate memberships is eventually consistent. Re-read
    // the selected membership from the base table before authorizing a request.
    const result = candidate ? await this.db.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `TENANT#${candidate.tenantId}`, sk: `MEMBER#${userSub}` },
      ConsistentRead: true,
    })) : undefined;
    const membership = (result?.Item as MembershipRow | undefined)?.membership;
    if (!membership || membership.status === "disabled" || !isTenantRole(membership.role)) throw new TenantAccessError(memberships.length > 1 && !requestedTenantId ? "Select a tenant membership before accessing tenant data" : undefined);
    const tenantResult = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `TENANT#${membership.tenantId}`, sk: "META" }, ConsistentRead: true }));
    const tenant = (tenantResult.Item as TenantRow | undefined)?.tenant;
    if (!tenant || tenant.status !== "active") throw new TenantAccessError("The requested tenant is unavailable");
    return { tenantId: tenant.tenantId, userSub, role: membership.role, authMode: "cognito" };
  }

  async listForUser(userSub: string) {
    const rows: MembershipRow[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.db.send(new QueryCommand({
        TableName: this.table, IndexName: "ByUser", KeyConditionExpression: "gsi1pk = :user",
        ExpressionAttributeValues: { ":user": `USER#${userSub}` },
        ExclusiveStartKey,
      }));
      rows.push(...(result.Items ?? []) as MembershipRow[]);
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return (await Promise.all(rows.map(async (row) => {
      const current = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: row.pk, sk: row.sk }, ConsistentRead: true }));
      const membership = (current.Item as MembershipRow | undefined)?.membership;
      if (!membership || membership.userSub !== userSub || membership.status === "disabled") return undefined;
      const tenantResult = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: row.pk, sk: "META" }, ConsistentRead: true }));
      const tenant = (tenantResult.Item as TenantRow | undefined)?.tenant;
      return tenant ? { tenant, membership } : undefined;
    }))).filter((item): item is { tenant: Tenant; membership: TenantMembership } => Boolean(item));
  }

  async addTechnicianMember(tenantId: string, userSub: string): Promise<TenantMembership> {
    if (!userSub || userSub.length > 128) throw new TenantAccessError("A valid Cognito subject is required");
    const key = { pk: `TENANT#${tenantId}`, sk: `MEMBER#${userSub}` };
    const current = await this.db.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
    const existing = (current.Item as MembershipRow | undefined)?.membership;
    if (existing?.role === "technician" && existing.status !== "disabled") return existing;
    if (existing) throw new TenantConflictError("An existing tenant membership cannot be changed by technician provisioning");
    await this.assertUserActive(userSub);
    if ((await this.listForUser(userSub)).some((item) => item.tenant.tenantId !== tenantId)) throw new TenantConflictError("The account already belongs to another organization");
    const tenantResult = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `TENANT#${tenantId}`, sk: "META" }, ConsistentRead: true }));
    const tenant = (tenantResult.Item as TenantRow | undefined)?.tenant;
    if (!tenant || tenant.status !== "active") throw new TenantAccessError("The requested organization is unavailable");
    const membership: TenantMembership = { tenantId, userSub, role: "technician", createdAt: new Date().toISOString(), status: "active" };
    const row: MembershipRow = { ...key, entity: "MEMBERSHIP", membership, gsi1pk: `USER#${userSub}`, gsi1sk: `TENANT#${tenantId}` };
    try {
      await this.db.send(new PutCommand({ TableName: this.table, Item: row, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
      return membership;
    } catch (error) {
      const raced = await this.db.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
      const winner = (raced.Item as MembershipRow | undefined)?.membership;
      if (winner?.role === "technician" && winner.status !== "disabled") return winner;
      throw error;
    }
  }

  async disableTechnicianMember(tenantId: string, userSub: string) {
    const key = { pk: `TENANT#${tenantId}`, sk: `MEMBER#${userSub}` };
    const current = await this.db.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
    const row = current.Item as MembershipRow | undefined;
    if (!row) return;
    if (row.membership.role !== "technician") throw new TenantConflictError("Only technician memberships can be disabled by this operation");
    await this.db.send(new PutCommand({ TableName: this.table, Item: { ...row, membership: { ...row.membership, status: "disabled" } }, ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)" }));
  }

  async disableUser(userSub: string) {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: `USER#${userSub}`, sk: "STATUS", entity: "USER_STATUS", disabled: true, updatedAt: new Date().toISOString() } }));
  }

  async createTenant(userSub: string, name: string, idempotencyKey: string) {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 120) throw new TenantAccessError("Tenant name must contain 1 to 120 characters");
    if (!idempotencyKey.trim() || idempotencyKey.length > 200) throw new TenantAccessError("A valid Idempotency-Key is required");
    const now = new Date().toISOString();
    const tenant: Tenant = { tenantId: randomUUID(), name: cleanName, createdAt: now, status: "active" };
    const membership: TenantMembership = { tenantId: tenant.tenantId, userSub, role: "owner", createdAt: now };
    const idempotencyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    const creationRow: CreationRow = { pk: `USER#${userSub}`, sk: `CREATE#${idempotencyHash}`, entity: "TENANT_CREATION", tenantId: tenant.tenantId, idempotencyHash };
    const ownerLock = { pk: `USER#${userSub}`, sk: "INITIAL_OWNER_TENANT", entity: "INITIAL_OWNER_TENANT", tenantId: tenant.tenantId };
    const priorRequest = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: creationRow.pk, sk: creationRow.sk }, ConsistentRead: true }));
    const priorTenantId = (priorRequest.Item as CreationRow | undefined)?.tenantId;
    if (priorTenantId) {
      const [priorTenantResult, priorMembershipResult] = await Promise.all([
        this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `TENANT#${priorTenantId}`, sk: "META" }, ConsistentRead: true })),
        this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `TENANT#${priorTenantId}`, sk: `MEMBER#${userSub}` }, ConsistentRead: true })),
      ]);
      const priorTenant = (priorTenantResult.Item as TenantRow | undefined)?.tenant;
      const priorMembership = (priorMembershipResult.Item as MembershipRow | undefined)?.membership;
      if (priorTenant && priorMembership) {
        if (priorTenant.name !== cleanName) throw new TenantConflictError("Idempotency-Key was already used with different organization data");
        return { tenant: priorTenant, membership: priorMembership };
      }
    }
    if ((await this.listForUser(userSub)).length > 0) throw new TenantConflictError("Self-service organization creation is limited to one organization per account");
    const tenantRow: TenantRow = { pk: `TENANT#${tenant.tenantId}`, sk: "META", entity: "TENANT", tenant };
    const membershipRow: MembershipRow = {
      pk: `TENANT#${tenant.tenantId}`, sk: `MEMBER#${userSub}`, entity: "MEMBERSHIP", membership,
      gsi1pk: `USER#${userSub}`, gsi1sk: `TENANT#${tenant.tenantId}`,
    };
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.table, Item: tenantRow, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.table, Item: membershipRow, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.table, Item: creationRow, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
        { Put: { TableName: this.table, Item: ownerLock, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
      ] }));
      return { tenant, membership };
    } catch (error) {
      const existing = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: creationRow.pk, sk: creationRow.sk }, ConsistentRead: true }));
      const createdTenantId = (existing.Item as CreationRow | undefined)?.tenantId;
      if (createdTenantId) {
        const [tenantResult, membershipResult] = await Promise.all([
          this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `TENANT#${createdTenantId}`, sk: "META" }, ConsistentRead: true })),
          this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `TENANT#${createdTenantId}`, sk: `MEMBER#${userSub}` }, ConsistentRead: true })),
        ]);
        const existingTenant = (tenantResult.Item as TenantRow | undefined)?.tenant;
        const existingMembership = (membershipResult.Item as MembershipRow | undefined)?.membership;
        if (existingTenant && existingMembership) {
          if (existingTenant.name !== cleanName) throw new TenantConflictError("Idempotency-Key was already used with different organization data");
          return { tenant: existingTenant, membership: existingMembership };
        }
        throw error;
      }
      const ownerResult = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `USER#${userSub}`, sk: "INITIAL_OWNER_TENANT" }, ConsistentRead: true }));
      if (ownerResult.Item) throw new TenantConflictError("Self-service organization creation is limited to one organization per account");
      throw error;
    }
  }
}
