import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { validateEvent } from "../supervisor/event-contract";
import type { IntelligenceProvider } from "./contracts";

type Input = Parameters<IntelligenceProvider["analyze"]>[0];
type SafeMachine = { machineId: string; status: string; operatingHours?: number; temperature?: number; vibration?: number; pressure?: number; fuelConsumption?: number };
const fields = ["status", "operatingHours", "temperature", "vibration", "pressure", "fuelConsumption"] as const;
const maxBytes = 1024 * 1024;

export class HttpIntelligenceProvider implements IntelligenceProvider {
  private readonly endpoint: string;
  constructor(baseUrl: string, private readonly token: string, private readonly mode: "gemini" | "mock", private readonly timeoutMs = 10000, private readonly maxAttempts = 3, private readonly backoffMs = 250) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Intelligence URL must be HTTPS or loopback HTTP");
    if (!token || !Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 || backoffMs < 0) throw new Error("Invalid intelligence configuration");
    this.endpoint = `${url.toString().replace(/\/$/, "")}/v1/intelligence/analyze`;
  }
  async analyze(input: Input) {
    if (input.signal?.aborted) throw new Error("Cancelled");
    if (input.machines.some(m => m.tenantId !== input.tenantId)) throw new Error("Tenant mismatch");
    const taskId = input.jobId || randomUUID(), executionId = randomUUID(), correlationId = randomUUID();
    const recommendations: string[] = [];
    for (let offset = 0; offset < input.machines.length; offset += 200) {
      if (input.signal?.aborted) throw new Error("Cancelled");
      const original = input.machines.slice(offset, offset + 200);
      const machines: SafeMachine[] = original.map((machine, index) => {
        const safe: SafeMachine = { machineId: `machine-${offset + index + 1}`, status: machine.status };
        for (const key of fields.slice(1) as Array<Exclude<typeof fields[number], "status">>) if (machine[key] !== undefined) safe[key] = machine[key];
        return safe;
      });
      const event = { eventId: randomUUID(), eventType: "IntelligenceAnalysisRequested", schemaVersion: "1.0", timestamp: new Date().toISOString(), tenantId: input.tenantId, taskId, executionId, correlationId, source: "arquifusion-mailops", payload: { machines } };
      const body = JSON.stringify(event);
      if (Buffer.byteLength(body) > maxBytes) throw new Error("Request exceeds service limit");
      let responseBody: unknown;
      for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
        if (input.signal?.aborted) throw new Error("Cancelled");
        try {
          const timeout = AbortSignal.timeout(this.timeoutMs);
          const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
          const response = await fetch(this.endpoint, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body, signal });
          if ([429, 502, 503].includes(response.status)) { await response.body?.cancel(); throw new TransientError(); }
          if (!response.ok) { await response.body?.cancel(); throw new Error("Intelligence request rejected"); }
          const reader = response.body?.getReader(); if (!reader) throw new Error("Empty response");
          const chunks: Uint8Array[] = []; let length = 0;
          for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > maxBytes) { await reader.cancel(); throw new Error("Response too large"); } chunks.push(part.value); }
          responseBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          break;
        } catch (error) {
          if (input.signal?.aborted) throw new Error("Cancelled");
          const transient = error instanceof TransientError || (error instanceof Error && ["TimeoutError", "AbortError", "TypeError"].includes(error.name));
          if (!transient || attempt + 1 >= this.maxAttempts) throw error;
          await delay(Math.min(2000, this.backoffMs * 2 ** attempt), undefined, { signal: input.signal });
        }
      }
      if (!validateEvent(responseBody) || responseBody.eventType !== "IntelligenceAnalysisCompleted" || responseBody.tenantId !== input.tenantId || responseBody.taskId !== taskId || responseBody.executionId !== executionId || responseBody.correlationId !== correlationId || responseBody.source !== "arquifusion-intelligence") throw new Error("Invalid intelligence response envelope");
      const payload = responseBody.payload as Record<string, unknown>;
      if (payload.provider !== "gemini-api" || typeof payload.model !== "string" || !payload.model.trim() || !Array.isArray(payload.recommendations) || payload.recommendations.length > 100) throw new Error("Invalid intelligence response payload");
      for (const value of payload.recommendations) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recommendation");
        const item = value as Record<string, unknown>;
        const index = machines.findIndex(machine => machine.machineId === item.machineId);
        if (index < 0 || !["high", "medium"].includes(String(item.priority)) || !["maintenance", "operations"].includes(String(item.category))) throw new Error("Invalid recommendation identity");
        if (!["title", "reason", "suggestedAction"].every(key => typeof item[key] === "string" && (item[key] as string).trim().length > 0 && (item[key] as string).length <= 500)) throw new Error("Invalid recommendation text");
        if (!item.evidence || typeof item.evidence !== "object" || Array.isArray(item.evidence)) throw new Error("Invalid evidence");
        const evidence = Object.entries(item.evidence);
        if (!evidence.length || evidence.some(([key, val]) => !fields.includes(key as typeof fields[number]) || !Object.hasOwn(machines[index], key) || machines[index][key as keyof SafeMachine] !== val)) throw new Error("Evidence does not match input");
        recommendations.push(`${original[index].machineId}: ${item.title} — ${item.reason} Acción: ${item.suggestedAction} (evidencia: ${evidence.map(([key, val]) => `${key}=${val}`).join(", ")})`);
      }
    }
    return { source: this.mode, recommendations };
  }
}
class TransientError extends Error {}
