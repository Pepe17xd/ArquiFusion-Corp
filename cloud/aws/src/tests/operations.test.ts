import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalMachineRepository } from "../storage/local-machine-repository";
import { LocalOriginalFileStore } from "../storage/local-original-file-store";
import { LocalOperationalRepository } from "../operations/local-repository";
import { OperationsService } from "../operations/service";
import { validateBatch, validateRules } from "../operations/validation";
import { createLocalServer } from "../local-server";
import { LocalTenantDirectory } from "../tenancy/local-tenant-directory";
import { normalizeMachine } from "../core/machine";
import type { ApiServices } from "../api/handlers";

const iso = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

test("telemetry schema validates unit-bearing metric fields, bounds, timestamps and batch duplicates", () => {
  assert.equal(validateBatch({ readings: [{ machineId: "EQ-1", timestamp: iso(), metrics: { temperatureC: 85, vibrationMmS: 3.2, loadPercent: 65 } }] }).length, 1);
  assert.throws(() => validateBatch({ readings: [{ machineId: "EQ-1", timestamp: iso(), metrics: { temperature: 85 } }] }), /Validation failed/);
  assert.throws(() => validateBatch({ readings: [{ machineId: "EQ-1", timestamp: iso(), metrics: { temperatureC: 251 } }] }), /Validation failed/);
  assert.throws(() => validateBatch({ readings: [{ machineId: "EQ-1", timestamp: "2026-01-01T00:00:00", metrics: { rpm: 100 } }] }), /Validation failed/);
  assert.throws(() => validateBatch({ readings: [{ machineId: "EQ-1", timestamp: "2026-02-30T00:00:00Z", metrics: { rpm: 100 } }] }), /Validation failed/);
  const duplicateTimestamp = iso(1);
  assert.throws(() => validateBatch({ readings: [
    { machineId: "EQ-1", timestamp: duplicateTimestamp, metrics: { rpm: 10 } },
    { machineId: "EQ-1", timestamp: duplicateTimestamp, metrics: { rpm: 12 } },
  ] }), /Validation failed/);
});

