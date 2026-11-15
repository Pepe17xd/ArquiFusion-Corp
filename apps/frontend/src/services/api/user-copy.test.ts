import assert from "node:assert/strict";
import test from "node:test";
import { toEventLabel, toStatusLabel } from "./user-copy.ts";

test("turns recorded event names and states into readable labels", () => {
  assert.equal(toEventLabel("WorkflowFailed"), "proceso con error");
  assert.equal(toEventLabel("MaintenanceWorkCompleted"), "mantenimiento trabajo completado");
  assert.equal(toStatusLabel("in_progress"), "En progreso");
  assert.equal(toStatusLabel("failed"), "Con error");
});
