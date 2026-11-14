const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const YAML = require("yaml");

const document = YAML.parse(readFileSync(join(__dirname, "../serverless.yml"), "utf8"));
assert.equal(document.service, "arquifusion-intelligence", "service name must be present");
assert.equal(document.provider?.name, "aws", "provider must be AWS");
assert.equal(document.provider?.runtime, "nodejs24.x", "Lambda runtime must match the supported Node.js baseline");
assert.equal(document.provider?.region, "\${opt:region, 'us-east-1'}", "region must be explicit and overridable");
assert.equal(document.provider?.environment?.STORAGE_MODE, "cloud", "deployed functions must select cloud storage");
assert.match(document.provider?.environment?.MACHINES_TABLE ?? "", /machines$/, "table name must be configured");
assert.match(document.provider?.environment?.UPLOADS_BUCKET ?? "", /UPLOADS_BUCKET|AWS_ACCOUNT_ID/, "bucket name must include an account-specific value");
assert.match(document.provider?.iam?.role ?? "", /AWS_LAMBDA_ROLE_ARN/, "deployment must use an explicitly supplied existing role");

const functions = Object.entries(document.functions ?? {});
assert.equal(functions.length, 7, "each API responsibility must have an explicit Lambda");
const routes = new Set();
for (const [name, definition] of functions) {
  const handler = definition.handler;
  assert.equal(typeof handler, "string", name + " must declare a handler");
  const [moduleName, exportName] = handler.split(".");
  assert.ok(existsSync(join(__dirname, "..", moduleName + ".js")), name + " handler module must be built");
  assert.ok(exportName, name + " handler export must be named");
  for (const event of definition.events ?? []) {
    const route = event.httpApi;
    assert.ok(route?.path && route?.method, name + " must declare an HTTP API route");
    const key = route.method + " " + route.path;
    assert.ok(!routes.has(key), "duplicate route " + key);
    routes.add(key);
  }
}

const resources = document.resources?.Resources ?? {};
const table = resources.MachinesTable;
assert.equal(table?.Type, "AWS::DynamoDB::Table");
assert.equal(table.Properties?.BillingMode, "PAY_PER_REQUEST");
assert.deepEqual(table.Properties?.KeySchema, [{ AttributeName: "machineId", KeyType: "HASH" }]);
const bucket = resources.UploadsBucket;
assert.equal(bucket?.Type, "AWS::S3::Bucket");
assert.equal(bucket.Properties?.PublicAccessBlockConfiguration?.BlockPublicPolicy, true);
assert.equal(bucket.Properties?.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]?.ServerSideEncryptionByDefault?.SSEAlgorithm, "AES256");
assert.ok(!Object.values(resources).some((resource) => resource.Type === "AWS::IAM::Role"), "project must not create IAM roles");

process.stdout.write("Infrastructure YAML is valid; 7 Lambda routes, DynamoDB and private encrypted S3 resources passed structural checks. No AWS calls or deployment were made.\n");
