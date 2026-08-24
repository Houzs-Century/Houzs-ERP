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

/* ----------------------------------------------------------------------------
   RE-RESOLVING AN ALREADY-RECORDED PARENTLESS ROW.

   Owner 2026-08-24: 「我的 GR PO 所有文件都要有 Send Now 的 button」and 「点击
   Send Now 的话，如果它之前上面的 documentation 没有进去，它就要补调进去」.

   The two exports above fixed the CREATE path, so documents raised from now on
   name their parent. They do nothing for the documents already recorded — eight
   of them on production, each carrying "there is no earlier document to carry
   across" and, because a parentless row is not requeueable, no button to press.
   The claim on those rows is false: their lines name a parent, the create just
   did not look.

   So Send-again re-asks the question against the DOCUMENT instead of replaying
   the stored answer. Same resolver as the create path — one definition of "has
   a parent", not a second one that can disagree with it.
   -------------------------------------------------------------------------- */

/** The conversions whose parent can be re-read from the child's own lines. */
const RERESOLVE: Record<string, { parents: (sb: Sb, id: string) => Promise<string[]>; table: 'purchase_orders' | 'grns' }> = {
  po_to_gr: { parents: sourcePoIdsForGrn, table: 'purchase_orders' },
  gr_to_pi: { parents: sourceGrnIdsForPi, table: 'grns' },
};

export type ReresolvedParent = { table: 'purchase_orders' | 'grns'; ids: string[] };

/**
 * The parent this document actually has, read fresh from its lines — or null
 * when the op has no line-level resolver or the document really is parentless.
 *
 * `null` is the honest answer in both cases and the caller reports the second
 * one as the refusal it always was; what it must NOT do is keep answering
 * "parentless" for a document that can be read to have a parent.
 */
export async function reresolveConvertSource(
  sb: Sb,
  op: string,
  docId: string | null | undefined,
): Promise<ReresolvedParent | null> {
  const spec = RERESOLVE[op];
  if (!spec || !docId) return null;
  const ids = await spec.parents(sb, String(docId));
  return ids.length ? { table: spec.table, ids } : null;
}
