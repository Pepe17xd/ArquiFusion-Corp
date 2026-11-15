const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const YAML = require("yaml");

const root = __dirname + "/..";
const read = (name) => YAML.parse(readFileSync(join(root, name), "utf8"));
const platform = read("serverless.yml");
const domains = ["fleet", "ingestion", "intelligence", "supervisor", "operations", "aura"].map((domain) => read(`serverless.${domain}.yml`));
const all = [platform, ...domains];
assert.equal(platform.service, "arquifusion-platform");
assert.equal(platform.provider?.name, "aws");
assert.equal(platform.provider?.runtime, "nodejs24.x");
assert.equal(platform.package?.individually, true);
assert.match(platform.provider?.iam?.role ?? "", /AWS_LAMBDA_ROLE_ARN/, "shared LabRole ARN fallback must be explicit");
assert.equal(platform.provider?.httpApi?.authorizers?.cognito?.type, "jwt");
assert.ok(!platform.provider?.httpApi?.cors?.allowedOrigins?.includes("*"));
assert.deepEqual(platform.provider?.httpApi?.cors?.allowedMethods, ["GET", "POST", "PUT", "PATCH", "OPTIONS"]);
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
  ["arquifusion-operations", ["telemetryBatch", "telemetry", "latestTelemetry", "anomalies", "getAnomaly", "explainAnomaly", "getAnomalyRules", "putAnomalyRules", "incidents", "updateIncident", "maintenanceOrders", "updateMaintenanceOrder", "operationalEvents", "processAnomaly"]],
  ["arquifusion-aura", ["technicians", "saveTechnician", "getTechnician", "archiveTechnician", "putMachineCoordinates", "parts", "createPart", "stock", "inventoryAlerts", "movements", "createMovement", "reserve", "releaseReservation", "optimize", "assignments", "assignment", "assignmentResponse", "policy", "savePolicy", "kpis", "events", "workflowCapture", "workflowNext", "workflowAccept", "workflowClose", "workflowFail"]],
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
  }
  for (const [name, definition] of functions) {
    assert.equal(typeof definition.handler, "string", `${name} handler is required`);
    const [modulePath, exportName] = definition.handler.split(".");
    if (modulePath.startsWith("src/api/domains/")) {
      assert.ok(existsSync(join(root, modulePath + ".ts")), `${name} source TypeScript handler must exist for Serverless v4 bundling`);
      assert.equal(service.build?.esbuild?.bundle, true, `${name} source handler must be bundled by Serverless v4`);
    } else {
      assert.ok(modulePath.startsWith("dist/api/domains/"), `${name} must use a compiled domain entrypoint`);
      assert.ok(existsSync(join(root, modulePath + ".js")), `${name} compiled handler must exist after backend build`);
      assert.ok(existsSync(join(root, modulePath.replace(/^dist\//, "src/") + ".ts")), `${name} must have a domain-owned TypeScript entrypoint`);
    }
    assert.ok(exportName, `${name} handler export must be named`);
    assert.ok(definition.role || service.provider?.iam?.role, `${name} must use an explicit existing runtime role`);
    for (const event of definition.events ?? []) {
      const route = event.httpApi;
      assert.ok(route?.path && route?.method, `${name} HTTP route must be declared`);
      if (!(service === platform && name === "health")) {
        assert.ok(route.authorizer?.name === "cognito" || /HTTP_API_AUTHORIZER_ID/.test(route.authorizer?.id ?? ""), `${name} must require the shared Cognito authorizer`);
        const expectedScope = ["POST", "PUT", "PATCH", "DELETE"].includes(route.method) ? "arquifusion/write" : "arquifusion/read";
        assert.ok(route.authorizer?.scopes?.includes(expectedScope), `${name} must require ${expectedScope}`);
      }
      const key = route.method + " " + route.path;
      assert.ok(!routes.has(key), `duplicate HTTP route ${key}`);
      routes.add(key);
    }
  }
}
assert.equal(functionCount, 57);
assert.equal(routes.size, 49);

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
assert.ok(domains.filter((service) => !["arquifusion-supervisor", "arquifusion-operations", "arquifusion-aura"].includes(service.service)).every((service) => Object.values(service.resources?.Resources ?? {}).every((resource) => resource.Type !== "AWS::StepFunctions::StateMachine")), "only the Supervisor, Operations and AURA domains own their separate workflow resources");
const operations = domains.find((service) => service.service === "arquifusion-operations");
const operationalTable = operations.resources.Resources.OperationalRecordsTable;
assert.equal(operationalTable?.Type, "AWS::DynamoDB::Table");
assert.equal(operationalTable?.DeletionPolicy, "Retain");
assert.equal(operationalTable?.UpdateReplacePolicy, "Retain");
assert.equal(operationalTable?.Properties?.BillingMode, "PAY_PER_REQUEST");
assert.deepEqual(operationalTable?.Properties?.GlobalSecondaryIndexes?.map((index) => index.IndexName).sort(), ["ByTenantMachine", "ByTenantType"]);
assert.equal(operationalTable?.Properties?.TimeToLiveSpecification?.AttributeName, "expiresAt");
const anomalyWorkflow = operations.resources.Resources.AnomalyProcessingStateMachine;
assert.equal(anomalyWorkflow?.Type, "AWS::StepFunctions::StateMachine");
assert.equal(anomalyWorkflow?.Properties?.StateMachineType, "STANDARD");
assert.ok(anomalyWorkflow?.Properties?.Definition?.States?.ProcessAnomaly?.Retry?.length);
assert.ok(Object.values(operations.functions).filter((fn) => fn.events?.length).every((fn) => fn.role), "operational routes require dedicated pre-existing role ARNs");

const aura = domains.find((service) => service.service === "arquifusion-aura");
const auraTable = aura.resources.Resources.AuraTable;
assert.equal(auraTable?.Type, "AWS::DynamoDB::Table");
assert.equal(auraTable?.DeletionPolicy, "Retain");
assert.equal(auraTable?.UpdateReplacePolicy, "Retain");
assert.deepEqual(auraTable?.Properties?.GlobalSecondaryIndexes?.map((index) => index.IndexName), ["ByTenantType"]);
assert.equal(auraTable?.Properties?.TimeToLiveSpecification?.AttributeName, "expiresAt");
const coordination = aura.resources.Resources.IncidentCoordinationStateMachine;
assert.equal(coordination?.Properties?.StateMachineType, "STANDARD");
assert.equal(coordination?.Properties?.Definition?.States?.CaptureConfirmation?.TimeoutSeconds, 43200);
assert.equal(coordination?.Properties?.Definition?.States?.CaptureIntervention?.TimeoutSeconds, 86400);
assert.ok(coordination?.Properties?.Definition?.States?.FindNextCandidate?.Retry?.length);
assert.equal(coordination?.Properties?.Definition?.States?.FindNextCandidate?.Parameters?.["expectedAttempt.$"], "$.attempt");
assert.equal(coordination?.Properties?.Definition?.States?.CaptureIntervention?.Catch?.[0]?.Next, "WorkflowFailure");
assert.ok(Object.values(aura.functions).filter((fn) => fn.events?.length).every((fn) => fn.role), "AURA routes require explicit pre-existing role ARNs");
assert.ok(aura.functions.assignmentResponse.role.includes("AURA_CALLBACK_ROLE_ARN"), "callback permissions must be isolated to assignment response functions");

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

const auraContract = YAML.parse(readFileSync(join(root, "../../packages/contracts/openapi/aura.v1.yaml"), "utf8"));
assert.equal(auraContract.openapi, "3.1.0");
assert.ok(auraContract.paths?.["/assignments/optimize"]?.post, "AURA optimization contract must exist");
assert.ok(auraContract.paths?.["/assignments/{assignmentId}/response"]?.post, "AURA human callback response must exist");
assert.ok(auraContract.paths?.["/inventory/alerts"]?.get, "AURA inventory alert contract must exist");
for (const [name, definition] of Object.entries(aura.functions)) {
  for (const event of definition.events ?? []) {
    const route = event.httpApi;
    assert.ok(auraContract.paths?.[route.path]?.[route.method.toLowerCase()], `AURA route ${route.method} ${route.path} must exist in OpenAPI`);
  }
}
assert.equal(auraContract.components?.schemas?.Technician?.additionalProperties, false, "AURA technician payload must reject arbitrary tenant fields");
assert.ok(!JSON.stringify(auraContract).includes("taskToken"), "AURA OpenAPI must not expose callback task tokens");

process.stdout.write("Static checks passed: 7 Serverless stacks, 57 functions, 49 unique routes, retained tenant/operations/AURA tables, external least-privilege role references, JWT routes, separate Supervisor/Operations/AURA Standard workflows and versioned contracts. This is not CloudFormation validation; no AWS call or deployment was made.\n");
