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
  webOrigin?: string;
}

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const storageMode = env.STORAGE_MODE ?? "local";
  const authMode = env.AUTH_MODE ?? (storageMode === "local" ? "local" : "cognito");
  if (storageMode !== "local" && storageMode !== "cloud") {
    throw new ConfigurationError("STORAGE_MODE must be local or cloud");
  }
  if (storageMode === "cloud" && (!env.MACHINES_TABLE || !env.UPLOADS_BUCKET || !env.TENANTS_TABLE || !env.TASKS_TABLE || !env.TASK_STATE_MACHINE_ARN)) throw new ConfigurationError("MACHINES_TABLE, TENANTS_TABLE, TASKS_TABLE, UPLOADS_BUCKET and TASK_STATE_MACHINE_ARN are required in cloud mode");
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
    taskStateMachineArn: env.TASK_STATE_MACHINE_ARN,
    cognitoIssuer: env.COGNITO_ISSUER,
    cognitoAudience: env.COGNITO_AUDIENCE,
    webOrigin: env.WEB_ORIGIN ?? "http://localhost:5173",
  };
}
