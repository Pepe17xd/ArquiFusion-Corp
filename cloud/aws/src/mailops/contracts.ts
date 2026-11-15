import type { Machine, IngestionSource } from "../core/machine";
import type { FleetMetrics } from "../metrics/service";
import type { MaintenanceEvaluation } from "./maintenance-intelligence";

export type MailState = "RECEIVED" | "VALIDATING" | "PROCESSING" | "ANALYZING" | "GENERATING_REPORT" | "SENDING" | "COMPLETED" | "FAILED";
export interface Attachment { filename: string; contentType: string; bytes: Uint8Array }
export interface MailMessage { id: string; threadId: string; from: string; subject: string; messageId: string; attachments: Attachment[]; identityVerified: boolean }
export interface Reply { to: string; subject: string; threadId: string; messageId: string; text: string; html: string }
export interface MailAdapter { listNew(): Promise<MailMessage[]>; send(reply: Reply): Promise<{ id: string }> }
export interface Organization { tenantId: string; name: string; email: string }
export interface AnalysisResult { processed: number; accepted: Machine[]; rejected: number; metrics: FleetMetrics; maintenance?: MaintenanceEvaluation[] }
export interface AnalysisAdapter { analyze(content: string, source: IngestionSource, tenantId: string): Promise<AnalysisResult> }
/** Provider-neutral seam; implementations return only validated recommendations. */
export interface IntelligenceProvider { analyze(input: { tenantId: string; machines: Machine[]; jobId?: string; signal?: AbortSignal }): Promise<{ source: "gemini" | "mock"; recommendations: string[] }> }
/** Compatibility alias kept for MailOps v3 callers. */
export interface IntelligenceAdapter extends IntelligenceProvider {}
export interface MailJob { id: string; messageId: string; state: MailState; tenantId?: string; recipient?: string; createdAt: string; updatedAt: string; error?: string; report?: { text: string; html: string }; sentId?: string; deliveryUncertain?: boolean }
export interface MailJobRepository { claim(messageId: string, now: string): Promise<{ job: MailJob; created: boolean }>; save(job: MailJob): Promise<void>; get(messageId: string): Promise<MailJob | undefined> }
/** Throw only when the provider definitively rejected the send before delivery. */
export class SendRejected extends Error {}
