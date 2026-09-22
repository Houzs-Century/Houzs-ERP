// ----------------------------------------------------------------------------
// so-converted-po — resolve, per SO doc_no, the system Purchase Order numbers
// raised against that SO's lines (the POs the SO was "converted into").
//
// Drives the Sales Orders list "PO No." column (owner 2026-07-24: the column
// used to show the CUSTOMER's hand-typed PO # — never filled for 2990 — where
// the operator expected the system PO the SO produced).
//
// Chain (migration 0098 — the same link dropship-batch.ts walks):
//     scm.purchase_order_items.so_item_id  = an SO line id
//        → scm.mfg_sales_order_items.doc_no = the SO the line belongs to
//        → scm.purchase_order_items.purchase_order_id
//        → scm.purchase_orders.po_number
//
// A SO can raise SEVERAL POs (different suppliers), so each doc_no maps to a
// SORTED, de-duped list. CANCELLED POs are dropped — a cancelled PO is not a
// live conversion and printing its number would mislead; DRAFT and every live
// stage are kept (the SO did produce that PO).
//
// Best-effort: any read error yields an empty map (the column shows "—"),
// never a throw — the PO number is an ancillary column, not load-bearing for
// the list, and must never 500 it.
//
// Readers: the Sales Orders list (numbers only) and the Service Case list +
// detail "Order PO" (services/assrOrderPos.ts), which needs the PO id too so
// the detail can link each number to its PO page. ONE walk, two projections.
//
// `companyId` is REQUIRED (number | null) and, when a number, goes on all
// three reads as company_id = <id>. The SCM client is the service role, so
// that predicate is the only thing keeping a doc_no or line id of the other
// company's books out of the answer. null = no predicate, and a caller passing
// it has to say why.
// ----------------------------------------------------------------------------

/** PostgREST `.in()` caps out on URL length, and the un-paginated SO list can
 *  hand us 500 docs → well over a thousand line ids. Chunk every `.in()` set so
 *  a wide list can't blow the query-string limit. */
const IN_CHUNK = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type SoConvertedPo = { id: string; po_number: string };

export async function soConvertedPoNumbers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  docNos: Array<string | null | undefined>,
  companyId: number | null,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const [doc, pos] of await soConvertedPos(sb, docNos, companyId)) {
    out.set(doc, [...new Set(pos.map((p) => p.po_number))]);
  }
  return out;
}

/**
 * Per SO LINE (so_item_id) the system PO numbers raised AGAINST THAT LINE — the
 * line's OWN incoming PO, the same `purchase_order_items.so_item_id` link
 * `soConvertedPos` walks, but keyed per line instead of rolled up to the doc.
 *
 * This is what the Sales Order detail's "Incoming PO" chip should show: the PO
 * this line was ordered on, NOT the PO whose physical FIFO batch its goods later
 * shipped from (a shared-stock line can consume a lot received under another
 * order's PO — correct for costing, misleading as "this line's PO"). CANCELLED
 * POs are dropped. Best-effort: any read error yields an empty map, never a throw.
 *
 * `companyId` is REQUIRED (number | null); when a number it scopes every read,
 * the only boundary under the service-role client.
 */
