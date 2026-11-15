import type { IntelligenceInput, IntelligenceOutput, IntelligenceProvider } from "./contracts";
import { LangGraphFleetIntelligence } from "./fleet-graph";
import { RemoteGeminiIntelligence } from "./remote-provider";

/** Uses the primary provider and degrades to the deterministic rules if it fails. */
export class FallbackIntelligence implements IntelligenceProvider {
  constructor(private readonly primary: IntelligenceProvider, private readonly fallback: IntelligenceProvider) {}
  async recommend(input: IntelligenceInput): Promise<IntelligenceOutput> {
    try { return await this.primary.recommend(input); }
    catch (error) {
      console.error(JSON.stringify({
        event: "intelligence.fallback",
        errorName: error instanceof Error ? error.name : "UnknownError",
        code: error instanceof Error ? error.message : undefined,
      }));
      return this.fallback.recommend(input);
    }
  }
}

export function createIntelligenceProvider(env: NodeJS.ProcessEnv = process.env): IntelligenceProvider {
  const rules = new LangGraphFleetIntelligence();
  if (!env.INTELLIGENCE_SERVICE_URL || !env.INTELLIGENCE_API_KEY) return rules;
  return new FallbackIntelligence(
    new RemoteGeminiIntelligence({ url: env.INTELLIGENCE_SERVICE_URL, apiKey: env.INTELLIGENCE_API_KEY }),
    rules,
  );
}