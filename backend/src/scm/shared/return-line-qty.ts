export function parseReturnLineQty(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const q = Number(raw);
  return Number.isFinite(q) && q > 0 ? q : null;
}

/** The message shown when a line's quantity is not valid. */
export function returnLineQtyMessage(itemCode: string | null | undefined, raw: unknown): string {
  const shown = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '') ? 'blank' : String(raw);
  return `Return quantity must be more than 0 on every line (${itemCode || 'a line'} is ${shown}).`;
}
