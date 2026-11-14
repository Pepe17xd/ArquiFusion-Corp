export interface AlertMessage {
  type: string; occurredAt: string; resource?: string; agent: string; executionId: string;
  description: string; attempts: number; recommendation?: string;
}
export interface AccessTokenProvider { accessToken(): Promise<string | undefined> }
export interface NotificationResult { status: "sent" | "pending" | "duplicate"; reason?: string; providerMessageId?: string }

/** Gmail REST adapter. Tokens must come from an injected protected provider; no OAuth token is read from source or browser code. */
export class GmailApiNotifier {
  private readonly sentKeys = new Set<string>();
  constructor(private readonly recipient: string | undefined, private readonly tokens: AccessTokenProvider | undefined, private readonly request: typeof fetch = fetch) {}

  async send(idempotencyKey: string, alert: AlertMessage): Promise<NotificationResult> {
    if (this.sentKeys.has(idempotencyKey)) return { status: "duplicate" };
    if (!this.recipient || !this.tokens) return { status: "pending", reason: "Gmail no está configurado." };
    const token = await this.tokens.accessToken();
    if (!token) return { status: "pending", reason: "El proveedor protegido de OAuth no entregó un token." };
    const subject = `[ARQUIFUSION] ${alert.type}`;
    const body = [
      "ARQUIFUSION · Informe operacional", `Tipo: ${alert.type}`, `Fecha y hora: ${alert.occurredAt}`,
      `Recurso: ${alert.resource ?? "No especificado"}`, `Agente: ${alert.agent}`, `Ejecución: ${alert.executionId}`,
      `Descripción: ${alert.description}`, `Intentos: ${alert.attempts}`, `Acción recomendada: ${alert.recommendation ?? "No hay una recomendación verificada."}`,
    ].join("\n");
    const raw = [`To: ${this.recipient}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8", "", body].join("\r\n");
    const response = await this.request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
    });
    if (!response.ok) return { status: "pending", reason: `Gmail API respondió HTTP ${response.status}.` };
    const result = await response.json() as { id?: string };
    this.sentKeys.add(idempotencyKey);
    return { status: "sent", providerMessageId: result.id };
  }
}
