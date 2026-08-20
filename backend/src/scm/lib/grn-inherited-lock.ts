/* GRN inherited-field lock (owner 2026-08-20: "PO 开成 GR 就不可以在 GR 里改
 * variant — 要 cancel GR 再去 PO 改"). A GRN line LINKED to a PO line inherits its
 * identity + spec from that PO — item, category and VARIANT are what the supplier
 * was told to make — so they are READ-ONLY on the receipt. Only the line's own
 * receipt data (qty / cost / batch / delivery) is editable. To change an inherited
 * field, cancel the GRN (reverses the stock) and edit the PO, then receive again.
 * A MANUAL (unlinked) line is ad-hoc and keeps editing its own spec.
 *
 * Variant equality is compared on the rendered SUMMARY, not raw JSON, so a
 * re-serialised-but-unchanged payload (key order, a recomputed totalHeight) never
 * false-trips; only a real spec change is flagged. Pure — the route passes the
 * summary builder in so this stays free of the shared-module import graph. */

export type GrnLinePrev = {
  purchase_order_item_id: string | null;
  item_code: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
};

export type GrnLinePatch = {
  itemCode?: unknown;
  itemGroup?: unknown;
  variants?: unknown;
};

/** The inherited fields this patch genuinely changes on a PO-linked GRN line —
 *  [] when the line is manual, or only own-stage fields (qty/cost/…) move. */
export function grnInheritedFieldChanges(
  prev: GrnLinePrev,
  patch: GrnLinePatch,
  variantSummary: (group: string, variants: Record<string, unknown> | null) => string,
): string[] {
  if (!prev.purchase_order_item_id) return [];
  const storedCode = String(prev.item_code ?? '').trim().toUpperCase();
  const storedGroup = prev.item_group ?? null;
  const storedVariants = prev.variants ?? null;
  const nextGroup = patch.itemGroup !== undefined ? (patch.itemGroup as string | null) : storedGroup;
  const nextVariants = patch.variants !== undefined ? (patch.variants as Record<string, unknown> | null) : storedVariants;

  const changed: string[] = [];
  if (patch.itemCode !== undefined && String(patch.itemCode ?? '').trim().toUpperCase() !== storedCode) changed.push('product');
  if (String(nextGroup ?? '') !== String(storedGroup ?? '')) changed.push('category');
  if (variantSummary(String(nextGroup ?? ''), nextVariants) !== variantSummary(String(storedGroup ?? ''), storedVariants)) {
    changed.push('product options (variant)');
  }
  return changed;
}

/** The 409 body naming the locked fields and the cancel-to-source remedy. */
export function grnInheritedLockedRefusal(changed: string[]) {
  return {
    error: 'grn_inherited_field_locked',
    message:
      `The ${[...new Set(changed)].join(', ')} on this line comes from its Purchase Order, so it `
      + 'cannot be changed on the goods receipt. To change it, cancel this GRN (that reverses the '
      + 'received stock) and edit the PO, then receive it again.',
  };
}

/* ── GRN HEADER inherited-field lock (owner 2026-08-20, §8 GAP-1) ─────────────
 * The GRN header PATCH had NO downstream lock at all: a GRN that already has a
 * Purchase Invoice / Purchase Return could have its supplier or its costing basis
 * changed, silently diverging from the PI that was billed / costed against it.
 * These four columns ARE the PI's basis — the party billed and the numbers the
 * invoice + landed-cost recost run on — so they freeze once a live PI/PR exists.
 * The GRN's OWN-stage fields (received date, delivery-note ref, notes) and its
 * warehouse (which carries its own stock-relocation handling) stay editable.
 * Keyed by DB column name; the norm() collapses null/undefined/'' like the PO
 * lock so a form re-sending an unchanged blank does not read as a change. */
export const GRN_HEADER_INHERITED_COLS: ReadonlySet<string> = new Set<string>([
  'supplier_id', 'currency', 'exchange_rate', 'allocation_method',
]);

const normLock = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The inherited header columns this PATCH genuinely changes — [] when it only
    touches own-stage fields (received date / notes / warehouse), which then save
    even with a live PI/PR. Reads the camel-keyed request `body` against the
    snake-keyed `before` row via the route's own camel->snake audit-field map, so
    the route needs no mapping loop of its own. */
export function grnHeaderInheritedChanges(
  body: Record<string, unknown>,
  before: Record<string, unknown>,
  auditFields: ReadonlyArray<readonly [string, string]>,
): string[] {
  const changed: string[] = [];
  for (const [camel, snake] of auditFields) {
    if (!GRN_HEADER_INHERITED_COLS.has(snake) || body[camel] === undefined) continue;
    if (normLock(body[camel]) !== normLock(before[snake])) changed.push(snake);
  }
  return changed;
}

/** The 409 body when a header PATCH moves an inherited field on a GRN that
    already has a Purchase Invoice / Purchase Return. */
export function grnHeaderInheritedRefusal(cols: string[]) {
  const label: Record<string, string> = {
    supplier_id: 'supplier', currency: 'currency',
    exchange_rate: 'exchange rate', allocation_method: 'cost allocation method',
  };
  return {
    error: 'grn_header_inherited_locked',
    message:
      `The ${cols.map((c) => label[c] ?? c).join(', ')} on this GRN is already reflected in a `
      + 'Purchase Invoice or Purchase Return, so it cannot be changed here. Cancel the downstream '
      + 'invoice/return first, then edit the GRN. Its received date, notes and warehouse are still editable.',
    fields: cols,
  };
}
