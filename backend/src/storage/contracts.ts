import type { Machine, MachineFilters } from "../core/machine";

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface MachineRepository {
  upsert(machine: Machine): Promise<void>;
  list(limit: number, cursor?: string, filters?: MachineFilters): Promise<Page<Machine>>;
  get(machineId: string): Promise<Machine | undefined>;
}

export interface OriginalFileStore {
  saveOriginal(input: { content: string; contentType: string; extension: string; sha256: string }): Promise<string>;
}

export async function collectAllMachines(repository: MachineRepository): Promise<Machine[]> {
  const machines: Machine[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list(100, cursor);
    machines.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return machines;
}
