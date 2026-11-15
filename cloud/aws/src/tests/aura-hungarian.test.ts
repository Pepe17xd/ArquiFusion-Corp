import { test } from "node:test";
import { strict as assert } from "node:assert";
import { solveHungarianAssignment } from "../aura/hungarian-assignment";

test("Hungarian solver returns a known global optimum for a square matrix", () => {
  const result = solveHungarianAssignment([
    [0.4, 0.1, 0.3],
    [0.2, 0.0, 0.5],
    [0.3, 0.2, 0.2],
  ]);
  assert.deepEqual(result.matches.map((match) => match.technicianIndex), [1, 0, 2]);
  assert.ok(Math.abs(result.totalCost - 0.5) < 1e-9);
});

test("rectangular matrices keep technicians unique and leave excess incidents unassigned", () => {
  const result = solveHungarianAssignment([
    [0.1, 0.8],
    [0.2, 0.3],
    [0.4, 0.1],
  ], 0.7);
  assert.deepEqual(result.matches.map((match) => match.technicianIndex), [0, null, 1]);
  assert.ok(Math.abs(result.totalCost - 0.9) < 1e-9);
  assert.equal(new Set(result.matches.flatMap((match) => match.technicianIndex === null ? [] : [match.technicianIndex])).size, 2);
});

test("hard incompatibilities and empty candidate sets return safe unassigned rows", () => {
  assert.deepEqual(solveHungarianAssignment([[null, null], [null, null]]).matches.map((match) => match.technicianIndex), [null, null]);
  assert.deepEqual(solveHungarianAssignment([[], []]).matches.map((match) => match.technicianIndex), [null, null]);
  assert.deepEqual(solveHungarianAssignment([]), { matches: [], totalCost: 0 });
});

test("global optimization beats row-order greedy on a known counterexample", () => {
  const costs = [
    [0.1, 0.2],
    [0.11, 0.9],
  ];
  const result = solveHungarianAssignment(costs, 1);
  const greedy = greedyByIncidentOrder(costs);
  assert.deepEqual(result.matches.map((match) => match.technicianIndex), [1, 0]);
  assert.ok(result.totalCost < greedy);
  assert.equal(result.totalCost, 0.31);
});

test("solver rejects ragged and non-normalized matrices", () => {
  assert.throws(() => solveHungarianAssignment([[0.2], [0.3, 0.4]]), /rectangular/);
  assert.throws(() => solveHungarianAssignment([[1.1]]), /normalized/);
  assert.throws(() => solveHungarianAssignment([[Number.NaN]]), /normalized/);
  assert.throws(() => solveHungarianAssignment([[0.1]], -0.1), /unmatchedCost/);
});

function greedyByIncidentOrder(costs: number[][]): number {
  const occupied = new Set<number>();
  let total = 0;
  for (const row of costs) {
    const candidate = row.map((cost, index) => ({ cost, index })).filter(({ index }) => !occupied.has(index)).sort((a, b) => a.cost - b.cost)[0];
    if (!candidate) continue;
    occupied.add(candidate.index);
    total += candidate.cost;
  }
  return total;
}
