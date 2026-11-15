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
  source: "deterministic-rules" | "gemini-api";
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
export interface ApiPage<T> { items: T[]; nextCursor?: string }
export interface OperationalItem { entityId: string; entityType: string; machineId?: string; status?: string; severity?: string; priority?: string; title?: string; occurredAt?: string; createdAt: string; updatedAt: string; version?: number; [key: string]: unknown }
export interface AuraTechnician { technicianId: string; displayName: string; availability: "available" | "unavailable"; specialties: string[]; skills: Array<{ code: string; level: number }>; maxConcurrentAssignments: number; status?: string; shifts?: Array<{ daysOfWeek: number[]; startTime: string; endTime: string; timeZone: string }>; coordinates?: { latitude: number; longitude: number; datum: "WGS84" }; version: number }
export interface InventoryPart { partId: string; name: string; sku: string; unit: string; minimumStock: number; status: string; version: number }
export interface InventoryBalance { stockId: string; partId: string; locationId: string; onHand: number; reserved: number; version: number }
export interface AuraAssignment { assignmentId: string; incidentId: string; machineId: string; technicianId: string | null; status: string; severity: string; cost: number; costBreakdown: Record<string, number>; distanceKm?: number }
export interface TechnicianWorkOrder extends OperationalItem { incidentId: string; assignedTechnicianId: string; partsUsed?: Array<{ reservationId: string; partId: string; locationId: string; quantity: number; consumedAt?: string }>; reservations?: Array<{ reservationId: string; partId: string; locationId: string; quantity: number; status: string }>; incident?: OperationalItem | null; machine?: Machine | null }
export interface AuraKpis { period: { from: string; to: string }; mttr: { averageMinutes: number | null; resolvedIncidentCount: number }; downtime: { totalMinutes: number | null; reason: string }; recurrence: { windowDays: number; recurrentIncidentCount: number; incidentCount: number; percent: number | null }; responseSla: { responseSlaMinutes: number | null; acknowledgedCount: number; withinSlaCount: number; compliancePercent: number | null } }

import { accessToken, authMode, selectedTenantId, expireSession, type TenantChoice } from "../auth/session";

const apiBase = (import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "/api" : "https://ep40dq915l.execute-api.us-east-1.amazonaws.com")).replace(/\/$/, "");

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ApiError"; }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response | undefined;
  const safeGet = (init?.method ?? "GET").toUpperCase() === "GET";
  for (let attempt = 0; attempt < (safeGet ? 3 : 1); attempt += 1) {
    try {
      const headers = new Headers(init?.headers);
      const token = authMode === "cognito" ? await accessToken() : undefined;
      if (token) headers.set("authorization", `Bearer ${token}`);
      const tenantId = authMode === "cognito" ? selectedTenantId() : undefined;
      if (tenantId) headers.set("x-tenant-id", tenantId);
      response = await fetch(apiBase + path, { ...init, headers });
      if (![502, 503, 504].includes(response.status) || attempt === 2) break;
    }
    catch {
      if (!safeGet || attempt === 2) throw new Error("No se pudo conectar con la API.");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (!response) throw new Error("No se pudo conectar con la API.");

  const envelope = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && authMode === "cognito") {
      expireSession();
    }
    const details = envelope?.data?.details;
    throw new ApiError(Array.isArray(details) ? details.join("; ") : envelope?.data?.error || "HTTP " + response.status, response.status);
  }
  return envelope.data as T;
}

export const apiSession = {
  tenants: () => request<TenantChoice[]>("/tenants"),
  createTenant: (name: string, idempotencyKey: string) => request<TenantChoice>("/tenants", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ name }) }),
  addTechnician: (tenantId: string, userSub: string) => request<{ tenantId: string; userSub: string; role: "technician"; status: string }>("/tenants/" + encodeURIComponent(tenantId) + "/members", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userSub }) }),
};

