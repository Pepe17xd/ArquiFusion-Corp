import { MAX_IMPORT_BYTES } from "../ingestion/service";
import type { MailAdapter, MailMessage, Reply, Attachment } from "./contracts";
import { SendRejected } from "./contracts";

interface Header { name: string; value: string }
interface Part { filename?: string; mimeType?: string; body?: { size?: number; data?: string; attachmentId?: string }; parts?: Part[] }
interface GmailMessage { id: string; threadId: string; payload?: Part & { headers?: Header[] } }
export interface GmailTokenProvider { accessToken(): Promise<string> }
/** This verifier must use trusted delivery evidence, not sender-controlled headers alone. */
export interface SenderVerifier { verify(message: GmailMessage, from: string): Promise<boolean> }

export class GmailAdapter implements MailAdapter {
  constructor(private readonly token: GmailTokenProvider, private readonly verifier: SenderVerifier, private readonly request: typeof fetch = fetch) {}
  private async api(path: string) {
    const response = await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${await this.token.accessToken()}` } });
    if (!response.ok) throw new Error(`Gmail API HTTP ${response.status}`);
    return response.json() as Promise<any>;
  }
  async listNew(): Promise<MailMessage[]> {
    const messages: MailMessage[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ q: "in:inbox -in:spam -in:trash", maxResults: "100" });
      if (pageToken) query.set("pageToken", pageToken);
      const list = await this.api(`messages?${query}`) as { messages?: { id: string }[]; nextPageToken?: string };
      for (const item of list.messages ?? []) {
        const raw = await this.api(`messages/${encodeURIComponent(item.id)}?format=full`) as GmailMessage;
        const headers = raw.payload?.headers ?? [];
        const values = (name: string) => headers.filter(h => h.name.toLowerCase() === name).map(h => h.value);
        const from = values("from"); const subject = values("subject"); const messageId = values("message-id");
        if (from.length !== 1 || subject.length !== 1 || messageId.length !== 1) continue;
        const match = /^(?:[^<>\r\n]*<)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+)>?$/i.exec(from[0].trim());
        if (!match || !await this.verifier.verify(raw, match[1].toLowerCase())) continue;
        const attachments: Attachment[] = [];
        const visit = async (part: Part): Promise<void> => {
          if (part.filename || part.body?.attachmentId) {
            if (!part.filename || (part.body?.size ?? 0) > MAX_IMPORT_BYTES || attachments.length >= 1) throw new Error("Adjuntos inválidos o demasiado grandes.");
            const body = part.body?.attachmentId ? await this.api(`messages/${encodeURIComponent(item.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`) : part.body;
            const bytes = Buffer.from(body?.data ?? "", "base64url");
            if (bytes.length > MAX_IMPORT_BYTES) throw new Error("Adjunto demasiado grande.");
            attachments.push({ filename: part.filename, contentType: part.mimeType ?? "application/octet-stream", bytes });
          }
          for (const child of part.parts ?? []) await visit(child);
        };
        try { if (raw.payload) await visit(raw.payload); }
        catch { attachments.push({ filename: "invalid", contentType: "invalid", bytes: new Uint8Array() }); }
        messages.push({ id: raw.id, threadId: raw.threadId, from: match[1].toLowerCase(), subject: subject[0], messageId: messageId[0], identityVerified: true, attachments });
      }
      pageToken = list.nextPageToken;
    } while (pageToken);
    return messages;
  }
  async send(reply: Reply) {
    if (/[\r\n]/.test(reply.to + reply.subject + reply.messageId) || !/^<[^<>\s]+>$/.test(reply.messageId)) throw new SendRejected("Cabeceras de respuesta inválidas.");
    const boundary = "arquifusion-mailops-boundary";
    const encode = (s: string) => Buffer.from(s, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
    const subject = `=?UTF-8?B?${Buffer.from(reply.subject, "utf8").toString("base64")}?=`;
    const raw = [`To: ${reply.to}`, `Subject: ${subject}`, `In-Reply-To: ${reply.messageId}`, `References: ${reply.messageId}`, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", encode(reply.text), `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", encode(reply.html), `--${boundary}--`, ""].join("\r\n");
    const token = await this.token.accessToken();
    const response = await this.request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url"), threadId: reply.threadId }) });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new SendRejected("Gmail rechazó el envío.");
      throw new Error("Estado de entrega incierto.");
    }
    const sent = await response.json() as { id?: string };
    if (!sent.id) throw new Error("Gmail no devolvió confirmación.");
    return { id: sent.id };
  }
}
