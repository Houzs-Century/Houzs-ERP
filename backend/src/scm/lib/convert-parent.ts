/* ----------------------------------------------------------------------------
   convert-parent — does this document actually have a parent to transfer from?

   WHY THIS FILE EXISTS. POST /grns and POST /purchase-invoices recorded EVERY
   document they created as parentless, including the ones the desktop
   conversion screens produce — which is the normal way both are raised, since
   the pickers navigate to the New form and the New form posts to these routes.
   A parentless row never reaches AutoCount and is deliberately not requeueable,
   so the operator got no Send-again button either. See docs/bugs/0524.

   THE PARENT IS READ FROM THE LINES, never from a header hint. `purchaseOrderId`
   on the request body is a field the form may or may not carry; the line link is
   what `readConvertSourceKeys` will name when the conversion is composed. Asking
   the same question the conversion answers is what stops the two disagreeing
   about whether a document has a parent — which is the disagreement that put
   "Goods received from a purchase order" next to "There is no earlier document
   to carry across" on the same row.

   Both return [] rather than throwing on a read failure: a receipt that cannot
   prove a parent is recorded parentless, which is the honest, narrower answer.
   -------------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client; `sb` is
   `any` throughout the SCM routes, no exported client type. */
type Sb = any;

async function parentIds(
  sb: Sb,
  childTable: string, childFk: string, childId: string, linkCol: string,
  parentTable: string, parentCol: string,
): Promise<string[]> {
  const { data: lines, error } = await sb.from(childTable).select(linkCol).eq(childFk, childId);
  if (error || !lines) return [];
  const ids = [...new Set((lines as Array<Record<string, string | null>>)
    .map((l) => l[linkCol]).filter((v): v is string => !!v))];
  if (!ids.length) return [];
  const { data: rows, error: e2 } = await sb.from(parentTable).select(parentCol).in('id', ids);
  if (e2 || !rows) return [];
  return [...new Set((rows as Array<Record<string, string | null>>)
    .map((r) => r[parentCol]).filter((v): v is string => !!v))];
}

/** The purchase orders a receipt's lines came from, or [] when none did. */
export const sourcePoIdsForGrn = (sb: Sb, grnId: string): Promise<string[]> =>
  parentIds(sb, 'grn_items', 'grn_id', grnId, 'purchase_order_item_id',
    'purchase_order_items', 'purchase_order_id');

/** The goods-received notes a purchase invoice's lines billed, or [] when none. */
export const sourceGrnIdsForPi = (sb: Sb, piId: string): Promise<string[]> =>
  parentIds(sb, 'purchase_invoice_items', 'purchase_invoice_id', piId, 'grn_item_id',
    'grn_items', 'grn_id');
