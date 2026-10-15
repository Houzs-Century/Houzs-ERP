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
