/* Generic header field-level lock (owner 2026-08-20, §8 GAP-1). The purchase side
 * grew this per-doc (po-identity-lock.ts, grn-inherited-lock.ts); this is the
 * shared core the sales-side siblings (DO, Consignment Note, PCO) reuse so the
 * rule cannot drift five ways. A downstream child (SI/DR, Consignment Return, PC
 * Receive) snapshots the parent's identity/value columns, so those freeze once a
 * live child exists; the parent's OWN-stage columns (dates, dispatch, notes) stay
 * editable. Pure — no I/O; the route pairs it with the doc's `*HasDownstream`. */

/** Loose equality: null / undefined / '' all collapse, so a form re-sending an
    unchanged blank does not read as a change. */
export const normLock = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The inherited columns this patch genuinely changes. `updates` is the
    snake-keyed, already-normalised column map the route is about to write; `[]`
    means only own-stage columns moved, which then save even with a live child. */
export function changedLockedCols(
  lockCols: ReadonlySet<string>,
  updates: Record<string, unknown>,
  before: Record<string, unknown>,
): string[] {
  return [...lockCols].filter(
    (col) => col in updates && normLock(updates[col]) !== normLock(before[col]),
  );
}

/** A 409 body naming the frozen fields and the cancel-to-source remedy. */
export function identityLockedRefusal(opts: {
  error: string;
  fields: string[];
  labels: Record<string, string>;
  /** The parent noun, e.g. "Delivery Order". */
  what: string;
  /** The child noun, e.g. "Sales Invoice or Delivery Return". */
  child: string;
  /** What stays editable, e.g. "delivery dates, dispatch details and notes". */
  ownFields: string;
}) {
  const names = opts.fields.map((f) => opts.labels[f] ?? f);
  return {
    error: opts.error,
    message:
      `The ${names.join(', ')} on this ${opts.what} is already reflected in a ${opts.child}, so it `
      + `cannot be changed here. Cancel the downstream document first, then edit the ${opts.what}. `
      + `Its ${opts.ownFields} are still editable.`,
    fields: opts.fields,
  };
}
