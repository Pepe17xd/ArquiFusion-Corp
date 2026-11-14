import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { normalizeMachine, ValidationError, type Machine } from "../core/machine";
import { IngestionService, MAX_IMPORT_BYTES, normalizeRows, parseCsv } from "../ingestion/service";
import { aggregateFleetMetrics, getFleetMetrics } from "../metrics/service";
import { LangGraphFleetIntelligence } from "../intelligence/fleet-graph";
import { LocalMachineRepository } from "../storage/local-machine-repository";
import { LocalOriginalFileStore } from "../storage/local-original-file-store";
import type { MachineRepository } from "../storage/contracts";
import { decodeDynamoKey, encodeDynamoKey } from "../storage/dynamo-machine-repository";
import { createLocalServer } from "../local-server";

const sample = {
  machineId: "EXC-001", model: "Excavator X200", category: "Excavadora", location: "Zona A",
  status: "operational", operatingHours: 1250, temperature: 85, vibration: 4.2, pressure: 180, fuelConsumption: 18,
};
const testDataDirectory = resolve(__dirname, "../../data");

test("CSV and JSON pass through one normalizer and produce compatible machines", () => {
  const csv = parseCsv("machineId,model,category,location,status,operatingHours\nEXC-001,Excavator X200,Excavadora,Zona A,operational,1250");
  const fromCsv = normalizeRows(csv, "csv", "local-demo").accepted[0];
  const fromJson = normalizeRows(sample, "json", "local-demo").accepted[0];
  assert.equal(fromCsv.machineId, fromJson.machineId);
  assert.equal(fromCsv.operatingHours, fromJson.operatingHours);
  assert.equal(fromCsv.dataSource, "csv");
  assert.equal(fromJson.dataSource, "json");
});

test("normalization reports required fields, invalid status and invalid numeric values", () => {
  assert.throws(() => normalizeMachine({ machineId: "x" }, "json", "local-demo"), ValidationError);
  const result = normalizeRows([{ ...sample, status: "unknown", operatingHours: -1 }], "json", "local-demo");
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].errors.join(" "), /status/);
  assert.match(result.rejected[0].errors.join(" "), /operatingHours/);
});

test("CSV reports missing required headers and malformed input", () => {
  assert.throws(() => parseCsv("machineId,model\nx,y"), (error) => error instanceof ValidationError && error.issues[0].includes("Missing CSV headers"));
  assert.throws(() => parseCsv("id,name"), (error) => error instanceof ValidationError && error.issues[0].includes("Missing CSV headers"));
  assert.throws(() => parseCsv('machineId,model,category,location,status\n"unterminated'), (error) => error instanceof ValidationError && error.issues[0].includes("Invalid CSV"));
});

