export interface SessionRuntime {
  mode: "local" | "cognito" | "invalid";
  clientId: string;
  domain: string;
  redirectUri: string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  location: Pick<Location, "origin" | "href" | "pathname" | "assign" | "replace">;
  history: Pick<History, "replaceState">;
  crypto: Pick<Crypto, "getRandomValues" | "subtle">;
  fetcher: typeof fetch;
  onExpired?: () => void;
}

const ACCESS_KEY = "arquifusion.access-token";
const REFRESH_KEY = "arquifusion.refresh-token";
const TENANT_KEY = "arquifusion.tenant-id";
const TENANT_ROLE_KEY = "arquifusion.tenant-role";
const VERIFIER_KEY = "arquifusion.pkce-verifier";
const STATE_KEY = "arquifusion.oauth-state";

function randomBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function expiry(token: string) {
  try {
    const payload = token.split(".")[1];
    return Number(JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).exp ?? 0);
  } catch { return 0; }
}

export function createSessionClient(runtime: SessionRuntime) {
  const clearTenant = () => { runtime.storage.removeItem(TENANT_KEY); runtime.storage.removeItem(TENANT_ROLE_KEY); };
  const clearSession = () => { runtime.storage.removeItem(ACCESS_KEY); runtime.storage.removeItem(REFRESH_KEY); clearTenant(); };

  async function beginLogin(signup = false) {
    if (runtime.mode !== "cognito" || !runtime.clientId || !runtime.domain) throw new Error("Falta configurar el cliente y el dominio de Cognito.");
    const verifier = randomBase64Url(runtime.crypto.getRandomValues(new Uint8Array(32)));
    const state = randomBase64Url(runtime.crypto.getRandomValues(new Uint8Array(32)));
    runtime.storage.setItem(VERIFIER_KEY, verifier);
    runtime.storage.setItem(STATE_KEY, state);
    const digest = await runtime.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = randomBase64Url(new Uint8Array(digest));
    const url = new URL(`${runtime.domain}/oauth2/authorize`);
    url.search = new URLSearchParams({
      response_type: "code", client_id: runtime.clientId, redirect_uri: runtime.redirectUri,
      scope: "openid email profile arquifusion/read arquifusion/write", state, code_challenge: challenge, code_challenge_method: "S256",
      ...(signup ? { screen_hint: "signup" } : {}),
    }).toString();
    runtime.location.assign(url.toString());
  }

  async function completeLoginCallback() {
    const url = new URL(runtime.location.href);
    if (url.pathname !== "/auth/callback") return false;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expectedState = runtime.storage.getItem(STATE_KEY);
    const verifier = runtime.storage.getItem(VERIFIER_KEY);
    if (url.searchParams.has("error") || !code || !state || state !== expectedState || !verifier) {
      clearSession(); runtime.storage.removeItem(STATE_KEY); runtime.storage.removeItem(VERIFIER_KEY);
      throw new Error(url.searchParams.get("error_description") || "La respuesta de inicio de sesión no es válida.");
    }
    let response: Response;
    try {
      response = await runtime.fetcher(`${runtime.domain}/oauth2/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: runtime.clientId, code, redirect_uri: runtime.redirectUri, code_verifier: verifier }),
      });
    } catch {
      clearSession(); runtime.storage.removeItem(STATE_KEY); runtime.storage.removeItem(VERIFIER_KEY);
      throw new Error("No se pudo conectar con el servicio de identidad.");
    }
    const tokens = await response.json().catch(() => ({}));
    if (!response.ok || typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") {
      clearSession(); runtime.storage.removeItem(STATE_KEY); runtime.storage.removeItem(VERIFIER_KEY);
      throw new Error("Cognito no pudo completar la sesión.");
    }
    runtime.storage.setItem(ACCESS_KEY, tokens.access_token);
    runtime.storage.setItem(REFRESH_KEY, tokens.refresh_token);
    runtime.storage.removeItem(VERIFIER_KEY); runtime.storage.removeItem(STATE_KEY);
    runtime.history.replaceState({}, "", "/app");
    return true;
  }

  async function accessToken(): Promise<string | undefined> {
    const token = runtime.storage.getItem(ACCESS_KEY) || undefined;
    if (!token) { if (runtime.storage.getItem(REFRESH_KEY)) clearSession(); return undefined; }
    if (expiry(token) > Date.now() / 1000 + 60) return token;
    const refresh = runtime.storage.getItem(REFRESH_KEY);
    if (!refresh || runtime.mode !== "cognito" || !runtime.clientId || !runtime.domain) { clearSession(); return undefined; }
    try {
      const response = await runtime.fetcher(`${runtime.domain}/oauth2/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: runtime.clientId, refresh_token: refresh }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.access_token !== "string") throw new Error("refresh failed");
      runtime.storage.setItem(ACCESS_KEY, result.access_token);
      if (typeof result.refresh_token === "string") runtime.storage.setItem(REFRESH_KEY, result.refresh_token);
      return result.access_token;
    } catch { clearSession(); return undefined; }
  }

  async function signOut() {
    const refresh = runtime.storage.getItem(REFRESH_KEY);
    clearSession(); runtime.storage.removeItem(STATE_KEY); runtime.storage.removeItem(VERIFIER_KEY);
    const publicHome = new URL("/", runtime.location.origin).toString();
    if (runtime.mode !== "cognito" || !runtime.clientId || !runtime.domain) { runtime.location.replace(publicHome); return; }
    const logout = new URL("/logout", runtime.domain);
    logout.search = new URLSearchParams({ client_id: runtime.clientId, logout_uri: publicHome }).toString();
    if (refresh) {
      void runtime.fetcher(`${runtime.domain}/oauth2/revoke`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refresh, client_id: runtime.clientId }),
          signal: AbortSignal.timeout(5000), keepalive: true,
        }).catch(() => undefined);
    }
    runtime.location.replace(logout.toString());
  }

  return {
    beginLogin, completeLoginCallback, accessToken, signOut,
    expireSession: () => { clearSession(); runtime.onExpired?.(); },
    hasSession: () => Boolean(runtime.storage.getItem(ACCESS_KEY)),
    selectedTenantId: () => runtime.storage.getItem(TENANT_KEY) || undefined,
    selectedTenantRole: () => runtime.storage.getItem(TENANT_ROLE_KEY) || undefined,
    selectTenant: (tenantId: string, role?: string) => { runtime.storage.setItem(TENANT_KEY, tenantId); if (role) runtime.storage.setItem(TENANT_ROLE_KEY, role); else runtime.storage.removeItem(TENANT_ROLE_KEY); },
    clearTenant, clearSession,
  };
}
