import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMailQueue, LeaseLost } from "../mailops/durable";
import { MockMailAdapter } from "../mailops/mock";
import { TenantResolver } from "../mailops/processor";
import { MailReceiver, MailWorker, runResident } from "../mailops/worker";
import type { MailMessage } from "../mailops/contracts";
import { spawn } from "node:child_process";

const resolver = new TenantResolver([{ email: "a@example.test", tenantId: "a", name: "A" }, { email: "b@example.test", tenantId: "b", name: "B" }]);
function message(id: string, from = "a@example.test"): MailMessage { return { id, from, identityVerified: true, threadId: "thread", messageId: "<x@example.test>", subject: "Report", attachments: [{ filename: "data.csv", contentType: "text/csv", bytes: Buffer.from("machineId,model,category,location,status\nM1,M,C,L,alert\n") }] }; }
function temp() { const dir = mkdtempSync(join(tmpdir(), "mailops-")); return { dir, file: join(dir, "jobs.sqlite"), clean: () => rmSync(dir, { recursive: true, force: true }) }; }

test("durable queue deduplicates across restart and workers process separate tenants", async () => {
  const t = temp(); let q = new SqliteMailQueue(t.file);
  try {
    const receiver = new MailReceiver(q, resolver); assert.equal(receiver.receive(message("one")), true); assert.equal(receiver.receive(message("one", "b@example.test")), false); receiver.receive(message("two", "b@example.test")); q.close();
    q = new SqliteMailQueue(t.file); const mail = new MockMailAdapter([]);
    await Promise.all([new MailWorker(q, mail, resolver, "1").runOne(), new MailWorker(q, mail, resolver, "2").runOne()]);
    assert.equal(q.get("one")?.tenantId, "a"); assert.equal(q.get("two")?.tenantId, "b"); assert.equal(mail.sent.length, 2); assert.equal(q.get("one")?.state, "COMPLETED");
  } finally { q.close(); t.clean(); }
});
test("expired lease is recovered and stale worker is fenced", () => {
  const t = temp(); const q = new SqliteMailQueue(t.file);
  try { q.submit(message("one"), 0); const a = q.receive("a", 0, 10)!; assert.equal(q.receive("b", 5, 10), undefined); const b = q.receive("b", 11, 10)!; assert.equal(b.attempts, 2); assert.throws(() => q.save(a, a.job, 11), LeaseLost); assert.throws(() => q.acknowledge(b, 11)); }
  finally { q.close(); t.clean(); }
});
test("abandoned SENDING is quarantined instead of resent", () => {
  const t = temp(); const q = new SqliteMailQueue(t.file);
  try { q.submit(message("one"), 0); const a = q.receive("a", 0, 10)!; q.save(a, { ...a.job, state: "SENDING" }, 1); assert.equal(q.receive("b", 11, 10), undefined); assert.equal(q.get("one")?.deliveryUncertain, true); assert.equal(q.counts()[0].queue_state, "dead"); }
  finally { q.close(); t.clean(); }
});
test("definitive rejection retries after backoff, ambiguous delivery never retries", async () => {
  const t = temp(); const q = new SqliteMailQueue(t.file); let now = 100;
  try { const mail = new MockMailAdapter([]); mail.failNextSend = true; const worker = new MailWorker(q, mail, resolver, "a", () => now); q.submit(message("one"), now); await worker.runOne(); assert.equal(await worker.runOne(), false); now += 1000; await worker.runOne(); assert.equal(q.get("one")?.state, "COMPLETED"); assert.equal(mail.sent.length, 1);
    q.submit(message("two"), now); mail.send = async () => { throw new Error("timeout"); }; await worker.runOne(); assert.equal(q.get("two")?.deliveryUncertain, true); assert.equal(await worker.runOne(), false);
  } finally { q.close(); t.clean(); }
});
test("unauthorized messages are rejected before persistence and failed database writes do not publish", () => {
  const t = temp(); const q = new SqliteMailQueue(t.file);
  try { const receiver = new MailReceiver(q, resolver); assert.throws(() => receiver.receive({ ...message("bad"), identityVerified: false })); assert.equal(q.get("bad"), undefined); q.db.exec("CREATE TRIGGER deny_insert BEFORE INSERT ON mail_queue BEGIN SELECT RAISE(ABORT, 'failed'); END"); assert.throws(() => receiver.receive(message("failed"))); assert.equal(q.get("failed"), undefined); assert.equal(q.counts().length, 0); }
  finally { q.close(); t.clean(); }
});
test("separate processes compete for one durable lease", async () => {
  const t = temp(); const q = new SqliteMailQueue(t.file);
  try {
    q.submit(message("one"), Date.now());
    const script = `const {SqliteMailQueue}=require(process.argv[1]); const q=new SqliteMailQueue(process.argv[2]); const r=q.receive(process.argv[3],Date.now(),60000); process.stdout.write(r?'claimed':'empty'); q.close();`;
    const run = (id: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script, require.resolve("../mailops/durable"), t.file, id], { stdio: ["ignore", "pipe", "ignore"] });
      let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.on("error", reject); child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`child failed: ${code}`)));
    });
    const result = await Promise.all([run("first"), run("second")]);
    assert.deepEqual(result.sort(), ["claimed", "empty"]);
  } finally { q.close(); t.clean(); }
});
test("lease renewal is fenced by token, version and expiry", () => {
  const t = temp(); const q = new SqliteMailQueue(t.file);
  try {
    q.submit(message("one"), 0); const a = q.receive("a", 0, 10)!; const old = { ...a };
    q.renew(a, 9, 10); assert.throws(() => q.renew(old, 10, 10), LeaseLost);
    assert.equal(q.receive("b", 11, 10), undefined); const b = q.receive("b", 20, 10)!;
    assert.throws(() => q.renew(a, 20, 10), LeaseLost); q.renew(b, 21, 10);
  } finally { q.close(); t.clean(); }
});
test("worker renews during a slow send and prevents competing claims", async () => {
  const t = temp(); const q = new SqliteMailQueue(t.file);
  try {
    q.submit(message("one"), Date.now()); const mail = new MockMailAdapter([]); const original = mail.send.bind(mail);
    mail.send = async reply => { await new Promise(resolve => setTimeout(resolve, 130)); assert.equal(q.receive("other", Date.now(), 60), undefined); return original(reply); };
    await new MailWorker(q, mail, resolver, "w", Date.now, 60).runOne(); assert.equal(q.get("one")?.state, "COMPLETED"); assert.equal(mail.sent.length, 1);
  } finally { q.close(); t.clean(); }
});
test("lost lease before sending prevents side effects", async () => {
  const t = temp(); const q = new SqliteMailQueue(t.file);
  try {
    q.submit(message("one"), Date.now()); const mail = new MockMailAdapter([]);
    class RevokingResolver extends TenantResolver { override resolve(m: MailMessage) { const org = super.resolve(m); q.db.prepare("UPDATE mail_queue SET token='stolen' WHERE message_id=?").run(m.id); return org; } }
    const revoked = new RevokingResolver([{ email: "a@example.test", tenantId: "a", name: "A" }]);
    await assert.rejects(new MailWorker(q, mail, revoked, "w").runOne(), LeaseLost); assert.equal(mail.sent.length, 0);
  } finally { q.close(); t.clean(); }
});
test("resident worker processes and stops gracefully", async () => {
  const t = temp(); const q = new SqliteMailQueue(t.file); const controller = new AbortController();
  try {
    q.submit(message("one"), Date.now()); const mail = new MockMailAdapter([]);
    const worker = new MailWorker(q, mail, resolver, "resident");
    const run = runResident(worker, { signal: controller.signal, pollMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 60)); controller.abort(); await run;
    assert.equal(q.get("one")?.state, "COMPLETED"); assert.equal(mail.sent.length, 1);
  } finally { controller.abort(); q.close(); t.clean(); }
});
test("manual retry requires matching tenant and rejects ambiguous deliveries", async () => {
  const t = temp(); const q = new SqliteMailQueue(t.file);
  try {
    const mail = new MockMailAdapter([]); mail.failNextSend = true; q.submit(message("one"), Date.now());
    const worker = new MailWorker(q, mail, resolver, "one", Date.now, 30000, 1); await worker.runOne();
    assert.equal(q.failures("a").length, 1); assert.equal(q.failures("b").length, 0);
    assert.throws(() => q.history("one", "b")); assert.throws(() => q.retryManual("one", "b", Date.now()));
    q.retryManual("one", "a", Date.now()); await worker.runOne(); assert.equal(mail.sent.length, 1); assert.ok(q.history("one", "a").some((event: any) => event.code === "MANUAL_RETRY"));
    q.submit(message("two"), Date.now()); mail.send = async () => { throw new Error("timeout"); }; await worker.runOne();
    assert.throws(() => q.retryManual("two", "a", Date.now()));
  } finally { q.close(); t.clean(); }
});
test("retention redacts completed data while preserving deduplication", async () => {
  const t = temp(); const q = new SqliteMailQueue(t.file);
  try {
    q.submit(message("one"), Date.now()); await new MailWorker(q, new MockMailAdapter([]), resolver, "w").runOne();
    assert.equal(q.cleanCompleted(Date.now() + 1000), 1); assert.equal(q.get("one")?.report, undefined);
    assert.equal(q.submit(message("one"), Date.now()), false); assert.equal(q.cleanCompleted(Date.now() + 1000), 0);
  } finally { q.close(); t.clean(); }
});