test("anomaly thresholds follow metric units and allow valid negative temperature limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arquifusion-rules-"));
  try {
    const repo = new LocalOperationalRepository(join(dir, "operations.json"));
    const machines = new LocalMachineRepository(join(dir, "machines.json"));
    const service = new OperationsService(repo, machines);
    await service.saveRules("tenant-rules", [{ ruleId: "cold", title: "Cold", explanation: "Below threshold", severity: "warning", match: "all", conditions: [{ metric: "temperatureC", operator: "lt", threshold: -20 }], enabled: true }]);
    assert.throws(() => validateRules({ rules: [{ ruleId: "bad", title: "Bad", explanation: "Outside range", severity: "warning", match: "all", enabled: true, conditions: [{ metric: "rpm", operator: "gte", threshold: -1 }] }] }), /Validation failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("manual incident and corrective order creation are tenant scoped and idempotent without AI output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arquifusion-manual-incident-"));
  try {
    const machines = new LocalMachineRepository(join(dir, "machines.json"));
    await machines.upsert(normalizeMachine({ machineId: "EQ-MANUAL", model: "Loader", category: "Loader", location: "Yard", status: "operational" }, "json", "tenant-manual"));
    const repo = new LocalOperationalRepository(join(dir, "operations.json"));
    const service = new OperationsService(repo, machines);
    const input = { machineId: "EQ-MANUAL", type: "hydraulic-leak", severity: "warning" as const, description: "Visible leak during inspection" };
    const first = await service.createManualIncident("tenant-manual", "manual-incident-key", input, { userSub: "admin-sub", role: "admin" });
    const replay = await service.createManualIncident("tenant-manual", "manual-incident-key", input, { userSub: "admin-sub", role: "admin" });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    await assert.rejects(service.createManualIncident("tenant-manual", "manual-incident-key", { ...input, description: "changed" }, { userSub: "admin-sub", role: "admin" }), /different incident data/);
    const createdOrder = await service.createWorkOrderFromIncident("tenant-manual", first.incident.entityId, { userSub: "admin-sub", role: "admin" });
    const orderReplay = await service.createWorkOrderFromIncident("tenant-manual", first.incident.entityId, { userSub: "admin-sub", role: "admin" });
    assert.equal(createdOrder.replayed, false);
    assert.equal(orderReplay.replayed, true);
    assert.equal(createdOrder.workOrder.status, "planned");
    assert.equal(createdOrder.workOrder.anomalyId, undefined);
    assert.equal(await repo.get("other-tenant", "INCIDENT", first.incident.entityId), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("operational endpoint enforces Cognito tenant isolation and idempotent anomaly-to-incident workflow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arquifusion-operations-api-"));
  const tenants = new LocalTenantDirectory(join(dir, "tenants.json"));
  const tenantA = await tenants.createTenant("operator-a", "Operations A", "ops-a");
  const tenantB = await tenants.createTenant("operator-b", "Operations B", "ops-b");
  const machines = new LocalMachineRepository(join(dir, "machines.json"));
  await machines.upsert(normalizeMachine({ machineId: "EQ-1", model: "Loader", category: "Loader", location: "North yard", status: "operational" }, "json", tenantA.tenant.tenantId));
  await machines.upsert(normalizeMachine({ machineId: "EQ-1", model: "Loader", category: "Loader", location: "South yard", status: "operational" }, "json", tenantB.tenant.tenantId));
  const operations = new LocalOperationalRepository(join(dir, "operations.json"));
  const service = new OperationsService(operations, machines);
  let dispatchCount = 0;
  const workflow = { dispatch: async (input: { tenantId: string; anomalyId: string }) => { dispatchCount += 1; await service.processAnomaly(input.tenantId, input.anomalyId); } };
  const tokens = new Map([
    ["token-a", "operator-a"], ["token-b", "operator-b"],
  ]);
  const services: ApiServices = {
    machines, originals: new LocalOriginalFileStore(join(dir, "uploads")), operations, operationsWorkflow: workflow,
    tenants, authMode: "cognito", tokenVerifier: { verify: async (token) => {
      const sub = tokens.get(token); if (!sub) throw new Error("invalid token");
      return { sub, scope: "arquifusion/read arquifusion/write", client_id: "test-client", token_use: "access", iss: "https://issuer.test", exp: Math.floor(Date.now() / 1000) + 600 };
    } },
  };
  const server = createLocalServer(services);
  try {
    await listen(server);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = (token: string, path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "x-tenant-id": token === "token-a" ? tenantA.tenant.tenantId : tenantB.tenant.tenantId, ...(init.headers as Record<string, string> | undefined) } });
    const timestamp = iso(1);
    const reading = { readings: [{ machineId: "EQ-1", timestamp, metrics: { loadPercent: 120, temperatureC: 95 } }] };
    const forged = await request("token-a", "/telemetry/batch", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "forged-tenant" }, body: JSON.stringify({ ...reading, tenantId: tenantB.tenant.tenantId }) });
    assert.equal(forged.status, 400, "request tenantId is not an accepted field");

    const first = await request("token-a", "/telemetry/batch", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "sensor-batch-1" }, body: JSON.stringify(reading) });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { data: { accepted: number; anomalyCount: number; anomalies: Array<{ anomalyId: string }>; replayed: boolean } };
    assert.equal(firstBody.data.accepted, 1);
    assert.equal(firstBody.data.anomalyCount, 1);
    assert.equal(firstBody.data.replayed, false);
    assert.equal(dispatchCount, 1);

    const replay = await request("token-a", "/telemetry/batch", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "sensor-batch-1" }, body: JSON.stringify(reading) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { data: { replayed: boolean } }).data.replayed, true);
    assert.equal(dispatchCount, 2, "workflow replay is safe and the worker is idempotent");

    const changed = await request("token-a", "/telemetry/batch", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "sensor-batch-1" }, body: JSON.stringify({ readings: [{ machineId: "EQ-1", timestamp, metrics: { loadPercent: 90 } }] }) });
    assert.equal(changed.status, 409);
    const duplicateReading = await request("token-a", "/telemetry/batch", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "different-key" }, body: JSON.stringify(reading) });
    assert.equal(duplicateReading.status, 409);

    const ownIncidents = await request("token-a", "/incidents");
    const incidents = (await ownIncidents.json() as { data: { items: Array<{ entityId: string; version: number; status: string }> } }).data.items;
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].status, "open");
    const ownOrders = (await request("token-a", "/maintenance/orders").then((response) => response.json()) as { data: { items: Array<{ status: string; type: string; partsUsed: unknown[] }> } }).data.items;
    assert.equal(ownOrders.length, 1);
    assert.equal(ownOrders[0].type, "corrective");
    assert.deepEqual(ownOrders[0].partsUsed, []);
    const ownEvents = (await request("token-a", "/operations/events").then((response) => response.json()) as { data: { items: Array<{ eventType: string }> } }).data.items;
    assert.ok(ownEvents.some((event) => event.eventType === "OperationalAnomalyDetected"));
    assert.ok(ownEvents.some((event) => event.eventType === "IncidentCreated"));
    assert.ok(ownEvents.some((event) => event.eventType === "MaintenanceOrderCreated"));
    assert.ok(ownEvents.some((event) => event.eventType === "NotificationRequested"));

    const tenantBIncidents = (await request("token-b", "/incidents").then((response) => response.json()) as { data: { items: unknown[] } }).data.items;
    const tenantBTelemetry = (await request("token-b", "/telemetry?machineId=EQ-1").then((response) => response.json()) as { data: { items: unknown[] } }).data.items;
    assert.deepEqual(tenantBIncidents, []);
    assert.deepEqual(tenantBTelemetry, []);

    const updated = await request("token-a", `/incidents/${incidents[0].entityId}`, { method: "PATCH", headers: { "content-type": "application/json", "if-match": '"1"' }, body: JSON.stringify({ status: "acknowledged", assignedTo: "supervisor-7" }) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as { data: { version: number; status: string } }).data.version, 2);
    const stale = await request("token-a", `/incidents/${incidents[0].entityId}`, { method: "PATCH", headers: { "content-type": "application/json", "if-match": "1" }, body: JSON.stringify({ status: "resolved", resolution: "done" }) });
    assert.equal(stale.status, 409);

    const manual = await request("token-a", "/incidents", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "manual-demo-incident" }, body: JSON.stringify({ machineId: "EQ-1", type: "hydraulic-leak", severity: "warning", description: "Observed during operator inspection" }) });
    assert.equal(manual.status, 200);
    const manualIncident = (await manual.json() as { data: { incident: { entityId: string; status: string }; replayed: boolean } }).data;
    assert.equal(manualIncident.incident.status, "open");
    assert.equal(manualIncident.replayed, false);
    const manualReplay = await request("token-a", "/incidents", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "manual-demo-incident" }, body: JSON.stringify({ machineId: "EQ-1", type: "hydraulic-leak", severity: "warning", description: "Observed during operator inspection" }) });
    assert.equal((await manualReplay.json() as { data: { replayed: boolean } }).data.replayed, true);
    const orderResponse = await request("token-a", `/incidents/${manualIncident.incident.entityId}/maintenance-orders`, { method: "POST" });
    assert.equal(orderResponse.status, 200);
    const manualOrder = (await orderResponse.json() as { data: { workOrder: { incidentId: string; status: string; anomalyId?: string } } }).data.workOrder;
    assert.equal(manualOrder.incidentId, manualIncident.incident.entityId);
    assert.equal(manualOrder.status, "planned");
    assert.equal(manualOrder.anomalyId, undefined);
    assert.equal((await request("token-b", `/incidents/${manualIncident.incident.entityId}/maintenance-orders`, { method: "POST" })).status, 404);
  } finally { await close(server); await rm(dir, { recursive: true, force: true }); }
});

