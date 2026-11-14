import type { Machine } from "../core/machine";
import { collectAllMachines, type MachineRepository } from "../storage/contracts";

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

export function aggregateFleetMetrics(machines: Machine[]): FleetMetrics {
  const byCategory: Record<string, number> = {};
  let fuelCount = 0;
  let fuelTotal = 0;
  let operatingHoursCount = 0;
  let operatingHoursTotal = 0;
  const metrics: FleetMetrics = {
    total: machines.length, operational: 0, maintenance: 0, stopped: 0, alert: 0,
    availabilityPercent: 0, totalFuelConsumption: 0, byCategory,
  };
  for (const machine of machines) {
    metrics[machine.status] += 1;
    byCategory[machine.category] = (byCategory[machine.category] ?? 0) + 1;
    if (machine.fuelConsumption !== undefined) { fuelTotal += machine.fuelConsumption; fuelCount += 1; }
    if (machine.operatingHours !== undefined) { operatingHoursTotal += machine.operatingHours; operatingHoursCount += 1; }
  }
  metrics.totalFuelConsumption = fuelTotal;
  metrics.availabilityPercent = machines.length ? Number(((metrics.operational / machines.length) * 100).toFixed(1)) : 0;
  if (fuelCount) metrics.averageFuelConsumption = Number((fuelTotal / fuelCount).toFixed(2));
  if (operatingHoursCount) metrics.averageOperatingHours = Number((operatingHoursTotal / operatingHoursCount).toFixed(1));
  return metrics;
}

export async function getFleetMetrics(repository: MachineRepository, tenantId: string): Promise<FleetMetrics> {
  return aggregateFleetMetrics(await collectAllMachines(repository, tenantId));
}
