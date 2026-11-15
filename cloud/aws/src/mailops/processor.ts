import { createHash } from "node:crypto";
import type { AnalysisAdapter, AnalysisResult, IntelligenceAdapter, MailAdapter, MailJob, MailJobRepository, MailMessage, Organization } from "./contracts";
import { SendRejected } from "./contracts";
import { validateAttachment } from "./analysis";
import { MaintenanceIntelligenceEngine, type MaintenanceEvaluation } from "./maintenance-intelligence";

export class TenantResolver {
  private readonly allowed = new Map<string, Organization>();
  constructor(entries: Organization[]) {
    for (const entry of entries) {
      const email = entry.email.toLowerCase();
      if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/i.test(email) || !entry.tenantId.trim() || !entry.name.trim() || this.allowed.has(email)) throw new Error("Lista de remitentes inválida o duplicada.");
      this.allowed.set(email, { ...entry, email });
    }
  }
  resolve(message: MailMessage) {
    if (!message.identityVerified) throw new Error("Identidad del remitente no verificada.");
    const org = this.allowed.get(message.from.toLowerCase());
    if (!org) throw new Error("Remitente no autorizado.");
    return org;
  }
}

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!); }
export class ReportGenerator {
  generate(job: MailJob, org: Organization, filename: string, hash: string, result: AnalysisResult, recommendations?: string[], warning?: string, source: "gemini" | "mock" = "gemini", maintenance: MaintenanceEvaluation[] = []) {
    const m = result.metrics;
    const maintenanceLines = maintenance.flatMap(item => {
      const output = ["Máquina " + item.machineId + " — prioridad determinista: " + item.priority, "Evaluación: " + item.explanation, "Mantenimiento preventivo: " + item.preventive.status];
      for (const missing of item.preventive.missingData) output.push("Dato faltante: " + missing);
      for (const finding of item.anomalies) output.push("Hallazgo " + finding.severity + " [" + finding.type + "; regla=" + finding.rule + "; evidencia=" + JSON.stringify(finding.observed) + "]: " + finding.explanation);
      return output;
    });
    const maintenanceSection = ["Maintenance Intelligence determinista (política local; no especificaciones de fabricante):", ...(maintenanceLines.length ? maintenanceLines : ["No hay registros para evaluar."])].join("\n");
    const lines = ["ARQUIFUSION / MAILOPS · INFORME DE ANÁLISIS", `Trabajo: ${job.id}`, `Organización: ${org.name}`, `Archivo: ${filename}`, `Fecha: ${job.createdAt}`, "Estado del análisis: completado", `Registros válidos: ${result.accepted.length}`, `Registros rechazados: ${result.rejected}`, `Errores de validación: ${result.rejected} registros rechazados.`, `Equipos: ${m.total} · Operativos: ${m.operational} · Mantenimiento: ${m.maintenance} · Detenidos: ${m.stopped} · Alerta: ${m.alert}`, `Disponibilidad: ${m.availabilityPercent}%`, `Anomalías: ${m.alert} en alerta, ${m.stopped} detenidos (según estado informado).`, `Fuente: adjunto del mensaje ${job.messageId}; SHA-256: ${hash}`, "Modo análisis: no se modificó la flota.", warning || "Advertencias: ninguna.", recommendations ? `Recomendaciones Gemini:\n${recommendations.join("\n") || "Sin recomendaciones."}` : "Recomendaciones Gemini: no disponibles."];
    if (recommendations && source === "mock") lines[lines.length - 1] = `Recomendaciones de servicio simulado (no Gemini real):\n${recommendations.join("\n") || "Sin recomendaciones."}`;
    lines.splice(Math.max(0, lines.length - 2), 0, maintenanceSection);
    const text = lines.join("\n");
    return { text, html: `<!doctype html><html lang="es"><meta charset="utf-8"><body><pre>${escapeHtml(text)}</pre></body></html>` };
  }
}

export class MailProcessor {
  private readonly active = new Set<string>();
  constructor(private readonly mail: MailAdapter, private readonly jobs: MailJobRepository, private readonly tenants: TenantResolver, private readonly analysis: AnalysisAdapter, private readonly reports: ReportGenerator, private readonly intelligence?: IntelligenceAdapter, private readonly now: () => string = () => new Date().toISOString(), private readonly signal?: AbortSignal, private readonly maintenance = new MaintenanceIntelligenceEngine()) {}
  private async transition(job: MailJob, state: MailJob["state"]) { job.state = state; job.updatedAt = this.now(); await this.jobs.save(job); }
  async process(message: MailMessage, retry = false): Promise<MailJob> {
    const claim = await this.jobs.claim(message.id, this.now());
    const job = claim.job;
    if (this.active.has(message.id) || (!claim.created && (!retry || job.state !== "FAILED" || !job.report || job.deliveryUncertain))) return job;
    this.active.add(message.id);
    try {
      const org = this.tenants.resolve(message);
      if (job.tenantId && job.tenantId !== org.tenantId) throw new Error("La organización del trabajo no coincide.");
      if (job.recipient && job.recipient !== org.email) throw new Error("El destinatario del trabajo no coincide.");
      job.tenantId = org.tenantId;
      job.recipient = org.email;
      if (!job.report) {
        await this.transition(job, "VALIDATING");
        const file = validateAttachment(message.attachments);
        await this.transition(job, "PROCESSING");
        const result = await this.analysis.analyze(file.content, file.source, org.tenantId);
        result.maintenance = this.maintenance.evaluate({ tenantId: org.tenantId, machines: result.accepted, assessedAt: this.now() }).evaluations;
        await this.transition(job, "ANALYZING");
        let recommendations: string[] | undefined;
        let warning: string | undefined;
        let source: "gemini" | "mock" = "gemini";
        if (this.intelligence) {
          try { const output = await this.intelligence.analyze({ tenantId: org.tenantId, machines: result.accepted, jobId: job.id, signal: this.signal }); source = output.source; recommendations = output.recommendations; }
          catch { if (this.signal?.aborted) throw new Error("Trabajo cancelado."); warning = "Advertencia: servicio de inteligencia no disponible; informe básico sin recomendaciones Gemini."; }
        }
        await this.transition(job, "GENERATING_REPORT");
        job.report = this.reports.generate(job, org, file.filename, createHash("sha256").update(file.content).digest("hex"), result, recommendations, warning, source, result.maintenance);
      }
      await this.transition(job, "SENDING");
      try {
        const sent = await this.mail.send({ to: org.email, subject: message.subject, threadId: message.threadId, messageId: message.messageId, ...job.report });
        if (!sent.id) throw new Error("No provider confirmation");
        job.sentId = sent.id; job.error = undefined; job.deliveryUncertain = false;
        await this.transition(job, "COMPLETED");
      } catch (error) {
        job.error = error instanceof SendRejected ? "El proveedor rechazó el envío; se puede reintentar." : "Entrega incierta; conciliar antes de reintentar.";
        job.deliveryUncertain = !(error instanceof SendRejected);
        await this.transition(job, "FAILED");
      }
    } catch { job.error = "Validación, autorización o procesamiento fallido."; await this.transition(job, "FAILED"); }
    finally { this.active.delete(message.id); }
    return structuredClone(job);
  }
}
