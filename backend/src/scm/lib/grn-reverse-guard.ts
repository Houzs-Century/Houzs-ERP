/* company-scope-file: this module WRITES NOTHING. Its one read is a balance
   lookup pinned to the warehouse the caller resolved under its own company
   predicate, and its answer is a refusal or null — no row is returned and none
   is written, so there is nothing here for a company predicate to protect. */
import { computeVariantKey, isServiceLine, type VariantAttrs } from '../shared';
import { pgrestIn } from './pgrest-in-list';

/* ── Downstream-consumption guard (bug #2) ─────────────────────────────────
   Moved out of grns.ts on 2026-09-07, when the migrated-document guard pushed
   that file past its size ceiling. A MOVE, not a rewrite — the body is
   unchanged. Same reasoning as grn-cancel-reversal.ts, extracted from the same
   file for the same gate (docs/modules/grn.md 7b).

   Reversing a GRN receipt (whole-cancel or line-delete) writes an inventory OUT
   per line. The FIFO trigger (migration 0053) ALLOWS negative stock, so if the
   received goods were ALREADY consumed downstream (shipped on a DO / drawn into
   production), that reversing OUT eats some OTHER lot's FIFO batch → negative
   stock + wrong COGS. grnHasDownstream only catches PI/PR draws, NOT physical
   consumption.

   This guard checks, per (warehouse, product, variant) bucket, whether the
   CURRENT on-hand (inventory_balances) still covers the qty we're about to
   reverse out. If on-hand < what we'd reverse, the received stock is (at least
   partly) already gone downstream — BLOCK the cancel/delete.

   IT CANNOT SEE A MIGRATED DOCUMENT, AND CALLERS MUST NOT TREAT IT AS IF IT
   COULD. It asks whether the units are on hand. Behind a `migrated_no_stock`
   receipt (migration 0276) they ARE — put there by the AutoCount balance
   snapshot rather than by this document — so it PASSES and the phantom OUT is
   written with every guard reporting satisfied. That is how a cancel that
   removes 879 units it never received read as safe for a month. Callers skip
   this guard for those documents entirely, because with no IN to reverse
   "already consumed" names a cause that does not exist. See
   lib/migrated-no-stock.ts and docs/bugs/0675-*.md.

   `lines` carry each reversing line's accepted qty + variant; warehouseId is the
   GRN's receive-into warehouse (same one the OUT would target). Returns the
   blocking JSON, or null when every bucket still has enough on-hand to reverse
   safely. Best-effort read: if the balance query errors we DON'T block (the
   primary lock semantics in grnHasDownstream still apply). */
export async function grnReverseWouldGoNegative(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unchanged from grns.ts: the PostgREST-shaped client has no honest type until schema.pg.ts covers the SCM tables.
  sb: any,
  warehouseId: string | null,
  /* qty_accepted NULLABLE, and qty below likewise: both are read straight off a
     PostgREST `any` client whose columns accept NULL, and the `?? 0` guards are
     the only thing standing between a null and a wrong verdict. Typing them
     `number` because a caller's hand-written cast says so is what makes the
     linter call those guards redundant. Same reasoning as GrnCancelLine. */
  lines: Array<{ qty_accepted: number | null; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }>,
): Promise<{ error: string; message: string } | null> {
  if (!warehouseId) return null;
  // Sum the qty we'd reverse OUT per (item_code, variant_key) bucket.
  const needByBucket = new Map<string, { item_code: string; variant_key: string; need: number }>();
  for (const l of lines) {
    /* SERVICE lines never entered inventory, so they cannot be reversed out of
       it. The POST path skips them and this guard did not, which made a
       landed-cost GRN impossible to cancel: a freight line produces no IN, so
       onHand 0 < need 1 and the cancel returned 409 grn_consumed_downstream,
       naming a cause that does not exist. It also blocked the warehouse relocate
       and the line's own deletion. Counting it as stock is a live hazard too:
       the movement build would write an OUT for a non-stock SKU. */
    if (isServiceLine({ itemGroup: l.item_group ?? null, itemCode: l.item_code })) continue;
    const qty = Number(l.qty_accepted ?? 0);
    if (qty <= 0) continue;
    const variant_key = computeVariantKey(l.item_group, l.variants ?? null);
    const k = `${l.item_code}::${variant_key}`;
    const cur = needByBucket.get(k) ?? { item_code: l.item_code, variant_key, need: 0 };
    cur.need += qty;
    needByBucket.set(k, cur);
  }
  if (needByBucket.size === 0) return null;

  const itemCodes = [...new Set([...needByBucket.values()].map((b) => b.item_code))];
  const { data: balRows, error } = await pgrestIn(sb
    .from('inventory_balances')
    .select('item_code, variant_key, qty')
    .eq('warehouse_id', warehouseId), 'item_code', itemCodes);
  if (error) return null; // best-effort: don't block on a balance read failure
  const onHand = new Map<string, number>();
  for (const r of (balRows ?? []) as Array<{ item_code: string; variant_key: string | null; qty: number | null }>) {
    onHand.set(`${r.item_code}::${r.variant_key ?? ''}`, Number(r.qty ?? 0));
  }
  for (const [k, b] of needByBucket) {
    const have = onHand.get(k) ?? 0;
    if (have < b.need) {
      return {
        error: 'grn_consumed_downstream',
        message: 'Received goods were already consumed downstream (shipped / used in production) — cannot reverse this GRN. Make a Purchase Return instead.',
      };
    }
  }
  return null;
}
