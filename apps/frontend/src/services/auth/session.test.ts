import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createSessionClient, type SessionRuntime } from "./session-core.ts";

const origin = "http://localhost:5173";
const domain = "https://identity.example.test";
const clientId = "public-client";
const redirectUri = `${origin}/auth/callback`;

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("expired access token refreshes through the OAuth token endpoint", async () => {
  const storage = new MemoryStorage();
  storage.setItem("arquifusion.access-token", token(Date.now() / 1000 - 10));
  storage.setItem("arquifusion.refresh-token", "refresh-value");
  let requestBody = "";
  const runtime = runtimeFor(storage, async (_input, init) => {
    requestBody = String(init?.body ?? "");
    return Response.json({ access_token: token(Date.now() / 1000 + 3600), refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 });
  });
  const client = createSessionClient(runtime);
  const renewed = await client.accessToken();
  assert.ok(renewed);
  assert.equal(new URLSearchParams(requestBody).get("grant_type"), "refresh_token");
  assert.equal(new URLSearchParams(requestBody).get("refresh_token"), "refresh-value");
  assert.equal(client.hasSession(), true);
  assert.equal(storage.getItem("arquifusion.refresh-token"), "rotated-refresh");
});

test("expired session without a refresh token clears all browser session state", async () => {
  const storage = new MemoryStorage();
  storage.setItem("arquifusion.access-token", token(Date.now() / 1000 - 10));
  storage.setItem("arquifusion.tenant-id", "tenant-a");
  const client = createSessionClient(runtimeFor(storage));
  assert.equal(await client.accessToken(), undefined);
  assert.equal(storage.getItem("arquifusion.access-token"), null);
  assert.equal(storage.getItem("arquifusion.tenant-id"), null);
});

test("an API 401 expires the Cognito session and notifies the authenticated application", () => {
  const storage = new MemoryStorage();
  storage.setItem("arquifusion.access-token", "expired-token");
  storage.setItem("arquifusion.refresh-token", "refresh-token");
  storage.setItem("arquifusion.tenant-id", "tenant-a");
  let expiredEvents = 0;
  const runtime = runtimeFor(storage);
  runtime.onExpired = () => { expiredEvents += 1; };
  createSessionClient(runtime).expireSession();
  assert.equal(storage.getItem("arquifusion.access-token"), null);
  assert.equal(storage.getItem("arquifusion.refresh-token"), null);
  assert.equal(storage.getItem("arquifusion.tenant-id"), null);
  assert.equal(expiredEvents, 1);
});

test("OAuth callback validates state and exchanges the code with the saved PKCE verifier", async () => {
  const storage = new MemoryStorage();
  storage.setItem("arquifusion.oauth-state", "expected-state");
  storage.setItem("arquifusion.pkce-verifier", "saved-verifier");
  const runtime = runtimeFor(storage, async (_input, init) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "test-code");
    assert.equal(body.get("code_verifier"), "saved-verifier");
    return Response.json({ access_token: token(Date.now() / 1000 + 3600), refresh_token: "new-refresh", token_type: "Bearer" });
  });
  runtime.location.href = `${origin}/auth/callback?code=test-code&state=expected-state`;
  const client = createSessionClient(runtime);
  assert.equal(await client.completeLoginCallback(), true);
  assert.equal(client.hasSession(), true);
  assert.equal(storage.getItem("arquifusion.refresh-token"), "new-refresh");
  assert.equal(storage.getItem("arquifusion.pkce-verifier"), null);
  assert.equal(runtime.location.href, `${origin}/app`);
});

test("OAuth callback with a mismatched state is rejected and clears the session", async () => {
  const storage = new MemoryStorage();
  storage.setItem("arquifusion.oauth-state", "expected-state");
  storage.setItem("arquifusion.pkce-verifier", "saved-verifier");
  storage.setItem("arquifusion.access-token", "stale");
  const runtime = runtimeFor(storage);
  runtime.location.href = `${origin}/auth/callback?code=test-code&state=attacker-state`;
  const client = createSessionClient(runtime);
  await assert.rejects(client.completeLoginCallback(), /no es válida/);
  assert.equal(storage.getItem("arquifusion.access-token"), null);
  assert.equal(storage.getItem("arquifusion.oauth-state"), null);
});

test("PKCE login sends only the challenge and keeps state in session storage", async () => {
  const storage = new MemoryStorage();
  const runtime = runtimeFor(storage);
  const client = createSessionClient(runtime);
  await client.beginLogin();
  const loginUrl = new URL(runtime.location.href);
  assert.equal(loginUrl.origin, domain);
  assert.equal(loginUrl.searchParams.get("response_type"), "code");
  assert.equal(loginUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(loginUrl.searchParams.get("state"), storage.getItem("arquifusion.oauth-state"));
  assert.ok(loginUrl.searchParams.get("code_challenge"));
  assert.equal(loginUrl.searchParams.has("code_verifier"), false);
  assert.ok(storage.getItem("arquifusion.pkce-verifier"));
});

test("logout revokes the refresh token, clears local state, and ends the Cognito Hosted UI session", async () => {
  const storage = new MemoryStorage();
  for (const key of ["arquifusion.access-token", "arquifusion.refresh-token", "arquifusion.tenant-id"]) storage.setItem(key, "value");
  let revokeBody = "";
  const runtime = runtimeFor(storage, async (url, init) => {
    if (String(url).endsWith("/oauth2/revoke")) revokeBody = String(init?.body ?? "");
    return new Response(null, { status: 200 });
  });
  const client = createSessionClient(runtime);
  await client.signOut();
  const logoutUrl = new URL(runtime.location.href);
  assert.equal(logoutUrl.origin, domain);
  assert.equal(logoutUrl.pathname, "/logout");
  assert.equal(logoutUrl.searchParams.get("client_id"), clientId);
  assert.equal(logoutUrl.searchParams.get("logout_uri"), origin);
  assert.equal(new URLSearchParams(revokeBody).get("token"), "value");
  assert.equal(new URLSearchParams(revokeBody).get("client_id"), clientId);
  assert.equal(storage.getItem("arquifusion.access-token"), null);
  assert.equal(storage.getItem("arquifusion.refresh-token"), null);
  assert.equal(storage.getItem("arquifusion.tenant-id"), null);
});

function runtimeFor(storage: MemoryStorage, fetcher: typeof fetch = async () => Response.json({})) {
  const location = {
    origin,
    href: origin + "/",
    get pathname() { return new URL(this.href).pathname; },
    assign(url: string | URL) { this.href = String(url); },
  };
  const history = { replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { location.href = new URL(String(url ?? "/"), origin).toString(); } };
  return { mode: "cognito", clientId, domain, redirectUri, storage, location, history, crypto: globalThis.crypto, fetcher } as SessionRuntime & { location: typeof location };
}

function token(exp: number) {
  const payload = btoa(JSON.stringify({ exp })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${payload}.signature`;
}
