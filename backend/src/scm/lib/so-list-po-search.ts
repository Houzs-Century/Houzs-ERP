// ----------------------------------------------------------------------------
// so-list-po-search — find a Sales Order by the SYSTEM Purchase Order number
// raised against it (owner 2026-11-11: "Sales Order 这边要能搜 PO number").
//
// The SO list already DISPLAYS that number in its "PO No." column
// (so-converted-po.ts walks SO -> PO forwards). This is the REVERSE walk, so
// the free-text search box can find the order from a PO number the same way it
// already finds it from the customer's Ref No. (so-ref-search.ts).
//
// Chain (migration 0098, the link so-converted-po.ts walks forward):
//     purchase_orders.po_number ILIKE %term%   (CANCELLED dropped, as the column)
//        -> purchase_orders.id
//        -> purchase_order_items.purchase_order_id / .so_item_id
//        -> mfg_sales_order_items.id / .doc_no   (the SO)
//
// The line link is the DIRECT one only (purchase_order_items.so_item_id), the
// same set the "PO No." column shows — not FIFO allocations, which can tie a
// PO to another order's line and would surface an SO that does NOT list that PO.
//
// Like the approval-code search (so-list-approval-codes.ts), a read error
// REFUSES the list rather than dropping matches silently: a search that quietly
// lost its hits is a wrong answer, not an empty one. The caller catches the
// throw and returns 500. Capped — a term too short to be a PO number would admit
// half the ledger, and every doc_no rides the request URL as one `.in()` arm.
//
// CompanyScopeCtx scopes every read: the SCM client is the service role, so the
// company predicate is the only boundary between the two companies' books — on
// the by-uuid hops too (a PO number is not globally unique across companies).
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { chunkIn } from './paginate-all';
import { escapeForOr } from './postgrest-search';

/** How many SO doc numbers a PO-number search may admit — one URL carries them
 *  all as a single `doc_no.in.(...)` arm, so this stays well inside the
 *  PostgREST query budget (paginate-all.ts). */
export const PO_NUMBER_MATCH_CAP = 200;

/**
 * SO doc numbers in the caller's company whose system PO number contains the
 * term — the reverse of so-converted-po's forward walk, so a PO number finds its
 * order. Empty when the term is blank or nothing matches; THROWS on a read error
 * so the caller can refuse the list rather than drop matches.
 */
export async function soDocNosByPoNumber(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout (companyScope.ts)
  sb: any,
  c: CompanyScopeCtx,
  term: string | null,
): Promise<string[]> {
  const s = escapeForOr(term ?? '');
  if (!s) return [];

  // 1. PO headers whose number contains the term. CANCELLED dropped app-side
  //    (the same rule so-converted-po applies), so the search admits exactly
  //    the orders the "PO No." column shows. Capped at the match budget.
  const headRes = await scopeToCompany(
    sb.from('purchase_orders').select('id, status').ilike('po_number', `%${s}%`),
    c,
  ).limit(PO_NUMBER_MATCH_CAP);
  if (headRes.error) throw new Error(`PO number lookup failed: ${headRes.error.message}`);
  const poIds = ((headRes.data ?? []) as Array<{ id: string | null; status: string | null }>)
    .filter((p) => (p.status ?? '').toUpperCase() !== 'CANCELLED')
    .map((p) => p.id)
    .filter((id): id is string => !!id);
  if (poIds.length === 0) return [];

  // 2. Their PO lines -> the SO lines they were raised from (direct link only).
  const poItems = await chunkIn<{ so_item_id: string | null }>(poIds, (batch, from, to) =>
    scopeToCompany(sb.from('purchase_order_items').select('so_item_id'), c)
      .in('purchase_order_id', batch)
      .not('so_item_id', 'is', null)
      .range(from, to),
  );
  if (poItems.error) throw new Error(`PO line lookup failed: ${poItems.error.message}`);
  const soItemIds = [...new Set(
    poItems.data.map((r) => r.so_item_id).filter((id): id is string => !!id),
  )];
  if (soItemIds.length === 0) return [];

  // 3. Those SO lines -> their SO doc_no.
  const soItems = await chunkIn<{ doc_no: string | null }>(soItemIds, (batch, from, to) =>
    scopeToCompany(sb.from('mfg_sales_order_items').select('doc_no'), c)
      .in('id', batch)
      .range(from, to),
  );
  if (soItems.error) throw new Error(`SO line lookup failed: ${soItems.error.message}`);
  return [...new Set(
    soItems.data.map((r) => r.doc_no).filter((d): d is string => !!d),
  )].slice(0, PO_NUMBER_MATCH_CAP);
}
