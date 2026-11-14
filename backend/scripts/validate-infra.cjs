const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const YAML = require("yaml");

const document = YAML.parse(readFileSync(join(__dirname, "../serverless.yml"), "utf8"));
const cognito = YAML.parse(readFileSync(join(__dirname, "../infrastructure/cognito.yml"), "utf8"));
assert.equal(document.service, "arquifusion-intelligence", "service name must be present");
assert.equal(document.provider?.name, "aws", "provider must be AWS");
assert.equal(document.provider?.runtime, "nodejs24.x", "Lambda runtime must match the supported Node.js baseline");
assert.equal(document.provider?.region, "\${opt:region, 'us-east-1'}", "region must be explicit and overridable");
assert.equal(document.provider?.environment?.STORAGE_MODE, "cloud", "deployed functions must select cloud storage");
assert.equal(document.provider?.environment?.AUTH_MODE, "cognito", "deployed functions must require Cognito auth");
assert.match(document.provider?.environment?.MACHINES_TABLE ?? "", /machines-v2$/, "tenant partitioned table v2 must be configured");
assert.match(document.provider?.environment?.TENANTS_TABLE ?? "", /tenants$/, "tenant directory table must be configured");
assert.match(document.provider?.environment?.UPLOADS_BUCKET ?? "", /UPLOADS_BUCKET|AWS_ACCOUNT_ID/, "bucket name must include an account-specific value");
assert.match(document.provider?.iam?.role ?? "", /AWS_LAMBDA_ROLE_ARN/, "deployment must use an explicitly supplied existing role");
assert.equal(document.provider?.httpApi?.authorizers?.cognito?.type, "jwt", "business API routes must use a JWT authorizer");
assert.match(document.provider?.httpApi?.authorizers?.cognito?.issuerUrl ?? "", /COGNITO_ISSUER/);
assert.match(document.provider?.httpApi?.authorizers?.cognito?.audience?.[0] ?? "", /COGNITO_AUDIENCE/);

const functions = Object.entries(document.functions ?? {});
assert.equal(functions.length, 17, "each API and workflow responsibility must have an explicit Lambda");
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
    if (name !== "health") {
      assert.equal(route.authorizer?.name, "cognito", name + " must require Cognito");
      const expectedScope = route.method === "POST" ? "arquifusion/write" : "arquifusion/read";
      assert.ok(route.authorizer?.scopes?.includes(expectedScope), name + " must require the expected OAuth scope");
    }
    const key = route.method + " " + route.path;
    assert.ok(!routes.has(key), "duplicate route " + key);
    routes.add(key);
  }
}

const resources = document.resources?.Resources ?? {};
assert.deepEqual(resources.MachinesTable?.Properties?.KeySchema, [{ AttributeName: "machineId", KeyType: "HASH" }], "legacy table schema must remain to avoid replacement");
assert.equal(resources.MachinesTable?.DeletionPolicy, "Retain", "legacy machine data must be retained");
const table = resources.MachinesTableV2;
assert.equal(table?.Type, "AWS::DynamoDB::Table");
assert.equal(table.Properties?.BillingMode, "PAY_PER_REQUEST");
assert.deepEqual(table.Properties?.KeySchema, [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }]);
const tenantTable = resources.TenantsTable;
assert.equal(tenantTable?.Type, "AWS::DynamoDB::Table");
assert.equal(tenantTable.Properties?.GlobalSecondaryIndexes?.[0]?.IndexName, "ByUser");
assert.equal(resources.TasksTable?.Type, "AWS::DynamoDB::Table");
assert.equal(resources.FleetRecommendationsStateMachine?.Type, "AWS::StepFunctions::StateMachine");
assert.equal(resources.FleetRecommendationsStateMachine?.Properties?.StateMachineType, "STANDARD");
assert.match(document.functions?.submitTask?.environment?.TASK_STATE_MACHINE_ARN ?? "", /stateMachine/);
const bucket = resources.UploadsBucket;
assert.equal(bucket?.Type, "AWS::S3::Bucket");
assert.equal(bucket.Properties?.PublicAccessBlockConfiguration?.BlockPublicPolicy, true);
assert.equal(bucket.Properties?.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]?.ServerSideEncryptionByDefault?.SSEAlgorithm, "AES256");
assert.ok(!Object.values(resources).some((resource) => resource.Type === "AWS::IAM::Role"), "project must not create IAM roles");
assert.equal(cognito.Resources?.ArquiFusionUserPool?.Type, "AWS::Cognito::UserPool");
assert.equal(cognito.Resources?.ArquiFusionWebClient?.Properties?.GenerateSecret, false, "browser OAuth client must not contain a client secret");
assert.deepEqual(cognito.Resources?.ArquiFusionWebClient?.Properties?.AllowedOAuthFlows, ["code"], "browser auth must use OAuth authorization code flow");

assert.equal(routes.size, 15, "all public API endpoints are represented by explicit routes");
process.stdout.write("Infrastructure YAML is valid; 15 API routes, 2 workflow Lambdas, JWT authorization, tenant-partitioned DynamoDB, Standard Step Functions, Cognito template and private encrypted S3 passed structural checks. No AWS calls or deployment were made.\n");
