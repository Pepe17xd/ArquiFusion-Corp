const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const YAML = require("yaml");

const root = __dirname + "/..";
const read = (name) => YAML.parse(readFileSync(join(root, name), "utf8"));
const platform = read("serverless.yml");
const domains = ["fleet", "ingestion", "intelligence", "supervisor"].map((domain) => read(`serverless.${domain}.yml`));
const all = [platform, ...domains];
assert.equal(platform.service, "arquifusion-platform");
assert.equal(platform.provider?.name, "aws");
assert.equal(platform.provider?.runtime, "nodejs24.x");
assert.equal(platform.package?.individually, true);
assert.match(platform.provider?.iam?.role ?? "", /AWS_LAMBDA_ROLE_ARN/, "shared LabRole ARN fallback must be explicit");
assert.equal(platform.provider?.httpApi?.authorizers?.cognito?.type, "jwt");
assert.ok(!platform.provider?.httpApi?.cors?.allowedOrigins?.includes("*"));
assert.deepEqual(platform.provider?.httpApi?.cors?.allowedMethods, ["GET", "POST", "OPTIONS"]);
assert.ok(all.every((service) => service.package?.individually === true), "each service must package functions individually");

const ownedResources = new Map();
const resourceTypes = (service) => Object.entries(service.resources?.Resources ?? {}).map(([logicalId, resource]) => {
  if (resource.Type === "AWS::DynamoDB::Table" || resource.Type === "AWS::S3::Bucket" || resource.Type === "AWS::ApiGatewayV2::Api") {
    assert.ok(!ownedResources.has(resource.Type + ":" + (resource.Properties?.TableName ?? resource.Properties?.BucketName ?? logicalId)), "shared resource is declared more than once");
    ownedResources.set(resource.Type + ":" + (resource.Properties?.TableName ?? resource.Properties?.BucketName ?? logicalId), service.service);
  }
  return resource;
});
all.forEach(resourceTypes);
assert.equal([...ownedResources.values()].filter((owner) => owner === platform.service).length, 5, "shared data/API foundation must own legacy + operational tables, upload bucket and policy/API resource");
assert.ok(!all.some((service) => Object.values(service.resources?.Resources ?? {}).some((resource) => resource.Type === "AWS::IAM::Role")), "templates must not create IAM roles");

