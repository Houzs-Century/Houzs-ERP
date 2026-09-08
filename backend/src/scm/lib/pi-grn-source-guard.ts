/* The purchase invoice's SOURCE-LINE guard: company, quantity, and — new here
 * — IDENTITY.
 *
 * WHY IT IS A MODULE. It was thirty lines inline in `POST /purchase-invoices`,
 * which is where its siblings are NOT: `checkSiOverRemaining`
 * (lib/do-line-remaining.ts) and `qtyCapRefusal` (lib/qty-cap.ts) are the same
 * shape for the sales-invoice and add-line paths and both live in lib. Moving
 * it here is what let the identity assertion be added without growing
 * `purchase-invoices.ts` — the file-size gate charges GROWTH, and its own
 * message names this as the way to pay: "move the new code into its own
 * module".
 *
 * WHAT IT ASSERTS, in the order a wrong answer is loudest:
 *
 *   1  COMPANY — the parent GRN rides the embed, because these grn_item ids
 *      come from the REQUEST BODY and the downstream writes
 *      (`recomputeGrnInvoiced`, `recostForPi`) land on whoever owns them while
 *      the invoice is stamped with the active company.
 *   2  IDENTITY — docs/bugs/0672 site 15. The rows are already in hand, so
 *      comparing the product costs nothing. Without it a line for product B
 *      could name a receipt line for product A: valid foreign key, nothing
 *      dangling, no constraint broken, and `recomputeGrnInvoiced` then draws
 *      down the WRONG receipt line's remaining, leaving the right one open to
 *      be invoiced a second time. probe-link-identity.mjs run 34172468269
 *      counted 3 such rows live on `purchase_invoice_items.grn_item_id`.
 *   3  QUANTITY — the invoice may not exceed accepted − invoiced − returned.
 *
 * Identity is asserted BEFORE quantity on purpose: a cap computed against the
 * wrong line is a number about the wrong thing, and reporting it would send the
 * operator to fix a quantity when the real fault is the source they picked.
 */
import { crossCompanyConversionBlocked, isCrossCompanySource, type CompanyScopeCtx } from './companyScope';
import { lineLinkItemMismatch } from './line-link-item-identity';

type GiRow = {
  id: string; qty_accepted: number; invoiced_qty: number; returned_qty: number;
  item_code: string | null;
  grn?: { grn_number?: string | null; company_id?: number | null } | Array<{ grn_number?: string | null; company_id?: number | null }> | null;
};

export type PiGrnRefusal = { body: Record<string, unknown>; status: 400 | 409 | 500 | 503 };

export async function piGrnSourceRefusal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  c: CompanyScopeCtx,
  wantByGrnItem: Map<string, number>,
  items: Array<Record<string, unknown>>,
): Promise<PiGrnRefusal | null> {
  const gids = [...wantByGrnItem.keys()];
  if (gids.length === 0) return null;

  const { data: giRows, error } = await sb.from('grn_items')
    .select('id, qty_accepted, invoiced_qty, returned_qty, item_code, grn:grns!inner ( grn_number, company_id )')
    .in('id', gids);
  /* A failed read is not "no problems found". Every assertion below is taken
     over these rows, so an unreadable source means NONE of them ran — and "we
     could not check" must never be spelled the same way as "we checked and it
     was fine". Same stance as remainingUnavailableResponse. */
  if (error) {
    return { body: { error: 'source_check_failed', reason: `grn_items: ${error.message}` }, status: 503 };
  }
  const giList = (giRows ?? []) as unknown as GiRow[];
  const parentOf = (g: GiRow) => (Array.isArray(g.grn) ? g.grn[0] : g.grn) ?? null;

  // isCrossCompanySource is false for a null company_id, so a hit is never null.
  const foreign = giList.map(parentOf).find((p) => isCrossCompanySource(p?.company_id, c));
  if (foreign) {
    return { body: crossCompanyConversionBlocked(foreign.grn_number ?? null, foreign.company_id, c) as unknown as Record<string, unknown>, status: 409 };
  }

  const byId = new Map<string, GiRow>(giList.map((g) => [g.id, g]));

  const mismatch = lineLinkItemMismatch(
    items.filter((it) => it.grnItemId).map((it) => ({ linkId: it.grnItemId as string, itemCode: it.itemCode })),
    new Map([...byId].map(([id, g]) => [id, g.item_code])),
    { source: 'Goods Receipt line' },
  );
  if (mismatch) return { body: mismatch as unknown as Record<string, unknown>, status: 409 };

  const over: Array<{ grnItemId: string; requested: number; remaining: number }> = [];
  for (const [gid, want] of wantByGrnItem.entries()) {
    const g = byId.get(gid);
    if (!g) {
      return {
        body: { error: 'item_not_found', grnItemId: gid, message: 'A line on this invoice points at a receipt line that is no longer there. Reopen the Goods Receipt and raise the invoice from it again.' },
        status: 400,
      };
    }
    const remaining = (g.qty_accepted ?? 0) - (g.invoiced_qty ?? 0) - (g.returned_qty ?? 0);
    if (want > remaining) over.push({ grnItemId: gid, requested: want, remaining });
  }
  if (over.length > 0) return { body: { error: 'qty_exceeds_remaining', lines: over }, status: 409 };
  return null;
}
