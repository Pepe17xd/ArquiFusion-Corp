import type { IntelligenceOutput } from "../intelligence/contracts";

export const TASK_STATES = ["PENDING", "QUEUED", "RUNNING", "SUCCEEDED", "RETRYING", "FAILED", "DEAD_LETTER"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type AgentId = "fleet-intelligence" | "coordinator" | "maintenance" | "fleet-operations" | "inventory" | "technician-assignment" | "incident-intelligence";
export type TaskType = "fleet.recommendations";

export interface AgentDescriptor {
  id: AgentId;
  name: string;
  specialty: string;
  capabilities: TaskType[];
  inputs: string[];
  outputs: string[];
  status: "operational" | "planned" | "unavailable";
  version: string;
}

export interface AgentEvent {
  eventId: string;
  eventType: string;
  schemaVersion: "1.0";
  timestamp: string;
  taskId: string;
  executionId: string;
  correlationId: string;
  source: string;
  payload: Record<string, unknown>;
}

export interface TaskRecord {
  taskId: string;
  executionId: string;
  correlationId: string;
  taskType: TaskType;
  agentId: AgentId;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  state: TaskState;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  result?: IntelligenceOutput;
  error?: { code: string; message: string; retryable: boolean };
}

export interface TaskStore {
  create(task: TaskRecord, event: AgentEvent): Promise<{ task: TaskRecord; created: boolean }>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  list(): Promise<TaskRecord[]>;
  events(taskId?: string): Promise<AgentEvent[]>;
  update(task: TaskRecord, event: AgentEvent): Promise<void>;
}

export class PermanentTaskError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PermanentTaskError"; }
}
