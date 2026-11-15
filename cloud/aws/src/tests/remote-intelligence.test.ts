import { test } from "node:test";
import assert from "node:assert/strict";
import type { Machine } from "../core/machine";
import { FallbackIntelligence } from "../intelligence/factory";
import { LangGraphFleetIntelligence } from "../intelligence/fleet-graph";
import { RemoteGeminiIntelligence } from "../intelligence/remote-provider";

const machine = { machineId: "EXC-001", model: "CAT 320", category: "excavator", location: "Lima", status: "alert", temperature: 96, updatedAt: new Date().toISOString(), dataSource: "csv" } as Machine;

test("remote provider sends the bearer key and parses the completed event", async () => {
  let authorization: string | null = null;
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({
      eventType: "IntelligenceAnalysisCompleted", timestamp: "2026-11-14T20:00:00Z",
      payload: { recommendations: [{ machineId: "EXC-001", priority: "high", category: "maintenance", title: "t", reason: "r", suggestedAction: "a", evidence: {} }] },
    }), { status: 200 });
  }) as typeof fetch;
  const result = await new RemoteGeminiIntelligence({ url: "https://example.test", apiKey: "secret" }, fakeFetch).recommend({ machines: [machine] });
  assert.equal(authorization, "Bearer secret");
  assert.equal(result.source, "gemini-api");
  assert.equal(result.recommendations.length, 1);
});

test("fallback returns deterministic rules when the remote service fails", async () => {
  const failingFetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  const provider = new FallbackIntelligence(new RemoteGeminiIntelligence({ url: "https://example.test", apiKey: "secret" }, failingFetch), new LangGraphFleetIntelligence());
  const result = await provider.recommend({ machines: [machine] });
  assert.equal(result.source, "deterministic-rules");
  assert.ok(result.recommendations.length > 0);
});