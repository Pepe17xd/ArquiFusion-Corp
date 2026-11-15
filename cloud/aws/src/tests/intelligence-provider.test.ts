import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpIntelligenceProvider } from "../mailops/http-intelligence";
import { GcpIntelligenceAdapter } from "../mailops/gcp-intelligence";
import { createIntelligenceProvider, intelligenceProviderFromEnv, MockIntelligenceProvider } from "../mailops/intelligence-provider";
import type { Machine } from "../core/machine";

const machine: Machine = { tenantId: "tenant-a", machineId: "M1", model: "Model", category: "hauler", location: "private", status: "operational", updatedAt: "2026-01-01T00:00:00Z", dataSource: "json" };
const input = { tenantId: "tenant-a", jobId: "job-a", machines: [machine] };

async function localService() {
  let seenUrl = "";
  const server = createServer((request, response) => {
    seenUrl = request.url ?? "";
    const buffers: Buffer[] = [];
    request.on("data", (chunk: Buffer) => buffers.push(chunk));
    request.on("end", () => {
      const event = JSON.parse(Buffer.concat(buffers).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...event, eventId: "completed", eventType: "IntelligenceAnalysisCompleted", source: "arquifusion-intelligence", payload: { provider: "gemini-api", model: "local-test", recommendations: [] } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: "http://127.0.0.1:" + (server.address() as AddressInfo).port, get seenUrl() { return seenUrl; }, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("Azure configuration selects the generic HTTP provider and calls its configured endpoint", async () => {
  const service = await localService();
  try {
    const provider = intelligenceProviderFromEnv({ MAILOPS_INTELLIGENCE_PROVIDER: "azure", MAILOPS_AZURE_INTELLIGENCE_URL: service.url, MAILOPS_INTELLIGENCE_TOKEN: "local-test" });
    assert.ok(provider instanceof HttpIntelligenceProvider);
    const result = await provider!.analyze(input);
    assert.equal(result.source, "gemini");
    assert.deepEqual(result.recommendations, []);
    assert.equal(service.seenUrl, "/v1/intelligence/analyze");
  } finally { await service.close(); }
});
test("legacy GCP environment remains the default alternative without contract changes", () => {
  const provider = intelligenceProviderFromEnv({ MAILOPS_INTELLIGENCE_URL: "https://gcp.example.test", MAILOPS_INTELLIGENCE_TOKEN: "test", MAILOPS_INTELLIGENCE_MODE: "gemini" });
  assert.ok(provider instanceof GcpIntelligenceAdapter);
  assert.equal(createIntelligenceProvider({ provider: "gcp", url: "https://gcp.example.test", token: "test" }) instanceof GcpIntelligenceAdapter, true);
});
test("explicit mock is offline, tenant guarded and emits no invented advice", async () => {
  const provider = intelligenceProviderFromEnv({ MAILOPS_INTELLIGENCE_PROVIDER: "mock" });
  assert.ok(provider instanceof MockIntelligenceProvider);
  assert.deepEqual(await provider!.analyze(input), { source: "mock", recommendations: [] });
  await assert.rejects(provider!.analyze({ ...input, machines: [{ ...machine, tenantId: "tenant-b" }] }), /Tenant mismatch/);
});
test("unknown or incomplete remote provider configurations fail closed", () => {
  assert.throws(() => intelligenceProviderFromEnv({ MAILOPS_INTELLIGENCE_PROVIDER: "aws" }), /Unsupported/);
  assert.throws(() => intelligenceProviderFromEnv({ MAILOPS_INTELLIGENCE_PROVIDER: "azure", MAILOPS_INTELLIGENCE_TOKEN: "x" }), /URL and token/);
  assert.throws(() => intelligenceProviderFromEnv({ MAILOPS_INTELLIGENCE_URL: "https://gcp.example.test", MAILOPS_INTELLIGENCE_TOKEN: "x" }), /MODE remains required/);
});
