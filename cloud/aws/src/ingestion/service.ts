import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { normalizeMachine, ValidationError, type IngestionSource, type Machine } from "../core/machine";
import type { MachineRepository, OriginalFileStore } from "../storage/contracts";

export interface IngestionResult {
  processed: number;
  accepted: Machine[];
  rejected: Array<{ row: number; errors: string[] }>;
  originalFileUri: string;
}
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

export function parseCsv(content: string): unknown[] {
  let rows: Record<string, string>[];
  const required = ["machineId", "model", "category", "location", "status"];
  try {
    rows = parse(content, {
      columns: (headers: string[]) => {
        const missing = required.filter((header) => !headers.includes(header));
        if (missing.length) throw new ValidationError([`Missing CSV headers: ${missing.join(", ")}`]);
        return headers;
      },
      skip_empty_lines: true, trim: true, bom: true, relax_column_count: false,
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError([`Invalid CSV: ${error instanceof Error ? error.message : "parse error"}`]);
  }
  if (!rows.length) return [];
  return rows;
}

export function normalizeRows(rows: unknown, source: IngestionSource, tenantId: string) {
  const list = Array.isArray(rows) ? rows : [rows];
  const accepted: Machine[] = [];
  const rejected: IngestionResult["rejected"] = [];
  list.forEach((row, index) => {
    try { accepted.push(normalizeMachine(row, source, tenantId)); }
    catch (error) {
      rejected.push({ row: index + 1, errors: error instanceof ValidationError ? error.issues : ["Invalid record"] });
    }
  });
  return { processed: list.length, accepted, rejected };
}

export class IngestionService {
  constructor(private readonly repository: MachineRepository, private readonly originals: OriginalFileStore) {}

  async ingest(content: string, source: IngestionSource, contentType: string, tenantId: string): Promise<IngestionResult> {
    if (Buffer.byteLength(content, "utf8") > MAX_IMPORT_BYTES) throw new ValidationError(["Import file exceeds the 8 MB limit"]);
    const rows = source === "csv" ? parseCsv(content) : parseJson(content);
    const normalized = normalizeRows(rows, source, tenantId);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const originalFileUri = await this.originals.saveOriginal({
      tenantId, content, contentType, extension: source, sha256,
    });
    for (const machine of normalized.accepted) await this.repository.upsert(machine);
    return { ...normalized, originalFileUri };
  }
}

function parseJson(content: string): unknown {
  try { return JSON.parse(content); }
  catch { throw new ValidationError(["Body must be valid JSON"]); }
}
