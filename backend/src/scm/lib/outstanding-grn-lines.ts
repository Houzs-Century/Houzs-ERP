// ----------------------------------------------------------------------------
// outstanding-grn-lines — the read behind GET /purchase-invoices/outstanding-grn-items,
// the "Bill a Goods-Received Note" picker.
//
// THE BUG THIS EXISTS FOR (2026-09-14). The handler read
//
//     grns  .eq('status','POSTED').eq('on_hold', false)
//           .order('received_at', { ascending: false }).limit(500)
//
// and only THEN kept the lines with qty_accepted - invoiced_qty - returned_qty
// > 0. The 500 was spent on every posted note, billed or not, so past 500 of
// them an older note that still had something to bill was simply not in the
// answer — not in the picker, not in its search, and nothing on the screen said
// so. The lines were then one unpaged `.in('grn_id', <up to 500 ids>)`: ~19.5KB
// of uuids, which is the size the gateway has refused before
// (lib/paginate-all.ts), and a response PostgREST's row ceiling can cut short in
// silence. `docs/bugs/0302` and `0778` are the same shape on the two sibling
// pickers: a cap above a later filter is a cap on the question, not the answer.
//
// WHAT IT DOES NOW. The note set is asked for by what makes a note billable,
// not by how new it is:
//
//   1. `scm.v_grn_outstanding` (mig 0267) — the ids of POSTED notes with at
//      least one line whose accepted - invoiced - returned is above zero. That
//      view is the same arithmetic the lines are filtered by below, and it is
//      what the Outstanding page's GRN tab already reads in production. PAGED,
//      and it SAYS whether it stopped at its ceiling.
//   2. those notes' headers, in URL-sized batches — status and the hold marker
//      re-checked on the row itself, company-scoped.
//   3. their lines, in URL-sized batches, each batch paged — company-scoped.
//   4. each line's OWN purchase order, through its purchase_order_item_id.
//
// THE PO IS PER LINE (staff, 2026-11-09: "convert GRN list all same PO
// number"). One goods receipt can take lines from several POs (the add-PO
// picker, `/from-po-items`), and `grns.purchase_order_id` names only the first.
// Labelling every line with the header PO showed HC-GRN-2611-052's lines all as
// HC-PO-2610-125 while the invoice line billed from it said HC-PO-2610-202. The
// header PO is used only for a line with no PO link at all (a manual line).
//
// Every query form here is one production already runs: `.eq` on a view column
// (routes/outstanding.ts), `.in` on a key, `.order().range()` windows. Nothing
// ships on a filter over an embedded path, which no test double here can prove.
//
// The cost scales with notes that still have something to bill, not with every
// note ever received.
// ----------------------------------------------------------------------------

import { chunkIn } from './paginate-all';
import { pageWithTruncation } from './outstanding-po-lines';
import { normalizeCurrency, normalizeExchangeRate } from './fx';

/** The note header the picker groups by. `supplier` and `purchase_order` are
 *  to-one embeds; supabase-js types them as arrays, which is why rows pass
 *  through `unknown` once, inside the reads below. */
type NoteRow = {
  id: string; grn_number: string; received_at: string; supplier_id: string;
  purchase_order_id: string | null;
  currency: string | null; exchange_rate: string | number | null;
  supplier: { code: string; name: string } | null;
  purchase_order: { po_number: string } | null;
};

/* Quantities are nullable in the TYPE on purpose: the value arrives through an
   untyped client, and a hand-written `number` would make the `?? 0` guards read
   as unnecessary conditions to the linter, which is the trap CLAUDE.md's lint
   section describes. The handler has always coalesced them. */
type LineRow = {
  id: string; grn_id: string; material_kind: string; item_code: string;
  material_name: string; item_group: string | null; description: string | null; supplier_sku: string | null;
  purchase_order_item_id: string | null;
  qty_accepted: number | null; qty_rejected: number | null;
  invoiced_qty: number | null; returned_qty: number | null;
  unit_price_sen: number; variants: unknown; created_at: string | null;
};

const NOTE_SELECT = `
      id, grn_number, received_at, supplier_id, purchase_order_id, currency, exchange_rate,
      supplier:suppliers ( code, name ),
      purchase_order:purchase_orders ( po_number )
    `;

const LINE_SELECT = `
      id, grn_id, material_kind, item_code, material_name, item_group,
      description, supplier_sku, purchase_order_item_id, qty_accepted, qty_rejected, invoiced_qty, returned_qty, unit_price_sen, variants, created_at
    `;

