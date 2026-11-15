import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Tenant, TenantContext, TenantDirectory, TenantMembership } from "./contracts";
import { isTenantRole, TenantAccessError, TenantConflictError } from "./contracts";
import { atomicWriteFile } from "../storage/local-file";

interface LocalDirectoryData { tenants: Tenant[]; memberships: TenantMembership[]; creationRequests?: Record<string, string>; disabledUsers?: string[] }

/** Explicit local-only identity/membership simulation. It is never selected in cloud mode. */
export class LocalTenantDirectory implements TenantDirectory {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly file: string, private readonly localUserSub = "local-dev-user", private readonly localTenantId = "local-demo") {}

  async assertUserActive(userSub: string) {
    const data = await this.read();
    if (data.disabledUsers?.includes(userSub)) throw new TenantAccessError("The user account is disabled");
  }

  async resolve(userSub: string, requestedTenantId?: string): Promise<TenantContext> {
    const data = await this.read();
    const matches = data.memberships.filter((item) => item.userSub === userSub && item.status !== "disabled");
    const selected = requestedTenantId ? matches.find((item) => item.tenantId === requestedTenantId) : matches.length === 1 ? matches[0] : undefined;
    if (!selected || !isTenantRole(selected.role)) throw new TenantAccessError(matches.length > 1 && !requestedTenantId ? "Select a tenant membership before accessing tenant data" : undefined);
    const tenant = data.tenants.find((item) => item.tenantId === selected.tenantId);
    if (!tenant || tenant.status !== "active") throw new TenantAccessError("The requested tenant is unavailable");
    return { tenantId: selected.tenantId, userSub: selected.userSub, role: selected.role, authMode: "local-simulation" };
  }

  async listForUser(userSub: string) {
    const data = await this.read();
    return data.memberships.filter((membership) => membership.userSub === userSub && membership.status !== "disabled").flatMap((membership) => {
      const tenant = data.tenants.find((item) => item.tenantId === membership.tenantId);
      return tenant ? [{ tenant, membership }] : [];
    });
  }

  async createTenant(userSub: string, name: string, idempotencyKey: string) {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 120) throw new TenantAccessError("Tenant name must contain 1 to 120 characters");
    if (!idempotencyKey.trim() || idempotencyKey.length > 200) throw new TenantAccessError("A valid Idempotency-Key is required");
    return this.serial(async () => {
      const data = await this.read();
      data.creationRequests ??= {};
      const requestKey = `${userSub}:${idempotencyKey}`;
      const existingTenantId = data.creationRequests[requestKey];
      if (existingTenantId) {
        const tenant = data.tenants.find((item) => item.tenantId === existingTenantId);
        const membership = data.memberships.find((item) => item.tenantId === existingTenantId && item.userSub === userSub);
        if (tenant && membership) {
          if (tenant.name !== cleanName) throw new TenantConflictError("Idempotency-Key was already used with different organization data");
          return { tenant, membership };
        }
      }
      if (data.memberships.some((item) => item.userSub === userSub)) {
        throw new TenantConflictError("Self-service organization creation is limited to one organization per account");
      }
      const tenant: Tenant = { tenantId: randomUUID(), name: cleanName, createdAt: new Date().toISOString(), status: "active" };
      const membership: TenantMembership = { tenantId: tenant.tenantId, userSub, role: "owner", createdAt: tenant.createdAt };
      data.tenants.push(tenant); data.memberships.push(membership); data.creationRequests[requestKey] = tenant.tenantId; await this.write(data);
      return { tenant, membership };
    });
  }

  async addTechnicianMember(tenantId: string, userSub: string): Promise<TenantMembership> {
    if (!userSub || userSub.length > 128) throw new TenantAccessError("A valid Cognito subject is required");
    return this.serial(async () => {
      const data = await this.read();
      if (data.disabledUsers?.includes(userSub)) throw new TenantAccessError("The user account is disabled");
      if (!data.tenants.some((tenant) => tenant.tenantId === tenantId && tenant.status === "active")) throw new TenantAccessError("The requested organization is unavailable");
      const elsewhere = data.memberships.find((item) => item.userSub === userSub && item.tenantId !== tenantId && item.status !== "disabled");
      if (elsewhere) throw new TenantConflictError("The account already belongs to another organization");
      const current = data.memberships.find((item) => item.tenantId === tenantId && item.userSub === userSub);
      if (current?.role === "technician" && current.status !== "disabled") return current;
      if (current) throw new TenantConflictError("An existing tenant membership cannot be changed by technician provisioning");
      const membership: TenantMembership = { tenantId, userSub, role: "technician", createdAt: new Date().toISOString(), status: "active" };
      data.memberships.push(membership); await this.write(data); return membership;
    });
  }

  async disableTechnicianMember(tenantId: string, userSub: string) {
    await this.serial(async () => {
      const data = await this.read();
      const membership = data.memberships.find((item) => item.tenantId === tenantId && item.userSub === userSub);
      if (!membership) return;
      if (membership.role !== "technician") throw new TenantConflictError("Only technician memberships can be disabled by this operation");
      membership.status = "disabled";
      await this.write(data);
    });
  }

  async disableUser(userSub: string) {
    await this.serial(async () => {
      const data = await this.read();
      data.disabledUsers ??= [];
      if (!data.disabledUsers.includes(userSub)) data.disabledUsers.push(userSub);
      for (const membership of data.memberships) if (membership.userSub === userSub) membership.status = "disabled";
      await this.write(data);
    });
  }

  private async read(): Promise<LocalDirectoryData> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as LocalDirectoryData;
      if (!Array.isArray(parsed.tenants) || !Array.isArray(parsed.memberships)) throw new Error("Invalid local tenant directory");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const now = new Date(0).toISOString();
      return {
        tenants: [{ tenantId: this.localTenantId, name: "Entorno local de desarrollo", createdAt: now, status: "active" }],
        memberships: [{ tenantId: this.localTenantId, userSub: this.localUserSub, role: "owner", createdAt: now }],
      };
    }
  }

  private async write(data: LocalDirectoryData) {
    await atomicWriteFile(this.file, JSON.stringify(data, null, 2));
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

export const LOCAL_USER_SUB = "local-dev-user";
export const LOCAL_TENANT_ID = "local-demo";