export const fleetApi = {
  health: () => request<{ status: "ok" }>("/health"),
  metrics: () => request<FleetMetrics>("/metrics"),
  machines: (query: URLSearchParams) => request<MachinePage>("/machines?" + query.toString()),
  machine: (id: string) => request<Machine>("/machines/" + encodeURIComponent(id)),
  recommendations: () => request<RecommendationResult>("/intelligence/recommendations"),
  submitRecommendationTask: (idempotencyKey: string, correlationId: string) => request<{ task: AgentTask; created: boolean }>("/tasks", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ taskType: "fleet.recommendations", idempotencyKey, correlationId }) }),
  tasks: () => request<AgentTask[]>("/tasks"),
  task: (taskId: string) => request<AgentTask>("/tasks/" + encodeURIComponent(taskId)),
  overview: () => request<OperationsOverview>("/operations/overview"),
  events: () => request<AgentEvent[]>("/events"),
  ingest: (file: File) => request<IngestionResult>(
    "/ingest/" + (file.name.toLowerCase().endsWith(".csv") ? "csv" : "json"),
    { method: "POST", headers: { "content-type": file.name.toLowerCase().endsWith(".csv") ? "text/csv" : "application/json" }, body: file },
  ),
};

export const operationsApi = {
  incidents: (query = new URLSearchParams({ limit: "100" })) => request<ApiPage<OperationalItem>>("/incidents?" + query.toString()),
  createIncident: (input: { machineId: string; type: string; severity: "info" | "warning" | "critical"; description: string }, idempotencyKey: string) => request<{ incident: OperationalItem; replayed: boolean }>("/incidents", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(input) }),
  createMaintenanceFromIncident: (incidentId: string) => request<{ workOrder: OperationalItem; replayed: boolean }>("/incidents/" + encodeURIComponent(incidentId) + "/maintenance-orders", { method: "POST" }),
  maintenance: (query = new URLSearchParams({ limit: "100" })) => request<ApiPage<OperationalItem>>("/maintenance/orders?" + query.toString()),
  anomalies: (query = new URLSearchParams({ limit: "100" })) => request<ApiPage<OperationalItem>>("/anomalies?" + query.toString()),
  explainAnomaly: (anomalyId: string) => request<{ anomalyId: string; source: "gemini-api" | "deterministic-rules"; generatedAt: string; recommendations: Recommendation[]; evidence: Record<string, unknown> }>("/anomalies/" + encodeURIComponent(anomalyId) + "/explanation", { method: "POST" }),
};

