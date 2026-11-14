export const MACHINE_STATUSES = ["operational", "maintenance", "stopped", "alert"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];
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
  updatedAt: string;
  dataSource: IngestionSource;
}

export interface MachineFilters {
  status?: MachineStatus;
  category?: string;
  search?: string;
}

export class ValidationError extends Error {
  constructor(readonly issues: string[]) {
    super("Validation failed");
    this.name = "ValidationError";
  }
}

const requiredFields = ["machineId", "model", "category", "location"] as const;
const numericFields = ["operatingHours", "temperature", "vibration", "pressure", "fuelConsumption"] as const;

export function normalizeMachine(input: unknown, source: IngestionSource): Machine {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError(["row must be an object"]);
  }

  const row = input as Record<string, unknown>;
  const issues: string[] = [];
  for (const field of requiredFields) {
    if (typeof row[field] !== "string" || !row[field].trim()) issues.push(`${field} is required`);
  }

  const status = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  if (!MACHINE_STATUSES.includes(status as MachineStatus)) {
    issues.push(`status must be one of ${MACHINE_STATUSES.join(", ")}`);
  }

  const numbers: Partial<Pick<Machine, (typeof numericFields)[number]>> = {};
  for (const field of numericFields) {
    const value = row[field];
    if (value === undefined || value === null || value === "") continue;
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) issues.push(`${field} must be a non-negative number`);
    else numbers[field] = parsed;
  }

  if (issues.length) throw new ValidationError(issues);

  return {
    machineId: (row.machineId as string).trim(),
    model: (row.model as string).trim(),
    category: (row.category as string).trim(),
    location: (row.location as string).trim(),
    status: status as MachineStatus,
    ...numbers,
    updatedAt: new Date().toISOString(),
    dataSource: source,
  };
}