const expectedServices = new Map([
  ["arquifusion-platform", ["health", "listTenants", "createTenant"]],
  ["arquifusion-fleet", ["listMachines", "getMachine", "metrics"]],
  ["arquifusion-ingestion", ["ingestCsv", "ingestJson"]],
  ["arquifusion-intelligence", ["intelligence", "agents"]],
  ["arquifusion-supervisor", ["submitTask", "tasks", "getTask", "taskEvents", "operationsOverview", "runTask", "markTaskDeadLetter"]],
]);
const routes = new Set();
let functionCount = 0;
for (const service of all) {
  assert.ok(expectedServices.has(service.service), `unexpected service ${service.service}`);
  const functions = Object.entries(service.functions ?? {});
  assert.deepEqual(functions.map(([name]) => name).sort(), [...expectedServices.get(service.service)].sort());
  functionCount += functions.length;
  if (service !== platform) {
    assert.match(service.provider?.httpApi?.id ?? "", /HTTP_API_ID/, `${service.service} must bind to the shared HTTP API`);
    assert.equal(service.provider?.httpApi?.authorizers?.cognito?.type, "jwt", `${service.service} owns a Cognito JWT authorizer for its route resources`);
  }
  for (const [name, definition] of functions) {
    assert.equal(typeof definition.handler, "string", `${name} handler is required`);
    const [modulePath, exportName] = definition.handler.split(".");
    assert.ok(modulePath.startsWith("dist/api/domains/"), `${name} must use a compiled domain entrypoint`);
    assert.ok(existsSync(join(root, modulePath + ".js")), `${name} compiled handler must exist after backend build`);
    assert.ok(existsSync(join(root, modulePath.replace(/^dist\//, "src/") + ".ts")), `${name} must have a domain-owned TypeScript entrypoint`);
    assert.ok(exportName, `${name} handler export must be named`);
    assert.ok(definition.role || service.provider?.iam?.role, `${name} must use an explicit existing runtime role`);
    for (const event of definition.events ?? []) {
      const route = event.httpApi;
      assert.ok(route?.path && route?.method, `${name} HTTP route must be declared`);
      if (!(service === platform && name === "health")) {
        assert.equal(route.authorizer?.name, "cognito", `${name} must require Cognito`);
        const expectedScope = route.method === "POST" ? "arquifusion/write" : "arquifusion/read";
        assert.ok(route.authorizer?.scopes?.includes(expectedScope), `${name} must require ${expectedScope}`);
      }
      const key = route.method + " " + route.path;
      assert.ok(!routes.has(key), `duplicate HTTP route ${key}`);
      routes.add(key);
    }
  }
}
assert.equal(functionCount, 17);
assert.equal(routes.size, 15);

const foundation = platform.resources.Resources;
assert.equal(foundation.LegacyMachinesTable?.DeletionPolicy, "Retain");
assert.deepEqual(foundation.LegacyMachinesTable?.Properties?.KeySchema, [{ AttributeName: "machineId", KeyType: "HASH" }]);
const machines = foundation.MachinesTable;
assert.equal(machines?.Type, "AWS::DynamoDB::Table");
assert.deepEqual(machines.Properties?.KeySchema, [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }]);
assert.equal(machines.Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled, true);
assert.equal(foundation.TenantsTable.Properties?.GlobalSecondaryIndexes?.[0]?.IndexName, "ByUser");
assert.equal(foundation.TasksTable.Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled, true);
assert.equal(foundation.UploadsBucket?.Properties?.PublicAccessBlockConfiguration?.BlockPublicPolicy, true);
assert.equal(foundation.UploadsBucket?.Properties?.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]?.ServerSideEncryptionByDefault?.SSEAlgorithm, "AES256");
assert.equal(foundation.UploadsBucket?.Properties?.OwnershipControls?.Rules?.[0]?.ObjectOwnership, "BucketOwnerEnforced");
assert.equal(foundation.UploadsBucketPolicy?.Properties?.PolicyDocument?.Statement?.[0]?.Condition?.Bool?.["aws:SecureTransport"], "false");
assert.equal(platform.resources.Outputs?.HttpApiId?.Export?.Name, "arquifusion-${sls:stage}-HttpApiId");

const supervisor = domains.find((service) => service.service === "arquifusion-supervisor");
const stateMachine = supervisor.resources.Resources.FleetRecommendationsStateMachine;
assert.equal(stateMachine?.Type, "AWS::StepFunctions::StateMachine");
assert.equal(stateMachine?.Properties?.StateMachineType, "STANDARD");
const states = stateMachine.Properties.Definition.States;
assert.equal(stateMachine.Properties.Definition.StartAt, "EjecutarWorkflow");
assert.equal(states.EjecutarWorkflow.TimeoutSeconds, 330);
assert.ok(states.EjecutarWorkflow.Retry?.length);
assert.equal(states.EjecutarWorkflow.Catch?.[0]?.Next, "RegistrarFalloDurable");
assert.equal(states.RegistrarFalloDurable.Next, "EjecucionFallida");
assert.equal(states.EjecucionFallida.Type, "Fail");
assert.ok(!domains.slice(0, 3).some((service) => Object.values(service.resources?.Resources ?? {}).some((resource) => resource.Type === "AWS::StepFunctions::StateMachine")), "only Supervisor owns workflow resources");

const cognito = read("infrastructure/cognito.yml");
assert.equal(cognito.Resources.ArquiFusionUserPool.Properties.DeletionProtection, "ACTIVE");
assert.equal(cognito.Resources.ArquiFusionWebClient.Properties.GenerateSecret, false);
assert.deepEqual(cognito.Resources.ArquiFusionWebClient.Properties.AllowedOAuthFlows, ["code"]);
assert.equal(cognito.Resources.ArquiFusionWebClient.Properties.EnableTokenRevocation, true);
assert.equal(cognito.Resources.ArquiFusionWebClient.Properties.RefreshTokenRotation.Feature, "ENABLED");

const contractPath = join(root, "../../packages/contracts/openapi/intelligence.v1.yaml");
const contract = YAML.parse(readFileSync(contractPath, "utf8"));
assert.equal(contract.openapi, "3.1.0");
assert.ok(contract.paths?.["/v1/intelligence/analyze"]?.post, "versioned intelligence HTTP endpoint must be documented");
assert.equal(contract.paths["/v1/intelligence/analyze"].post.responses?.["503"]?.description?.includes("proveedor"), true);
const requestSchema = contract.paths["/v1/intelligence/analyze"].post.requestBody?.content?.["application/json"]?.schema?.$ref;
assert.ok(requestSchema, "intelligence endpoint must use a shared JSON schema");
assert.ok(existsSync(join(require("node:path").dirname(contractPath), requestSchema)), "OpenAPI request schema reference must resolve from the contract file");

process.stdout.write("Static checks passed: 5 Serverless stacks, 17 functions, 15 unique routes, shared resource ownership, external role references, JWT routes, retained tenant storage, Supervisor Standard workflow and the versioned intelligence contract. This is not CloudFormation validation; no AWS call or deployment was made.\n");
