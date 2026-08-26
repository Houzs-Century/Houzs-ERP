// ----------------------------------------------------------------------------
// so-state-warehouse-rebind — when a Sales Order's State changes, which lines
// MOVE to the new warehouse and which lines BLOCK the change?
//
// THE GATE THIS NARROWS (owner 2026-07-22, "supplier 就会发错货给我"): a State
// change used to 409 whenever ANY non-cancelled line was already bound to a
// different warehouse, because a downstream PO/DO cut against the old
// warehouse would keep shipping there while the header said otherwise. That
// blanket rule was fine while lines were only ever bound by an address —
// binding and address arrived together, so the conflict was rare and always
// meant a real downstream doc.
//
// THE OPERATOR-STORE DEFAULT BREAKS THAT ASSUMPTION (owner 2026-08-25). A POS
// walk-in order is now born bound to the operator's own store (see the create
// core in routes/mfg-sales-orders.ts), and its address arrives LATER — on
// basically every delivered order, since the delivery-date gate requires the
// address. No state maps to a showroom, so under the blanket rule every one
// of those orders would 409 the moment the address was filled, and the
// operator would be told to cancel downstream documents that do not exist.
//
// SO THE RULE IS NOW THE GATE'S OWN STATED REASON, applied literally: a line
// ANCHORED by a live downstream document (a non-cancelled PO line raised from
// it, or a non-cancelled DO line shipping it) still blocks the change — moving
// it would strand the supplier/driver on the old warehouse. A line with NO
// live downstream doc moves with its order, exactly like a NULL-warehouse
// line always has. All-or-nothing: one anchored line blocks the whole change
// (nothing moves), so the operator never sees a half-moved order.
//
// The anchor lookup FAILS CLOSED: if the downstream read errors, every moved
// line counts as anchored and the change 409s — the pre-narrowing behaviour.
// Moving stock because a check could not run is the exact misdelivery the
// owner's ruling exists to prevent.
// ----------------------------------------------------------------------------

export type StateRebindLine = {
  /** mfg_sales_order_items.id */
  id: string;
  itemCode: string;
  /** The line's CURRENT warehouse (null = unbound; the CAS rebinds those
   *  unconditionally, they are never a conflict). */
  warehouseId: string | null;
  /** TRUE when a live downstream doc (non-cancelled PO or DO line) targets
   *  this line's current warehouse — see loadSoLineDownstreamAnchors. */
  anchored: boolean;
};

export type StateRebindPlan = {
  /** Anchored lines that block the State change — 409 with these named. */
  offenders: Array<{ id: string; itemCode: string; currentWarehouseId: string }>;
  /** Line ids the header CAS should move to the new warehouse IN the same
   *  transaction (p_rebind_line_ids). Empty whenever offenders is non-empty:
   *  a blocked change moves nothing. */
  rebindLineIds: string[];
};

export function planStateWarehouseRebind(
  reboundWarehouseId: string | null,
  lines: StateRebindLine[],
): StateRebindPlan {
  if (!reboundWarehouseId) return { offenders: [], rebindLineIds: [] };
  const moved = lines.filter(
    (l) => l.warehouseId != null && l.warehouseId !== reboundWarehouseId,
  );
  const offenders = moved
    .filter((l) => l.anchored)
    .map((l) => ({ id: l.id, itemCode: l.itemCode, currentWarehouseId: l.warehouseId as string }));
  if (offenders.length > 0) return { offenders, rebindLineIds: [] };
  return { offenders: [], rebindLineIds: moved.map((l) => l.id) };
}

/** The whole gate for one document: load the mismatched lines, look up their
 *  downstream anchors, and return the plan. The MISMATCH read failing is
 *  fail-OPEN on purpose (log + empty plan): that is byte-for-byte the
 *  pre-narrowing behaviour (`const { data: mismatchRows }` discarded its
 *  error, so an unreadable check silently skipped the gate), and the CAS only
 *  ever moves NULL lines plus the ids returned here, so the worst case is "no
 *  extra move and no gate" — exactly the old worst case. The ANCHOR read
 *  failing stays fail-CLOSED inside loadSoLineDownstreamAnchors (null →
 *  caller marks everything anchored). */
