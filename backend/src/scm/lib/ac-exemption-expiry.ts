import type { Variables } from '../env';
import { scopeToAllowedCompanies, type CompanyScopeCtx } from './companyScope';
import { chunkIn } from './paginate-all';
import { noteDegradedRead } from './read-failure';

/* BUG-51 column repoint (owner 2026-10-15). Map each SO doc_no to the REAL
   AutoCount sales-exemption expiry: its linked book doc no (`linked_ac_docno`)
   resolved through the AutoCount mirror rows (`public.sales_orders`, one per book
   doc, carrying `expiry_date` = AutoCount's SalesExemptionExpiryDate UDF). A SO is
   ABSENT from the result when it has no AutoCount link or the mirror carries no
   expiry for it — the column then shows blank, which is correct (most orders are
   not SST-exempt). Pure, so the keying is tested without the view/mirror reads
   around it. ONE home, shared by the SO list (lib/so-list-rows.ts) and the
   Delivery Planning board (routes/delivery-planning.ts); never reads the ERP's own
   `sales_exemption_expiry` (the frozen original delivery date — left untouched). */
export function acExemptionExpiryByDoc(
  linkedAcByDoc: Map<string, string>,
  mirrorRows: Array<{ doc_no: string | null; expiry_date: string | null }>,
): Map<string, string> {
  const expiryByAcDoc = new Map<string, string>();
  for (const a of mirrorRows) if (a.doc_no && a.expiry_date) expiryByAcDoc.set(a.doc_no, a.expiry_date);
  const out = new Map<string, string>();
  for (const [docNo, acDoc] of linkedAcByDoc) {
    const v = expiryByAcDoc.get(acDoc);
    if (v) out.set(docNo, v);
  }
  return out;
}

/* Set `ac_sales_exemption_expiry` on a set of Delivery Planning SO rows: collect
   each row's linked book doc no, read the AutoCount mirror once (the mirror lives
   in the `public` schema — this client defaults to `scm` — and is HOUZS-only, so
   on this cross-company queue the read widens to the caller's GRANTED companies;
   2990 orders carry no linked_ac_docno and contribute nothing), then stamp each
   SO order by its `so_doc_no` (null when the order is not in AutoCount or the book
   carries no expiry). A mirror blip is observed via noteDegradedRead and degrades
   to blank — it never fails the board. Lives beside the keying so the board and the
   SO list resolve the exemption one way; never touches the ERP's own
   `sales_exemption_expiry`. */
export async function attachBoardAcExemptionExpiry(
  sb: Variables['supabase'],
  c: CompanyScopeCtx,
  soRows: Array<{ doc_no?: string | null; linked_ac_docno?: string | null; linkedAcDocno?: string | null }>,
  soOrders: Array<{ so_doc_no?: string | null } & Record<string, unknown>>,
): Promise<void> {
  const linkedAcByDoc = new Map<string, string>();
  for (const r of soRows) {
    const dn = String(r.doc_no ?? '');
    const ac = ((r.linkedAcDocno ?? r.linked_ac_docno) ?? '').trim();
    if (dn && ac) linkedAcByDoc.set(dn, ac);
  }
  let byDoc = new Map<string, string>();
  const acDocNos = [...new Set(linkedAcByDoc.values())];
  if (acDocNos.length > 0) {
    const { data, error } = await chunkIn<{ doc_no: string | null; expiry_date: string | null }>(
      acDocNos,
      (batch, from, to) =>
        scopeToAllowedCompanies(
          sb.schema('public').from('sales_orders').select('doc_no, expiry_date').in('doc_no', batch).order('doc_no'),
          c,
        ).range(from, to),
    );
    noteDegradedRead('ac_exemption_expiry', error);
    byDoc = acExemptionExpiryByDoc(linkedAcByDoc, data ?? []);
  }
  for (const o of soOrders) {
    (o as Record<string, unknown>).ac_sales_exemption_expiry = byDoc.get(String(o.so_doc_no ?? '')) ?? null;
  }
}
