import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Tenant, TenantContext, TenantDirectory, TenantMembership, TenantRole } from "./contracts";
import { isTenantRole, TenantAccessError } from "./contracts";
import { atomicWriteFile } from "../storage/local-file";

interface LocalDirectoryData { tenants: Tenant[]; memberships: TenantMembership[] }

/** Explicit local-only identity/membership simulation. It is never selected in cloud mode. */
export class LocalTenantDirectory implements TenantDirectory {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly file: string, private readonly localUserSub = "local-dev-user", private readonly localTenantId = "local-demo") {}

  async resolve(userSub: string, requestedTenantId?: string): Promise<TenantContext> {
    const data = await this.read();
    const matches = data.memberships.filter((item) => item.userSub === userSub);
    const selected = requestedTenantId ? matches.find((item) => item.tenantId === requestedTenantId) : matches.length === 1 ? matches[0] : undefined;
    if (!selected || !isTenantRole(selected.role)) throw new TenantAccessError(matches.length > 1 && !requestedTenantId ? "Select a tenant membership before accessing tenant data" : undefined);
    const tenant = data.tenants.find((item) => item.tenantId === selected.tenantId);
    if (!tenant || tenant.status !== "active") throw new TenantAccessError("The requested tenant is unavailable");
    return { tenantId: selected.tenantId, userSub: selected.userSub, role: selected.role, authMode: "local-simulation" };
  }

  async listForUser(userSub: string) {
    const data = await this.read();
    return data.memberships.filter((membership) => membership.userSub === userSub).flatMap((membership) => {
      const tenant = data.tenants.find((item) => item.tenantId === membership.tenantId);
      return tenant ? [{ tenant, membership }] : [];
    });
  }

  async createTenant(userSub: string, name: string) {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 120) throw new TenantAccessError("Tenant name must contain 1 to 120 characters");
    return this.serial(async () => {
      const data = await this.read();
      const tenant: Tenant = { tenantId: randomUUID(), name: cleanName, createdAt: new Date().toISOString(), status: "active" };
      const membership: TenantMembership = { tenantId: tenant.tenantId, userSub, role: "owner", createdAt: tenant.createdAt };
      data.tenants.push(tenant); data.memberships.push(membership); await this.write(data);
      return { tenant, membership };
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
