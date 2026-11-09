/* pi-header-pos — which purchase orders a purchase invoice bills.

   Owner 2026-11-10: an invoice billing lines from several POs must list ALL of
   them in its header, not only the first. `purchase_invoices.purchase_order_id`
   is a single FK holding the first receipt's PO, so the list is read off the
   LINES instead: each line's `source_po_number`, which the server resolves
   per line (grn_item -> purchase_order_item -> purchase_order) in
   attachGrnLineFacts — the same value the line card shows as "From PO".

   The header FK is the answer only when no line names a PO (a hand-raised
   invoice against a PO, or a detail read whose line facts failed). */

const byPoNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export function piPoNumbers(
  linePoNumbers: ReadonlyArray<string | null | undefined>,
  headerPoNumber: string | null,
): string[] {
  const uniq = [...new Set(linePoNumbers.map((n) => (n ?? '').trim()).filter(Boolean))].sort(byPoNumber);
  if (uniq.length) return uniq;
  const h = (headerPoNumber ?? '').trim();
  return h ? [h] : [];
}

/** How many PO numbers a compact header cell shows before "+N more". */
export const PI_PO_SHOWN = 3;

export function piPoShortLabel(poNumbers: ReadonlyArray<string>, shown: number): string {
  if (poNumbers.length === 0) return '—';
  const head = poNumbers.slice(0, shown).join(', ');
  const more = poNumbers.length - shown;
  return more > 0 ? `${head} +${more} more` : head;
}
