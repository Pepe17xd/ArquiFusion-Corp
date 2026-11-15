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
import { LocalOperationalRepository } from "../operations/local-repository";
import { LocalMachineRepository } from "../storage/local-machine-repository";

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
    await tenants.addTechnicianMember(tenantA.tenant.tenantId, "subject-tech");
    const repo = new LocalAuraRepository(join(dir, "aura.json"));
    const service = new AuraService(repo, {} as never, {} as never);
    const auth = createRequestAuthorizer({ authMode: "cognito", tenants, tokenVerifier: { verify: async (token) => {
      const sub = token === "token-a" ? "subject-a" : token === "token-b" ? "subject-b" : token === "token-tech" ? "subject-tech" : undefined;
      if (!sub) throw new Error("invalid token");
      return { sub, scope: "arquifusion/read arquifusion/write", client_id: "test", token_use: "access", iss: "https://issuer.test", exp: Math.floor(Date.now() / 1000) + 600 };
    } } });
    const handlers = createAuraHandlers(service, auth);
    const invoke = (handler: (event: APIGatewayProxyEventV2) => Promise<unknown>, token: string, body?: unknown) => handler({
      version: "2.0", routeKey: "POST /inventory/parts", rawPath: "/inventory/parts", rawQueryString: "",
      requestContext: { requestId: "test" }, headers: { authorization: `Bearer ${token}`, "x-tenant-id": token === "token-b" ? tenantB.tenant.tenantId : tenantA.tenant.tenantId },
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
    const technicianTenantWideRead = await invoke(handlers.parts, "token-tech");
    assert.equal(technicianTenantWideRead.statusCode, 403);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("technician work orders are isolated by linked Cognito subject and admin approval closes the incident", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aura-technician-workflow-"));
  try {
    const tenantId = "tenant-a", now = new Date().toISOString();
    const aura = new LocalAuraRepository(join(dir, "aura.json"));
    const operations = new LocalOperationalRepository(join(dir, "operations.json"));
    const machines = new LocalMachineRepository(join(dir, "machines.json"));
    await aura.save({ tenantId, entityType: "TECHNICIAN", entityId: "tech-1", technicianId: "tech-1", cognitoSub: "subject-tech-1", displayName: "Tech 1", status: "active", createdAt: now, updatedAt: now, version: 1 }, null);
    await operations.save({ tenantId, entityType: "INCIDENT", entityId: "incident-1", machineId: "machine-1", status: "assigned", createdAt: now, updatedAt: now, version: 1, history: [{ status: "assigned", at: now }] }, null);
    await operations.save({ tenantId, entityType: "WORK_ORDER", entityId: "order-1", incidentId: "incident-1", machineId: "machine-1", assignedTechnicianId: "tech-1", status: "assigned", createdAt: now, updatedAt: now, version: 1, history: [] }, null);
    await operations.save({ tenantId, entityType: "WORK_ORDER", entityId: "order-other-tech", incidentId: "incident-1", machineId: "machine-1", assignedTechnicianId: "tech-2", status: "assigned", createdAt: now, updatedAt: now, version: 1, history: [] }, null);
    await operations.save({ tenantId, entityType: "WORK_ORDER", entityId: "order-2", incidentId: "incident-1", machineId: "machine-2", assignedTechnicianId: "tech-1", status: "assigned", createdAt: now, updatedAt: now, version: 1, history: [] }, null);
    const service = new AuraService(aura, operations, machines);
    const own = await service.technicianWorkOrders(tenantId, "subject-tech-1", 10);
    assert.deepEqual(own.items.map((item) => item.entityId).sort(), ["order-1", "order-2"]);
    const page1 = await service.technicianWorkOrders(tenantId, "subject-tech-1", 1);
    assert.equal(page1.items.length, 1);
    assert.ok(page1.nextCursor);
    const page2 = await service.technicianWorkOrders(tenantId, "subject-tech-1", 1, page1.nextCursor);
    assert.equal(page2.items.length, 1);
    assert.notEqual(page1.items[0].entityId, page2.items[0].entityId);
    await assert.rejects(service.technicianWorkOrders(tenantId, "subject-other", 10), /not linked/);
    await service.updateTechnicianWorkOrder(tenantId, "subject-tech-1", "order-1", { action: "start" });
    await service.completeTechnicianWorkOrder(tenantId, "subject-tech-1", "order-1", "Replaced and tested the hydraulic filter");
    const completed = await operations.get(tenantId, "WORK_ORDER", "order-1");
    assert.equal(completed?.status, "completed");
    assert.equal((completed?.history as Array<Record<string, unknown>>).at(-1)?.actorRole, "technician");
    assert.equal((await operations.get(tenantId, "INCIDENT", "incident-1"))?.status, "in_progress", "technician completion must not close the incident");
    await service.reviewWorkOrder(tenantId, "subject-admin", "order-1", "approve", "Reviewed work and verified machine operation");
    assert.equal((await operations.get(tenantId, "WORK_ORDER", "order-1"))?.status, "approved");
    assert.equal((await operations.get(tenantId, "INCIDENT", "incident-1"))?.status, "closed");
    const events = await operations.queryByType(tenantId, "EVENT", 20);
    assert.ok(events.items.some((item) => item.eventType === "MaintenanceApproved"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cognito technician invitations persist subject linkage and replay idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aura-tech-invite-"));
  try {
    const aura = new LocalAuraRepository(join(dir, "aura.json"));
    const operations = new LocalOperationalRepository(join(dir, "operations.json"));
    const machines = new LocalMachineRepository(join(dir, "machines.json"));
    const tenants = new LocalTenantDirectory(join(dir, "tenants.json"));
    const tenantId = (await tenants.listForUser("local-dev-user"))[0].tenant.tenantId;
    let invitations = 0;
    const identity = { invite: async (email: string) => { invitations += 1; assert.equal(email, "tech@example.test"); return { userSub: "cognito-created-sub" }; }, disable: async () => undefined };
    const service = new AuraService(aura, operations, machines, undefined, undefined, undefined, identity, tenants);
    const profile = { technicianId: "tech-demo-1", displayName: "Demo Technician", specialties: ["hydraulics"], skills: [{ code: "hydraulic-diagnostics", level: 3 }], availability: "available", maxConcurrentAssignments: 2, shifts: [{ daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "17:00", timeZone: "America/Lima" }], email: "tech@example.test" };
    const created = await service.inviteTechnician(tenantId, profile, "invite-key-0001");
    const replay = await service.inviteTechnician(tenantId, profile, "invite-key-0001");
    assert.equal(created.userSub, "cognito-created-sub");
    assert.equal(created.technician.cognitoSub, "cognito-created-sub");
    assert.equal(replay.replayed, true);
    assert.equal(invitations, 1);
    assert.equal((await tenants.resolve("cognito-created-sub", tenantId)).role, "technician");
    await assert.rejects(service.inviteTechnician(tenantId, { ...profile, displayName: "Changed" }, "invite-key-0001"), /different technician invitation/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("approving an AURA recommendation creates or links the technician-assigned maintenance order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aura-assigned-order-"));
  try {
    const tenantId = "tenant-assignment", now = new Date().toISOString();
    const aura = new LocalAuraRepository(join(dir, "aura.json"));
    const operations = new LocalOperationalRepository(join(dir, "operations.json"));
    const machines = new LocalMachineRepository(join(dir, "machines.json"));
    await aura.save({ tenantId, entityType: "TECHNICIAN", entityId: "tech-assigned", technicianId: "tech-assigned", cognitoSub: "subject-tech", displayName: "Technician", specialties: ["hydraulics"], skills: [{ code: "hydraulic-diagnostics", level: 3 }], availability: "available", maxConcurrentAssignments: 2, status: "active", shifts: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: "00:00", endTime: "23:59", timeZone: "UTC" }], createdAt: now, updatedAt: now, version: 1 }, null);
    await operations.save({ tenantId, entityType: "INCIDENT", entityId: "incident-aura", machineId: "machine-aura", severity: "warning", status: "open", createdAt: now, updatedAt: now, version: 1, history: [] }, null);
    await aura.save({ tenantId, entityType: "ASSIGNMENT", entityId: "assignment-aura", assignmentId: "assignment-aura", incidentId: "incident-aura", machineId: "machine-aura", technicianId: "tech-assigned", status: "proposed", version: 1, candidates: [{ technicianId: "tech-assigned", cost: 0.2, breakdown: { skill: 0.2 } }], cost: 0.2, costBreakdown: { skill: 0.2 }, createdAt: now, updatedAt: now }, null);
    const service = new AuraService(aura, operations, machines);
    const response = await service.approveAssignment(tenantId, "subject-admin", "assignment-aura", "tech-assigned", 1, "assignment-approval-key");
    assert.equal(response.workflowStarted, false);
    const orders = await operations.queryByType(tenantId, "WORK_ORDER", 10);
    assert.equal(orders.items.length, 1);
    assert.equal(orders.items[0].assignedTechnicianId, "tech-assigned");
    assert.equal(orders.items[0].incidentId, "incident-aura");
    const incident = await operations.get(tenantId, "INCIDENT", "incident-aura");
    assert.equal(incident?.workOrderId, orders.items[0].entityId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("audit filters are applied before cursor pagination and cursors are bound to the filter set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aura-audit-filters-"));
  try {
    const aura = new LocalAuraRepository(join(dir, "aura.json"));
    const operations = new LocalOperationalRepository(join(dir, "operations.json"));
    const machines = new LocalMachineRepository(join(dir, "machines.json"));
    const service = new AuraService(aura, operations, machines);
    const start = Date.now() - 10_000;
    for (let index = 0; index < 7; index += 1) {
      const eventType = index % 2 ? "MaintenanceUpdated" : "MaintenanceFailed";
      const createdAt = new Date(start + index * 1000).toISOString();
      await aura.save({ tenantId: "tenant-audit", entityType: "EVENT", entityId: `event-${index}`, eventId: `event-${index}`, eventType, resourceId: `order-${index}`, status: index === 5 ? "failed" : "completed", payload: { errorCode: index === 5 ? "UPDATE_FAILED" : undefined }, createdAt, updatedAt: createdAt }, null);
    }
    const filters = { from: new Date(start + 2000).toISOString(), to: new Date(start + 6000).toISOString(), eventType: "MaintenanceUpdated", error: true };
    const first = await service.listEvents("tenant-audit", filters, 1);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].entityId, "event-5");
    assert.ok(first.nextCursor);
    const filteredRemainder = await service.listEvents("tenant-audit", filters, 1, first.nextCursor);
    assert.deepEqual(filteredRemainder.items, []);
    assert.equal(filteredRemainder.nextCursor, undefined);
    const broad = await service.listEvents("tenant-audit", { error: false }, 2);
    assert.equal(broad.items.length, 2);
    assert.ok(broad.nextCursor);
    await assert.rejects(service.listEvents("tenant-audit", { error: true }, 2, broad.nextCursor), /Validation failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
