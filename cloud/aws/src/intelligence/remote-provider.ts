import { randomUUID } from "node:crypto";
import { createEvent } from "../supervisor/event-contract";
import type { IntelligenceInput, IntelligenceOutput, IntelligenceProvider, Recommendation } from "./contracts";

const MAX_MACHINES = 200;

export interface RemoteIntelligenceOptions {
  url: string;
  apiKey: string;
  /** Render's free instance can take about a minute to wake up. */
  timeoutMs?: number;
}

export class RemoteGeminiIntelligence implements IntelligenceProvider {
  constructor(private readonly options: RemoteIntelligenceOptions, private readonly request: typeof fetch = fetch) {}

  async recommend(input: IntelligenceInput): Promise<IntelligenceOutput> {
    const context = input.context ?? { tenantId: "direct", taskId: randomUUID(), executionId: randomUUID(), correlationId: randomUUID() };
    const event = createEvent({
      eventType: "IntelligenceAnalysisRequested",
      ...context,
      payload: { machines: input.machines.slice(0, MAX_MACHINES) },
    });
    const response = await this.request(new URL("/v1/intelligence/analyze", this.options.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 100_000),
    });
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
    return parseCompleted(await response.json());
  }
}

function parseCompleted(data: unknown): IntelligenceOutput {
  const event = data as { eventType?: string; timestamp?: string; payload?: { recommendations?: unknown } } | undefined;
  const recommendations = event?.payload?.recommendations;
  if (!event || event.eventType !== "IntelligenceAnalysisCompleted" || !Array.isArray(recommendations)) {
    throw new Error("INVALID_PROVIDER_RESPONSE");
  }
  return {
    generatedAt: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
    recommendations: recommendations as Recommendation[],
    source: "gemini-api",
  };
}