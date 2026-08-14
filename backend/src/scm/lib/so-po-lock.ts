// ----------------------------------------------------------------------------
// so-po-lock — "a Purchase Order has been raised against this SO" lock.
//
// Owner 2026-08-12, after 2990-SO-2608-017: a PO went to HOOKKA at 01:03 and a
// salesperson added LEG 6" to the two sofa lines at 01:38 — directly, with no
// amendment and no approval, because the ONLY edit lock we had (soProcessingLocked)
// keys off the Processing Date having PASSED and that SO's was still four days
// out. The supplier kept building the old spec, and because MRP pools supply by
// (warehouse, item_code, variantKey) the now-diverged SO line stopped matching
// its own PO's supply bucket and reappeared as a shortage. One unguarded edit,
// two broken downstreams.
//
// So: once a LIVE PO exists for any of an SO's lines, the SO is committed to a
// supplier and edits must go through the amendment flow — exactly as if the
// processing date had elapsed. This is a SOFT lock (amendment-eligible), NOT the
// hard downstream lock a DO/SI applies: the change is still legitimate, it just
// has to be approved and re-sent rather than applied behind the purchaser's back.
//
// ── SCOPE: 2990 ONLY (owner 2026-08-12) ──────────────────────────────────────
// Measured before shipping: 304 live SOs carry a live PO while remaining directly
// editable — and 302 of them are HOUZS orders that simply never had a Processing
// Date filled in (SO dates back to 2024-01). Locking those in one deploy would
// flip a two-year backlog of Houzs orders to amendment-only in a single step, so
// the owner scoped this rule to 2990, where the exposure is 2 orders and the POS
// create path stamps a processing date anyway. Houzs keeps the date-only rule
// until it is decided separately.
//
// The 2990 test is the DOC-NUMBER PREFIX (isMirroredDocNo), not company_id — see
// the MIRRORED_COMPANY_CODE block in lib/companyScope.ts for why the prefix is
// the authoritative marker: it needs no companies-master lookup, so this guard
// behaves identically in a request, in a reconstructed headless context, and in
// a library called without a Context, where a company_id read would silently
// no-op and fail OPEN.
//
// Chain (the same link so-converted-po.ts walks):
//     scm.mfg_sales_order_items.id
//        → scm.purchase_order_items.so_item_id
//        → scm.purchase_orders.status  (CANCELLED dropped — a cancelled PO is
//          not a commitment; the SO is free again, which is also how the
//          From-SO picker and recomputeSoPicked treat it)
//
// DRAFT POs DO count here, deliberately diverging from recomputeSoPicked (which
// excludes DRAFT so a draft can't drop a line off the From-SO picker). The two
// answer different questions: that one asks "is this line already bought?", this
// one asks "is a purchaser mid-flight on this order?" — and a purchaser drafting
// a PO is exactly when a silent line edit does the most damage. There are no
// DRAFT POs bound to SO lines in prod today, so this costs nothing now and is
// the safe side of the fence later.
//
// FAIL CLOSED on a read error: an unreadable PO link means we cannot prove the
// SO is free, and the cost of a wrong "unlocked" (an unapproved spec change
// reaching a supplier) is far higher than the cost of a wrong "locked" (an
// operator routed through the amendment flow they would use tomorrow anyway).
// This is the opposite of so-converted-po.ts's best-effort empty map — that one
// feeds a display column, this one is a guard.
// ----------------------------------------------------------------------------

import { isMirroredDocNo } from './companyScope';

/** PostgREST `.in()` caps out on URL length. An SO's line count is small (the
 *  widest live order is a handful of rows), but chunk anyway so a pathological
 *  order can't blow the query string. Mirrors so-converted-po.ts. */
const IN_CHUNK = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * True when a live (non-CANCELLED) Purchase Order claims any line of this SO,
 * and the SO is 2990's. Houzs orders always answer false — see SCOPE above.
 *
 * eslint-disable-next-line @typescript-eslint/no-explicit-any — `sb` is the
 * untyped supabase-js client this whole module tree passes around.
 */
