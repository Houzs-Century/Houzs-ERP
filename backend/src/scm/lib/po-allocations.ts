// ----------------------------------------------------------------------------
// PO line allocations — the PURE half of the write path (mig 0235).
//
// One PO line can serve several customers plus stock (a consolidated purchase:
// 2990-PO-2606-023's qty-5 MAKOTO line = SO-036 x1 + SO-029 x1 + 3 stock), so
// scm.purchase_order_item_allocations splits a line into 1-based sub-numbered
// slices. These helpers hold the rules the routes enforce, kept free of Hono /
// Supabase so the unit suite exercises them directly; the DB triggers in mig
// 0235 are the concurrency backstop for the same invariant.
//
//   * qty is a positive integer, and SUM(allocations.qty) <= line qty — an
//     allocation attributes real purchased units, it cannot invent them.
//   * seq is dense 1..n per line: created at count+1, resequenced on delete so
//     the printable sub-number (PO-2606-001-01, -02, ...) never gaps.
// ----------------------------------------------------------------------------

export type AllocationRow = { id: string; seq: number; qty: number; so_item_id: string | null };

export type AllocationRefusal = {
  error: 'invalid_qty' | 'allocation_exceeds_line_qty' | 'allocation_not_found';
  message: string;
  /* The numbers behind an exceeds refusal, so the UI can say exactly how much
     room the line has left instead of making the operator count. */
  lineQty?: number;
  allocatedQty?: number;
  remainingQty?: number;
};

const badQty = (qty: unknown): AllocationRefusal | null => {
  const q = Number(qty);
  if (!Number.isInteger(q) || q <= 0) {
    return { error: 'invalid_qty', message: 'Allocation qty must be a whole number of at least 1.' };
  }
  return null;
};

const exceeds = (lineQty: number, otherSum: number, qty: number): AllocationRefusal | null => {
  if (otherSum + qty > lineQty) {
    return {
      error: 'allocation_exceeds_line_qty',
      message: `This line orders ${lineQty}; ${otherSum} of that is already allocated, so at most ${Math.max(0, lineQty - otherSum)} more can be.`,
      lineQty,
      allocatedQty: otherSum,
      remainingQty: Math.max(0, lineQty - otherSum),
    };
  }
  return null;
};

/** Validate a CREATE against the line's qty and the existing allocations.
    Returns the refusal to 400/409 with, or the dense seq to insert at. */
export function planAllocationCreate(
  lineQty: number,
  existing: ReadonlyArray<Pick<AllocationRow, 'qty'>>,
  qty: unknown,
): { refusal: AllocationRefusal } | { refusal: null; qty: number; seq: number } {
  const invalid = badQty(qty);
  if (invalid) return { refusal: invalid };
  const q = Number(qty);
  const otherSum = existing.reduce((s, a) => s + Number(a.qty ?? 0), 0);
  const over = exceeds(Number(lineQty ?? 0), otherSum, q);
  if (over) return { refusal: over };
  return { refusal: null, qty: q, seq: existing.length + 1 };
}

/** Validate a qty UPDATE on one allocation (partial PATCH: undefined = keep).
    The cap excludes the row being updated. */
export function planAllocationQtyUpdate(
  lineQty: number,
  existing: ReadonlyArray<Pick<AllocationRow, 'id' | 'qty'>>,
  allocationId: string,
  qty: unknown,
): { refusal: AllocationRefusal } | { refusal: null; qty: number } {
  const self = existing.find((a) => a.id === allocationId);
  if (!self) {
    return { refusal: { error: 'allocation_not_found', message: 'That allocation no longer exists on this line.' } };
  }
  if (qty === undefined) return { refusal: null, qty: Number(self.qty ?? 0) };
  const invalid = badQty(qty);
  if (invalid) return { refusal: invalid };
  const q = Number(qty);
  const otherSum = existing
    .filter((a) => a.id !== allocationId)
    .reduce((s, a) => s + Number(a.qty ?? 0), 0);
  const over = exceeds(Number(lineQty ?? 0), otherSum, q);
  if (over) return { refusal: over };
  return { refusal: null, qty: q };
}

/** After deleting one allocation, the survivors' dense 1..n seqs in stored-seq
    order. Only rows whose seq actually changes are returned (ascending, so the
    UNIQUE (item, seq) constraint can never collide mid-resequence: each update
    moves a row DOWN into a slot the delete or the previous update just freed). */
export function resequenceAfterDelete(
  existing: ReadonlyArray<Pick<AllocationRow, 'id' | 'seq'>>,
  deletedId: string,
): Array<{ id: string; seq: number }> {
  const survivors = existing
    .filter((a) => a.id !== deletedId)
    .sort((a, b) => a.seq - b.seq);
  const moves: Array<{ id: string; seq: number }> = [];
  survivors.forEach((a, i) => {
    const want = i + 1;
    if (a.seq !== want) moves.push({ id: a.id, seq: want });
  });
  return moves;
}

/** The printable sub-number for one allocation: PO-2606-001 + seq 2 ->
    "PO-2606-001-02". Two digits covers any real split (a line qty is small);
    a seq past 99 simply prints wider rather than lying. */
export const allocationSubNumber = (poNumber: string | null | undefined, seq: number): string =>
  `${poNumber ?? ''}-${String(seq).padStart(2, '0')}`;

/** The un-allocated remainder of a line, as a STOCK release plan.
 *
 *  Used when a supplier CANNOT follow an SO revision (the follow-up PO
 *  amendment is rejected): the goods will arrive as originally ordered, so
 *  whatever the line has not already sliced out is re-pointed to STOCK — the
 *  owner's rule, 2026-08-06: a spec mismatch is a FACT, not a decision ("他就
 *  变了"). Returns null when the line is already fully allocated (nothing left
 *  to release — existing slices are somebody's deliberate split and are not
 *  touched). */
export function planStockRelease(
  lineQty: number,
  existing: AllocationRow[],
): { seq: number; qty: number } | null {
  const allocated = existing.reduce((s, a) => s + Number(a.qty ?? 0), 0);
  const remaining = Math.max(0, Number(lineQty ?? 0) - allocated);
  if (remaining <= 0) return null;
  return { seq: existing.length + 1, qty: remaining };
}