export async function soLineBoundPoNumbers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soItemIds: Array<string | null | undefined>,
  companyId: number | null,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoped = (q: any) => (companyId == null ? q : q.eq('company_id', companyId));
  const ids = [...new Set(soItemIds.filter((d): d is string => !!d))];
  if (ids.length === 0) return out;
  try {
    const links: Array<{ so_item_id: string; purchase_order_id: string }> = [];
    const poIds = new Set<string>();
    for (const part of chunk(ids, IN_CHUNK)) {
      const { data, error } = await scoped(sb
        .from('purchase_order_items')
        .select('so_item_id, purchase_order_id'))
        .in('so_item_id', part)
        .not('purchase_order_id', 'is', null);
      if (error) return out;
      for (const r of (data ?? []) as Array<{ so_item_id: string | null; purchase_order_id: string | null }>) {
        if (r.so_item_id && r.purchase_order_id) {
          links.push({ so_item_id: r.so_item_id, purchase_order_id: r.purchase_order_id });
          poIds.add(r.purchase_order_id);
        }
      }
    }
    if (links.length === 0) return out;
    const numById = new Map<string, string>();
    for (const part of chunk([...poIds], IN_CHUNK)) {
      const { data, error } = await scoped(sb
        .from('purchase_orders')
        .select('id, po_number, status'))
        .in('id', part);
      if (error) return out;
      for (const p of (data ?? []) as Array<{ id: string; po_number: string | null; status: string | null }>) {
        if ((p.status ?? '').toUpperCase() === 'CANCELLED') continue;
        if (p.po_number) numById.set(p.id, p.po_number);
      }
    }
    const bySoItem = new Map<string, Set<string>>();
    for (const l of links) {
      const num = numById.get(l.purchase_order_id);
      if (!num) continue;
      let s = bySoItem.get(l.so_item_id);
      if (!s) { s = new Set(); bySoItem.set(l.so_item_id, s); }
      s.add(num);
    }
    for (const [itemId, s] of bySoItem) {
      out.set(itemId, [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    }
    return out;
  } catch {
    return out;
  }
}

export async function soConvertedPos(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  docNos: Array<string | null | undefined>,
  companyId: number | null,
): Promise<Map<string, SoConvertedPo[]>> {
  const out = new Map<string, SoConvertedPo[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoped = (q: any) => (companyId == null ? q : q.eq('company_id', companyId));
  const docs = [...new Set(docNos.filter((d): d is string => !!d))];
  if (docs.length === 0) return out;

  try {
    // 1. SO line id → its SO doc_no. (Not filtered on `cancelled`: a PO raised
    //    against a line that was later cancelled still exists and still counts
    //    as a conversion of that SO.)
    const docByItemId = new Map<string, string>();
    for (const part of chunk(docs, IN_CHUNK)) {
      const { data, error } = await scoped(sb
        .from('mfg_sales_order_items')
        .select('id, doc_no'))
        .in('doc_no', part);
      if (error) return out;
      for (const r of (data ?? []) as Array<{ id: string | null; doc_no: string | null }>) {
        if (r.id && r.doc_no) docByItemId.set(r.id, r.doc_no);
      }
    }
    const itemIds = [...docByItemId.keys()];
    if (itemIds.length === 0) return out;

    // 2. PO lines raised from those SO lines → (SO line id, PO id).
    const links: Array<{ so_item_id: string; purchase_order_id: string }> = [];
    const poIds = new Set<string>();
    for (const part of chunk(itemIds, IN_CHUNK)) {
      const { data, error } = await scoped(sb
        .from('purchase_order_items')
        .select('so_item_id, purchase_order_id'))
        .in('so_item_id', part)
        .not('purchase_order_id', 'is', null);
      if (error) return out;
      for (const r of (data ?? []) as Array<{ so_item_id: string | null; purchase_order_id: string | null }>) {
        if (r.so_item_id && r.purchase_order_id) {
          links.push({ so_item_id: r.so_item_id, purchase_order_id: r.purchase_order_id });
          poIds.add(r.purchase_order_id);
        }
      }
    }
    if (links.length === 0) return out;

    // 3. PO id → po_number, dropping CANCELLED (filtered app-side so a schema
    //    without the status column can't silently widen the set).
    const numById = new Map<string, string>();
    for (const part of chunk([...poIds], IN_CHUNK)) {
      const { data, error } = await scoped(sb
        .from('purchase_orders')
        .select('id, po_number, status'))
        .in('id', part);
      if (error) return out;
      for (const p of (data ?? []) as Array<{ id: string; po_number: string | null; status: string | null }>) {
        if ((p.status ?? '').toUpperCase() === 'CANCELLED') continue;
        if (p.po_number) numById.set(p.id, p.po_number);
      }
    }

    // Assemble doc_no → PO de-duped by id, sorted by number.
    const byDoc = new Map<string, Map<string, SoConvertedPo>>();
    for (const l of links) {
      const doc = docByItemId.get(l.so_item_id);
      const num = numById.get(l.purchase_order_id);
      if (!doc || !num) continue;
      let m = byDoc.get(doc);
      if (!m) { m = new Map(); byDoc.set(doc, m); }
      m.set(l.purchase_order_id, { id: l.purchase_order_id, po_number: num });
    }
    for (const [doc, m] of byDoc) {
      out.set(doc, [...m.values()].sort((a, b) => a.po_number.localeCompare(b.po_number, undefined, { numeric: true })));
    }
    return out;
  } catch {
    return out;
  }
}
