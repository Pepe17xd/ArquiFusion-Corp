import { MACHINE_STATUSES, ValidationError, type MachineFilters } from "../core/machine";
import { NotFoundError } from "../core/errors";
import type { MachineRepository } from "../storage/contracts";

export interface MachineListInput { limit?: string; cursor?: string; status?: string; category?: string; search?: string }

export class FleetService {
  constructor(private readonly repository: MachineRepository) {}

  async list(input: MachineListInput) {
    const limit = input.limit === undefined ? 25 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError(["limit must be an integer between 1 and 100"]);
    }
    if (input.status && !MACHINE_STATUSES.includes(input.status as (typeof MACHINE_STATUSES)[number])) {
      throw new ValidationError(["status must be one of " + MACHINE_STATUSES.join(", ")]);
    }
    const filters: MachineFilters = {
      status: input.status as MachineFilters["status"], category: input.category, search: input.search,
    };
    return this.repository.list(limit, input.cursor, filters);
  }

  async get(machineId: string) {
    let decoded: string;
    try { decoded = decodeURIComponent(machineId); }
    catch { throw new ValidationError(["machineId is malformed"]); }
    if (!decoded.trim()) throw new ValidationError(["machineId is required"]);
    const machine = await this.repository.get(decoded);
    if (!machine) throw new NotFoundError("Machine not found");
    return machine;
  }
}
