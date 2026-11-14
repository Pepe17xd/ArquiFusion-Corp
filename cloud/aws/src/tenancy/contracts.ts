export type TenantRole = "owner" | "admin" | "operator" | "viewer";
export const isTenantRole = (value: unknown): value is TenantRole => ["owner", "admin", "operator", "viewer"].includes(String(value));

export interface Tenant {
  tenantId: string;
  name: string;
  createdAt: string;
  status: "active" | "suspended";
}

export interface TenantMembership {
  tenantId: string;
  userSub: string;
  role: TenantRole;
  createdAt: string;
}

/** Tenant context is derived only after authenticating the user and checking membership. */
export interface TenantContext {
  tenantId: string;
  userSub: string;
  role: TenantRole;
  authMode: "local-simulation" | "cognito";
}

export interface TenantDirectory {
  resolve(userSub: string, requestedTenantId?: string): Promise<TenantContext>;
  listForUser(userSub: string): Promise<Array<{ tenant: Tenant; membership: TenantMembership }>>;
  createTenant(userSub: string, name: string, idempotencyKey: string): Promise<{ tenant: Tenant; membership: TenantMembership }>;
}

export class AuthenticationError extends Error {
  constructor(message = "Authentication is required") { super(message); this.name = "AuthenticationError"; }
}

export class TenantAccessError extends Error {
  constructor(message = "The user is not a member of the requested tenant") { super(message); this.name = "TenantAccessError"; }
}

export class TenantConflictError extends Error {
  constructor(message = "The organization request conflicts with an existing account state") { super(message); this.name = "TenantConflictError"; }
}
