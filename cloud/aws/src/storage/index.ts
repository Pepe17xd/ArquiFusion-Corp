import { loadConfig, type AppConfig, type RuntimeDomain } from "../core/config";
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

export function createMachineRepository(config: AppConfig): MachineRepository {
  return config.storageMode === "cloud" ? new DynamoMachineRepository(config.machinesTable!) : new LocalMachineRepository(config.localDataFile);
}

export function createOriginalFileStore(config: AppConfig): OriginalFileStore {
  return config.storageMode === "cloud" ? new S3OriginalFileStore(config.uploadsBucket!) : new LocalOriginalFileStore(config.localUploadsDir);
}

export function createTenantDirectory(config: AppConfig) {
  return config.storageMode === "cloud" ? new DynamoTenantDirectory(config.tenantsTable!) : new LocalTenantDirectory(join(dirname(config.localDataFile), "tenants.json"));
}

export function createTaskStore(config: AppConfig) {
  return config.storageMode === "cloud" ? new DynamoTaskStore(config.tasksTable!) : undefined;
}

export function createTaskDispatcher(config: AppConfig) {
  return config.storageMode === "cloud" && config.taskStateMachineArn ? new StepFunctionsTaskDispatcher(config.taskStateMachineArn) : undefined;
}

export function createTokenVerifier(config: AppConfig) {
  return config.authMode === "cognito" ? createCognitoAccessTokenVerifier({ issuer: config.cognitoIssuer!, clientId: config.cognitoAudience! }) : undefined;
}

export function createStorage(domain: RuntimeDomain = "all") {
  const config = loadConfig(process.env, domain);
  const machines = createMachineRepository(config);
  const originals = createOriginalFileStore(config);
  const tenants = createTenantDirectory(config);
  const tasks = createTaskStore(config);
  const dispatcher = createTaskDispatcher(config);
  const tokenVerifier = createTokenVerifier(config);
  return { machines, originals, tenants, authMode: config.authMode, storageMode: config.storageMode, tasks, dispatcher, tokenVerifier };
}
