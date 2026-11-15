import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LocalAnalysisAdapter } from "../mailops/analysis";
import { MockMailAdapter } from "../mailops/mock";
import { MailProcessor, ReportGenerator, TenantResolver } from "../mailops/processor";
import { MemoryMailJobRepository } from "../mailops/repository";
import type { MailMessage, IntelligenceAdapter } from "../mailops/contracts";
import { GmailAdapter } from "../mailops/gmail";

const csv = "machineId,model,category,location,status\nM1,Model,Excavator,Mine,alert\n";
function fixture(content = csv, filename = "fleet.csv"): MailMessage { return { id: "message-1", threadId: "thread-1", messageId: "<one@example.test>", from: "operator@example.test", subject: "Report", identityVerified: true, attachments: [{ filename, contentType: filename.endsWith(".json") ? "application/json" : "text/csv", bytes: Buffer.from(content) }] }; }
function setup(message = fixture(), intelligence?: IntelligenceAdapter) {
  const mail = new MockMailAdapter([message]); const jobs = new MemoryMailJobRepository();
  const resolver = new TenantResolver([{ email: "operator@example.test", tenantId: "a", name: "Org A" }, { email: "other@example.test", tenantId: "b", name: "Org B" }]);
  const processor = new MailProcessor(mail, jobs, resolver, new LocalAnalysisAdapter(), new ReportGenerator(), intelligence, () => "2026-01-01T00:00:00.000Z");
  return { mail, jobs, processor };
}
test("CSV is analyzed and replied once with real metrics and traceability", async () => {
  const m = fixture(); const { processor, mail } = setup(m); const result = await processor.process(m);
  assert.equal(result.state, "COMPLETED"); assert.equal(result.sentId, "mock-sent-1"); assert.match(mail.sent[0].text, /Registros válidos: 1/); assert.match(mail.sent[0].text, /1 en alerta/); assert.match(mail.sent[0].text, /SHA-256/);
  assert.equal((await processor.process(m)).state, "COMPLETED"); assert.equal(mail.sent.length, 1);
});
test("JSON and partial row rejection produce accurate report", async () => {
  const m = fixture(JSON.stringify([{ machineId: "A", model: "M", category: "C", location: "L", status: "operational" }, { status: "bad" }]), "fleet.json"); const { processor, mail } = setup(m);
  assert.equal((await processor.process(m)).state, "COMPLETED"); assert.match(mail.sent[0].text, /Registros válidos: 1/); assert.match(mail.sent[0].text, /Registros rechazados: 1/);
});
test("unauthorized and unverified senders never receive a reply", async () => {
  for (const change of [{ from: "unknown@example.test" }, { identityVerified: false }]) { const m = { ...fixture(), ...change }; const { processor, mail } = setup(m); assert.equal((await processor.process(m)).state, "FAILED"); assert.equal(mail.sent.length, 0); }
});
test("empty, malformed, invalid UTF-8, oversized or unexpected attachments fail closed", async () => {
  const cases = [fixture(""), fixture("bad", "file.json"), fixture("wrong headers\na"), { ...fixture(), attachments: [{ filename: "file.csv", contentType: "text/csv", bytes: Uint8Array.of(255) }] }, { ...fixture(), attachments: [{ filename: "big.csv", contentType: "text/csv", bytes: new Uint8Array(8 * 1024 * 1024 + 1) }] }, { ...fixture(), attachments: [...fixture().attachments, ...fixture().attachments] }];
  for (const m of cases) { const { processor, mail } = setup(m); assert.equal((await processor.process(m)).state, "FAILED"); assert.equal(mail.sent.length, 0); }
});
test("processor failure does not send mail", async () => {
  const m = fixture(); const mail = new MockMailAdapter([m]); const processor = new MailProcessor(mail, new MemoryMailJobRepository(), new TenantResolver([{ email: m.from, tenantId: "a", name: "A" }]), { analyze: async () => { throw new Error("secret"); } }, new ReportGenerator());
  const job = await processor.process(m); assert.equal(job.state, "FAILED"); assert.doesNotMatch(job.error!, /secret/); assert.equal(mail.sent.length, 0);
});
test("Gemini failure falls back to a basic report without invented recommendations", async () => {
  const m = fixture(); const { processor, mail } = setup(m, { analyze: async () => { throw new Error("down"); } }); assert.equal((await processor.process(m)).state, "COMPLETED"); assert.match(mail.sent[0].text, /sin recomendaciones Gemini/); assert.match(mail.sent[0].text, /Recomendaciones Gemini: no disponibles/);
});
test("definitive send failure can be retried once without duplication", async () => {
  const m = fixture(); const { processor, mail } = setup(m); mail.failNextSend = true; assert.equal((await processor.process(m)).state, "FAILED"); assert.equal((await processor.process(m, true)).state, "COMPLETED"); await processor.process(m, true); assert.equal(mail.sent.length, 1);
});
test("ambiguous delivery is not retried automatically", async () => {
  const m = fixture(); const { processor, mail } = setup(m); mail.send = async () => { throw new Error("timeout"); }; const failed = await processor.process(m); assert.equal(failed.deliveryUncertain, true); assert.equal((await processor.process(m, true)).state, "FAILED");
});
test("another tenant cannot retry or receive an existing report", async () => {
  const m = fixture(); const { processor, mail } = setup(m); mail.failNextSend = true; await processor.process(m); const altered = { ...m, from: "other@example.test" }; assert.equal((await processor.process(altered, true)).state, "FAILED"); assert.equal(mail.sent.length, 0);
});
test("instructions in CSV are treated as data and never executed", async () => {
  const m = fixture('machineId,model,category,location,status\nM1,"=RUN(\"\"malicious\"\")",Excavator,Mine,operational\n'); const { processor, mail } = setup(m); assert.equal((await processor.process(m)).state, "COMPLETED"); assert.doesNotMatch(mail.sent[0].text, /RUN/);
});
test("Gmail adapter refuses unverified senders before fetching attachments", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return Response.json(calls === 1 ? { messages: [{ id: "1" }] } : { id: "1", threadId: "t", payload: { headers: [{ name: "From", value: "operator@example.test" }, { name: "Subject", value: "Report" }, { name: "Message-ID", value: "<one@example.test>" }], parts: [{ filename: "f.csv", body: { attachmentId: "attachment" } }] } }); };
  const adapter = new GmailAdapter({ accessToken: async () => "test-token" }, { verify: async () => false }, request);
  assert.deepEqual(await adapter.listNew(), []); assert.equal(calls, 2);
});
test("Gmail reply supplies thread, message references and requires provider ID", async () => {
  let body: { raw: string; threadId: string } | undefined;
  const request: typeof fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ id: "gmail-confirmed" }); };
  const adapter = new GmailAdapter({ accessToken: async () => "test-token" }, { verify: async () => false }, request);
  const sent = await adapter.send({ to: "operator@example.test", subject: "Report", threadId: "thread-1", messageId: "<one@example.test>", text: "Informe", html: "<p>Informe</p>" });
  assert.equal(sent.id, "gmail-confirmed"); assert.equal(body!.threadId, "thread-1");
  const raw = Buffer.from(body!.raw, "base64url").toString("utf8"); assert.match(raw, /In-Reply-To: <one@example.test>/); assert.match(raw, /References: <one@example.test>/);
});
