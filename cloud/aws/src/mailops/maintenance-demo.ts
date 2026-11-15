import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MaintenanceIntelligenceEngine, type MachineThresholds, type MachineReading, type MaintenanceRecord } from "./maintenance-intelligence";
import type { Machine } from "../core/machine";

interface DemoFixture { simulation_notice: string; tenantId: string; assessedAt: string; machines: Array<Omit<Machine, "tenantId" | "updatedAt" | "dataSource">>; readings: MachineReading[]; maintenanceHistory: MaintenanceRecord[]; demoRules: MachineThresholds[] }
export function runMaintenanceDemo() {
  const path = resolve(__dirname, "../../../..", "cloud/aws/fixtures/maintenance/demo.json");
  const fixture = JSON.parse(readFileSync(path, "utf8")) as DemoFixture;
  if (!fixture.simulation_notice.startsWith("SIMULATED")) throw new Error("Maintenance demo fixture must be identified as simulated");
  const machines: Machine[] = fixture.machines.map(machine => ({ ...machine, tenantId: fixture.tenantId, updatedAt: fixture.assessedAt, dataSource: "json" }));
  const result = new MaintenanceIntelligenceEngine(fixture.demoRules).evaluate({ tenantId: fixture.tenantId, machines, readings: fixture.readings, maintenanceHistory: fixture.maintenanceHistory, assessedAt: fixture.assessedAt });
  return { simulationNotice: fixture.simulation_notice, result };
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/maintenance-demo.js")) {
  const demo = runMaintenanceDemo();
  console.log(demo.simulationNotice);
  console.log(JSON.stringify(demo.result.evaluations.map(item => ({ machineId: item.machineId, priority: item.priority, preventive: item.preventive, anomalies: item.anomalies })), null, 2));
}
