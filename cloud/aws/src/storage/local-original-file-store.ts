import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OriginalFileStore } from "./contracts";

export class LocalOriginalFileStore implements OriginalFileStore {
  constructor(private readonly directory: string) {}

  async saveOriginal(input: { tenantId: string; content: string; contentType: string; extension: string; sha256: string }): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.tenantId)) throw new Error("Invalid tenant identifier");
    await mkdir(this.directory, { recursive: true });
    const filename = `${input.sha256}.${input.extension}`;
    const tenantDirectory = join(this.directory, "tenants", input.tenantId, "imports");
    await mkdir(tenantDirectory, { recursive: true });
    await writeFile(join(tenantDirectory, filename), input.content, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return `local://tenants/${input.tenantId}/imports/${filename}`;
  }
}
