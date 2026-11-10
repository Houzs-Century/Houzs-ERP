/* One supplier bill is owed once. A second live purchase invoice (or AP
   invoice) carrying the same supplier's bill number is the same debt booked
   twice, and nothing stopped it: the scan queue only FLAGGED it, and the New
   forms did not look at all.

   The key is the scan queue's own (pi-scan-check.ts refKey): whitespace out,
   upper case, so "inv 001" and "INV001" are one bill. CANCELLED rows are not
   live and never block. AP invoices compare within their own doc_kind, so a
   supplier's debit note numbered like one of its invoices is not refused. */

export const billRefKey = (s: unknown): string =>
  typeof s === 'string' ? s.replace(/\s+/g, '').toUpperCase() : '';

export type DuplicateBill = { id: string; invoiceNumber: string; status: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped everywhere it is passed
type Sb = { from(table: string): any };

/** `excludeId` is the row being edited (null on create). `docKind` is the AP
 *  invoice kind, or null for purchase invoices, which have none. */
export async function findDuplicateSupplierBill(
  sb: Sb,
  table: 'purchase_invoices' | 'ap_invoices',
  q: { companyId: number; supplierId: string; ref: unknown; excludeId: string | null; docKind: 'INV' | 'DN' | null },
): Promise<{ ok: true; duplicate: DuplicateBill | null } | { ok: false; reason: string }> {
  const key = billRefKey(q.ref);
  if (!key || !q.supplierId) return { ok: true, duplicate: null };
  /* Narrowed in the database by an ilike that allows anything between the
     key's characters (so stored spacing cannot hide a match), then decided
     exactly here on the normalised key. */
  const pattern = `%${[...key].map((ch) => (/[%_\\]/.test(ch) ? `\\${ch}` : ch)).join('%')}%`;
  const cols = table === 'ap_invoices' ? 'id, invoice_number, status, supplier_invoice_ref, doc_kind' : 'id, invoice_number, status, supplier_invoice_ref';
  const { data, error } = await sb.from(table).select(cols)
    .eq('company_id', q.companyId).eq('supplier_id', q.supplierId)
    .neq('status', 'CANCELLED').ilike('supplier_invoice_ref', pattern);
  if (error) return { ok: false, reason: String(error.message ?? error) };
  const hit = ((data ?? []) as Array<Record<string, unknown>>).find((r) =>
    String(r.id) !== q.excludeId
    && billRefKey(r.supplier_invoice_ref) === key
    && (q.docKind === null || String(r.doc_kind ?? 'INV').toUpperCase() === q.docKind));
  return { ok: true, duplicate: hit ? { id: String(hit.id), invoiceNumber: String(hit.invoice_number), status: String(hit.status) } : null };
}

export function duplicateBillRefusal(ref: unknown, dup: DuplicateBill) {
  return {
    error: 'duplicate_supplier_bill',
    message: `This supplier's bill ${String(ref).trim()} is already booked as ${dup.invoiceNumber} (${dup.status}). Open that one, or cancel it first if it is wrong.`,
    existing: dup,
  };
}