export async function soPoLocked(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  docNo: string | null | undefined,
): Promise<boolean> {
  if (!docNo || !isMirroredDocNo(docNo)) return false;

  try {
    const { data: lineRows, error: lineErr } = await sb
      .from('mfg_sales_order_items')
      .select('id')
      .eq('doc_no', docNo);
    if (lineErr) return true; // fail closed
    const itemIds = ((lineRows ?? []) as Array<{ id: string | null }>)
      .map((r) => r.id)
      .filter((id): id is string => Boolean(id));
    if (itemIds.length === 0) return false; // no lines → nothing can be bought

    const poIds = new Set<string>();
    for (const part of chunk(itemIds, IN_CHUNK)) {
      const { data, error } = await sb
        .from('purchase_order_items')
        .select('purchase_order_id')
        .in('so_item_id', part)
        .not('purchase_order_id', 'is', null);
      if (error) return true; // fail closed
      for (const r of (data ?? []) as Array<{ purchase_order_id: string | null }>) {
        if (r.purchase_order_id) poIds.add(r.purchase_order_id);
      }
    }
    if (poIds.size === 0) return false;

    /* Status filtered app-side (not `.neq('status','CANCELLED')`) for the same
       reason so-converted-po.ts does it: a schema without the column would make
       a server-side predicate silently widen the set, and here that would mean
       a cancelled PO keeping an SO locked forever. */
    for (const part of chunk([...poIds], IN_CHUNK)) {
      const { data, error } = await sb
        .from('purchase_orders')
        .select('id, status')
        .in('id', part);
      if (error) return true; // fail closed
      for (const p of (data ?? []) as Array<{ status: string | null }>) {
        if ((p.status ?? '').toUpperCase() !== 'CANCELLED') return true;
      }
    }
    return false;
  } catch {
    return true; // fail closed
  }
}

/**
 * Batched flavour — the set of doc_nos that are PO-locked, for LIST payloads.
 *
 * The Delivery Planning board needs this per row: its drawer routes a CONTROLLED
 * field (replacement_disposal) into an amendment when the SO is locked, and it
 * decides that client-side from the row. Without the fact on the row the drawer
 * would attempt a direct write, collect the guard's 409, and leave the operator
 * with a change they were told to request and no way to request it.
 *
 * Same rules as soPoLocked (2990 only, CANCELLED dropped, DRAFT counts) — but
 * NOT the same failure mode: a list is a read, and failing an entire board
 * closed because one query hiccupped would freeze every row's drawer. On error
 * this returns what it resolved so far, and the WRITE guards (which do fail
 * closed) remain the control. That asymmetry is deliberate; the display may
 * under-report, the guard may not.
 */
export async function soPoLockedMany(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  docNos: Array<string | null | undefined>,
): Promise<Set<string>> {
  const locked = new Set<string>();
  const docs = [...new Set(docNos.filter((d): d is string => !!d && isMirroredDocNo(d)))];
  if (docs.length === 0) return locked;

  try {
    const docByItemId = new Map<string, string>();
    for (const part of chunk(docs, IN_CHUNK)) {
      const { data, error } = await sb
        .from('mfg_sales_order_items')
        .select('id, doc_no')
        .in('doc_no', part);
      if (error) return locked;
      for (const r of (data ?? []) as Array<{ id: string | null; doc_no: string | null }>) {
        if (r.id && r.doc_no) docByItemId.set(r.id, r.doc_no);
      }
    }
    const itemIds = [...docByItemId.keys()];
    if (itemIds.length === 0) return locked;

    const docsByPoId = new Map<string, Set<string>>();
    for (const part of chunk(itemIds, IN_CHUNK)) {
      const { data, error } = await sb
        .from('purchase_order_items')
        .select('so_item_id, purchase_order_id')
        .in('so_item_id', part)
        .not('purchase_order_id', 'is', null);
      if (error) return locked;
      for (const r of (data ?? []) as Array<{ so_item_id: string | null; purchase_order_id: string | null }>) {
        const doc = r.so_item_id ? docByItemId.get(r.so_item_id) : undefined;
        if (!doc || !r.purchase_order_id) continue;
        let s = docsByPoId.get(r.purchase_order_id);
        if (!s) { s = new Set(); docsByPoId.set(r.purchase_order_id, s); }
        s.add(doc);
      }
    }
    if (docsByPoId.size === 0) return locked;

    for (const part of chunk([...docsByPoId.keys()], IN_CHUNK)) {
      const { data, error } = await sb
        .from('purchase_orders')
        .select('id, status')
        .in('id', part);
      if (error) return locked;
      for (const p of (data ?? []) as Array<{ id: string; status: string | null }>) {
        if ((p.status ?? '').toUpperCase() === 'CANCELLED') continue;
        for (const doc of docsByPoId.get(p.id) ?? []) locked.add(doc);
      }
    }
    return locked;
  } catch {
    return locked;
  }
}
