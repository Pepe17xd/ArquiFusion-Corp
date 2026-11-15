import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SqliteMailQueue } from "./durable";
import { MockMailAdapter } from "./mock";
import { TenantResolver } from "./processor";
import { MailReceiver, MailWorker } from "./worker";
import type { MailMessage } from "./contracts";

async function run(count: number, workers: number) {
  const dir = mkdtempSync(join(tmpdir(), "mailops-bench-")); const queue = new SqliteMailQueue(join(dir, "jobs.sqlite"));
  try {
    const mail = new MockMailAdapter([]); const resolver = new TenantResolver([{ email: "demo@example.test", tenantId: "demo", name: "Demo" }]); const receiver = new MailReceiver(queue, resolver);
    const started = performance.now();
    for (let i = 0; i < count; i++) {
      const message: MailMessage = { id: `job-${i}`, from: "demo@example.test", subject: "Demo", threadId: "t", messageId: "<demo@example.test>", identityVerified: true, attachments: [{ filename: "fleet.csv", contentType: "text/csv", bytes: Buffer.from("machineId,model,category,location,status\nM,M,C,L,operational\n") }] };
      receiver.receive(message);
    }
    const latencies: number[] = []; let errors = 0;
    await Promise.all(Array.from({ length: workers }, async (_, i) => {
      const worker = new MailWorker(queue, mail, resolver, `worker-${i}`);
      for (;;) { const start = performance.now(); try { if (!await worker.runOne()) break; latencies.push(performance.now() - start); } catch { errors++; break; } }
    }));
    const elapsed = performance.now() - started; const sorted = latencies.sort((a, b) => a - b);
    const percentile = (p: number) => Number((sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(2));
    const counts = queue.counts();
    console.log(JSON.stringify({ mode: "local-simulated-single-process", jobs: count, workers, elapsedMs: Number(elapsed.toFixed(2)), jobsPerSecond: Number((mail.sent.length * 1000 / elapsed).toFixed(2)), processingLatencyP50Ms: percentile(.5), processingLatencyP95Ms: percentile(.95), errors, retries: 0, pending: counts.filter(x => x.queue_state === "ready" || x.queue_state === "leased").reduce((n, x) => n + x.count, 0), completed: mail.sent.length }));
  } finally { queue.close(); rmSync(dir, { recursive: true, force: true }); }
}
async function main() { for (const jobs of [100, 500, 1000]) for (const workers of [2, 5, 10]) await run(jobs, workers); }
void main().catch(() => { console.error("Benchmark failed"); process.exitCode = 1; });
