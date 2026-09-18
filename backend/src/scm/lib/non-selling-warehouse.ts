// ----------------------------------------------------------------------------
// non-selling-warehouse — "what a warehouse HOLDS" and "what may be PROMISED to
// a customer" are two different numbers, and this module is the second one.
//
// WHY THIS EXISTS. The 2026-09-08 cutover brought the book's showroom stock in
// exactly as AutoCount holds it, with no marking of any kind, because the owner
// refused one: 「你换不一样就代表我们的数据从 autocount 搬过来的就不一样了啊」 — a
// flag on a migrated row IS a change to the data. Complete data, our rules on
// top. So the rule has to live HERE, in the rule layer, and it reads an axis the
// warehouse master already carries.
//
// WHAT IT DECIDES. A showroom piece is standing on the floor doing its job; a
// unit in a SERVICE warehouse is physically away at the supplier being repaired.
// Neither may be promised to a customer, and until 2026-09-08 the allocator
// asked no question at all about the warehouse it was drawing from
// (docs/bugs/0682). Measured that day, read-only run 34177208009: 9 non-selling
// warehouses in company 1 holding 1,897 units, 1,642 of them in the pooled class
// that allocates on on-hand alone — and 0 sales-order lines pointing at any of
// them, which is why the rule was cheap to add on that date and gets more
// expensive every day after it.
//
// THE AXIS IS NOT NEW AND IS NOT EMPTY. `scm.warehouses.type` (mig 0177, enum
// warehouse | showroom | display | service | others) already drives the
// dead-stock report — the owner ruled on exactly this axis once before, on
// 2026-08-05: 「我的 dead stock 里面怎么会有 dead stock 呢？因为它明明是 showroom
// 的 display 啊」. All 9 warehouses carry a correct type (measured, same run), so
// a rule reading it bites on every one of them and nothing needs backfilling.
//
// `is_showroom` is NOT this axis and must never be substituted for it: it is
// true on only 2 of the 9 because it drives the project VENUE picker.
//
// SELLING THE PIECE IS STILL POSSIBLE — through a stock transfer
// (/scm/stock-transfers/new, and its mobile twin), which is how SAP, Odoo and
// NetSuite all model it. The refusal is not a wall; it is a route.
// ----------------------------------------------------------------------------

/** The three `scm.warehouses.type` values whose stock may not be promised. The
 *  ONE definition — routes/inventory.ts's dead-stock exclusion reads it too, so
 *  the two can never drift into disagreeing about what a showroom is. */
export const NON_SELLING_WAREHOUSE_TYPES: ReadonlySet<string> = new Set([
  'showroom',
  'display',
  'service',
]);

export function isNonSellingWarehouseType(type: string | null | undefined): boolean {
  return NON_SELLING_WAREHOUSE_TYPES.has(String(type ?? '').toLowerCase());
}

export type NonSellingWarehouse = {
  id: string;
  code: string | null;
  name: string | null;
  type: string | null;
};

/**
 * Every warehouse whose stock may not be promised, keyed by id.
 *
 * NOT company-scoped, deliberately: warehouse ids are UUIDs and the allocator
 * this feeds sweeps every company in one pass, so a scoped read would hand it a
 * set that is right for one company and silently permissive for the next.
 *
 * THROWS on a read failure, and that is the only safe direction. A rule that
 * cannot load its own inputs must stop the recompute (the caller's wrapper
 * catches, reports `ok:false` and queues a retry) rather than run with the gate
 * silently off — the half-applied shape this repo has shipped before.
 */
export async function loadNonSellingWarehouses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
): Promise<Map<string, NonSellingWarehouse>> {
  const { data, error } = await sb.from('warehouses').select('id, code, name, type');
  if (error) throw new Error(`non-selling warehouse load failed: ${error.message}`);
  const out = new Map<string, NonSellingWarehouse>();
  for (const w of (data ?? []) as Array<Record<string, unknown>>) {
    const type = (w.type ?? null) as string | null;
    if (!isNonSellingWarehouseType(type)) continue;
    const id = String(w.id ?? '');
    if (!id) continue;
    out.set(id, {
      id,
      code: (w.code ?? null) as string | null,
      name: (w.name ?? null) as string | null,
      type,
    });
  }
  return out;
}

/**
 * May a line bound to `warehouseId` be promised goods from it?
 *
 * `nonSelling` is REQUIRED and non-nullable on purpose (CLAUDE.md, "a parameter
 * that DECIDES something"). There is no `null` escape hatch and no default,
 * because both available defaults are wrong: permissive re-opens the hole, and
 * strict would flip every line in the system to PENDING the first time the
 * warehouse read hiccups. A caller that cannot load the set must not call this
 * — it must fail, which is what `loadNonSellingWarehouses` throwing arranges.
 */
export function warehouseCanPromise(
  warehouseId: string | null,
  nonSelling: ReadonlySet<string>,
): boolean {
  if (warehouseId === null) return true;
  return !nonSelling.has(warehouseId);
}

/** What the operator is told, naming the warehouse and the way out. Shared by
 *  the desktop pill and its mobile twin so the two cannot word it differently.
 *  A refusal nobody can read is the "the button does nothing" defect
 *  (vendor/scm/lib/mutation-error.ts) wearing a different hat. */
export function nonSellingWarehouseNotice(w: {
  code: string | null;
  name: string | null;
  type: string | null;
}): string {
  const where = w.code ?? w.name ?? 'This warehouse';
  const kind = (w.type ?? '').toLowerCase() === 'service'
    ? 'a service warehouse (goods are away at the supplier)'
    : `a ${(w.type ?? 'display').toLowerCase()} warehouse`;
  return `${where} is ${kind}, so its stock is never promised to a customer. `
    + 'To sell this piece, raise a stock transfer into a selling warehouse first.';
}
