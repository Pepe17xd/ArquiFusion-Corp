import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./design-system.css", import.meta.url), "utf8");

test("industrial design tokens define the agreed dark graphite and red palette", () => {
  for (const token of ["--color-bg: #0b0b0d", "--color-surface: #151517", "--color-surface-elevated: #202023", "--color-primary: #e5242d", "--color-primary-hover: #c91f28", "--color-text: #f7f7f5", "--color-text-muted: #a3a3a8", "--color-border: #333338"]) {
    assert.ok(css.includes(token), `missing design token ${token}`);
  }
});

test("shared controls and responsive accessibility rules are part of the design system", () => {
  assert.match(css, /\.module-form-grid\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(css, /\.module-form-grid\s*\{[^}]*grid-template-columns: 1fr/s);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /:focus-visible/);
});
