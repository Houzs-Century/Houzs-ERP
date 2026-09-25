// ---------------------------------------------------------------------------
// Find documents by their Sales Order's reference number (owner 2026-09-25:
// "整个系统的search button都能搜到SO的ref number").
//
// The SO's reference lives on the SO (`ref`, with `customer_so_no` as the
// fallback — frontend/src/lib/customer-ref.ts). DOs and SIs carry a COPY of
// `ref`, but the copy is unreliable: on 2026-09-25, 205 / 474 DOs and 79 / 205
// SIs had an empty copy while their SO had a ref, and a merged document's copy
// reads "Merged from ...". POs carry no ref at all (the link is per line). So a
// list searches the SO first and matches its own rows by the SO link instead of
// trusting the copy.
//
// The match is capped: a term that hits more SOs than the cap is too generic to
// be a reference number, and every id rides in the request URL (PostgREST
// `.in`), which has a budget (paginate-all.ts URL_QUERY_BUDGET).
// ---------------------------------------------------------------------------
import type { Variables } from '../env';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { chunkIn } from './paginate-all';
import { escapeForOr } from './postgrest-search';

type Sb = Variables['supabase'];

export const SO_REF_MATCH_CAP = 50;

/** SO doc numbers in the caller's company whose `ref` or `customer_so_no`
 *  contains the term. Empty when the term is blank or nothing matches. */
export async function soDocNosByRef(sb: Sb, c: CompanyScopeCtx, term: string | null): Promise<string[]> {
  const s = escapeForOr(term ?? '');
  if (!s) return [];
  const { data, error } = await scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select('doc_no')
      .or(`ref.ilike.%${s}%,customer_so_no.ilike.%${s}%`),
    c,
  ).limit(SO_REF_MATCH_CAP);
  if (error) throw new Error(`SO reference lookup failed: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as Array<{ doc_no: string | null }>;
  return [...new Set(rows.map((r) => r.doc_no).filter((d): d is string => !!d))];
}

/** PO ids with a line bought for one of these SOs — the line's own SO link
 *  (purchase_order_items.so_item_id) or a split allocation of it
 *  (purchase_order_item_allocations, mig 0235). */
export async function poIdsForSoDocNos(sb: Sb, docNos: readonly string[]): Promise<string[]> {
  if (docNos.length === 0) return [];
  const soItems = await chunkIn<{ id: string }>(docNos, (batch, from, to) =>
    sb.from('mfg_sales_order_items').select('id').in('doc_no', batch).range(from, to),
  );
  if (soItems.error) throw new Error(`SO line lookup failed: ${soItems.error.message}`);
  const soItemIds = soItems.data.map((r) => r.id);
  if (soItemIds.length === 0) return [];

  const [direct, allocated] = await Promise.all([
    chunkIn<{ purchase_order_id: string }>(soItemIds, (batch, from, to) =>
      sb.from('purchase_order_items').select('purchase_order_id').in('so_item_id', batch).range(from, to),
    ),
    chunkIn<{ purchase_order_item_id: string }>(soItemIds, (batch, from, to) =>
      sb.from('purchase_order_item_allocations').select('purchase_order_item_id').in('so_item_id', batch).range(from, to),
    ),
  ]);
  if (direct.error) throw new Error(`PO line lookup failed: ${direct.error.message}`);
  if (allocated.error) throw new Error(`PO allocation lookup failed: ${allocated.error.message}`);

  const poIds = new Set(direct.data.map((r) => r.purchase_order_id).filter(Boolean));
  const allocItemIds = [...new Set(allocated.data.map((r) => r.purchase_order_item_id).filter(Boolean))];
  if (allocItemIds.length > 0) {
    const viaAlloc = await chunkIn<{ purchase_order_id: string }>(allocItemIds, (batch, from, to) =>
      sb.from('purchase_order_items').select('purchase_order_id').in('id', batch).range(from, to),
    );
    if (viaAlloc.error) throw new Error(`PO line lookup failed: ${viaAlloc.error.message}`);
    for (const r of viaAlloc.data) if (r.purchase_order_id) poIds.add(r.purchase_order_id);
  }
  return [...poIds].slice(0, SO_REF_MATCH_CAP);
}

/** The `.or()` arm that adds "linked to one of these" to a list's free-text
 *  search, or nothing. Values are doc numbers / uuids, quoted so a comma or
 *  bracket in one cannot break the filter grammar. */
export function inArm(col: string, values: readonly string[]): string[] {
  if (values.length === 0) return [];
  return [`${col}.in.(${values.map((v) => `"${v.replace(/"/g, '')}"`).join(',')})`];
}

/** A DO / SI list's filters with the SO-reference matches resolved. Every
 *  reader of the list (page, export, facets) goes through this, so all of
 *  them match the same rows. */
export async function withSoRefDocNos<F extends { q: string | null; soRefDocNos: string[] }>(
  sb: Sb, c: CompanyScopeCtx, f: F,
): Promise<F> {
  return { ...f, soRefDocNos: await soDocNosByRef(sb, c, f.q) };
}

/** The PO list's filters with the SO-reference matches resolved (see above). */
export async function withSoRefPoIds<F extends { q: string | null; soRefPoIds: string[] }>(
  sb: Sb, c: CompanyScopeCtx, f: F,
): Promise<F> {
  return { ...f, soRefPoIds: await poIdsForSoDocNos(sb, await soDocNosByRef(sb, c, f.q)) };
}
