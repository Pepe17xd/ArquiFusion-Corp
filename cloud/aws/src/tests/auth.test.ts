import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createCognitoAccessTokenVerifier } from "../security/cognito-token-verifier";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalTenantDirectory } from "../tenancy/local-tenant-directory";
import { createRequestAuthorizer } from "../api/request-authorizer";
import { TenantAccessError } from "../tenancy/contracts";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createTenantHandlers } from "../api/handlers/tenants";

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

test("technician membership cannot use tenant-wide routes and is accepted only by technician-scoped handlers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aura-technician-role-"));
  try {
    const tenants = new LocalTenantDirectory(join(dir, "tenants.json"));
    const owner = await tenants.createTenant("owner-sub", "Tenant", "tenant-create-key");
    await tenants.addTechnicianMember(owner.tenant.tenantId, "tech-sub");
    const auth = createRequestAuthorizer({ authMode: "cognito", tenants, tokenVerifier: { verify: async () => ({ sub: "tech-sub", scope: "arquifusion/read arquifusion/write", client_id: clientId, token_use: "access", iss: issuer, exp: now + 3600 }) } });
    const event = { headers: { authorization: "Bearer access" }, requestContext: { requestId: "test" } } as unknown as APIGatewayProxyEventV2;
    const telemetry = { requestId: "test", correlationId: "test", operation: "test" };
    assert.equal((await auth.tenant(event, telemetry, "technician")).userSub, "tech-sub");
    await assert.rejects(auth.tenant(event, telemetry), TenantAccessError);
    await assert.rejects(auth.tenant(event, telemetry, "operator", "arquifusion/write"), TenantAccessError);
    await assert.rejects(auth.tenant(event, telemetry, "admin", "arquifusion/write"), TenantAccessError);
    await tenants.disableUser("tech-sub");
    await assert.rejects(auth.authenticatedUser(event, "arquifusion/read"), TenantAccessError, "a previously issued but still unexpired JWT is denied after server-side deactivation");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("admin cannot link a technician by an arbitrary Cognito subject; invitation is required", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tenant-link-guard-"));
  try {
    const tenants = new LocalTenantDirectory(join(dir, "tenants.json"));
    const owner = await tenants.createTenant("owner-sub", "Tenant", "tenant-create-key");
    const auth = createRequestAuthorizer({ authMode: "cognito", tenants, tokenVerifier: { verify: async () => ({ sub: "owner-sub", scope: "arquifusion/read arquifusion/write", client_id: clientId, token_use: "access", iss: issuer, exp: now + 3600 }) } });
    const handlers = createTenantHandlers(tenants, auth);
    const event = { headers: { authorization: "Bearer access" }, pathParameters: { tenantId: owner.tenant.tenantId }, body: JSON.stringify({ userSub: "somebody-elses-sub" }), requestContext: { requestId: "test" } } as unknown as APIGatewayProxyEventV2;
    const response = await handlers.addTechnician(event);
    assert.equal(typeof response === "string" ? 0 : response.statusCode, 409);
    assert.equal((await tenants.listForUser("somebody-elses-sub")).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
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
