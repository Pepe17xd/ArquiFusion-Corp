import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OriginalFileStore } from "./contracts";

export class LocalOriginalFileStore implements OriginalFileStore {
  constructor(private readonly directory: string) {}

  async saveOriginal(input: { content: string; contentType: string; extension: string; sha256: string }): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const filename = `${input.sha256}.${input.extension}`;
    await writeFile(join(this.directory, filename), input.content, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return `local://imports/${filename}`;
  }
}
