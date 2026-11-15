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
  operationsTable?: string;
  operationsStateMachineArn?: string;
  auraTable?: string;
  auraStateMachineArn?: string;
  taskStateMachineArn?: string;
  cognitoIssuer?: string;
  cognitoAudience?: string;
  webOrigin?: string;
}

export type RuntimeDomain = "all" | "platform" | "fleet" | "ingestion" | "intelligence" | "supervisor" | "operations" | "aura";

function isCognitoIssuer(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash
      && /^cognito-idp\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/i.test(url.hostname)
      && /^\/[a-z0-9-]+_[A-Za-z0-9]+$/.test(url.pathname);
  } catch { return false; }
}

function isSecureOrigin(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value && url.pathname === "/" && !url.search && !url.hash; }
  catch { return false; }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, domain: RuntimeDomain = "all"): AppConfig {
  const storageMode = env.STORAGE_MODE ?? "local";
  const authMode = env.AUTH_MODE ?? (storageMode === "local" ? "local" : "cognito");
  if (storageMode !== "local" && storageMode !== "cloud") {
    throw new ConfigurationError("STORAGE_MODE must be local or cloud");
  }
  const requiredCloudValues: Partial<Record<RuntimeDomain, string[]>> = {
    all: ["MACHINES_TABLE", "UPLOADS_BUCKET", "TENANTS_TABLE", "TASKS_TABLE", "TASK_STATE_MACHINE_ARN"],
    platform: ["TENANTS_TABLE"], fleet: ["MACHINES_TABLE", "TENANTS_TABLE"],
    ingestion: ["MACHINES_TABLE", "TENANTS_TABLE", "UPLOADS_BUCKET"],
    intelligence: ["MACHINES_TABLE", "TENANTS_TABLE"],
    supervisor: ["MACHINES_TABLE", "TENANTS_TABLE", "TASKS_TABLE", "TASK_STATE_MACHINE_ARN"],
    operations: ["MACHINES_TABLE", "TENANTS_TABLE", "OPERATIONS_TABLE", "OPERATIONS_STATE_MACHINE_ARN"],
    aura: ["MACHINES_TABLE", "TENANTS_TABLE", "OPERATIONS_TABLE", "AURA_TABLE", "AURA_STATE_MACHINE_ARN"],
  };
  if (storageMode === "cloud") {
    const missing = (requiredCloudValues[domain] ?? requiredCloudValues.all!).filter((key) => !env[key]);
    if (missing.length) throw new ConfigurationError(`Missing cloud configuration for ${domain}: ${missing.join(", ")}`);
  }
  if (authMode !== "local" && authMode !== "cognito") throw new ConfigurationError("AUTH_MODE must be local or cognito");
  if (storageMode === "cloud" && authMode !== "cognito") throw new ConfigurationError("Cloud mode requires AUTH_MODE=cognito");
  if (storageMode === "local" && authMode !== "local") throw new ConfigurationError("Local mode requires AUTH_MODE=local and never contacts Cognito");
  if (authMode === "cognito" && (!env.TENANTS_TABLE || !env.COGNITO_ISSUER || !env.COGNITO_AUDIENCE)) {
    throw new ConfigurationError("TENANTS_TABLE, COGNITO_ISSUER and COGNITO_AUDIENCE are required for Cognito authentication");
  }
  if (authMode === "cognito" && !isCognitoIssuer(env.COGNITO_ISSUER!)) throw new ConfigurationError("COGNITO_ISSUER must be the HTTPS issuer URL of an Amazon Cognito User Pool");
  if (storageMode === "cloud" && (!env.WEB_ORIGIN || !isSecureOrigin(env.WEB_ORIGIN))) {
    throw new ConfigurationError("WEB_ORIGIN must be one explicit HTTPS origin in cloud mode");
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
    operationsTable: env.OPERATIONS_TABLE,
    operationsStateMachineArn: env.OPERATIONS_STATE_MACHINE_ARN,
    auraTable: env.AURA_TABLE,
    auraStateMachineArn: env.AURA_STATE_MACHINE_ARN,
    taskStateMachineArn: env.TASK_STATE_MACHINE_ARN,
    cognitoIssuer: env.COGNITO_ISSUER,
    cognitoAudience: env.COGNITO_AUDIENCE,
    webOrigin: env.WEB_ORIGIN ?? "http://localhost:5173",
  };
}
