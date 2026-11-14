import { loadConfig } from "../core/config";
import type { MachineRepository, OriginalFileStore } from "./contracts";
import { LocalMachineRepository } from "./local-machine-repository";
import { DynamoMachineRepository } from "./dynamo-machine-repository";
import { LocalOriginalFileStore } from "./local-original-file-store";
import { S3OriginalFileStore } from "./s3-original-file-store";

export function createStorage() {
  const config = loadConfig();
  const machines: MachineRepository = config.storageMode === "cloud"
    ? new DynamoMachineRepository(config.machinesTable!)
    : new LocalMachineRepository(config.localDataFile);
  const originals: OriginalFileStore = config.storageMode === "cloud"
    ? new S3OriginalFileStore(config.uploadsBucket!)
    : new LocalOriginalFileStore(config.localUploadsDir);
  return { machines, originals };
}
