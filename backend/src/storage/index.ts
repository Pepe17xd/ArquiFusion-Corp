import { loadConfig } from "../core/config";
import { dirname, join } from "node:path";
import type { MachineRepository, OriginalFileStore } from "./contracts";
import { LocalMachineRepository } from "./local-machine-repository";
import { DynamoMachineRepository } from "./dynamo-machine-repository";
import { LocalOriginalFileStore } from "./local-original-file-store";
import { S3OriginalFileStore } from "./s3-original-file-store";
import { LocalTenantDirectory } from "../tenancy/local-tenant-directory";
import { DynamoTenantDirectory } from "../tenancy/dynamo-tenant-directory";
import { DynamoTaskStore } from "../supervisor/dynamo-task-store";
import { StepFunctionsTaskDispatcher } from "../supervisor/step-functions-dispatcher";
import { createCognitoAccessTokenVerifier } from "../security/cognito-token-verifier";

export function createStorage() {
  const config = loadConfig();
  const machines: MachineRepository = config.storageMode === "cloud"
    ? new DynamoMachineRepository(config.machinesTable!)
    : new LocalMachineRepository(config.localDataFile);
  const originals: OriginalFileStore = config.storageMode === "cloud"
    ? new S3OriginalFileStore(config.uploadsBucket!)
    : new LocalOriginalFileStore(config.localUploadsDir);
  const tenants = config.storageMode === "cloud"
    ? new DynamoTenantDirectory(config.tenantsTable!)
    : new LocalTenantDirectory(join(dirname(config.localDataFile), "tenants.json"));
  const tasks = config.storageMode === "cloud" ? new DynamoTaskStore(config.tasksTable!) : undefined;
  const dispatcher = config.storageMode === "cloud" && config.taskStateMachineArn ? new StepFunctionsTaskDispatcher(config.taskStateMachineArn) : undefined;
  const tokenVerifier = config.authMode === "cognito" ? createCognitoAccessTokenVerifier({ issuer: config.cognitoIssuer!, clientId: config.cognitoAudience! }) : undefined;
  return { machines, originals, tenants, authMode: config.authMode, storageMode: config.storageMode, tasks, dispatcher, tokenVerifier };
}
