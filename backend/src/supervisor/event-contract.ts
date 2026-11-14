import { randomUUID } from "node:crypto";
import type { AgentEvent } from "./contracts";

export const EVENT_TYPES = ["AgentTaskRequested", "AgentTaskAssigned", "AgentTaskStarted", "AgentTaskCompleted", "AgentTaskFailed", "IntelligenceAnalysisRequested", "IntelligenceAnalysisCompleted", "OperationalAlertCreated", "NotificationRequested"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function createEvent(input: Omit<AgentEvent, "eventId" | "schemaVersion" | "timestamp" | "source"> & { eventType: EventType; source?: string; timestamp?: string }): AgentEvent {
  return { ...input, eventId: randomUUID(), schemaVersion: "1.0", timestamp: input.timestamp ?? new Date().toISOString(), source: input.source ?? "arquifusion-supervisor" };
}

export function validateEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const required = ["eventId", "eventType", "schemaVersion", "timestamp", "taskId", "executionId", "correlationId", "source", "payload"];
  return Object.keys(event).length === required.length
    && required.every((key) => Object.hasOwn(event, key))
    && typeof event.eventId === "string" && Boolean(event.eventId)
    && typeof event.eventType === "string" && EVENT_TYPES.includes(event.eventType as EventType)
    && event.schemaVersion === "1.0"
    && typeof event.timestamp === "string" && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(event.timestamp) && !Number.isNaN(Date.parse(event.timestamp))
    && ["taskId", "executionId", "correlationId", "source"].every((key) => typeof event[key] === "string" && Boolean(event[key]))
    && Boolean(event.payload) && typeof event.payload === "object" && !Array.isArray(event.payload);
}
