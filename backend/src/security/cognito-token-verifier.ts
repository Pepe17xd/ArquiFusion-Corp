import { JwtVerifier } from "aws-jwt-verify";
import { validateCognitoJwtFields } from "aws-jwt-verify/cognito-verifier";
import type { Jwks } from "aws-jwt-verify/jwk";

export interface VerifiedAccessToken {
  sub: string;
  scope: string;
  client_id: string;
  token_use: "access";
  iss: string;
  exp: number;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<VerifiedAccessToken>;
}

/**
 * Verifies Cognito access tokens cryptographically. API Gateway performs the
 * first check; the Lambda boundary repeats it so direct invocation and local
 * contract tests cannot treat decoded claims as proof of identity.
 */
export function createCognitoAccessTokenVerifier(input: {
  issuer: string;
  clientId: string;
  jwksUri?: string;
  jwks?: Jwks;
}): AccessTokenVerifier {
  const jwksUri = input.jwksUri ?? `${input.issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  const verifier = JwtVerifier.create({
    issuer: input.issuer,
    audience: null,
    jwksUri,
    customJwtCheck: ({ header, payload }) => {
      if (header.alg !== "RS256") throw new Error("Only RS256 Cognito access tokens are accepted");
      validateCognitoJwtFields(payload, { tokenUse: "access", clientId: input.clientId });
      if (typeof payload.sub !== "string" || !payload.sub) throw new Error("JWT subject is missing");
      if (typeof payload.scope !== "string") throw new Error("JWT scopes are missing");
    },
  });
  if (input.jwks) verifier.cacheJwks(input.jwks);
  return {
    async verify(token: string) {
      const payload = await verifier.verify(token);
      if (typeof payload.sub !== "string" || typeof payload.scope !== "string" || typeof payload.client_id !== "string"
        || payload.token_use !== "access" || typeof payload.iss !== "string" || typeof payload.exp !== "number") {
        throw new Error("JWT claims are incomplete");
      }
      return payload as unknown as VerifiedAccessToken;
    },
  };
}
