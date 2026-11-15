import { test } from "node:test";
import { strict as assert } from "node:assert";
import { moduleLoadState, moduleUnavailable } from "./module-state.ts";

test("operational module distinguishes loading, HTTP error, empty and populated results", () => {
  assert.equal(moduleLoadState({ loading: true, error: "", recordCount: 0 }), "loading");
  assert.equal(moduleLoadState({ loading: false, error: "HTTP 503", recordCount: 0 }), "error");
  assert.equal(moduleLoadState({ loading: false, error: "", recordCount: 0 }), "empty");
  assert.equal(moduleLoadState({ loading: false, error: "", recordCount: 3 }), "ready");
});

test("unavailable endpoint state is explicit only for missing API routes", () => {
  assert.equal(moduleUnavailable("HTTP 404"), true);
  assert.equal(moduleUnavailable("Access forbidden"), false);
  assert.equal(moduleUnavailable("HTTP 503"), false);
});
