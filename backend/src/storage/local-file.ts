import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Replace a local JSON file atomically, retrying transient Windows sharing violations. */
export async function atomicWriteFile(file: string, content: string, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, file); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !["EPERM", "EACCES", "EBUSY"].includes(code) || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
