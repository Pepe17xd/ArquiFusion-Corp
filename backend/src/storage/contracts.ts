import type { Machine, MachineFilters } from "../core/machine";

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface MachineRepository {
  upsert(machine: Machine): Promise<void>;
  list(tenantId: string, limit: number, cursor?: string, filters?: MachineFilters): Promise<Page<Machine>>;
  get(tenantId: string, machineId: string): Promise<Machine | undefined>;
}

export interface OriginalFileStore {
  saveOriginal(input: { tenantId: string; content: string; contentType: string; extension: string; sha256: string }): Promise<string>;
}

export async function collectAllMachines(repository: MachineRepository, tenantId: string): Promise<Machine[]> {
  const machines: Machine[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list(tenantId, 100, cursor);
    machines.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return machines;
}
