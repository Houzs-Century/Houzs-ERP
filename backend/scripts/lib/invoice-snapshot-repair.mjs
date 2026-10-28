// ---------------------------------------------------------------------------
// Which side of an invoice/parent item-code disagreement is the STALE one.
//
// THE SHAPE. A migrated invoice line is a SNAPSHOT. create-migrated-invoices.mjs
// copies `item_code` (and the name, desc2, variants and money) straight off the
// parent row it was raised from — `l._row.item_code` at :305 for a purchase
// invoice and :345 for a sales invoice. So a migrated invoice line has NO
// independent authority over its own item code: if it disagrees with its
// parent, the invoice is quoting a parent that has since changed.
//
// AND ONE DID CHANGE. apply-sofa-compartment-corrections.mjs rewrites a sofa
// line that reached the ERP as a bare `-1S` placeholder into the owner-approved
// compartments, and its own comment says why the chain must follow: "All three
// took a SNAPSHOT of the code and variants when they were created ... so
// correcting the parent alone would leave them stating the old build." It then
// carries the new code onto purchase_order_items, grn_items and
// delivery_order_items — and NOT onto the two invoice tables, which took the
// same snapshot from the same rows. That omission is the defect; this module is
// the retro half, and the carry itself is fixed at the site.
//
// WHY THIS IS A DECISION MODULE AND NOT A QUERY. The repair rewrites the item
// code printed on a POSTED document. It is only allowed when it is FORCED —
// when no other reading of the row is available — and every case that is not
// forced has to come out with a REASON rather than a guess. That is the split
// scripts/lib/do-so-link-repair.mjs already uses, and the reason both are pure:
// the rule is unit-testable without a database.
//
// WHAT IT NEVER TOUCHES. Quantity, unit price, discount, line total, the link
// column itself. The money on an invoice line is the invoice's own and is
// untouched by any of this; the link is settled by the parent having exactly
// ONE line, which is a precondition below, not an assumption.
// ---------------------------------------------------------------------------
import { decomposeGroup } from './sofa-compartment-suffixes.mjs';
import { normItemCode } from './ac-po-line.mjs';

/**
 * @typedef {Object} InvoiceSnapshotRow
 * @property {string}  id                the invoice LINE id
 * @property {'SI'|'PI'} chain
 * @property {string}  invoiceNo
 * @property {boolean} invoiceMigrated   header `migrated_no_stock`
 * @property {string}  lineCode          the invoice line's item_code
 * @property {string}  parentCode        the linked DO / GRN line's item_code
 * @property {string}  parentDocNo
 * @property {number}  parentLineCount   lines on the parent DOCUMENT
 *
 * @param {InvoiceSnapshotRow[]} rows
 * @returns {{repair: Array<{id: string, chain: string, invoiceNo: string,
 *            parentDocNo: string, from: string, to: string, model: string}>,
 *           refused: Array<{id: string, invoiceNo: string, from: string,
 *            to: string, why: string}>}}
 */
export function planInvoiceSnapshotRepair(rows) {
  const repair = [];
  const refused = [];
  for (const r of rows ?? []) {
    const from = normItemCode(r.lineCode);
    const to = normItemCode(r.parentCode);
    const no = (why) => refused.push({ id: r.id, invoiceNo: r.invoiceNo, from, to, why });

    if (!from || !to) { no('one side carries no item code at all'); continue; }
    if (from === to) { no('the two sides already agree — not a candidate'); continue; }

    /* A typed invoice is somebody's statement about what was billed. Only a
       snapshot can be overwritten from its parent, because only a snapshot
       never had an opinion of its own. */
    if (r.invoiceMigrated !== true) {
      no('the invoice was not created as a snapshot of its parent — a person must decide which side is right');
      continue;
    }

    /* The link is only FORCED when the parent document has one line: there is
       then no other row it could have meant. With two or more, the link itself
       may be the error, and repairing the CODE would hide that. */
    if (r.parentLineCount !== 1) {
      no(`the parent ${r.parentDocNo} has ${r.parentLineCount} lines, so the LINK itself could be the error — escalate, do not repair the code`);
      continue;
    }

    /* decomposeGroup owns the compartment split rule. `ok` here means: both
       codes are {one model}-{a known compartment}, the model agrees, and the
       two compartments differ. A model disagreement is a wrong LINK, not a
       stale compartment, and must never be repaired by rewriting a code. */
    const d = decomposeGroup([from, to]);
    if (!d.ok) { no(`not one sofa's two compartments — ${d.why}`); continue; }

    repair.push({ id: r.id, chain: r.chain, invoiceNo: r.invoiceNo, parentDocNo: r.parentDocNo, from, to, model: d.model });
  }
  return { repair, refused };
}
