import { resolve } from "node:path";
import { ConfigurationError } from "./errors";

export interface AppConfig {
  storageMode: "local" | "cloud";
  authMode: "local" | "cognito";
  localDataFile: string;
  localUploadsDir: string;
  machinesTable?: string;
  uploadsBucket?: string;
  awsRegion?: string;
  tenantsTable?: string;
  tasksTable?: string;
  taskStateMachineArn?: string;
  cognitoIssuer?: string;
  cognitoAudience?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const storageMode = env.STORAGE_MODE ?? "local";
  const authMode = env.AUTH_MODE ?? (storageMode === "local" ? "local" : "cognito");
  if (storageMode !== "local" && storageMode !== "cloud") {
    throw new ConfigurationError("STORAGE_MODE must be local or cloud");
  }
  if (storageMode === "cloud" && (!env.MACHINES_TABLE || !env.UPLOADS_BUCKET || !env.TENANTS_TABLE || !env.TASKS_TABLE)) {
    throw new ConfigurationError("MACHINES_TABLE, TENANTS_TABLE, TASKS_TABLE and UPLOADS_BUCKET are required in cloud mode");
  }
  if (authMode !== "local" && authMode !== "cognito") throw new ConfigurationError("AUTH_MODE must be local or cognito");
  if (storageMode === "cloud" && authMode !== "cognito") throw new ConfigurationError("Cloud mode requires AUTH_MODE=cognito");
  if (authMode === "cognito" && (!env.TENANTS_TABLE || !env.COGNITO_ISSUER || !env.COGNITO_AUDIENCE)) {
    throw new ConfigurationError("TENANTS_TABLE, COGNITO_ISSUER and COGNITO_AUDIENCE are required for Cognito authentication");
  }
  return {
    storageMode,
    authMode,
    localDataFile: resolve(env.LOCAL_DATA_FILE ?? resolve(__dirname, "../../data/machines.json")),
    localUploadsDir: resolve(env.LOCAL_UPLOADS_DIR ?? resolve(__dirname, "../../data/uploads")),
    machinesTable: env.MACHINES_TABLE,
    uploadsBucket: env.UPLOADS_BUCKET,
    awsRegion: env.AWS_REGION,
    tenantsTable: env.TENANTS_TABLE,
    tasksTable: env.TASKS_TABLE,
    taskStateMachineArn: env.TASK_STATE_MACHINE_ARN,
    cognitoIssuer: env.COGNITO_ISSUER,
    cognitoAudience: env.COGNITO_AUDIENCE,
  };
}
