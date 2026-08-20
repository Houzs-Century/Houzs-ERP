/* company-scope-file: this module WRITES NOTHING. It maps GRN lines to the
   reversing OUT rows the caller hands to `writeMovements`, and that helper
   stamps company_id on every row it inserts. There is no statement here to
   carry a predicate. */

/* Extracted from grns.ts on 2026-08-20, when PATCH /:id/cancel moved into the
   PG command transaction. The file-size ratchet charges GROWTH on grns.ts, and
   the gate's own message names moving new code into a module as one of the two
   ways out — the same move ac-grn-outbox.ts made a day earlier for the same
   reason (docs/modules/grn.md 7b). The mapping below is a MOVE, not a rewrite:
   the two rules it encodes are the reason it is worth naming.

   Deliberately NOT shared with the line-DELETE reversal further down grns.ts.
   That one builds a single row for one line and does NOT filter service lines,
   so folding the two together would silently change its behaviour. Unifying
   them is a separate decision with its own evidence. */
import { computeVariantKey, isServiceLine, type VariantAttrs } from '../shared';

/** The GRN line columns the reversal reads. */
export type GrnCancelLine = {
  purchase_order_item_id: string | null;
  /* Nullable on purpose: this is read straight off scm.grn_items, whose column
     accepts NULL, and the `?? 0` guards below are the only thing standing
     between a null qty and a movement row. Typing it `number` because the
     caller's cast says so is what makes the linter call those guards
     redundant. */
  qty_accepted: number | null;
  item_code: string;
  material_name: string | null;
  item_group?: string | null;
  variants?: VariantAttrs | null;
};

/** Every field here DECIDES a column on the movement row, so none is optional. */
export type GrnCancelReversalContext = {
  warehouseId: string;
  grnId: string;
  grnNumber: string;
  performedBy: string;
};

/**
 * The reversing OUT rows for a cancelled GRN — one per stock-bearing line.
 *
 * Two rules, both bought by real bugs:
 *
 * 1. SERVICE LINES ARE EXCLUDED. Mirrors the POST filter. Without it the cancel
 *    writes an OUT for a freight line that never had an IN, which is a
 *    permanent negative on-hand for a non-stock SKU.
 * 2. EACH LINE REVERSES ITS OWN DYE LOT (migration 0120). The original IN
 *    stamped batch_no = source PO number so a sofa set's components share a
 *    lot, and the reversing OUT must consume that EXACT batch. `batchByItem` is
 *    resolved per purchase_order_item_id — deterministic per line, so two lines
 *    of the same product/variant from different POs each reverse their own lot
 *    instead of a per-bucket collapse that kept only the last batch. Manual
 *    lines (no PO link) stay un-batched, so they fall back to plain FIFO.
 */
export function buildGrnCancelReversals(
  lines: readonly GrnCancelLine[],
  /** purchase_order_item_id -> source PO number. `resolvePoBatchByItem`. */
  batchByItem: ReadonlyMap<string, string>,
  ctx: GrnCancelReversalContext,
) {
  return lines
    .filter((it) => !isServiceLine({ itemGroup: it.item_group ?? null, itemCode: it.item_code }))
    .filter((it) => (it.qty_accepted ?? 0) > 0)
    .map((it) => {
      const variant_key = computeVariantKey(it.item_group, it.variants ?? null);
      const batch_no = it.purchase_order_item_id ? (batchByItem.get(it.purchase_order_item_id) ?? null) : null;
      return {
        movement_type: 'OUT' as const,
        warehouse_id: ctx.warehouseId,
        item_code: it.item_code,
        variant_key,
        product_name: it.material_name,
        qty: it.qty_accepted ?? 0,
        source_doc_type: 'GRN' as const,
        source_doc_id: ctx.grnId,
        source_doc_no: ctx.grnNumber,
        performed_by: ctx.performedBy,
        // Only carry batch_no when the IN had one (omit -> non-batched lines stay plain FIFO).
        ...(batch_no != null ? { batch_no } : {}),
        notes: 'GRN cancelled — reversing receipt',
      };
    });
}
