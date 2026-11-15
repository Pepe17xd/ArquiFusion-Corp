import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { MailJob, MailJobRepository, MailMessage } from "./contracts";

export interface QueueReceipt { messageId: string; owner: string; token: string; version: number; attempts: number; job: MailJob; message: MailMessage }
export interface JobQueue {
  receive(worker: string, now: number, leaseMs: number): QueueReceipt | undefined;
  acknowledge(receipt: QueueReceipt, now: number): void;
  retry(receipt: QueueReceipt, now: number, delayMs: number, maxAttempts: number): void;
}
export class LeaseLost extends Error {}
type Row = { message_id: string; payload: string; job: string; version: number; attempts: number; owner: string | null; token: string | null; lease_until: number | null; queue_state: string };

/** Single SQLite transaction is both job creation and durable queue publication. */
export class SqliteMailQueue implements JobQueue {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS mail_queue (message_id TEXT PRIMARY KEY, payload TEXT NOT NULL, job TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, owner TEXT, token TEXT, lease_until INTEGER,
      available_at INTEGER NOT NULL, queue_state TEXT NOT NULL CHECK(queue_state IN ('ready','leased','done','dead')));
      CREATE INDEX IF NOT EXISTS mail_queue_ready ON mail_queue(queue_state, available_at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS mail_history (id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, tenant_id TEXT, state TEXT NOT NULL, at TEXT NOT NULL, code TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS mail_history_insert AFTER INSERT ON mail_queue BEGIN
        INSERT INTO mail_history(message_id,tenant_id,state,at,code) VALUES (NEW.message_id,json_extract(NEW.job,'$.tenantId'),json_extract(NEW.job,'$.state'),json_extract(NEW.job,'$.updatedAt'),'RECEIVED'); END;
      CREATE TRIGGER IF NOT EXISTS mail_history_update AFTER UPDATE OF job ON mail_queue WHEN json_extract(OLD.job,'$.state') <> json_extract(NEW.job,'$.state') BEGIN
        INSERT INTO mail_history(message_id,tenant_id,state,at,code) VALUES (NEW.message_id,json_extract(NEW.job,'$.tenantId'),json_extract(NEW.job,'$.state'),json_extract(NEW.job,'$.updatedAt'),CASE WHEN json_extract(NEW.job,'$.deliveryUncertain')=1 THEN 'DELIVERY_UNCERTAIN' WHEN json_extract(NEW.job,'$.state')='FAILED' THEN 'FAILED' ELSE 'STATE' END); END;`);
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  submit(message: MailMessage, now: number): boolean {
    const job: MailJob = { id: createHash("sha256").update(message.id).digest("hex").slice(0, 24), messageId: message.id, state: "RECEIVED", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    const payload = JSON.stringify({ ...message, attachments: message.attachments.map(a => ({ ...a, bytes: Buffer.from(a.bytes).toString("base64") })) });
    return this.transaction(() => Number(this.db.prepare("INSERT OR IGNORE INTO mail_queue(message_id,payload,job,available_at,queue_state) VALUES(?,?,?,?, 'ready')").run(message.id, payload, JSON.stringify(job), now).changes) === 1);
  }
  receive(owner: string, now: number, leaseMs: number): QueueReceipt | undefined {
    if (!owner || leaseMs <= 0) throw new Error("Invalid worker or lease");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM mail_queue WHERE (queue_state='ready' AND available_at<=?) OR (queue_state='leased' AND lease_until<=?) ORDER BY available_at, rowid LIMIT 1").get(now, now) as Row | undefined;
      if (!row) return undefined;
      const job = JSON.parse(row.job) as MailJob;
      if (job.state === "SENDING") {
        job.state = "FAILED"; job.deliveryUncertain = true; job.error = "Entrega incierta tras perder el lease; requiere conciliación."; job.updatedAt = new Date(now).toISOString();
        this.db.prepare("UPDATE mail_queue SET job=?, queue_state='dead', owner=NULL, token=NULL, lease_until=NULL, version=version+1 WHERE message_id=?").run(JSON.stringify(job), row.message_id);
        return undefined;
      }
      if (job.state === "COMPLETED" || (job.state === "FAILED" && job.deliveryUncertain)) {
        this.db.prepare("UPDATE mail_queue SET queue_state=?, owner=NULL, token=NULL, lease_until=NULL, version=version+1 WHERE message_id=?").run(job.state === "COMPLETED" ? "done" : "dead", row.message_id);
        return undefined;
      }
      const token = randomUUID();
      this.db.prepare("UPDATE mail_queue SET queue_state='leased',owner=?,token=?,lease_until=?,attempts=attempts+1,version=version+1 WHERE message_id=?").run(owner, token, now + leaseMs, row.message_id);
      const encoded = JSON.parse(row.payload) as Omit<MailMessage, "attachments"> & { attachments: Array<{ filename: string; contentType: string; bytes: string }> };
      const message: MailMessage = { ...encoded, attachments: encoded.attachments.map(a => ({ ...a, bytes: Buffer.from(a.bytes, "base64") })) };
      return { messageId: row.message_id, owner, token, version: row.version + 1, attempts: row.attempts + 1, job, message };
    });
  }
  private fenced(receipt: QueueReceipt, sql: string, args: (string | number)[], now: number) {
    const result = this.db.prepare(sql + " WHERE message_id=? AND queue_state='leased' AND owner=? AND token=? AND version=? AND lease_until>?").run(...args, receipt.messageId, receipt.owner, receipt.token, receipt.version, now);
    if (Number(result.changes) !== 1) throw new LeaseLost("Lease expired or changed");
    receipt.version++;
  }
  save(receipt: QueueReceipt, job: MailJob, now: number) {
    if (job.messageId !== receipt.messageId) throw new Error("Job identity mismatch");
    this.fenced(receipt, "UPDATE mail_queue SET job=?,version=version+1", [JSON.stringify(job)], now);
    receipt.job = structuredClone(job);
  }
  renew(receipt: QueueReceipt, now: number, leaseMs: number) {
    if (leaseMs <= 0) throw new Error("Invalid lease");
    this.fenced(receipt, "UPDATE mail_queue SET lease_until=?,version=version+1", [now + leaseMs], now);
  }
  acknowledge(receipt: QueueReceipt, now: number) {
    if (receipt.job.state !== "COMPLETED" && receipt.job.state !== "FAILED") throw new Error("Job has not reached a terminal state");
    this.fenced(receipt, "UPDATE mail_queue SET queue_state=?,owner=NULL,token=NULL,lease_until=NULL,version=version+1", [receipt.job.state === "COMPLETED" ? "done" : "dead"], now);
  }
  retry(receipt: QueueReceipt, now: number, delayMs: number, maxAttempts: number) {
    if (receipt.job.state !== "FAILED" || receipt.job.deliveryUncertain || !receipt.job.report) throw new Error("Unsafe retry");
    this.fenced(receipt, "UPDATE mail_queue SET queue_state=?,available_at=?,owner=NULL,token=NULL,lease_until=NULL,version=version+1", [receipt.attempts >= maxAttempts ? "dead" : "ready", now + delayMs], now);
  }
  get(messageId: string): MailJob | undefined { const row = this.db.prepare("SELECT job FROM mail_queue WHERE message_id=?").get(messageId) as { job: string } | undefined; return row && JSON.parse(row.job) as MailJob; }
  counts() { return this.db.prepare("SELECT queue_state, count(*) AS count FROM mail_queue GROUP BY queue_state").all() as Array<{ queue_state: string; count: number }>; }
  failures(tenantId: string) {
    return this.db.prepare("SELECT message_id, json_extract(job,'$.id') AS job_id, json_extract(job,'$.state') AS state, json_extract(job,'$.deliveryUncertain') AS uncertain, attempts FROM mail_queue WHERE queue_state='dead' AND json_extract(job,'$.tenantId')=?").all(tenantId);
  }
  history(messageId: string, tenantId: string) {
    const job = this.get(messageId);
    if (!job || job.tenantId !== tenantId) throw new Error("Job not found");
    return this.db.prepare("SELECT state,at,code FROM mail_history WHERE message_id=? ORDER BY id").all(messageId);
  }
  retryManual(messageId: string, tenantId: string, now: number) {
    return this.transaction(() => {
      const job = this.get(messageId);
      if (!job || job.tenantId !== tenantId || job.state !== "FAILED" || job.deliveryUncertain || !job.report) throw new Error("Job not eligible for retry");
      const result = this.db.prepare("UPDATE mail_queue SET queue_state='ready',available_at=?,attempts=0,version=version+1 WHERE message_id=? AND queue_state='dead'").run(now, messageId);
      if (Number(result.changes) !== 1) throw new Error("Job not eligible for retry");
      this.db.prepare("INSERT INTO mail_history(message_id,tenant_id,state,at,code) VALUES(?,?,?,?,?)").run(messageId, tenantId, job.state, new Date(now).toISOString(), "MANUAL_RETRY");
    });
  }
  cleanCompleted(before: number) {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT message_id,job FROM mail_queue WHERE queue_state='done' AND json_extract(job,'$.updatedAt')<=? AND payload<>'{}'").all(new Date(before).toISOString()) as Array<{ message_id: string; job: string }>;
      for (const row of rows) {
        const job = JSON.parse(row.job) as MailJob; delete job.report; delete job.recipient;
        this.db.prepare("UPDATE mail_queue SET payload='{}',job=?,version=version+1 WHERE message_id=? AND queue_state='done'").run(JSON.stringify(job), row.message_id);
        this.db.prepare("INSERT INTO mail_history(message_id,tenant_id,state,at,code) VALUES(?,?,?,?,?)").run(row.message_id, job.tenantId ?? null, job.state, new Date().toISOString(), "REDACTED");
      }
      return rows.length;
    });
  }
  /** The processor's repository is bound to one fenced lease; it cannot claim another job. */
  repository(receipt: QueueReceipt, clock: () => number): MailJobRepository {
    return {
      claim: async (id) => { if (id !== receipt.messageId) throw new LeaseLost("Job mismatch"); return { job: structuredClone(receipt.job), created: true }; },
      save: async (job) => this.save(receipt, job, clock()),
      get: async (id) => id === receipt.messageId ? this.get(id) : undefined,
    };
  }
}
