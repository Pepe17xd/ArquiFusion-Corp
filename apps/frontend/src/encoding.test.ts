import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(frontendRoot, "..", "..");
const textExtensions = new Set([".css", ".html", ".json", ".md", ".ts", ".tsx"]);
const corruptMarkers = ["\u00c3", "\u00c2", "\u00e2\u20ac", "\ufffd"];

function textFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (["dist", "node_modules"].includes(entry.name)) return [];
      return textFiles(resolve(directory, entry.name));
    }
    return textExtensions.has(extname(entry.name).toLowerCase()) ? [resolve(directory, entry.name)] : [];
  });
}

test("frontend text assets and root README contain valid, readable UTF-8 text", () => {
  const files = [...textFiles(frontendRoot), resolve(repositoryRoot, "README.md")];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.ok(!corruptMarkers.some((marker) => text.includes(marker)), `${file} contains a common mojibake or invalid UTF-8 marker`);
  }

  const html = readFileSync(resolve(frontendRoot, "index.html"), "utf8");
  assert.match(html, /<meta\s+charset=["']UTF-8["']\s*\/?\s*>/i);
  const landing = readFileSync(resolve(frontendRoot, "src", "Landing.tsx"), "utf8");
  for (const word of ["Operación", "Atención", "Núcleo", "Automatización", "Análisis", "Decisiones"]) {
    assert.ok(landing.toLocaleLowerCase("es").includes(word.toLocaleLowerCase("es")), `Landing copy is missing ${word}`);
  }
});