export async function planStateRebindForDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase client this SCM tree passes around
  sb: any,
  docNo: string,
  reboundWarehouseId: string,
): Promise<StateRebindPlan> {
  const { data: mismatchRows, error } = await sb
    .from('mfg_sales_order_items')
    .select('id, item_code, warehouse_id')
    .eq('doc_no', docNo)
    .eq('cancelled', false)
    .not('warehouse_id', 'is', null)
    .neq('warehouse_id', reboundWarehouseId);
  if (error) {
    /* eslint-disable-next-line no-console */
    console.error('[so-state-rebind] mismatch read failed — gate skipped, only NULL lines rebind:', error.message ?? error);
    return { offenders: [], rebindLineIds: [] };
  }
  const conflicts = (mismatchRows ?? []) as Array<{ id: string; item_code: string; warehouse_id: string }>;
  if (conflicts.length === 0) return { offenders: [], rebindLineIds: [] };
  const anchors = await loadSoLineDownstreamAnchors(sb, conflicts.map((r) => r.id));
  return planStateWarehouseRebind(reboundWarehouseId, conflicts.map((r) => ({
    id: r.id,
    itemCode: r.item_code,
    warehouseId: r.warehouse_id,
    anchored: anchors === null ? true : anchors.has(r.id),
  })));
}

/** The 409 payload for a blocked State change — shape unchanged from the
 *  2026-07-22 gate so the frontend's handling keeps working. */
export function stateChangeConflictBody(
  reboundWarehouseId: string,
  offenders: StateRebindPlan['offenders'],
): Record<string, unknown> {
  return {
    error: 'state_change_conflicts_line_warehouse',
    reason:
      'One or more lines are already bound to a different warehouse AND have a live PO / DO cut against it. ' +
      'Changing the State would leave that downstream doc targeting the old warehouse — supplier could ship to the wrong place. ' +
      'Cancel the affected downstream doc, or move each line to the new warehouse explicitly, then retry.',
    newWarehouseId: reboundWarehouseId,
    offenders: offenders.map((r) => ({ itemCode: r.itemCode, currentWarehouseId: r.currentWarehouseId })),
  };
}

/** Which of `lineIds` are anchored by a LIVE downstream document?
 *
 *  Live = the parent doc is not CANCELLED. DRAFT POs count as live on purpose
 *  — so-po-lock.ts already rules a draft PO a live claim on its SO line, and
 *  a draft raised against the old warehouse becomes a wrong-warehouse PO the
 *  moment it is sent.
 *
 *  Returns null when EITHER read fails — the caller must treat that as
 *  "everything is anchored" (fail closed, see the header). */
export async function loadSoLineDownstreamAnchors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase client this SCM tree passes around
  sb: any,
  lineIds: string[],
): Promise<Set<string> | null> {
  const ids = [...new Set(lineIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const anchored = new Set<string>();

  const { data: poRows, error: poErr } = await sb
    .from('purchase_order_items')
    .select('so_item_id, po:purchase_orders!inner(status)')
    .in('so_item_id', ids)
    .not('po.status', 'in', '("CANCELLED")');
  if (poErr) return null;
  for (const r of (poRows ?? []) as Array<{ so_item_id: string | null }>) {
    if (r.so_item_id) anchored.add(r.so_item_id);
  }

  const { data: doRows, error: doErr } = await sb
    .from('delivery_order_items')
    .select('so_item_id, d:delivery_orders!inner(status)')
    .in('so_item_id', ids)
    .not('d.status', 'in', '("CANCELLED")');
  if (doErr) return null;
  for (const r of (doRows ?? []) as Array<{ so_item_id: string | null }>) {
    if (r.so_item_id) anchored.add(r.so_item_id);
  }

  return anchored;
}
