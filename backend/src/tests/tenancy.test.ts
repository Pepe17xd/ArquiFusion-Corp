import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

const dataRoot = resolve(__dirname, "../../data");
const record = (tenantId: string, location: string) => normalizeMachine({
  machineId: "EQ-1", model: "Loader 1", category: "Loader", location, status: "operational",
}, "json", tenantId);

test("local identity is fixed, tenant selection requires membership, and tenant files are isolated", async () => {
  const dir = await mkdtemp(join(dataRoot, ".test-tenant-"));
  try {
    const directory = new LocalTenantDirectory(join(dir, "tenants.json"));
    await assert.rejects(directory.resolve("some-user", "local-demo"), TenantAccessError);
    const created = await directory.createTenant("local-dev-user", "Second organization");
    assert.equal(created.membership.role, "owner");
    assert.equal((await directory.resolve("local-dev-user", created.tenant.tenantId)).tenantId, created.tenant.tenantId);

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

test("local API ignores tenant IDs in imported records and refuses unverified Cognito identity", async () => {
  const dir = await mkdtemp(join(dataRoot, ".test-tenant-api-"));
  const services = {
    machines: new LocalMachineRepository(join(dir, "machines.json")),
    originals: new LocalOriginalFileStore(join(dir, "uploads")),
    tenants: new LocalTenantDirectory(join(dir, "tenants.json")),
    tasks: new LocalTaskStore(join(dir, "tasks.json")),
  };
  const local = createLocalServer(services);
  const cloudAuthBoundary = createLocalServer({ ...services, authMode: "cognito" });
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
  await tenants.createTenant("local-dev-user", "Viewer organization");
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
  const handlers = createApiHandlers({ machines: new LocalMachineRepository(join(dir, "machines.json")), originals: new LocalOriginalFileStore(join(dir, "uploads")), tenants, authMode: "cognito" });
  const event = (body?: string) => ({ headers: {}, body, isBase64Encoded: false, requestContext: { authorizer: { jwt: { claims: { sub: "new-cognito-user" } } } } } as unknown as APIGatewayProxyEventV2);
  try {
    const before = await handlers.listTenants(event());
    assert.equal(JSON.parse(responseBody(before)).data.length, 0);
    const created = await handlers.createTenant(event(JSON.stringify({ name: "First organization" })));
    assert.equal(JSON.parse(responseBody(created)).data.membership.role, "owner");
    const after = await handlers.listTenants(event());
    assert.equal(JSON.parse(responseBody(after)).data.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
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
