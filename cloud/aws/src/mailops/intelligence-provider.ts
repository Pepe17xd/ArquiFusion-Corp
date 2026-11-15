import type { IntelligenceProvider } from "./contracts";
import { GcpIntelligenceAdapter } from "./gcp-intelligence";
import { HttpIntelligenceProvider } from "./http-intelligence";

export type IntelligenceProviderName = "mock" | "gcp" | "azure";
export interface IntelligenceProviderConfig {
  provider: IntelligenceProviderName;
  url?: string;
  token?: string;
  mode?: "gemini" | "mock";
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
}

/** No-op mock: it never calls a service and never invents recommendations. */
export class MockIntelligenceProvider implements IntelligenceProvider {
  async analyze(input: Parameters<IntelligenceProvider["analyze"]>[0]) {
    if (input.signal?.aborted) throw new Error("Cancelled");
    if (!input.tenantId.trim() || input.machines.some(machine => machine.tenantId !== input.tenantId)) throw new Error("Tenant mismatch");
    return { source: "mock" as const, recommendations: [] };
  }
}

export function createIntelligenceProvider(config: IntelligenceProviderConfig): IntelligenceProvider {
  if (config.provider === "mock") return new MockIntelligenceProvider();
  if (!config.url || !config.token) throw new Error("Intelligence URL and token are required for the selected remote provider");
  const mode = config.mode ?? "gemini";
  if (mode !== "gemini" && mode !== "mock") throw new Error("Invalid intelligence provider mode");
  if (config.provider === "gcp") return new GcpIntelligenceAdapter(config.url, config.token, mode, config.timeoutMs, config.maxAttempts, config.backoffMs);
  if (config.provider === "azure") return new HttpIntelligenceProvider(config.url, config.token, mode, config.timeoutMs, config.maxAttempts, config.backoffMs);
  throw new Error("Unsupported intelligence provider");
}

/** Azure can be selected explicitly; legacy URL/token/mode settings continue to select GCP. */
export function intelligenceProviderFromEnv(env: Record<string, string | undefined> = process.env): IntelligenceProvider | undefined {
  const explicit = env.MAILOPS_INTELLIGENCE_PROVIDER;
  let provider: IntelligenceProviderName | undefined;
  if (explicit) {
    if (!["mock", "gcp", "azure"].includes(explicit)) throw new Error("Unsupported MAILOPS_INTELLIGENCE_PROVIDER");
    provider = explicit as IntelligenceProviderName;
  } else if (env.MAILOPS_INTELLIGENCE_URL || env.MAILOPS_INTELLIGENCE_TOKEN || env.MAILOPS_INTELLIGENCE_MODE) {
    provider = "gcp";
    if (!env.MAILOPS_INTELLIGENCE_MODE) throw new Error("MAILOPS_INTELLIGENCE_MODE remains required for legacy GCP configuration");
  } else if (env.MAILOPS_AZURE_INTELLIGENCE_URL || env.MAILOPS_AZURE_INTELLIGENCE_TOKEN) {
    provider = "azure";
  }
  if (!provider) return undefined;
  if (provider === "mock") return createIntelligenceProvider({ provider });
  if (provider === "gcp") return createIntelligenceProvider({
    provider, url: env.MAILOPS_GCP_INTELLIGENCE_URL ?? env.MAILOPS_INTELLIGENCE_URL,
    token: env.MAILOPS_GCP_INTELLIGENCE_TOKEN ?? env.MAILOPS_INTELLIGENCE_TOKEN,
    mode: env.MAILOPS_INTELLIGENCE_MODE as "gemini" | "mock" | undefined,
    timeoutMs: envNumber(env.MAILOPS_INTELLIGENCE_TIMEOUT_MS, 10000, 100, 120000),
    maxAttempts: envNumber(env.MAILOPS_INTELLIGENCE_ATTEMPTS, 3, 1, 5),
  });
  return createIntelligenceProvider({
    provider, url: env.MAILOPS_AZURE_INTELLIGENCE_URL,
    token: env.MAILOPS_AZURE_INTELLIGENCE_TOKEN ?? env.MAILOPS_INTELLIGENCE_TOKEN,
    mode: (env.MAILOPS_INTELLIGENCE_MODE ?? "gemini") as "gemini" | "mock",
    timeoutMs: envNumber(env.MAILOPS_INTELLIGENCE_TIMEOUT_MS, 10000, 100, 120000),
    maxAttempts: envNumber(env.MAILOPS_INTELLIGENCE_ATTEMPTS, 3, 1, 5),
  });
}

function envNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid intelligence numeric configuration");
  return value;
}
