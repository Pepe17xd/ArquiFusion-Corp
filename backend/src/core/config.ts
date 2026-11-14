import { resolve } from "node:path";
import { ConfigurationError } from "./errors";

export interface AppConfig {
  storageMode: "local" | "cloud";
  localDataFile: string;
  localUploadsDir: string;
  machinesTable?: string;
  uploadsBucket?: string;
  awsRegion?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const storageMode = env.STORAGE_MODE ?? "local";
  if (storageMode !== "local" && storageMode !== "cloud") {
    throw new ConfigurationError("STORAGE_MODE must be local or cloud");
  }
  if (storageMode === "cloud" && (!env.MACHINES_TABLE || !env.UPLOADS_BUCKET)) {
    throw new ConfigurationError("MACHINES_TABLE and UPLOADS_BUCKET are required in cloud mode");
  }
  return {
    storageMode,
    localDataFile: resolve(env.LOCAL_DATA_FILE ?? resolve(__dirname, "../../data/machines.json")),
    localUploadsDir: resolve(env.LOCAL_UPLOADS_DIR ?? resolve(__dirname, "../../data/uploads")),
    machinesTable: env.MACHINES_TABLE,
    uploadsBucket: env.UPLOADS_BUCKET,
    awsRegion: env.AWS_REGION,
  };
}
