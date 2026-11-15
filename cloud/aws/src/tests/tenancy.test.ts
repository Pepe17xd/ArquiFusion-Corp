import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalServer } from "../local-server";
import { LocalMachineRepository } from "../storage/local-machine-repository";
import { LocalOriginalFileStore } from "../storage/local-original-file-store";
import { LocalTaskStore } from "../supervisor/local-task-store";
import { LocalTenantDirectory } from "../tenancy/local-tenant-directory";
import { normalizeMachine } from "../core/machine";
import { TenantAccessError } from "../tenancy/contracts";
import { createApiHandlers } from "../api/handlers";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { getFleetMetrics } from "../metrics/service";

const dataRoot = tmpdir();
const record = (tenantId: string, location: string) => normalizeMachine({
  machineId: "EQ-1", model: "Loader 1", category: "Loader", location, status: "operational",
}, "json", tenantId);

test("local identity is fixed, tenant selection requires membership, and tenant files are isolated", async () => {
  const dir = await mkdtemp(join(dataRoot, ".test-tenant-"));
  try {
    const directory = new LocalTenantDirectory(join(dir, "tenants.json"));
    await assert.rejects(directory.resolve("some-user", "local-demo"), TenantAccessError);
    const created = await directory.createTenant("other-dev-user", "Second organization", "create-second-organization");
    const replay = await directory.createTenant("other-dev-user", "Second organization", "create-second-organization");
    assert.equal(replay.tenant.tenantId, created.tenant.tenantId);
    assert.equal(created.membership.role, "owner");
    assert.equal((await directory.resolve("other-dev-user", created.tenant.tenantId)).tenantId, created.tenant.tenantId);
    await assert.rejects(directory.createTenant("other-dev-user", "Another organization", "different-request"), /one organization per account/);

    const repository = new LocalMachineRepository(join(dir, "machines.json"));
    await repository.upsert(record("local-demo", "North yard"));
    await repository.upsert(record(created.tenant.tenantId, "South yard"));
    assert.equal((await repository.get("local-demo", "EQ-1"))?.location, "North yard");
    assert.equal((await repository.get(created.tenant.tenantId, "EQ-1"))?.location, "South yard");
    assert.equal((await repository.list("local-demo", 10)).items.length, 1);
    assert.equal((await repository.list(created.tenant.tenantId, 10)).items.length, 1);
    assert.equal((await getFleetMetrics(repository, "local-demo")).total, 1);
    assert.equal((await getFleetMetrics(repository, created.tenant.tenantId)).total, 1);
    const originals = new LocalOriginalFileStore(join(dir, "uploads"));
    const originalInput = { content: "same payload", contentType: "text/csv", extension: "csv", sha256: "a".repeat(64) };
    const firstFile = await originals.saveOriginal({ ...originalInput, tenantId: "local-demo" });
    const secondFile = await originals.saveOriginal({ ...originalInput, tenantId: created.tenant.tenantId });
    assert.notEqual(firstFile, secondFile);
    assert.equal((await readFile(join(dir, "uploads", "tenants", "local-demo", "imports", `${originalInput.sha256}.csv`), "utf8")), originalInput.content);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("tenant owner can idempotently attach an existing Cognito subject as technician", async () => {
  const dir = await mkdtemp(join(dataRoot, ".test-technician-membership-"));
  try {
    const directory = new LocalTenantDirectory(join(dir, "tenants.json"));
    const tenant = await directory.createTenant("owner-sub", "Tenant A", "tenant-create");
    const first = await directory.addTechnicianMember(tenant.tenant.tenantId, "existing-cognito-sub");
    const replay = await directory.addTechnicianMember(tenant.tenant.tenantId, "existing-cognito-sub");
    assert.equal(first.role, "technician");
    assert.equal(replay.createdAt, first.createdAt);
    assert.equal((await directory.resolve("existing-cognito-sub", tenant.tenant.tenantId)).role, "technician");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("technician membership cannot be reassigned into another tenant and deactivated subjects stay blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tenant-technician-disable-"));
  try {
    const tenants = new LocalTenantDirectory(join(dir, "tenants.json"));
    const first = await tenants.createTenant("owner-first", "First", "owner-first-key");
    const second = await tenants.createTenant("owner-second", "Second", "owner-second-key");
    await tenants.addTechnicianMember(first.tenant.tenantId, "tech-shared");
    await assert.rejects(tenants.addTechnicianMember(second.tenant.tenantId, "tech-shared"), /already belongs to another organization/);
    await tenants.disableUser("tech-shared");
    await assert.rejects(tenants.assertUserActive("tech-shared"), /disabled/);
    await assert.rejects(tenants.resolve("tech-shared", first.tenant.tenantId), /not a member/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("local API ignores tenant IDs in imported records and refuses unverified Cognito identity", async () => {
  const dir = await mkdtemp(join(dataRoot, ".test-tenant-api-"));
  const services = {
    machines: new LocalMachineRepository(join(dir, "machines.json")),
    originals: new LocalOriginalFileStore(join(dir, "uploads")),
    tenants: new LocalTenantDirectory(join(dir, "tenants.json")),
    tasks: new LocalTaskStore(join(dir, "tasks.json")),
  };
  const local = createLocalServer(services);
  const cloudAuthBoundary = createLocalServer({ ...services, authMode: "cognito", tokenVerifier: { verify: async () => { throw new Error("invalid token"); } } });
  try {
    await Promise.all([listen(local), listen(cloudAuthBoundary)]);
    const localBase = `http://127.0.0.1:${(local.address() as { port: number }).port}`;
    const cloudBase = `http://127.0.0.1:${(cloudAuthBoundary.address() as { port: number }).port}`;
    const imported = await fetch(`${localBase}/ingest/json`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: "EQ-1", model: "Loader 1", category: "Loader", location: "North yard", status: "operational", tenantId: "attacker-tenant" }),
    });
    assert.equal(imported.status, 200);
    const stored = await imported.json() as { data: { accepted: Array<{ tenantId: string }> } };
    assert.equal(stored.data.accepted[0].tenantId, "local-demo");
    assert.equal((await fetch(`${cloudBase}/machines`)).status, 401);
    assert.equal((await fetch(`${cloudBase}/machines`, { headers: { authorization: "Bearer unverified" } })).status, 401);
  } finally {
    await Promise.all([close(local), close(cloudAuthBoundary)]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("viewer membership can read operational data but cannot ingest records", async () => {
  const dir = await mkdtemp(join(dataRoot, ".test-tenant-role-"));
  const tenantFile = join(dir, "tenants.json");
  const tenants = new LocalTenantDirectory(tenantFile);
  await tenants.createTenant("viewer-user", "Viewer fixture organization", "viewer-fixture");
  const directory = JSON.parse(await readFile(tenantFile, "utf8"));
  directory.memberships.find((membership: { tenantId: string }) => membership.tenantId === "local-demo").role = "viewer";
  await writeFile(tenantFile, JSON.stringify(directory));
  const server = createLocalServer({ machines: new LocalMachineRepository(join(dir, "machines.json")), originals: new LocalOriginalFileStore(join(dir, "uploads")), tenants });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal((await fetch(`${base}/machines`, { headers: { "x-tenant-id": "local-demo" } })).status, 200);
    const response = await fetch(`${base}/ingest/json`, { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": "local-demo" }, body: JSON.stringify({ machineId: "EQ-2", model: "Loader", category: "Loader", location: "Yard", status: "operational" }) });
    assert.equal(response.status, 403);
  } finally { await close(server); await rm(dir, { recursive: true, force: true }); }
});

test("an authenticated Cognito subject with no memberships can create and list its first organization", async () => {
  const dir = await mkdtemp(join(dataRoot, ".test-tenant-onboarding-"));
  const tenants = new LocalTenantDirectory(join(dir, "tenants.json"));
  const handlers = createApiHandlers({ machines: new LocalMachineRepository(join(dir, "machines.json")), originals: new LocalOriginalFileStore(join(dir, "uploads")), tenants, authMode: "cognito", tokenVerifier: { verify: async (token) => {
    if (token !== "valid-test-access-token") throw new Error("invalid");
    return { sub: "new-cognito-user", client_id: "test-client", token_use: "access", scope: "arquifusion/read arquifusion/write", iss: "https://issuer.test", exp: Math.floor(Date.now() / 1000) + 60 };
  } } });
  const event = (body?: string, method = "GET", idempotencyKey = "new-org-request") => ({ headers: { authorization: "Bearer valid-test-access-token", "idempotency-key": idempotencyKey }, body, isBase64Encoded: false, requestContext: { requestId: "test-request", authorizer: { jwt: { claims: { sub: "attacker-controlled-subject" } } }, http: { method } } } as unknown as APIGatewayProxyEventV2);
  try {
    const before = await handlers.listTenants(event());
    assert.equal(JSON.parse(responseBody(before)).data.length, 0);
    const created = await handlers.createTenant(event(JSON.stringify({ name: "First organization" }), "POST"));
    const createdBody = JSON.parse(responseBody(created)).data;
    assert.equal(createdBody.membership.role, "owner");
    assert.equal(createdBody.membership.userSub, "new-cognito-user");
    const replay = await handlers.createTenant(event(JSON.stringify({ name: "First organization" }), "POST"));
    assert.equal(JSON.parse(responseBody(replay)).data.tenant.tenantId, createdBody.tenant.tenantId);
    const conflict = await handlers.createTenant(event(JSON.stringify({ name: "Other organization" }), "POST", "new-org-other-key"));
    assert.equal(responseStatus(conflict), 409);
    const after = await handlers.listTenants(event());
    assert.equal(JSON.parse(responseBody(after)).data.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("adversarial API requests cannot cross tenant boundaries for fleet, ingestion, metrics, tasks, events or files", async () => {
  const dir = await mkdtemp(join(dataRoot, ".test-tenant-adversarial-"));
  const tenants = new LocalTenantDirectory(join(dir, "tenants.json"));
  const tenantA = await tenants.createTenant("user-a", "Tenant A", "tenant-a-create");
  const tenantB = await tenants.createTenant("user-b", "Tenant B", "tenant-b-create");
  const viewer = await tenants.createTenant("user-viewer", "Viewer Tenant", "tenant-viewer-create");
  const tenantData = JSON.parse(await readFile(join(dir, "tenants.json"), "utf8"));
  tenantData.memberships.find((item: { tenantId: string }) => item.tenantId === viewer.tenant.tenantId).role = "viewer";
  await writeFile(join(dir, "tenants.json"), JSON.stringify(tenantData));

  const machines = new LocalMachineRepository(join(dir, "machines.json"));
  await machines.upsert(record(tenantA.tenant.tenantId, "A yard"));
  await machines.upsert(normalizeMachine({ machineId: "B-ONLY", model: "Bulldozer", category: "Bulldozer", location: "B yard", status: "alert" }, "json", tenantB.tenant.tenantId));
  await machines.upsert(normalizeMachine({ machineId: "B-SECOND", model: "Excavator", category: "Excavator", location: "B yard", status: "maintenance" }, "json", tenantB.tenant.tenantId));
  const originals = new LocalOriginalFileStore(join(dir, "uploads"));
  const sharedOriginal = { content: "private import", contentType: "text/csv", extension: "csv", sha256: "b".repeat(64) };
  const fileA = await originals.saveOriginal({ ...sharedOriginal, tenantId: tenantA.tenant.tenantId });
  const fileB = await originals.saveOriginal({ ...sharedOriginal, tenantId: tenantB.tenant.tenantId });
  assert.notEqual(fileA, fileB);

  const tokens: Record<string, { sub: string; scope: string; client_id: string; token_use: "access"; iss: string; exp: number }> = {
    "token-a": { sub: "user-a", scope: "arquifusion/read arquifusion/write", client_id: "test-client", token_use: "access", iss: "https://issuer.test", exp: 9_999_999_999 },
    "token-b": { sub: "user-b", scope: "arquifusion/read arquifusion/write", client_id: "test-client", token_use: "access", iss: "https://issuer.test", exp: 9_999_999_999 },
    "token-viewer": { sub: "user-viewer", scope: "arquifusion/read arquifusion/write", client_id: "test-client", token_use: "access", iss: "https://issuer.test", exp: 9_999_999_999 },
    "token-read": { sub: "user-a", scope: "arquifusion/read", client_id: "test-client", token_use: "access", iss: "https://issuer.test", exp: 9_999_999_999 },
    "token-no-membership": { sub: "user-none", scope: "arquifusion/read arquifusion/write", client_id: "test-client", token_use: "access", iss: "https://issuer.test", exp: 9_999_999_999 },
  };
  const tasks = new LocalTaskStore(join(dir, "tasks.json"));
  const server = createLocalServer({
    machines, originals, tenants, tasks, authMode: "cognito",
    tokenVerifier: { verify: async (token) => { const claims = tokens[token]; if (!claims) throw new Error("invalid token"); return claims; } },
  });
  const handlers = createApiHandlers({
    machines, originals, tenants, tasks, authMode: "cognito",
    tokenVerifier: { verify: async (token) => { const claims = tokens[token]; if (!claims) throw new Error("invalid token"); return claims; } },
  });
  const request = (base: string, token: string, path: string, init: RequestInit = {}, selectedTenantId = tenantA.tenant.tenantId) => fetch(base + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "x-tenant-id": selectedTenantId, ...(init.headers as Record<string, string> | undefined) },
  });
  try {
    await listen(server);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const listA = await request(base, "token-a", "/machines?tenantId=" + tenantB.tenant.tenantId).then((response) => response.json()) as { data: { items: Array<{ tenantId: string }> } };
    assert.equal(listA.data.items.length, 1);
    assert.ok(listA.data.items.every((item) => item.tenantId === tenantA.tenant.tenantId));
    const selectedB = await request(base, "token-a", "/machines", {}, tenantB.tenant.tenantId);
    const nonexistentTenant = await request(base, "token-a", "/machines", {}, "not-a-tenant");
    assert.equal(selectedB.status, 403);
    assert.equal(await selectedB.text(), await nonexistentTenant.text(), "forbidden tenant response must not disclose whether the tenant exists");

    const crossMachine = await request(base, "token-a", "/machines/B-ONLY");
    const missingMachine = await request(base, "token-a", "/machines/NO-SUCH-MACHINE");
    assert.equal(crossMachine.status, 404);
    assert.equal(await crossMachine.text(), await missingMachine.text(), "cross-tenant machine IDs are indistinguishable from absent IDs");
    assert.equal((await request(base, "token-a", "/metrics").then((response) => response.json()) as { data: { total: number } }).data.total, 1);

    const tamperedImport = await request(base, "token-a", "/ingest/json", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ machineId: "FORGED", model: "Loader", category: "Loader", location: "A yard", status: "operational", tenantId: tenantB.tenant.tenantId }) });
    assert.equal(tamperedImport.status, 200);
    const forgedResult = await tamperedImport.json() as { data: { accepted: Array<{ tenantId: string }> } };
    assert.equal(forgedResult.data.accepted[0].tenantId, tenantA.tenant.tenantId);
    assert.equal((await machines.get(tenantB.tenant.tenantId, "FORGED")), undefined);
    assert.equal((await request(base, "token-a", "/machines/B-ONLY", { method: "DELETE" })).status, 404);
    assert.equal((await request(base, "token-a", "/machines/B-ONLY", { method: "PUT", body: "{}" })).status, 404);

    const taskAResponse = await request(base, "token-a", "/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskType: "fleet.recommendations", idempotencyKey: "tenant-a-task" }) });
    const taskBResponse = await request(base, "token-b", "/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskType: "fleet.recommendations", idempotencyKey: "tenant-b-task" }) }, tenantB.tenant.tenantId);
    const taskA = (await taskAResponse.json() as { data: { task: { taskId: string } } }).data.task;
    const taskB = (await taskBResponse.json() as { data: { task: { taskId: string } } }).data.task;
    assert.equal((await request(base, "token-a", `/tasks/${taskB.taskId}`)).status, 404);
    const taskAEvents = await request(base, "token-a", "/events?taskId=" + taskB.taskId).then((response) => response.json()) as { data: unknown[] };
    assert.deepEqual(taskAEvents.data, []);
    assert.equal((await request(base, "token-a", "/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskType: "fleet.recommendations", tenantId: tenantB.tenant.tenantId }) })).status, 400);
    assert.equal((await request(base, "token-a", "/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskType: "fleet.recommendations" }) }, tenantB.tenant.tenantId)).status, 403);
    let taskBBeforeInternalTamper = await tasks.get(tenantB.tenant.tenantId, taskB.taskId);
    // Local task execution is queued in the background; allow slower Windows CI/filesystems to finish.
    for (let attempt = 0; attempt < 1000 && taskBBeforeInternalTamper?.state !== "SUCCEEDED"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      taskBBeforeInternalTamper = await tasks.get(tenantB.tenant.tenantId, taskB.taskId);
    }
    assert.equal(taskBBeforeInternalTamper?.state, "SUCCEEDED");
    const taskBCompleted = taskBBeforeInternalTamper!;
    await assert.rejects(handlers.runTask({ tenantId: tenantA.tenant.tenantId, taskId: taskB.taskId, executionId: taskBCompleted.executionId, correlationId: taskBCompleted.correlationId }), /Workflow context does not match/);
    assert.equal((await tasks.get(tenantB.tenant.tenantId, taskB.taskId))?.state, taskBCompleted.state);

    assert.equal((await request(base, "token-a", "/tasks").then((response) => response.json()) as { data: unknown[] }).data.length, 1);
    assert.equal((await request(base, "token-no-membership", "/machines", {}, tenantA.tenant.tenantId)).status, 403);
    assert.equal((await request(base, "token-viewer", "/machines", {}, viewer.tenant.tenantId)).status, 200);
    assert.equal((await request(base, "token-viewer", "/ingest/json", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, viewer.tenant.tenantId)).status, 403);
    assert.equal((await request(base, "token-read", "/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskType: "fleet.recommendations" }) })).status, 403);
    assert.equal((await request(base, "token-a", "/tenants/B/imports/" + "b".repeat(64) + ".csv")).status, 404);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

function listen(server: ReturnType<typeof createLocalServer>) {
  return new Promise<void>((resolveListen, reject) => server.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolveListen()));
}
function close(server: ReturnType<typeof createLocalServer>) {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
function responseBody(result: import("aws-lambda").APIGatewayProxyResultV2) {
  if (typeof result === "string") return result;
  return "body" in result && typeof result.body === "string" ? result.body : "";
}
function responseStatus(result: import("aws-lambda").APIGatewayProxyResultV2) {
  return typeof result === "object" && result !== null && "statusCode" in result ? result.statusCode : undefined;
}
