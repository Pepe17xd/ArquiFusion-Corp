import { test } from "node:test";
import { strict as assert } from "node:assert";
import { headerScrollDecision } from "./header-scroll.ts";

test("scroll direction requires a cumulative threshold and shows the header at the top", () => {
  assert.deepEqual(headerScrollDecision(100, 108, false), { anchor: 100, hidden: null });
  assert.deepEqual(headerScrollDecision(100, 112, false), { anchor: 112, hidden: true });
  assert.deepEqual(headerScrollDecision(112, 99, false), { anchor: 99, hidden: false });
  assert.deepEqual(headerScrollDecision(100, 20, false), { anchor: 20, hidden: false });
});

test("an open menu or keyboard focus keeps the header visible", () => {
  assert.deepEqual(headerScrollDecision(100, 500, true), { anchor: 500, hidden: false });
  assert.deepEqual(headerScrollDecision(500, 507, false), { anchor: 500, hidden: null });
});
