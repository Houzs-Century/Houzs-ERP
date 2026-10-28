// ----------------------------------------------------------------------------
// planning-po-nos — the purchase orders RAISED from each Sales Order, for the
// Delivery Planning board's "PO No." column (owner 2026-09-15, asked for
// beside "Reference"). Same walk as the SO list's muted raised-PO chips
// (so-converted-po.ts); this file only adapts it to the board.
//
// The board is the SHARED cross-company queue, and soConvertedPoNumbers scopes
// ONE company per walk — that predicate is the only thing keeping the other
// company's PO off a doc_no both books carry — so the rows are grouped by
// company_id and walked once per company. A row with no company_id is skipped
// rather than walked unscoped. Best-effort like the walk it wraps: a failed
// read leaves the column blank, it never 500s the board.
// ----------------------------------------------------------------------------
import { soConvertedPoNumbers } from './so-converted-po';

export type PlanningPoRow = { doc_no: string | null; company_id: number | string | null };

export async function planningPoNosByDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  rows: PlanningPoRow[],
): Promise<Map<string, string[]>> {
  const byCompany = new Map<number, string[]>();
  for (const r of rows) {
    if (!r.doc_no || r.company_id == null) continue;
    const cid = Number(r.company_id);
    if (!Number.isFinite(cid)) continue;
    const list = byCompany.get(cid) ?? [];
    list.push(String(r.doc_no));
    byCompany.set(cid, list);
  }
  const out = new Map<string, string[]>();
  for (const [cid, docs] of byCompany) {
    for (const [doc, pos] of await soConvertedPoNumbers(sb, docs, cid)) out.set(doc, pos);
  }
  return out;
}