test("configurable history-delta rule does not infer a baseline when no prior reading exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arquifusion-operations-history-"));
  try {
    const machines = new LocalMachineRepository(join(dir, "machines.json"));
    await machines.upsert(normalizeMachine({ machineId: "EQ-H", model: "Excavator", category: "Excavator", location: "Yard", status: "operational" }, "json", "tenant-history"));
    const repository = new LocalOperationalRepository(join(dir, "operations.json"));
    const service = new OperationsService(repository, machines);
    await service.saveRules("tenant-history", [{ ruleId: "vibration-rise", title: "Incremento de vibración", explanation: "La vibración subió frente a la lectura previa.", severity: "warning", match: "all", conditions: [{ metric: "vibrationMmS", operator: "changePctGte", threshold: 50 }], enabled: true }]);
    const firstTimestamp = iso(5);
    const first = await service.ingestBatch("tenant-history", "first-reading", [{ machineId: "EQ-H", timestamp: firstTimestamp, metrics: { vibrationMmS: 10 } }]);
    assert.equal(first.anomalyCount, 0);
    const second = await service.ingestBatch("tenant-history", "second-reading", [{ machineId: "EQ-H", timestamp: iso(4), metrics: { vibrationMmS: 16 } }]);
    assert.equal(second.anomalyCount, 1);
    const anomalies = await service.list("tenant-history", "ANOMALY", 10);
    const evidence = (anomalies.items[0].evidence as Array<{ previous?: number; observed: number; changePercent?: number }>)[0];
    assert.equal(evidence.previous, 10);
    assert.equal(evidence.observed, 16);
    assert.equal(evidence.changePercent, 60);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function listen(server: ReturnType<typeof createLocalServer>) {
  return new Promise<void>((resolveListen, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolveListen()));
}
function close(server: ReturnType<typeof createLocalServer>) {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
