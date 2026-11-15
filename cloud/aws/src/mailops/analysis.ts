import { normalizeRows, parseCsv, MAX_IMPORT_BYTES } from "../ingestion/service";
import { aggregateFleetMetrics } from "../metrics/service";
import type { AnalysisAdapter, Attachment } from "./contracts";
import type { IngestionSource } from "../core/machine";

export function validateAttachment(attachments: Attachment[]): { content: string; source: IngestionSource; filename: string } {
  if (attachments.length !== 1) throw new Error("Se requiere exactamente un archivo CSV o JSON.");
  const a = attachments[0];
  if (!/^[^/\\\r\n\x00-\x1f]{1,180}\.(csv|json)$/i.test(a.filename)) throw new Error("Nombre o extensión de archivo no admitidos.");
  const source = a.filename.toLowerCase().endsWith(".csv") ? "csv" : "json";
  const allowed = source === "csv" ? ["text/csv", "application/csv", "text/plain", "application/octet-stream"] : ["application/json", "text/json", "text/plain", "application/octet-stream"];
  if (!allowed.includes(a.contentType.toLowerCase().split(";")[0].trim())) throw new Error("Tipo de archivo no admitido.");
  if (!a.bytes.length || a.bytes.length > MAX_IMPORT_BYTES) throw new Error("Archivo vacío o superior a 8 MB.");
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(a.bytes); } catch { throw new Error("El archivo debe ser UTF-8 válido."); }
  if (!content.trim() || content.includes("\0")) throw new Error("El archivo está vacío o contiene bytes no permitidos.");
  return { content, source, filename: a.filename };
}

export class LocalAnalysisAdapter implements AnalysisAdapter {
  async analyze(content: string, source: IngestionSource, tenantId: string) {
    let rows: unknown;
    if (source === "csv") rows = parseCsv(content);
    else { try { rows = JSON.parse(content); } catch { throw new Error("JSON inválido."); } }
    if (!Array.isArray(rows) && (!rows || typeof rows !== "object")) throw new Error("La estructura debe ser un objeto o una lista de objetos.");
    if (Array.isArray(rows) && !rows.length) throw new Error("El archivo no contiene registros.");
    const result = normalizeRows(rows, source, tenantId);
    if (!result.processed) throw new Error("El archivo no contiene registros.");
    return { processed: result.processed, accepted: result.accepted, rejected: result.rejected.length, metrics: aggregateFleetMetrics(result.accepted) };
  }
}
