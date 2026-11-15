import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalAuraRepository } from "../aura/local-repository";
import { AuraService, stockIdentity } from "../aura/service";
import { AuraConflictError, AuraStockError, type AuraRecord } from "../aura/contracts";
import { ValidationError } from "../core/machine";
import { LocalTenantDirectory } from "../tenancy/local-tenant-directory";
import { createRequestAuthorizer } from "../api/request-authorizer";
import { createAuraHandlers } from "../api/handlers/aura";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

test("inventory reservation transactions prevent negative stock under concurrent requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aura-stock-"));
  try {
    const repo = new LocalAuraRepository(join(dir, "aura.json"));
    const tenantId = "tenant-a", stockId = stockIdentity("filter", "yard-1"), now = new Date().toISOString();
    await repo.save({ tenantId, entityType: "STOCK", entityId: stockId, stockId, partId: "filter", locationId: "yard-1", onHand: 5, reserved: 0, version: 1, createdAt: now, updatedAt: now }, null);
    const request = (id: string): Parameters<typeof repo.reserveStock>[0] => ({
      tenantId, stockId, expectedVersion: 1, quantity: 4,
      reservation: { tenantId, entityType: "RESERVATION", entityId: id, reservationId: id, stockId, quantity: 4, status: "active", version: 1, createdAt: now, updatedAt: now },
      movement: { tenantId, entityType: "MOVEMENT", entityId: `move-${id}`, createdAt: now, updatedAt: now },
      idempotency: { tenantId, entityType: "IDEMPOTENCY", entityId: `idem-${id}`, createdAt: now, updatedAt: now },
    });
    const results = await Promise.allSettled([repo.reserveStock(request("r1")), repo.reserveStock(request("r2"))]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const stock = await repo.get(tenantId, "STOCK", stockId);
    assert.ok(Number(stock?.reserved) <= Number(stock?.onHand));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("AURA idempotency keys are tenant-scoped and reject different stock movement payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aura-idem-"));
  try {
    const repo = new LocalAuraRepository(join(dir, "aura.json"));
    const service = new AuraService(repo, {} as never, {} as never);
    await service.createPart("tenant-a", { partId: "filter", name: "Air filter", sku: "AF-1", unit: "each", minimumStock: 2 });
    await service.createPart("tenant-b", { partId: "filter", name: "Other filter", sku: "AF-2", unit: "each", minimumStock: 1 });
    await service.applyStockMovement("tenant-a", { partId: "filter", locationId: "yard-1", quantity: 8, kind: "receipt", reason: "Initial stock" }, "movement-key-1");
    const replay = await service.applyStockMovement("tenant-a", { partId: "filter", locationId: "yard-1", quantity: 8, kind: "receipt", reason: "Initial stock" }, "movement-key-1");
    assert.equal(replay.replayed, true);
    await assert.rejects(service.applyStockMovement("tenant-a", { partId: "filter", locationId: "yard-1", quantity: 9, kind: "receipt", reason: "Different" }, "movement-key-1"), AuraConflictError);
    assert.equal(await repo.get("tenant-b", "STOCK", stockIdentity("filter", "yard-1")), undefined);
    const alerts = await service.inventoryAlerts("tenant-a");
    assert.equal(alerts.items.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("callback response validates assigned actor, removes token after use, and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aura-callback-"));
  try {
    const repo = new LocalAuraRepository(join(dir, "aura.json"));
    const now = new Date().toISOString();
    const record = (entityType: AuraRecord["entityType"], entityId: string, values: Record<string, unknown> = {}): AuraRecord => ({ tenantId: "tenant-a", entityType, entityId, createdAt: now, updatedAt: now, version: 1, ...values });
    await repo.save(record("TECHNICIAN", "tech-a", { technicianId: "tech-a", cognitoSub: "subject-a" }), null);
    await repo.save(record("ASSIGNMENT", "assignment-a", { assignmentId: "assignment-a", technicianId: "tech-a", status: "proposed", confirmationAttempt: 1 }), null);
    await repo.save(record("CALLBACK", "assignment-a:confirmation:1", { callbackId: "assignment-a:confirmation:1", assignmentId: "assignment-a", phase: "confirmation", taskToken: "private-task-token", status: "waiting" }), null);
    let callbacks = 0;
    const service = new AuraService(repo, {} as never, {} as never, undefined, { succeed: async (token, result) => { callbacks += 1; assert.equal(token, "private-task-token"); assert.equal(result.decision, "accepted"); } });
    await assert.rejects(service.respondToAssignment("tenant-a", "assignment-a", "confirmation", { userSub: "subject-b", role: "operator" }, { decision: "accepted" }), ValidationError);
    const first = await service.respondToAssignment("tenant-a", "assignment-a", "confirmation", { userSub: "subject-a", role: "operator" }, { decision: "accepted" });
    const second = await service.respondToAssignment("tenant-a", "assignment-a", "confirmation", { userSub: "subject-a", role: "operator" }, { decision: "accepted" });
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(callbacks, 1);
    assert.equal((await repo.get("tenant-a", "CALLBACK", "assignment-a:confirmation:1"))?.taskToken, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("settling reservation cannot decrement stock below zero and repeated release is safe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aura-settle-"));
  try {
    const repo = new LocalAuraRepository(join(dir, "aura.json"));
    const tenantId = "tenant-a", stockId = stockIdentity("belt", "yard"), now = new Date().toISOString();
    const stock: AuraRecord = { tenantId, entityType: "STOCK", entityId: stockId, stockId, partId: "belt", locationId: "yard", onHand: 3, reserved: 2, version: 2, createdAt: now, updatedAt: now };
    const reservation: AuraRecord = { tenantId, entityType: "RESERVATION", entityId: "reserve-a", reservationId: "reserve-a", stockId, quantity: 2, status: "active", version: 1, createdAt: now, updatedAt: now };
    await repo.save(stock, null); await repo.save(reservation, null);
    const service = new AuraService(repo, {} as never, {} as never);
    const settled = await service.settleReservation(tenantId, "reserve-a", "release");
    assert.equal(settled.replayed, false);
    const replay = await service.settleReservation(tenantId, "reserve-a", "release");
    assert.equal(replay.replayed, true);
    const final = await repo.get(tenantId, "STOCK", stockId);
    assert.equal(final?.onHand, 3);
    assert.equal(final?.reserved, 0);
    await assert.rejects(repo.adjustStock({ tenantId, stockId, expectedVersion: Number(final?.version), nextOnHand: -1, movement: { tenantId, entityType: "MOVEMENT", entityId: "bad", createdAt: now, updatedAt: now } }), AuraStockError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("AURA API derives tenant from Cognito membership and rejects tenantId in request body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aura-api-tenant-"));
  try {
    const tenants = new LocalTenantDirectory(join(dir, "tenants.json"));
    const tenantA = await tenants.createTenant("subject-a", "Tenant A", "tenant-a-create");
    const tenantB = await tenants.createTenant("subject-b", "Tenant B", "tenant-b-create");
    const repo = new LocalAuraRepository(join(dir, "aura.json"));
    const service = new AuraService(repo, {} as never, {} as never);
    const auth = createRequestAuthorizer({ authMode: "cognito", tenants, tokenVerifier: { verify: async (token) => {
      const sub = token === "token-a" ? "subject-a" : token === "token-b" ? "subject-b" : undefined;
      if (!sub) throw new Error("invalid token");
      return { sub, scope: "arquifusion/read arquifusion/write", client_id: "test", token_use: "access", iss: "https://issuer.test", exp: Math.floor(Date.now() / 1000) + 600 };
    } } });
    const handlers = createAuraHandlers(service, auth);
    const invoke = (handler: (event: APIGatewayProxyEventV2) => Promise<unknown>, token: string, body?: unknown) => handler({
      version: "2.0", routeKey: "POST /inventory/parts", rawPath: "/inventory/parts", rawQueryString: "",
      requestContext: { requestId: "test" }, headers: { authorization: `Bearer ${token}`, "x-tenant-id": token === "token-a" ? tenantA.tenant.tenantId : tenantB.tenant.tenantId },
      body: body === undefined ? undefined : JSON.stringify(body), pathParameters: {}, queryStringParameters: {}, isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2) as Promise<{ statusCode: number; body: string }>;
    const rejected = await invoke(handlers.createPart, "token-a", { tenantId: tenantB.tenant.tenantId, partId: "filter", name: "Filter", sku: "F-1", unit: "each", minimumStock: 1 });
    assert.equal(rejected.statusCode, 400);
    const created = await invoke(handlers.createPart, "token-a", { partId: "filter", name: "Filter", sku: "F-1", unit: "each", minimumStock: 1 });
    assert.equal(created.statusCode, 200);
    assert.equal((await repo.get(tenantA.tenant.tenantId, "PART", "filter"))?.tenantId, tenantA.tenant.tenantId);
    assert.equal(await repo.get(tenantB.tenant.tenantId, "PART", "filter"), undefined);
    const listed = await invoke(handlers.parts, "token-b");
    assert.deepEqual(JSON.parse(listed.body).data.items, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
