import type { MailAdapter, MailMessage, Reply } from "./contracts";
import { SendRejected } from "./contracts";

export class MockMailAdapter implements MailAdapter {
  readonly sent: Reply[] = [];
  failNextSend = false;
  constructor(readonly messages: MailMessage[]) {}
  async listNew() { return this.messages; }
  async send(reply: Reply) {
    if (this.failNextSend) { this.failNextSend = false; throw new SendRejected("mock rejection"); }
    this.sent.push(structuredClone(reply));
    return { id: `mock-sent-${this.sent.length}` };
  }
}
