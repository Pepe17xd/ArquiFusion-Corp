import { createHash } from "node:crypto";
import type { MailJob, MailJobRepository } from "./contracts";

/** Single-process demo only; a cloud implementation needs durable atomic claims and fencing. */
export class MemoryMailJobRepository implements MailJobRepository {
  private readonly jobs = new Map<string, MailJob>();
  async claim(messageId: string, now: string) {
    const found = this.jobs.get(messageId);
    if (found) return { job: structuredClone(found), created: false };
    const job: MailJob = { id: createHash("sha256").update(messageId).digest("hex").slice(0, 24), messageId, state: "RECEIVED", createdAt: now, updatedAt: now };
    this.jobs.set(messageId, structuredClone(job));
    return { job, created: true };
  }
  async save(job: MailJob) { this.jobs.set(job.messageId, structuredClone(job)); }
  async get(messageId: string) { const job = this.jobs.get(messageId); return job && structuredClone(job); }
}
