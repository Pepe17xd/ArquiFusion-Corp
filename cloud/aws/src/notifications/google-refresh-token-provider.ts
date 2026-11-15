import type { AccessTokenProvider } from "./gmail";

export class GoogleRefreshTokenProvider implements AccessTokenProvider {
  private cached?: { token: string; expiresAt: number };
  constructor(
    private readonly credentials: { clientId: string; clientSecret: string; refreshToken: string },
    private readonly request: typeof fetch = fetch,
  ) {}

  async accessToken(): Promise<string | undefined> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.token;
    const response = await this.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) return undefined;
    this.cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}