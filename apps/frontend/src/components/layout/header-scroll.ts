export const SCROLL_THRESHOLD = 12;

export function headerScrollDecision(anchor: number, position: number, locked: boolean): { anchor: number; hidden: boolean | null } {
  const y = Math.max(0, position);
  if (locked || y <= 24) return { anchor: y, hidden: false };
  const delta = y - anchor;
  if (Math.abs(delta) < SCROLL_THRESHOLD) return { anchor, hidden: null };
  return { anchor: y, hidden: delta > 0 };
}