/** What is still to bill on one line. Kept here so the route, the tests and
 *  the view's own definition (mig 0267) are one arithmetic. */
export const remainingToBill = (r: {
  qty_accepted: number | null; invoiced_qty: number | null; returned_qty: number | null;
}): number => (r.qty_accepted ?? 0) - (r.invoiced_qty ?? 0) - (r.returned_qty ?? 0);

/** One picker line, as the frontend's `OutstandingGrnItem` reads it. */
export type OutstandingGrnItem = {
  grnItemId: string; grnId: string; grnDocNo: string; receivedAt: string;
  supplierId: string; supplierCode: string; supplierName: string;
  purchaseOrderId: string | null; poDocNo: string | null;
  itemCode: string; supplierSku: string | null; description: string; itemGroup: string;
  qtyAccepted: number | null; invoicedQty: number; remaining: number;
  unitPriceSen: number; variants: unknown;
  currency: string; exchangeRate: number;
};

/**
 * The whole read: outstanding notes, their headers, their lines, filtered and
 * shaped for the picker.
 *
 * `scopeQuery` is the CALLER's company predicate (`scopeToCompany(q, c)`),
 * handed in so this module has no `Context` and cannot be where a scope goes
 * missing. It is applied to all three reads. The SCM client is service-role and
 * bypasses RLS, so that predicate is the tenant boundary (CLAUDE.md). On the
 * lines it also matches the create path, which refuses a goods-receipt line
 * whose OWN company_id is not the active company's (`assertSourceLinesInCompany`
 * over `grn_items`) — so the picker offers nothing the create would refuse.
 *
 * `truncated` is true when the note-id read hit its ceiling
 * (`OUTSTANDING_MAX_PAGES` x `OUTSTANDING_PAGE` notes). That bounds a runaway,
 * not a business limit, and when it is reached the caller is TOLD.
 */
export async function loadOutstandingGrnLines(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase-js client this tree passes around
  sb: any;
  scopeQuery: <Q>(q: Q) => Q;
}): Promise<{ error: string } | { error: null; items: OutstandingGrnItem[]; truncated: boolean }> {
  const { sb, scopeQuery } = args;

  const ids = await pageWithTruncation<{ id: string }>((from, to) =>
    scopeQuery(sb.from('v_grn_outstanding').select('id').eq('status', 'POSTED').eq('is_outstanding', true))
      .order('id').range(from, to));
  if (ids.error) return { error: ids.error.message };
  const noteIds = (ids.data ?? []).map((r) => r.id);
  if (noteIds.length === 0) return { error: null, items: [], truncated: ids.truncated };

  /* The status and the hold marker are asked of the ROW, not trusted from the
     view: the view carries no hold, and a note can change between two reads. */
  const notes = await chunkIn<NoteRow>(noteIds, (batch, from, to) =>
    scopeQuery(sb.from('grns').select(NOTE_SELECT).in('id', batch))
      .eq('status', 'POSTED').eq('on_hold', false) // mig 0324: a held GRN reads POSTED — the hold is its own marker
      .order('id').range(from, to));
  if (notes.error) return { error: notes.error.message };
  const noteById = new Map(notes.data.map((n) => [n.id, n]));
  if (noteById.size === 0) return { error: null, items: [], truncated: ids.truncated };

  const lines = await chunkIn<LineRow>([...noteById.keys()], (batch, from, to) =>
    scopeQuery(sb.from('grn_items').select(LINE_SELECT).in('grn_id', batch))
      .order('id').range(from, to));
  if (lines.error) return { error: lines.error.message };

  const billable = lines.data.filter((r) => noteById.has(r.grn_id) && remainingToBill(r) > 0);

  const linePo = await loadLinePos({ sb, scopeQuery, lines: billable });
  if (linePo.error !== null) return { error: linePo.error };

  const items = billable
    .sort((a, b) => compareForPicker(noteById.get(a.grn_id)!, a, noteById.get(b.grn_id)!, b))
    .map((r) => toItem(noteById.get(r.grn_id)!, r, linePo.byPoItem));

  return { error: null, items, truncated: ids.truncated };
}

type LinePo = { purchaseOrderId: string; poDocNo: string | null };

/* purchase_order_item_id -> its PO id and number, both reads company-scoped and
   batched like the lines. A failed read is an error, not "no PO": the picker
   would otherwise fall back to the header PO this module exists not to trust. */
