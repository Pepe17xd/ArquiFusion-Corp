import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteMailQueue } from "./durable";
import { MailReceiver, MailWorker, runResident } from "./worker";
import { TenantResolver } from "./processor";
import type { MailAdapter, Organization } from "./contracts";
import { intelligenceProviderFromEnv } from "./intelligence-provider";
import { parseMaintenanceRules } from "./maintenance-intelligence";

function numberEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name]; const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
async function main() {
  const path = process.env.MAILOPS_DB;
  if (!path) throw new Error("MAILOPS_DB is required");
  const cmd = process.argv[2];
  if (!cmd) throw new Error("Command required: worker, seed-demo, failures, history, retry, cleanup");
  const queue = new SqliteMailQueue(path);
  try {
    if (cmd === "worker" || cmd === "seed-demo") {
      const config = process.env.MAILOPS_ALLOWLIST_JSON;
      if (!config) throw new Error("MAILOPS_ALLOWLIST_JSON is required");
      const entries: unknown = JSON.parse(config);
      if (!Array.isArray(entries) || !entries.every(e => e && typeof e.email === "string" && typeof e.tenantId === "string" && typeof e.name === "string")) throw new Error("Invalid allowlist");
      const resolver = new TenantResolver(entries as Organization[]);
      if (cmd === "seed-demo") {
        const root = resolve(process.cwd(), "cloud/aws/fixtures/mailops");
        const fixture = JSON.parse(readFileSync(resolve(root, "message.json"), "utf8")) as { id: string; threadId: string; messageId: string; from: string; subject: string; identityVerified: boolean; attachment: string };
        if (fixture.attachment !== "fleet.csv") throw new Error("Invalid fixture");
        const added = new MailReceiver(queue, resolver).receive({ ...fixture, attachments: [{ filename: fixture.attachment, contentType: "text/csv", bytes: readFileSync(resolve(root, fixture.attachment)) }] });
        console.log(JSON.stringify({ event: "mailops.fixture", inserted: added }));
      } else {
        const controller = new AbortController(); const stop = () => controller.abort();
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
        const lease = numberEnv("MAILOPS_LEASE_MS", 30000, 300, 3600000);
        const poll = numberEnv("MAILOPS_POLL_MS", 1000, 10, 60000);
        const attempts = numberEnv("MAILOPS_MAX_ATTEMPTS", 3, 1, 20);
        const retention = numberEnv("MAILOPS_RETENTION_HOURS", 168, 1, 87600);
        const mail: MailAdapter = { listNew: async () => [], send: async () => ({ id: `mock-${randomUUID()}` }) };
        const intelligence = intelligenceProviderFromEnv();
        const maintenanceRules = parseMaintenanceRules(process.env.MAILOPS_MAINTENANCE_RULES_JSON);
        const worker = new MailWorker(queue, mail, resolver, randomUUID(), Date.now, lease, attempts, intelligence, maintenanceRules);
        const cleanup = setInterval(() => { try { queue.cleanCompleted(Date.now() - retention * 3600000); } catch { console.error(JSON.stringify({ event: "mailops.cleanup", error_code: "CLEANUP_FAILED" })); } }, 3600000);
        console.log(JSON.stringify({ event: "mailops.worker.started", provider: "mock" }));
        try { await runResident(worker, { signal: controller.signal, pollMs: poll, onError: () => console.error(JSON.stringify({ event: "mailops.worker.error", error_code: "WORKER_ERROR" })) }); }
        finally { clearInterval(cleanup); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
        console.log(JSON.stringify({ event: "mailops.worker.stopped" }));
      }
    } else if (cmd === "cleanup") {
      const hours = numberEnv("MAILOPS_RETENTION_HOURS", 168, 1, 87600);
      console.log(JSON.stringify({ redacted: queue.cleanCompleted(Date.now() - hours * 3600000) }));
    } else {
      const tenant = process.argv[3]; if (!tenant) throw new Error("Tenant required");
      if (cmd === "failures") console.log(JSON.stringify(queue.failures(tenant)));
      else if (cmd === "history") { if (!process.argv[4]) throw new Error("Message ID required"); console.log(JSON.stringify(queue.history(process.argv[4], tenant))); }
      else if (cmd === "retry") { if (!process.argv[4] || process.argv[5] !== "--confirm") throw new Error("Message ID and --confirm required"); queue.retryManual(process.argv[4], tenant, Date.now()); console.log(JSON.stringify({ result: "queued" })); }
      else throw new Error("Unknown command");
    }
  } finally { queue.close(); }
}
void main().catch(() => { console.error(JSON.stringify({ event: "mailops.cli.error", error_code: "CONFIG_OR_OPERATION_FAILED" })); process.exitCode = 1; });
