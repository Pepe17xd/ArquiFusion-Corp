import { test } from "node:test";
import { strict as assert } from "node:assert";
import { filterAuditEvents } from "./activity-filter.ts";

const events = [
  { entityId: "evt-1", entityType: "EVENT", eventId: "evt-1", eventType: "MaintenanceWorkCompleted", timestamp: "2026-11-10T12:00:00Z", status: "completed", payload: { actorSub: "tech-a", orderId: "WO-1" }, createdAt: "2026-11-10T12:00:00Z", updatedAt: "2026-11-10T12:00:00Z" },
  { entityId: "evt-2", entityType: "EVENT", eventId: "evt-2", eventType: "WorkflowFailed", timestamp: "2026-11-12T12:00:00Z", status: "failed", payload: { incidentId: "INC-2" }, createdAt: "2026-11-12T12:00:00Z", updatedAt: "2026-11-12T12:00:00Z" },
];

test("activity filters apply date, type, status, and resource search to the fetched page", () => {
  assert.deepEqual(filterAuditEvents(events, { from: "2026-11-11", to: "2026-11-13", type: "WorkflowFailed", status: "fail", search: "inc-2" }).map((event) => event.entityId), ["evt-2"]);
  assert.deepEqual(filterAuditEvents(events, { from: "2026-11-20", to: "", type: "", status: "", search: "" }), []);
});

test("activity filters keep all fetched page events when no criteria are selected", () => {
  assert.equal(filterAuditEvents(events, { from: "", to: "", type: "", status: "", search: "" }).length, 2);
});
