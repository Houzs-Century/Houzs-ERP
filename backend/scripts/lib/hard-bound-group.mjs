// Which purchase / sales lines are HARD-BOUND, for the scripts that cannot import
// TypeScript under plain node.
//
// A MIRROR of `HARD_BOUND_GROUPS` + `isHardBoundLine` in
// src/scm/lib/so-stock-allocation.ts, and nothing more. The referee is
// tests/hardBoundGroupMirror.test.ts, which runs both over the same inputs, so the
// day the engine adds a group the test goes red until this list follows.
//
// Why it exists: the MRP link repair (repair-mrp-po-line-links.mjs) carried its own
// SQL copy that still read `in ('sofa','bedframe')` after the Sofa Accessory
// category (`fabric_accessory`) joined the rule on 2026-09-14, so its plan could
// never see a pillow line hidden from its order. Its `(SP)` test was also written
// in a tagged template where `\(` and `\s` lose their backslash, so it matched no
// mattress at all.

export const HARD_BOUND_GROUPS = Object.freeze(['bedframe', 'sofa', 'fabric_accessory']);

const SP_SUFFIX = /\(SP\)\s*$/i;

/** Same answer as `isHardBoundLine(itemGroup, itemCode)`. */
export function isHardBound(itemGroup, itemCode) {
  const g = String(itemGroup ?? '').toLowerCase();
  if (HARD_BOUND_GROUPS.includes(g)) return true;
  return g === 'mattress' && SP_SUFFIX.test(String(itemCode ?? ''));
}

/**
 * CLASS B of the MRP link repair: a purchase line linked to a hard-bound sales line
 * whose own group is not hard-bound. Takes the linked rows the plan query read and
 * returns the plan. Guarded on `received_qty = 0`: the group feeds the stock key, so
 * a line with goods already received under the old group is left for a human.
 */
export function planCategoryRepairs(rows) {
  return rows
    .filter((r) => isHardBound(r.so_group, r.item_code) && !isHardBound(r.po_group, r.item_code))
    .map((r) => {
      const received = Number(r.received_qty ?? 0);
      return {
        poItemId: r.po_item_id, poNumber: r.po_number, poStatus: r.po_status,
        itemCode: r.item_code, fromGroup: r.po_group, toGroup: r.so_group,
        soDocNo: r.so_doc_no, soLineNo: r.so_line_no, qty: r.qty, receivedQty: r.received_qty,
        verdict: received === 0 ? 'REPAIR' : 'SKIP',
        reason: received === 0 ? null
          : `${r.received_qty} unit(s) already received under item_group "${r.po_group}" — changing the group would move the receipt's variant bucket; needs a human`,
      };
    });
}
