/**
 * Deterministic minimum-cost one-to-one matching for incident rows and technician columns.
 * Costs must be normalized to [0, 1]; null is a hard incompatibility. Each incident
 * receives its own dummy column, so unassigned rows are always feasible and technicians
 * are never assigned to more than one incident in the same optimization.
 */
export interface AssignmentMatch {
  incidentIndex: number;
  technicianIndex: number | null;
  cost: number;
}

export interface AssignmentResult {
  matches: AssignmentMatch[];
  totalCost: number;
}

const FORBIDDEN_COST = 1_000_000;
const TIE_BREAK_EPSILON = 1e-12;

export function solveHungarianAssignment(
  costs: ReadonlyArray<ReadonlyArray<number | null>>,
  unmatchedCost = 0.75,
): AssignmentResult {
  if (!Number.isFinite(unmatchedCost) || unmatchedCost < 0 || unmatchedCost > 1) {
    throw new RangeError("unmatchedCost must be a normalized number from 0 to 1");
  }
  if (costs.length === 0) return { matches: [], totalCost: 0 };

  const technicianCount = costs[0]?.length ?? 0;
  for (const row of costs) {
    if (row.length !== technicianCount) throw new TypeError("cost matrix must be rectangular");
    for (const cost of row) {
      if (cost !== null && (!Number.isFinite(cost) || cost < 0 || cost > 1)) {
        throw new RangeError("eligible assignment costs must be normalized numbers from 0 to 1");
      }
    }
  }

  const incidentCount = costs.length;
  const columnCount = technicianCount + incidentCount;
  const matrix = costs.map((row) => [
    ...row.map((cost) => cost === null ? FORBIDDEN_COST : cost + TIE_BREAK_EPSILON),
    ...Array<number>(incidentCount).fill(unmatchedCost),
  ]);
  const columnForRow = hungarian(matrix);

  const matches = columnForRow.map((column, incidentIndex): AssignmentMatch => {
    const cost = costs[incidentIndex][column];
    if (column < technicianCount && cost !== null && cost < unmatchedCost) {
      return { incidentIndex, technicianIndex: column, cost };
    }
    return { incidentIndex, technicianIndex: null, cost: unmatchedCost };
  });
  return { matches, totalCost: matches.reduce((sum, match) => sum + match.cost, 0) };

  function hungarian(matrixValues: number[][]): number[] {
    const rowCount = matrixValues.length;
    const u = Array<number>(rowCount + 1).fill(0);
    const v = Array<number>(columnCount + 1).fill(0);
    const p = Array<number>(columnCount + 1).fill(0);
    const way = Array<number>(columnCount + 1).fill(0);

    for (let row = 1; row <= rowCount; row += 1) {
      p[0] = row;
      let column0 = 0;
      const minValue = Array<number>(columnCount + 1).fill(Number.POSITIVE_INFINITY);
      const used = Array<boolean>(columnCount + 1).fill(false);
      do {
        used[column0] = true;
        const row0 = p[column0];
        let delta = Number.POSITIVE_INFINITY;
        let column1 = 0;
        for (let column = 1; column <= columnCount; column += 1) {
          if (used[column]) continue;
          const reduced = matrixValues[row0 - 1][column - 1] - u[row0] - v[column];
          if (reduced < minValue[column]) {
            minValue[column] = reduced;
            way[column] = column0;
          }
          if (minValue[column] < delta) {
            delta = minValue[column];
            column1 = column;
          }
        }
        for (let column = 0; column <= columnCount; column += 1) {
          if (used[column]) {
            u[p[column]] += delta;
            v[column] -= delta;
          } else {
            minValue[column] -= delta;
          }
        }
        column0 = column1;
      } while (p[column0] !== 0);

      do {
        const column1 = way[column0];
        p[column0] = p[column1];
        column0 = column1;
      } while (column0 !== 0);
    }

    const columnByRow = Array<number>(rowCount).fill(-1);
    for (let column = 1; column <= columnCount; column += 1) {
      if (p[column] !== 0) columnByRow[p[column] - 1] = column - 1;
    }
    return columnByRow;
  }
}
