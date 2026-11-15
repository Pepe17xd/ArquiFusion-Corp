import { LocalAnalysisAdapter } from "./analysis";
import type { IntelligenceAdapter, MailAdapter, MailMessage } from "./contracts";
import { LeaseLost, SqliteMailQueue } from "./durable";
import { MailProcessor, ReportGenerator, TenantResolver } from "./processor";
import { MaintenanceIntelligenceEngine, type MachineThresholds } from "./maintenance-intelligence";

export class MailReceiver {
  constructor(private readonly queue: SqliteMailQueue, private readonly resolver: TenantResolver) {}
  receive(message: MailMessage, now = Date.now()) {
    this.resolver.resolve(message); // Reject unverified messages before persisting their content.
    return this.queue.submit(message, now);
  }
}

export class MailWorker {
  constructor(private readonly queue: SqliteMailQueue, private readonly mail: MailAdapter, private readonly resolver: TenantResolver, private readonly workerId: string, private readonly clock: () => number = Date.now, private readonly leaseMs = 30000, private readonly maxAttempts = 3, private readonly intelligence?: IntelligenceAdapter, private readonly maintenanceRules: MachineThresholds[] = []) {}
  async runOne(): Promise<boolean> {
    const receipt = this.queue.receive(this.workerId, this.clock(), this.leaseMs);
    if (!receipt) return false;
    const started = this.clock(); let lost = false; const cancellation = new AbortController();
    const renew = () => { if (lost) throw new LeaseLost("Lease lost"); try { this.queue.renew(receipt, this.clock(), this.leaseMs); } catch (error) { lost = true; cancellation.abort(); throw error; } };
    const timer = setInterval(() => { try { renew(); } catch { lost = true; } }, Math.max(1, Math.floor(this.leaseMs / 3)));
    const guardedMail: MailAdapter = { listNew: () => this.mail.listNew(), send: (reply) => { renew(); return this.mail.send(reply); } };
    try {
      const processor = new MailProcessor(guardedMail, this.queue.repository(receipt, this.clock), this.resolver, new LocalAnalysisAdapter(), new ReportGenerator(), this.intelligence, () => new Date(this.clock()).toISOString(), cancellation.signal, new MaintenanceIntelligenceEngine(this.maintenanceRules, () => new Date(this.clock()).toISOString()));
      const job = await processor.process(receipt.message);
      if (lost) throw new LeaseLost("Lease lost");
      if (job.state === "FAILED" && job.report && !job.deliveryUncertain) this.queue.retry(receipt, this.clock(), Math.min(60000, 1000 * 2 ** (receipt.attempts - 1)), this.maxAttempts);
      else this.queue.acknowledge(receipt, this.clock());
      console.log(JSON.stringify({ event: "mailops.job", job_id: job.id, tenant_id: job.tenantId ?? null, state: job.state, duration_ms: Math.max(0, this.clock() - started), error_code: job.deliveryUncertain ? "DELIVERY_UNCERTAIN" : job.state === "FAILED" ? (job.report ? "SEND_REJECTED" : "PROCESSING_FAILED") : null }));
      return true;
    } finally { clearInterval(timer); }
  }
}

export async function runResident(worker: MailWorker, options: { signal: AbortSignal; pollMs: number; onError?: () => void }) {
  while (!options.signal.aborted) {
    let handled = false;
    try { handled = await worker.runOne(); } catch { options.onError?.(); }
    if (!handled && !options.signal.aborted) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); options.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, options.pollMs);
      options.signal.addEventListener("abort", done, { once: true });
      if (options.signal.aborted) done();
    });
  }
}
