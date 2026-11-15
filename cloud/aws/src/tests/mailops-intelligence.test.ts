import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Machine } from "../core/machine";
import { GcpIntelligenceAdapter } from "../mailops/gcp-intelligence";
import { validateEvent } from "../supervisor/event-contract";
import { MailProcessor, ReportGenerator, TenantResolver } from "../mailops/processor";
import { LocalAnalysisAdapter } from "../mailops/analysis";
import { MemoryMailJobRepository } from "../mailops/repository";
import { MockMailAdapter } from "../mailops/mock";
import { SqliteMailQueue } from "../mailops/durable";
import { MailWorker } from "../mailops/worker";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const machine = (n: number): Machine => ({ tenantId: "a", machineId: `M${n}`, model: "private model", category: "excavator", location: "private location", status: "alert", temperature: 95, updatedAt: "2026-01-01T00:00:00Z", dataSource: "csv" });
const input = { tenantId: "a", jobId: "job", machines: [machine(1)] };
type Event = { eventId: string; eventType: string; schemaVersion: string; timestamp: string; tenantId: string; taskId: string; executionId: string; correlationId: string; source: string; payload: { machines: Array<Record<string, unknown>> } };
function response(event: Event) { return { ...event, eventId: "reply", eventType: "IntelligenceAnalysisCompleted", source: "arquifusion-intelligence", payload: { provider: "gemini-api", model: "test-model", recommendations: [{ machineId: event.payload.machines[0].machineId, priority: "high", category: "maintenance", title: "Revisar", reason: "Alerta", suggestedAction: "Inspeccionar", evidence: { status: "alert", temperature: 95 } }] } }; }
async function server(handler: (event: Event, res: ServerResponse, req: IncomingMessage) => void) {
  const instance = createServer((req, res) => { const parts: Buffer[] = []; req.on("data", p => parts.push(p)); req.on("end", () => handler(JSON.parse(Buffer.concat(parts).toString()) as Event, res, req)); });
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`, close: () => new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()); }) };
}
const ok = (res: ServerResponse, value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };

test("HTTP service receives real event and privacy-minimized data; validated recommendation is reported", async () => {
  let count = 0;
  const s = await server((event, res, req) => { count++; assert.equal(req.url, "/v1/intelligence/analyze"); assert.equal(req.headers.authorization, "Bearer test-only"); assert.ok(validateEvent(event)); assert.equal(event.eventType, "IntelligenceAnalysisRequested"); assert.deepEqual(event.payload.machines[0], { machineId: "machine-1", status: "alert", temperature: 95 }); ok(res, response(event)); });
  try { const out = await new GcpIntelligenceAdapter(s.url, "test-only", "mock").analyze(input); assert.equal(count, 1); assert.equal(out.source, "mock"); assert.match(out.recommendations[0], /^M1: Revisar/); }
  finally { await s.close(); }
});
for (const scenario of ["tenant", "correlation", "machine", "evidence"] as const) test(`rejects ${scenario} mismatch`, async () => {
  const s = await server((event, res) => { const result = response(event); if (scenario === "tenant") result.tenantId = "other"; if (scenario === "correlation") result.correlationId = "wrong"; if (scenario === "machine") result.payload.recommendations[0].machineId = "unknown"; if (scenario === "evidence") result.payload.recommendations[0].evidence.temperature = 999; ok(res, result); });
  try { await assert.rejects(new GcpIntelligenceAdapter(s.url, "test-only", "mock").analyze(input)); } finally { await s.close(); }
});
test("retries HTTP 429, then accepts a valid response", async () => {
  let count = 0; const s = await server((event, res) => { if (++count === 1) { res.writeHead(429); res.end(); } else ok(res, response(event)); });
  try { const out = await new GcpIntelligenceAdapter(s.url, "test-only", "mock", 1000, 2, 1).analyze(input); assert.equal(count, 2); assert.equal(out.recommendations.length, 1); } finally { await s.close(); }
});
test("retries HTTP 502 and 503 within the configured limit", async () => {
  let count = 0; const s = await server((event, res) => { count++; if (count < 3) { res.writeHead(count === 1 ? 502 : 503); res.end(); } else ok(res, response(event)); });
  try { await new GcpIntelligenceAdapter(s.url, "test-only", "mock", 1000, 3, 1).analyze(input); assert.equal(count, 3); } finally { await s.close(); }
});
test("timeout and connection failure are bounded", async () => {
  const s = await server((_event, res) => { setTimeout(() => res.end("{}"), 150); });
  try { await assert.rejects(new GcpIntelligenceAdapter(s.url, "test-only", "mock", 20, 1).analyze(input)); } finally { await s.close(); }
  await assert.rejects(new GcpIntelligenceAdapter(s.url, "test-only", "mock", 100, 1).analyze(input));
});
test("201 machines are sent sequentially in batches of 200 and 1", async () => {
  const seen: Event[] = []; const s = await server((event, res) => { seen.push(event); ok(res, { ...response(event), payload: { provider: "gemini-api", model: "test", recommendations: [] } }); });
  try { await new GcpIntelligenceAdapter(s.url, "test-only", "mock").analyze({ ...input, machines: Array.from({ length: 201 }, (_, i) => machine(i)) }); assert.deepEqual(seen.map(e => e.payload.machines.length), [200, 1]); assert.equal(seen[0].correlationId, seen[1].correlationId); assert.equal(seen[0].taskId, "job"); assert.notEqual(seen[0].eventId, seen[1].eventId); } finally { await s.close(); }
});
test("abort during request prevents further batches", async () => {
  let count = 0; const s = await server((_event, res) => { count++; setTimeout(() => res.end("{}"), 150); }); const controller = new AbortController();
  try { const pending = new GcpIntelligenceAdapter(s.url, "test-only", "mock", 1000, 2, 1).analyze({ ...input, signal: controller.signal }); setTimeout(() => controller.abort(), 30); await assert.rejects(pending); assert.equal(count, 1); } finally { await s.close(); }
});
test("intelligence failure creates the existing fallback report", async () => {
  const m = { id: "m", threadId: "t", from: "a@example.test", subject: "test", messageId: "<m@example.test>", identityVerified: true, attachments: [{ filename: "fleet.csv", contentType: "text/csv", bytes: Buffer.from("machineId,model,category,location,status\nM1,M,C,L,alert\n") }] };
  const mail = new MockMailAdapter([m]); const processor = new MailProcessor(mail, new MemoryMailJobRepository(), new TenantResolver([{ email: m.from, tenantId: "a", name: "A" }]), new LocalAnalysisAdapter(), new ReportGenerator(), new GcpIntelligenceAdapter("http://127.0.0.1:1", "test-only", "mock", 50, 1));
  assert.equal((await processor.process(m)).state, "COMPLETED"); assert.match(mail.sent[0].text, /Recomendaciones Gemini: no disponibles/);
});
test("worker losing a lease aborts intelligence and sends no report", async () => {
  const queue = new SqliteMailQueue(":memory:"); let calls = 0;
  const m = { id: "lease", threadId: "t", from: "a@example.test", subject: "test", messageId: "<m@example.test>", identityVerified: true, attachments: [{ filename: "fleet.csv", contentType: "text/csv", bytes: Buffer.from("machineId,model,category,location,status\nM1,M,C,L,alert\n") }] };
  const s = await server((_event, res) => { calls++; queue.db.prepare("UPDATE mail_queue SET token='stolen' WHERE message_id=?").run(m.id); setTimeout(() => res.end("{}"), 200); });
  try {
    queue.submit(m, Date.now()); const mail = new MockMailAdapter([m]); const tenants = new TenantResolver([{ email: m.from, tenantId: "a", name: "A" }]);
    const client = new GcpIntelligenceAdapter(s.url, "test-only", "mock", 1000, 1);
    await assert.rejects(new MailWorker(queue, mail, tenants, "worker", Date.now, 60, 3, client).runOne());
    assert.equal(calls, 1); assert.equal(mail.sent.length, 0); assert.notEqual(queue.get(m.id)?.state, "COMPLETED");
  } finally { await s.close(); queue.close(); }
});
test("mock output is labelled as simulated in the report", async () => {
  const s = await server((event, res) => ok(res, response(event)));
  try {
    const m = { id: "m", threadId: "t", from: "a@example.test", subject: "test", messageId: "<m@example.test>", identityVerified: true, attachments: [{ filename: "fleet.csv", contentType: "text/csv", bytes: Buffer.from("machineId,model,category,location,status,temperature\nM1,M,C,L,alert,95\n") }] };
    const mail = new MockMailAdapter([m]); const p = new MailProcessor(mail, new MemoryMailJobRepository(), new TenantResolver([{ email: m.from, tenantId: "a", name: "A" }]), new LocalAnalysisAdapter(), new ReportGenerator(), new GcpIntelligenceAdapter(s.url, "test-only", "mock"));
    assert.equal((await p.process(m)).state, "COMPLETED"); assert.match(mail.sent[0].text, /servicio simulado \(no Gemini real\)/); assert.match(mail.sent[0].html, /M1: Revisar/);
  } finally { await s.close(); }
});
test("real Python handler accepts the event with an in-process fake provider", async () => {
  const child = spawn("python", ["cloud/aws/fixtures/mailops/mock_python_service.py"], { cwd: resolve(__dirname, "../../../.."), stdio: ["ignore", "pipe", "pipe"] });
  try {
    const lines = createInterface({ input: child.stdout });
    const port = await new Promise<number>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Python did not start")), 5000); lines.once("line", value => { clearTimeout(timer); resolve(Number(value)); }); child.once("error", reject); child.once("exit", code => reject(new Error(`Python exited ${code}`))); });
    const result = await new GcpIntelligenceAdapter(`http://127.0.0.1:${port}`, "local-test-only", "mock", 2000, 1).analyze(input);
    assert.equal(result.source, "mock"); assert.match(result.recommendations[0], /M1: Revisar/);
  } finally { child.kill(); }
});
