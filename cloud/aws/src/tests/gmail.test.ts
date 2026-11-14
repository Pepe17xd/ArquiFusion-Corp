import { test } from "node:test";
import { strict as assert } from "node:assert";
import { GmailApiNotifier } from "../notifications/gmail";

const alert = { type: "Tarea en DLQ", occurredAt: "2026-11-14T00:00:00.000Z", agent: "fleet-intelligence", executionId: "exec-1", description: "No se completó", attempts: 3 };

test("Gmail adapter clearly reports the channel as pending without protected OAuth configuration", async () => {
  let requests = 0;
  const notifier = new GmailApiNotifier(undefined, undefined, async () => { requests += 1; return new Response("{}", { status: 200 }); });
  assert.deepEqual(await notifier.send("alert-1", alert), { status: "pending", reason: "Gmail no está configurado." });
  assert.equal(requests, 0);
});

test("Gmail adapter requires an OAuth access token before making a request", async () => {
  let requests = 0;
  const notifier = new GmailApiNotifier("alerts@example.invalid", { accessToken: async () => undefined }, async () => {
    requests += 1; return new Response("{}", { status: 200 });
  });
  assert.equal((await notifier.send("alert-key", alert)).status, "pending");
  assert.equal(requests, 0);
});
