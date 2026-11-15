import type { Machine } from "../core/machine";

export interface Recommendation {
  machineId: string;
  priority: "high" | "medium";
  category: "maintenance" | "operations";
  title: string;
  reason: string;
  suggestedAction: string;
  evidence: Record<string, string | number>;
}

export interface IntelligenceContext { tenantId: string; taskId: string; executionId: string; correlationId: string }
export interface IntelligenceInput { machines: Machine[]; context?: IntelligenceContext }
export interface IntelligenceOutput { generatedAt: string; recommendations: Recommendation[]; source: "deterministic-rules" | "gemini-api" }
export interface IntelligenceProvider {
  recommend(input: IntelligenceInput): Promise<IntelligenceOutput>;
}
