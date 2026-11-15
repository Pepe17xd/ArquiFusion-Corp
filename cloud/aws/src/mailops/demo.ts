import { LocalAnalysisAdapter } from "./analysis";
import { MockMailAdapter } from "./mock";
import { MailProcessor, ReportGenerator, TenantResolver } from "./processor";
import { MemoryMailJobRepository } from "./repository";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const root = resolve(process.cwd(), "cloud/aws/fixtures/mailops");
  const fixture = JSON.parse(readFileSync(resolve(root, "message.json"), "utf8")) as { id: string; threadId: string; messageId: string; from: string; subject: string; identityVerified: boolean; attachment: string };
  const email = fixture.from;
  const adapter = new MockMailAdapter([{ ...fixture, attachments: [{ filename: fixture.attachment, contentType: "text/csv", bytes: readFileSync(resolve(root, fixture.attachment)) }] }]);
  const processor = new MailProcessor(adapter, new MemoryMailJobRepository(), new TenantResolver([{ email, tenantId: "demo", name: "Organización de demostración" }]), new LocalAnalysisAdapter(), new ReportGenerator(), undefined, () => "2026-01-01T00:00:00.000Z");
  const job = await processor.process(adapter.messages[0]);
  if (job.state !== "COMPLETED") throw new Error("La demostración no terminó correctamente.");
  console.log(`Proveedor: mock · Estado: ${job.state}\n${adapter.sent[0].text}`);
}
void main().catch(() => { console.error("Falló la demostración MailOps."); process.exitCode = 1; });
