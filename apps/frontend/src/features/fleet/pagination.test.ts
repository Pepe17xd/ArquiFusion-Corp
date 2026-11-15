import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { paginate } from "./pagination.ts";

test("pagination uses the filtered records and clamps page boundaries", () => {
  const filtered = Array.from({ length: 23 }, (_, i) => i + 1).filter(n => n % 2 === 1);
  assert.deepEqual(paginate(filtered, 2, 5), { items: [11, 13, 15, 17, 19], page: 2, pages: 3, total: 12 });
  assert.deepEqual(paginate(filtered, 9, 10), { items: [21, 23], page: 2, pages: 2, total: 12 });
  assert.deepEqual(paginate([], 3, 20), { items: [], page: 1, pages: 1, total: 0 });
});

test("critical pagination and operational module copy is valid UTF-8", () => {
  const readUtf8 = (path: string) => new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(new URL(path, import.meta.url)));
  const fleet = readUtf8("./FleetView.tsx");
  assert.match(fleet, /Paginación del cliente ·/u);
  assert.match(fleet, /· página \{page\.page\} de \{page\.pages\}/u);
  assert.match(fleet, /Registros por página/u);
  assert.match(fleet, /Buscar por ID, modelo o ubicación/u);
  const planned = readUtf8("../planned/PlannedView.tsx");
  const app = readUtf8("../../App.tsx");
  assert.match(planned, /Asignación de técnicos/u);
  assert.match(planned, /Se incorporarán controles/u);
  assert.match(app, /OperationalModule/u);
});
