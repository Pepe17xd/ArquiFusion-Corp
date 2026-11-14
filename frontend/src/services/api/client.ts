export type MachineStatus = "operational" | "maintenance" | "stopped" | "alert";
export type IngestionSource = "csv" | "json";

export interface Machine {
  machineId: string;
  model: string;
  category: string;
  location: string;
  status: MachineStatus;
  operatingHours?: number;
  temperature?: number;
  vibration?: number;
  pressure?: number;
  fuelConsumption?: number;
  updatedAt?: string;
  dataSource?: IngestionSource;
}

export interface FleetMetrics {
  total: number;
  operational: number;
  maintenance: number;
  stopped: number;
  alert: number;
  availabilityPercent: number;
  totalFuelConsumption: number;
  averageFuelConsumption?: number;
  averageOperatingHours?: number;
  byCategory: Record<string, number>;
}

export interface Recommendation {
  machineId: string;
  priority: "high" | "medium";
  category: "maintenance" | "operations";
  title: string;
  reason: string;
  suggestedAction: string;
  evidence: Record<string, string | number>;
}

export interface RecommendationResult {
  generatedAt: string;
  recommendations: Recommendation[];
  source: "deterministic-rules";
}

export interface MachinePage { items: Machine[]; nextCursor?: string }
export interface IngestionResult {
  processed: number;
  accepted: Machine[];
  rejected: Array<{ row: number; errors: string[] }>;
  originalFileUri: string;
}
export type TaskState = "PENDING" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "RETRYING" | "FAILED" | "DEAD_LETTER";
export interface AgentTask {
  taskId: string; executionId: string; correlationId: string; taskType: "fleet.recommendations"; agentId: string;
  createdAt: string; updatedAt: string; state: TaskState; attempts: number; maxAttempts: number;
  result?: RecommendationResult; error?: { code: string; message: string; retryable: boolean };
}
export interface AgentEvent {
  eventId: string; eventType: string; schemaVersion: "1.0"; timestamp: string; taskId: string;
  executionId: string; correlationId: string; source: string; payload: Record<string, unknown>;
}
export interface OperationsOverview {
  generatedAt: string; fleet: FleetMetrics;
  agents: Array<{ id: string; name: string; specialty: string; status: "operational" | "planned" | "unavailable"; version: string; capabilities: string[] }>;
  tasks: { total: number; pending: number; succeeded: number; failed: number; deadLetter: number };
  recentEvents: AgentEvent[]; domains: { inventory: string; technicianAssignment: string; incidents: string };
}

import { accessToken, authMode, selectedTenantId, expireSession, type TenantChoice } from "../auth/session";

const apiBase = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    const token = authMode === "cognito" ? await accessToken() : undefined;
    if (token) headers.set("authorization", `Bearer ${token}`);
    const tenantId = authMode === "cognito" ? selectedTenantId() : undefined;
    if (tenantId) headers.set("x-tenant-id", tenantId);
    response = await fetch(apiBase + path, { ...init, headers });
  }
  catch { throw new Error("No se pudo conectar con la API."); }

  const envelope = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && authMode === "cognito") {
      expireSession();
    }
    const details = envelope?.data?.details;
    throw new Error(Array.isArray(details) ? details.join("; ") : envelope?.data?.error || "HTTP " + response.status);
  }
  return envelope.data as T;
}

export const apiSession = {
  tenants: () => request<TenantChoice[]>("/tenants"),
  createTenant: (name: string, idempotencyKey: string) => request<TenantChoice>("/tenants", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ name }) }),
};

export const fleetApi = {
  health: () => request<{ status: "ok" }>("/health"),
  metrics: () => request<FleetMetrics>("/metrics"),
  machines: (query: URLSearchParams) => request<MachinePage>("/machines?" + query.toString()),
  machine: (id: string) => request<Machine>("/machines/" + encodeURIComponent(id)),
  recommendations: () => request<RecommendationResult>("/intelligence/recommendations"),
  submitRecommendationTask: (idempotencyKey: string) => request<{ task: AgentTask; created: boolean }>("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskType: "fleet.recommendations", idempotencyKey }) }),
  task: (taskId: string) => request<AgentTask>("/tasks/" + encodeURIComponent(taskId)),
  overview: () => request<OperationsOverview>("/operations/overview"),
  events: () => request<AgentEvent[]>("/events"),
  ingest: (file: File) => request<IngestionResult>(
    "/ingest/" + (file.name.toLowerCase().endsWith(".csv") ? "csv" : "json"),
    { method: "POST", headers: { "content-type": file.name.toLowerCase().endsWith(".csv") ? "text/csv" : "application/json" }, body: file },
  ),
};