async function loadLinePos(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase-js client this tree passes around
  sb: any;
  scopeQuery: <Q>(q: Q) => Q;
  lines: LineRow[];
}): Promise<{ error: string } | { error: null; byPoItem: Map<string, LinePo> }> {
  const { sb, scopeQuery, lines } = args;
  const byPoItem = new Map<string, LinePo>();
  const poItemIds = [...new Set(lines.map((r) => r.purchase_order_item_id).filter((x): x is string => !!x))];
  if (poItemIds.length === 0) return { error: null, byPoItem };

  const poItems = await chunkIn<{ id: string; purchase_order_id: string | null }>(poItemIds, (batch, from, to) =>
    scopeQuery(sb.from('purchase_order_items').select('id, purchase_order_id').in('id', batch))
      .order('id').range(from, to));
  if (poItems.error) return { error: poItems.error.message };

  const poIds = [...new Set(poItems.data.map((r) => r.purchase_order_id).filter((x): x is string => !!x))];
  const poNumberById = new Map<string, string>();
  if (poIds.length > 0) {
    const pos = await chunkIn<{ id: string; po_number: string }>(poIds, (batch, from, to) =>
      scopeQuery(sb.from('purchase_orders').select('id, po_number').in('id', batch))
        .order('id').range(from, to));
    if (pos.error) return { error: pos.error.message };
    for (const p of pos.data) poNumberById.set(p.id, p.po_number);
  }

  for (const r of poItems.data) {
    if (!r.purchase_order_id) continue;
    byPoItem.set(r.id, { purchaseOrderId: r.purchase_order_id, poDocNo: poNumberById.get(r.purchase_order_id) ?? null });
  }
  return { error: null, byPoItem };
}

/* A line linked to a PO item names THAT item's PO, and only a line with no link
   falls back to the header. A link that did not resolve in this company reads
   as no PO rather than borrowing the header's, which is the wrong-PO label. */
function poForLine(h: NoteRow, r: LineRow, byPoItem: Map<string, LinePo>): { purchaseOrderId: string | null; poDocNo: string | null } {
  if (!r.purchase_order_item_id) {
    return { purchaseOrderId: h.purchase_order_id, poDocNo: h.purchase_order?.po_number ?? null };
  }
  return byPoItem.get(r.purchase_order_item_id) ?? { purchaseOrderId: null, poDocNo: null };
}

/* NEWEST NOTE FIRST, and a total order. The picker renders one card per note
   in the order lines arrive, and the old unpaged read had no ORDER BY at all,
   so the card order was whatever the planner produced. Received date first
   (what the old window meant by "newest"), then the note number, then the
   line's own entry order with its id as the last word. */
function compareForPicker(na: NoteRow, a: LineRow, nb: NoteRow, b: LineRow): number {
  if (na.received_at !== nb.received_at) return String(nb.received_at).localeCompare(String(na.received_at));
  if (na.grn_number !== nb.grn_number) return String(nb.grn_number).localeCompare(String(na.grn_number));
  if (a.created_at !== b.created_at) return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
  return a.id.localeCompare(b.id);
}

function toItem(h: NoteRow, r: LineRow, byPoItem: Map<string, LinePo>): OutstandingGrnItem {
  const currency = normalizeCurrency(h.currency);
  const po = poForLine(h, r, byPoItem);
  return {
    grnItemId:       r.id,
    grnId:           r.grn_id,
    grnDocNo:        h.grn_number,
    receivedAt:      h.received_at,
    supplierId:      h.supplier_id,
    supplierCode:    h.supplier?.code ?? '',
    supplierName:    h.supplier?.name ?? '',
    purchaseOrderId: po.purchaseOrderId,
    poDocNo:         po.poDocNo,
    itemCode:        r.item_code,
    supplierSku:     r.supplier_sku,
    description:     r.description ?? r.material_name,
    itemGroup:       r.item_group ?? '',
    qtyAccepted:     r.qty_accepted,
    invoicedQty:     r.invoiced_qty ?? 0,
    remaining:       remainingToBill(r),
    unitPriceSen:    r.unit_price_sen,
    variants:        r.variants,
    /* Multi-note invoices (owner 2026-08-06) — one invoice may bill several of a
       supplier's notes, but a PI header carries ONE currency + rate, so the
       picker locks on these too. */
    currency,
    exchangeRate:    normalizeExchangeRate(h.exchange_rate, currency),
  };
}
