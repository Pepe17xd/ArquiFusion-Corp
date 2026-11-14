const MODE = import.meta.env.VITE_AUTH_MODE || "local";
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || "";
const DOMAIN = (import.meta.env.VITE_COGNITO_DOMAIN || "").replace(/\/$/, "");
const REDIRECT_URI = import.meta.env.VITE_COGNITO_REDIRECT_URI || `${window.location.origin}/auth/callback`;
const ACCESS_KEY = "arquifusion.access-token";
const REFRESH_KEY = "arquifusion.refresh-token";
const TENANT_KEY = "arquifusion.tenant-id";
const VERIFIER_KEY = "arquifusion.pkce-verifier";
const STATE_KEY = "arquifusion.oauth-state";

export const authMode: "local" | "cognito" | "invalid" = MODE === "cognito" || MODE === "local" ? MODE : "invalid";
export interface TenantChoice { tenant: { tenantId: string; name: string }; membership: { role: string } }
export const selectedTenantId = () => sessionStorage.getItem(TENANT_KEY) || undefined;
export const selectTenant = (tenantId: string) => sessionStorage.setItem(TENANT_KEY, tenantId);
export const clearTenant = () => sessionStorage.removeItem(TENANT_KEY);
export const clearSession = () => { sessionStorage.removeItem(ACCESS_KEY); sessionStorage.removeItem(REFRESH_KEY); clearTenant(); };
export const hasSession = () => Boolean(sessionStorage.getItem(ACCESS_KEY));

function randomBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomToken() { return randomBase64Url(crypto.getRandomValues(new Uint8Array(32))); }

export function beginLogin(signup = false) {
  if (!CLIENT_ID || !DOMAIN) throw new Error("Falta configurar el cliente y el dominio de Cognito.");
  const verifier = randomToken();
  const state = randomToken();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  void crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then((digest) => {
    const challenge = randomBase64Url(new Uint8Array(digest));
    const url = new URL(`${DOMAIN}/oauth2/authorize`);
    url.search = new URLSearchParams({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      scope: "openid email profile arquifusion/read arquifusion/write", state, code_challenge: challenge, code_challenge_method: "S256",
      ...(signup ? { screen_hint: "signup" } : {}),
    }).toString();
    window.location.assign(url);
  });
}

export async function completeLoginCallback() {
  const url = new URL(window.location.href);
  if (url.pathname !== "/auth/callback") return false;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (url.searchParams.has("error") || !code || !state || state !== expectedState || !verifier) {
    throw new Error(url.searchParams.get("error_description") || "La respuesta de inicio de sesión no es válida.");
  }
  const response = await fetch(`${DOMAIN}/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || typeof tokens.access_token !== "string") throw new Error("Cognito no pudo completar la sesión.");
  sessionStorage.setItem(ACCESS_KEY, tokens.access_token);
  if (typeof tokens.refresh_token === "string") sessionStorage.setItem(REFRESH_KEY, tokens.refresh_token);
  sessionStorage.removeItem(VERIFIER_KEY); sessionStorage.removeItem(STATE_KEY);
  window.history.replaceState({}, "", "/");
  return true;
}

function tokenExpiry(token: string) {
  try { const payload = token.split(".")[1]; return Number(JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).exp ?? 0); }
  catch { return 0; }
}

export async function accessToken(): Promise<string | undefined> {
  let token = sessionStorage.getItem(ACCESS_KEY) || undefined;
  if (!token || tokenExpiry(token) > Date.now() / 1000 + 60) return token;
  const refresh = sessionStorage.getItem(REFRESH_KEY);
  if (!refresh || !CLIENT_ID || !DOMAIN) { clearSession(); return undefined; }
  try {
    const response = await fetch(`${DOMAIN}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refresh }) });
    const result = await response.json();
    if (!response.ok || typeof result.access_token !== "string") throw new Error("refresh failed");
    const renewed: string = result.access_token; sessionStorage.setItem(ACCESS_KEY, renewed); return renewed;
  } catch { clearSession(); return undefined; }
}

export function signOut() {
  clearSession();
  if (authMode === "local") { window.location.assign("/"); return; }
  if (!CLIENT_ID || !DOMAIN) { window.location.assign("/"); return; }
  const logout = new URL(`${DOMAIN}/logout`);
  logout.search = new URLSearchParams({ client_id: CLIENT_ID, logout_uri: window.location.origin }).toString();
  window.location.assign(logout);
}