export const auraApi = {
  technicians: (query = new URLSearchParams({ limit: "100" })) => request<ApiPage<AuraTechnician>>("/technicians?" + query.toString()),
  inviteTechnician: (tenantId: string, technician: Record<string, unknown>, idempotencyKey: string) => request<{ technician: AuraTechnician; invitationSent: boolean; replayed: boolean }>("/tenants/" + encodeURIComponent(tenantId) + "/technicians/invitations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(technician) }),
  saveTechnician: (technician: Omit<AuraTechnician, "version">) => request<AuraTechnician>("/technicians", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(technician) }),
  updateTechnician: (technician: Omit<AuraTechnician, "version">, version: number) => request<AuraTechnician>("/technicians/" + encodeURIComponent(technician.technicianId), { method: "PATCH", headers: { "content-type": "application/json", "if-match": String(version) }, body: JSON.stringify(technician) }),
  archiveTechnician: (technicianId: string, version: number) => request<AuraTechnician>("/technicians/" + encodeURIComponent(technicianId), { method: "PATCH", headers: { "content-type": "application/json", "if-match": String(version) }, body: JSON.stringify({ action: "deactivate" }) }),
  parts: (query = new URLSearchParams({ limit: "100" })) => request<ApiPage<InventoryPart>>("/inventory/parts?" + query.toString()),
  stock: (query = new URLSearchParams({ limit: "100" })) => request<ApiPage<InventoryBalance>>("/inventory/stock?" + query.toString()),
  inventoryAlerts: (query = new URLSearchParams({ limit: "100" })) => request<ApiPage<Record<string, unknown>>>("/inventory/alerts?" + query.toString()),
  assignments: (query = new URLSearchParams({ limit: "100" })) => request<ApiPage<AuraAssignment>>("/assignments?" + query.toString()),
  events: (query = new URLSearchParams({ limit: "100" })) => request<ApiPage<OperationalItem>>("/aura/events?" + query.toString()),
  kpis: (from: string, to: string) => request<AuraKpis>("/operations/kpis?" + new URLSearchParams({ from, to }).toString()),
  optimize: (incidentIds: string[], idempotencyKey: string, dispatch = true) => request<{ assignments: Array<AuraAssignment & { candidates?: Array<{ technicianId: string; cost: number; breakdown: Record<string, number> }>; version?: number }>; totalCost: number; workflowStarted: boolean; replayed: boolean }>("/assignments/optimize", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ incidentIds, dispatch }) }),
  approveAssignment: (assignmentId: string, technicianId: string | undefined, version: number | undefined, idempotencyKey: string) => request<{ assignment: AuraAssignment; workflowStarted: boolean; replayed: boolean }>("/assignments/" + encodeURIComponent(assignmentId) + "/approval", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey, ...(version === undefined ? {} : { "if-match": String(version) }) }, body: JSON.stringify(technicianId ? { technicianId } : {}) }),
  reviewWorkOrder: (workOrderId: string, decision: "approve" | "return", notes: string) => request<TechnicianWorkOrder>("/maintenance/orders/" + encodeURIComponent(workOrderId) + "/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, notes }) }),
  createPart: (part: Omit<InventoryPart, "status" | "version">) => request<InventoryPart>("/inventory/parts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(part) }),
  updatePart: (part: Omit<InventoryPart, "status" | "version">, version: number) => request<InventoryPart>("/inventory/parts/" + encodeURIComponent(part.partId), { method: "PUT", headers: { "content-type": "application/json", "if-match": String(version) }, body: JSON.stringify(part) }),
  movement: (input: { partId: string; locationId: string; quantity: number; kind: "receipt" | "adjustment"; reason: string }, idempotencyKey: string) => request("/inventory/movements", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(input) }),
  myProfile: () => request<AuraTechnician>("/technician/me"),
  myWorkOrders: (query = new URLSearchParams({ limit: "25" })) => request<ApiPage<TechnicianWorkOrder>>("/technician/work-orders?" + query.toString()),
  explainMyWorkOrder: (id: string) => request<{ anomalyId?: string; source: "gemini-api" | "deterministic-rules"; generatedAt?: string; recommendations: Recommendation[]; evidence: Record<string, unknown> | null; explanationAvailable?: boolean }>("/technician/work-orders/" + encodeURIComponent(id) + "/analysis", { method: "POST" }),
  startMyWorkOrder: (id: string) => request<TechnicianWorkOrder>("/technician/work-orders/" + encodeURIComponent(id) + "/start", { method: "POST" }),
  blockMyWorkOrder: (id: string, notes: string) => request<TechnicianWorkOrder>("/technician/work-orders/" + encodeURIComponent(id) + "/block", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes }) }),
  completeMyWorkOrder: (id: string, notes: string) => request<{ accepted?: boolean; callback?: boolean; replayed?: boolean; entityId?: string; status?: string }>("/technician/work-orders/" + encodeURIComponent(id) + "/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes }) }),
  reserveMyPart: (workOrderId: string, input: { partId: string; locationId: string; quantity: number; reason: string }, idempotencyKey: string) => request("/technician/work-orders/" + encodeURIComponent(workOrderId) + "/reservations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(input) }),
  consumeMyReservation: (workOrderId: string, reservationId: string) => request("/technician/work-orders/" + encodeURIComponent(workOrderId) + "/reservations/" + encodeURIComponent(reservationId) + "/consume", { method: "POST" }),
  respond: (assignmentId: string, body: Record<string, unknown>, idempotencyKey: string) => request<{ accepted: boolean; replayed: boolean }>("/assignments/" + encodeURIComponent(assignmentId) + "/response", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(body) }),
};
