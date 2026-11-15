import { createSessionClient } from "./session-core";

const MODE = import.meta.env.VITE_AUTH_MODE || "local";
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || "";
const DOMAIN = (import.meta.env.VITE_COGNITO_DOMAIN || "").replace(/\/$/, "");
const REDIRECT_URI = import.meta.env.VITE_COGNITO_REDIRECT_URI || `${window.location.origin}/auth/callback`;

export const authMode: "local" | "cognito" | "invalid" = MODE === "cognito" || MODE === "local" ? MODE : "invalid";
export interface TenantChoice { tenant: { tenantId: string; name: string }; membership: { role: string } }

const session = createSessionClient({
  mode: authMode,
  clientId: CLIENT_ID,
  domain: DOMAIN,
  redirectUri: REDIRECT_URI,
  storage: window.sessionStorage,
  location: window.location,
  history: window.history,
  crypto: window.crypto,
  fetcher: window.fetch.bind(window),
  onExpired: () => window.dispatchEvent(new Event("arquifusion:session-expired")),
});

export const selectedTenantId = session.selectedTenantId;
export const selectedTenantRole = session.selectedTenantRole;
export const selectTenant = session.selectTenant;
export const clearTenant = session.clearTenant;
export const clearSession = session.clearSession;
export const hasSession = session.hasSession;
export const beginLogin = session.beginLogin;
export const completeLoginCallback = session.completeLoginCallback;
export const accessToken = session.accessToken;
export const signOut = session.signOut;
export const expireSession = session.expireSession;
