import { test } from "node:test";
import { strict as assert } from "node:assert";
import { normalizeMachine, type Machine } from "../core/machine";
import { MaintenanceIntelligenceEngine, type MachineThresholds } from "../mailops/maintenance-intelligence";
import { runMaintenanceDemo } from "../mailops/maintenance-demo";
import { LocalAnalysisAdapter } from "../mailops/analysis";
import { MailProcessor, ReportGenerator, TenantResolver } from "../mailops/processor";
import { MemoryMailJobRepository } from "../mailops/repository";
import { MockMailAdapter } from "../mailops/mock";
import type { MailMessage, IntelligenceAdapter } from "../mailops/contracts";

const assessedAt = "2026-10-15T12:00:00.000Z";
function machine(tenantId: string, machineId: string, overrides: Record<string, unknown> = {}): Machine {
  return normalizeMachine({ machineId, model: "Model X", category: "hauler", location: "Mine", status: "operational", ...overrides }, "json", tenantId);
}
const rules: MachineThresholds[] = [{ category: "hauler", ranges: { temperature: { max: 90 }, vibration: { max: 8 }, pressure: { min: 100, max: 300 }, fuelConsumption: { max: 35 } }, operatingHoursHigh: 8000, maintenanceIntervalHours: 1000, maintenanceDueSoonHours: 150, combined: [{ metrics: ["temperature", "vibration", "pressure", "fuelConsumption"], minSignals: 2, severity: "CRITICAL", label: "multiple-signals" }] }];
function evaluate(machines: Machine[], extras: Partial<Parameters<MaintenanceIntelligenceEngine["evaluate"]>[0]> = {}, configured = rules) {
  return new MaintenanceIntelligenceEngine(configured).evaluate({ tenantId: machines[0]?.tenantId ?? "tenant-a", machines, assessedAt, ...extras });
}

