import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createCognitoAccessTokenVerifier } from "../security/cognito-token-verifier";

const issuer = "https://issuer.test.local/pool";
const clientId = "local-test-client";
const now = Math.floor(Date.now() / 1000);
const primary = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...primary.publicKey.export({ format: "jwk" }), kid: "local-key", alg: "RS256", use: "sig" };
const localJwks = { keys: [jwk] };

test("Cognito JWT verifier accepts a valid RS256 access token using a controlled local JWKS", async () => {
  const verifier = createCognitoAccessTokenVerifier({ issuer, clientId, jwks: localJwks as never });
  const payload = await verifier.verify(signJwt(primary.privateKey, claims()));
  assert.equal(payload.sub, "user-a");
  assert.equal(payload.token_use, "access");
  assert.equal(payload.client_id, clientId);
});

test("Cognito JWT verifier rejects an invalid signature even when the key id matches", async () => {
  await assert.rejects(createCognitoAccessTokenVerifier({ issuer, clientId, jwks: localJwks as never }).verify(signJwt(attacker.privateKey, claims())));
});

test("Cognito JWT verifier rejects an expired token", async () => {
  await assert.rejects(createCognitoAccessTokenVerifier({ issuer, clientId, jwks: localJwks as never }).verify(signJwt(primary.privateKey, claims({ exp: now - 1 }))));
});

test("Cognito JWT verifier rejects the wrong issuer", async () => {
  await assert.rejects(createCognitoAccessTokenVerifier({ issuer, clientId, jwks: localJwks as never }).verify(signJwt(primary.privateKey, claims({ iss: "https://other.test.local/pool" }))));
});

test("Cognito JWT verifier rejects a client id mismatch", async () => {
  await assert.rejects(createCognitoAccessTokenVerifier({ issuer, clientId, jwks: localJwks as never }).verify(signJwt(primary.privateKey, claims({ client_id: "other-client" }))));
});

test("Cognito JWT verifier rejects ID tokens at the API boundary", async () => {
  await assert.rejects(createCognitoAccessTokenVerifier({ issuer, clientId, jwks: localJwks as never }).verify(signJwt(primary.privateKey, claims({ token_use: "id" }))));
});

test("Cognito JWT verifier rejects non-RS256 tokens", async () => {
  await assert.rejects(createCognitoAccessTokenVerifier({ issuer, clientId, jwks: localJwks as never }).verify(signJwt(primary.privateKey, claims(), "RS512")));
});

function claims(overrides: Record<string, unknown> = {}) {
  return { iss: issuer, sub: "user-a", client_id: clientId, token_use: "access", scope: "openid arquifusion/read arquifusion/write", iat: now, exp: now + 3600, ...overrides };
}

function signJwt(privateKey: KeyObject, payload: Record<string, unknown>, algorithm = "RS256") {
  const header = encode({ alg: algorithm, typ: "JWT", kid: "local-key" });
  const body = encode(payload);
  const input = `${header}.${body}`;
  const signer = createSign(algorithm === "RS512" ? "RSA-SHA512" : "RSA-SHA256");
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString("base64url")}`;
}

function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