test("CSV parsing keeps duplicate __proto__ headers from replacing the record prototype", () => {
  const rows = parseCsv("machineId,model,category,location,status,__proto__,__proto__\nEQ-1,Loader,Loader,Yard,operational,first,second");
  assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("local repository upserts by ID, filters and paginates deterministically", async () => {
  const dir = await mkdtemp(join(testDataDirectory, ".test-repo-"));
  try {
    const repo = new LocalMachineRepository(join(dir, "machines.json"));
    await repo.upsert(normalizeMachine(sample, "json", "local-demo"));
    await repo.upsert(normalizeMachine({ ...sample, machineId: "BLD-002", status: "maintenance", location: "Zona B" }, "json", "local-demo"));
    await repo.upsert(normalizeMachine({ ...sample, location: "Zona C" }, "json", "local-demo"));
    assert.equal((await repo.list("local-demo", 10)).items.length, 2);
    assert.equal((await repo.get("local-demo", "EXC-001"))?.location, "Zona C");
    assert.equal(await repo.get("tenant-other", "EXC-001"), undefined);
    const filtered = await repo.list("local-demo", 10, undefined, { status: "maintenance" });
    assert.equal(filtered.items[0].machineId, "BLD-002");
    assert.equal(filtered.nextCursor, undefined);
    const page1 = await repo.list("local-demo", 1);
    const page2 = await repo.list("local-demo", 1, page1.nextCursor);
    assert.notEqual(page1.items[0].machineId, page2.items[0].machineId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("local repository exposes corrupt storage instead of silently returning an empty fleet", async () => {
  const dir = await mkdtemp(join(testDataDirectory, ".test-corrupt-"));
  try {
    const file = join(dir, "machines.json");
    await writeFile(file, "not json");
    await assert.rejects(new LocalMachineRepository(file).list("local-demo", 10), SyntaxError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CSV and JSON ingestion archive originals and report per-row errors while upserting accepted machines", async () => {
  const dir = await mkdtemp(join(testDataDirectory, ".test-ingestion-"));
  try {
    const repo = new LocalMachineRepository(join(dir, "machines.json"));
    const service = new IngestionService(repo, new LocalOriginalFileStore(join(dir, "uploads")));
    const json = JSON.stringify([sample, { ...sample, machineId: "", status: "bad" }]);
    const first = await service.ingest(json, "json", "application/json", "local-demo");
    const second = await service.ingest(json, "json", "application/json", "local-demo");
    assert.equal(first.processed, 2);
    assert.equal(first.accepted.length, 1);
    assert.equal(first.rejected.length, 1);
    assert.equal(first.originalFileUri, second.originalFileUri);
    assert.equal((await repo.list("local-demo", 10)).items.length, 1);
    assert.equal(JSON.parse(await readFile(join(dir, "machines.json"), "utf8")).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("fleet metrics aggregate every repository page, not just the first page", async () => {
  const machines: Machine[] = Array.from({ length: 205 }, (_, index) => normalizeMachine({
    ...sample,
    machineId: "M-" + String(index).padStart(3, "0"),
    status: index % 2 ? "operational" : "maintenance",
    fuelConsumption: 10,
    operatingHours: 100,
  }, "json", "local-demo"));
  const repository: MachineRepository = {
    upsert: async () => undefined,
    get: async (tenantId, id) => machines.find((machine) => machine.tenantId === tenantId && machine.machineId === id),
    list: async (tenantId, limit, cursor) => {
      const offset = cursor ? Number(cursor) : 0;
      const items = machines.filter((machine) => machine.tenantId === tenantId).slice(offset, offset + limit);
      return { items, nextCursor: offset + limit < machines.length ? String(offset + limit) : undefined };
    },
  };
  const metrics = await getFleetMetrics(repository, "local-demo");
  assert.equal(metrics.total, 205);
  assert.equal(metrics.operational, 102);
  assert.equal(metrics.maintenance, 103);
  assert.equal(metrics.totalFuelConsumption, 2050);
  assert.equal(metrics.averageOperatingHours, 100);
});

test("LangGraph runs the deterministic fleet workflow and returns evidence-backed recommendations", async () => {
  const machine = normalizeMachine({ ...sample, status: "alert", temperature: 94, vibration: 5.4 }, "json", "local-demo");
  const result = await new LangGraphFleetIntelligence().recommend({ machines: [machine] });
  assert.equal(result.source, "deterministic-rules");
  assert.equal(result.recommendations.length, 3);
  assert.equal(result.recommendations[0].machineId, machine.machineId);
  assert.deepEqual(result.recommendations[1].evidence, { temperature: 94 });
});

test("DynamoDB pagination cursors preserve the complete LastEvaluatedKey", () => {
  const key = { pk: "tenant-a", sk: "EXC-001" };
  assert.deepEqual(decodeDynamoKey(encodeDynamoKey(key)), key);
  assert.throws(() => decodeDynamoKey("not-a-cursor"), (error) => error instanceof ValidationError && error.issues[0] === "Invalid pagination cursor");
});

test("file ingestion enforces the API size limit", async () => {
  const dir = await mkdtemp(join(testDataDirectory, ".test-size-"));
  try {
    const service = new IngestionService(new LocalMachineRepository(join(dir, "machines.json")), new LocalOriginalFileStore(join(dir, "uploads")));
    await assert.rejects(service.ingest("x".repeat(MAX_IMPORT_BYTES + 1), "json", "application/json", "local-demo"), ValidationError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("local HTTP server exercises ingestion, list, detail and metrics through the API handlers", async () => {
  const dir = await mkdtemp(join(testDataDirectory, ".test-http-"));
  const server = createLocalServer({
    machines: new LocalMachineRepository(join(dir, "machines.json")),
    originals: new LocalOriginalFileStore(join(dir, "uploads")),
    tenants: new (await import("../tenancy/local-tenant-directory")).LocalTenantDirectory(join(dir, "tenants.json")),
  });
  try {
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    const health = await fetch(base + "/health").then((response) => response.json()) as any;
    assert.equal(health.data.status, "ok");
    const imported = await fetch(base + "/ingest/json", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sample),
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json() as any).data.accepted.length, 1);
    const listed = await fetch(base + "/machines?limit=1").then((response) => response.json()) as any;
    assert.equal(listed.data.items[0].machineId, "EXC-001");
    const detail = await fetch(base + "/machines/EXC-001").then((response) => response.json()) as any;
    assert.equal(detail.data.model, sample.model);
    const csv = "machineId,model,category,location,status,temperature\nALR-002,Loader L1,Loader,Zona C,alert,95";
    const csvImport = await fetch(base + "/ingest/csv", { method: "POST", headers: { "content-type": "text/csv" }, body: csv });
    assert.equal(csvImport.status, 200);
    const filtered = await fetch(base + "/machines?status=alert&category=Loader&search=ALR-002").then((response) => response.json()) as any;
    assert.equal(filtered.data.items.length, 1);
    assert.equal(filtered.data.items[0].machineId, "ALR-002");
    const metrics = await fetch(base + "/metrics").then((response) => response.json()) as any;
    assert.equal(metrics.data.total, 2);
    assert.equal(metrics.data.alert, 1);
    const intelligence = await fetch(base + "/intelligence/recommendations").then((response) => response.json()) as any;
    assert.equal(intelligence.data.recommendations[0].machineId, "ALR-002");
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("metric aggregate handles an empty fleet and missing telemetry", () => {
  const empty = aggregateFleetMetrics([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.availabilityPercent, 0);
  assert.equal(empty.averageFuelConsumption, undefined);
  const noTelemetry = aggregateFleetMetrics([normalizeMachine({ ...sample, fuelConsumption: undefined, operatingHours: undefined }, "json", "local-demo")]);
  assert.equal(noTelemetry.totalFuelConsumption, 0);
  assert.equal(noTelemetry.averageFuelConsumption, undefined);
});