test("configured model/category thresholds identify thermal and vibration anomalies", () => {
  const result = evaluate([machine("tenant-a", "hot", { temperature: 95 }), machine("tenant-a", "shaking", { vibration: 9 })]);
  assert.equal(result.evaluations[0].priority, "HIGH");
  assert.equal(result.evaluations[0].anomalies[0].observed.temperature, 95);
  assert.equal(result.evaluations[1].anomalies[0].type, "vibration-out-of-range");
  assert.match(result.evaluations[0].anomalies[0].explanation, /no es una especificación del fabricante/);
});
test("combined rules require multiple configured signal violations and are explainable", () => {
  const one = evaluate([machine("tenant-a", "one", { temperature: 95, vibration: 2, pressure: 200, fuelConsumption: 20 })]).evaluations[0];
  assert.equal(one.anomalies.some(item => item.type === "combined-signal"), false);
  const two = evaluate([machine("tenant-a", "two", { temperature: 95, vibration: 12, pressure: 200, fuelConsumption: 20 })]).evaluations[0];
  assert.equal(two.priority, "CRITICAL");
  assert.deepEqual(two.anomalies.find(item => item.type === "combined-signal")?.variables, ["temperature", "vibration", "pressure", "fuelConsumption"]);
});
test("missing telemetry and missing thresholds do not create invented values", () => {
  const result = evaluate([machine("tenant-a", "empty")], {}, []).evaluations[0];
  assert.equal(result.priority, "INSUFFICIENT_DATA");
  assert.deepEqual(result.anomalies, []);
  assert.equal(result.preventive.status, "INSUFFICIENT_DATA");
  assert.ok(result.preventive.missingData.includes("historial de mantenimiento"));
});
test("historical change needs at least three readings from the same machine", () => {
  const readings = [1, 2].map(day => ({ tenantId: "tenant-a", machineId: "m1", timestamp: "2026-10-0" + day + "T00:00:00.000Z", temperature: 50 }));
  const config: MachineThresholds[] = [{ model: "Model X", historyChangePercent: { temperature: 20 } }];
  assert.equal(evaluate([machine("tenant-a", "m1", { temperature: 80 })], { readings }, config).evaluations[0].anomalies.length, 0);
  readings.push({ tenantId: "tenant-a", machineId: "m1", timestamp: "2026-10-03T00:00:00.000Z", temperature: 50 });
  assert.ok(evaluate([machine("tenant-a", "m1", { temperature: 80 })], { readings }, config).evaluations[0].anomalies.some(item => item.type === "historical-change"));
});
test("future telemetry and invalid environment rules are rejected from an assessment", () => {
  const future = [{ tenantId: "tenant-a", machineId: "m1", timestamp: "2026-10-16T00:00:00.000Z", temperature: 50 }];
  const config: MachineThresholds[] = [{ model: "Model X", historyChangePercent: { temperature: 10 } }];
  const result = evaluate([machine("tenant-a", "m1", { temperature: 90 })], { readings: [...future, ...future, ...future] }, config).evaluations[0];
  assert.equal(result.anomalies.some(item => item.type === "historical-change"), false);
  assert.throws(() => new MaintenanceIntelligenceEngine([{ ranges: { temperature: { min: 100, max: 50 } } }]), /Invalid maintenance range/);
});
test("preventive maintenance calculates on-track, due-soon, overdue and missing history states", () => {
  const engine = new MaintenanceIntelligenceEngine([{ model: "Model X", maintenanceIntervalHours: 1000, maintenanceDueSoonHours: 100 }]);
  const entries = [800, 950, 1100].map((operatingHours, i) => machine("tenant-a", "m" + i, { operatingHours }));
  const maintenanceHistory = entries.map((item) => ({ tenantId: "tenant-a", machineId: item.machineId, maintainedAt: assessedAt, operatingHoursAtMaintenance: 0 }));
  const results = engine.evaluate({ tenantId: "tenant-a", machines: entries, maintenanceHistory, assessedAt }).evaluations;
  assert.deepEqual(results.map(item => item.preventive.status), ["ON_TRACK", "DUE_SOON", "OVERDUE"]);
  assert.deepEqual(results.map(item => item.preventive.hoursRemaining), [200, 50, -100]);
  assert.equal(results[2].priority, "HIGH");
  assert.equal(engine.evaluate({ tenantId: "tenant-a", machines: [machine("tenant-a", "m4", { operatingHours: 500 })], assessedAt }).evaluations[0].preventive.status, "INSUFFICIENT_DATA");
});
test("stopped and reported-alert states have deterministic and traceable priority", () => {
  assert.equal(evaluate([machine("tenant-a", "stop", { status: "stopped" })], {}, []).evaluations[0].priority, "CRITICAL");
  assert.equal(evaluate([machine("tenant-a", "alert", { status: "alert" })], {}, []).evaluations[0].priority, "HIGH");
});
test("comparable machine analysis requires three same-tenant model/type peers", () => {
  const current = machine("tenant-a", "outlier", { temperature: 100 });
  const peers = [1, 2, 3].map(n => machine("tenant-a", "peer-" + n, { temperature: 10 }));
  const crossTenant = machine("tenant-b", "other-tenant", { temperature: 1000 });
  const result = new MaintenanceIntelligenceEngine([{ comparableSigma: 2 }]).evaluate({ tenantId: "tenant-a", machines: [current, ...peers], assessedAt });
  assert.equal(result.evaluations.length, 4);
  assert.ok(result.evaluations[0].anomalies.some(item => item.type === "peer-deviation"));
  assert.throws(() => new MaintenanceIntelligenceEngine().evaluate({ tenantId: "tenant-a", machines: [current, crossTenant] }), /tenant boundary/);
});
test("other tenant history is ignored and its maintenance record cannot affect an evaluation", () => {
  const item = machine("tenant-a", "same-id", { operatingHours: 2000 });
  const result = evaluate([item], { maintenanceHistory: [{ tenantId: "tenant-b", machineId: "same-id", maintainedAt: assessedAt, operatingHoursAtMaintenance: 0, intervalHours: 100 }] }, []);
  assert.equal(result.evaluations[0].preventive.status, "INSUFFICIENT_DATA");
});
test("MailOps includes deterministic findings in report, separate from mock Gemini interpretation", async () => {
  const message: MailMessage = { id: "mail-maintenance", threadId: "thread", messageId: "<maintenance@example.test>", from: "ops@example.test", subject: "Fleet", identityVerified: true, attachments: [{ filename: "fleet.csv", contentType: "text/csv", bytes: Buffer.from("machineId,model,category,location,status,temperature,vibration,operatingHours\nM-42,Model X,hauler,Zone A,operational,96,12,9000\n") }] };
  const mail = new MockMailAdapter([message]);
  const intelligence: IntelligenceAdapter = { analyze: async () => ({ source: "mock", recommendations: ["MOCK ONLY: inspección sugerida"] }) };
  const processor = new MailProcessor(mail, new MemoryMailJobRepository(), new TenantResolver([{ email: message.from, tenantId: "tenant-a", name: "A" }]), new LocalAnalysisAdapter(), new ReportGenerator(), intelligence, () => assessedAt, undefined, new MaintenanceIntelligenceEngine(rules));
  const job = await processor.process(message);
  assert.equal(job.state, "COMPLETED");
  assert.match(job.report!.text, /prioridad determinista: CRITICAL/);
  assert.match(job.report!.text, /evidencia=/);
  assert.match(job.report!.text, /Recomendaciones de servicio simulado \(no Gemini real\)/);
});
test("reproducible demo has seven labeled simulated cases without production claims", () => {
  const demo = runMaintenanceDemo();
  assert.match(demo.simulationNotice, /^SIMULATED/);
  const byId = new Map(demo.result.evaluations.map(item => [item.machineId, item]));
  assert.equal(byId.get("SIM-OPER-01")?.priority, "NORMAL");
  assert.equal(byId.get("SIM-TEMP-02")?.priority, "HIGH");
  assert.ok(byId.get("SIM-VIB-03")?.anomalies.some(item => item.type === "vibration-out-of-range"));
  assert.equal(byId.get("SIM-MULTI-04")?.priority, "CRITICAL");
  assert.equal(byId.get("SIM-DUE-05")?.preventive.status, "DUE_SOON");
  assert.equal(byId.get("SIM-OVERDUE-06")?.preventive.status, "OVERDUE");
  assert.equal(byId.get("SIM-LOWDATA-07")?.priority, "INSUFFICIENT_DATA");
});
