/* HC-0130 — the supplier a service case should carry, from rows already read.
   The same rule as orderSupplierCode / resolveCreditorForCase
   (src/services/assrOrderPos.ts, src/services/stockItems.ts), for the backfill
   script, which runs in Node over postgres and cannot call the Worker code.
   Change one, change the other.

     1. the PO raised from the case item's SO line: not CANCELLED, has a
        supplier code; the latest po_date, then po_number, wins      -> 'po'
     2. the SO item's bound supplier (only when the SO line exists): the main
        supplier, else the one supplier when there is exactly one     -> 'so'
     3. AutoCount MainSupplier from the stock_items cache              -> 'auto'
     else null — Service Team picks by hand. */
export function pickCaseSupplier({ hasSoLine, pos, binds, mainSupplier }) {
  const latest = (pos ?? [])
    .filter((p) => String(p.status ?? '').toUpperCase() !== 'CANCELLED' && p.code)
    .sort((a, b) => String(b.po_date ?? '').localeCompare(String(a.po_date ?? ''))
      || String(b.po_number ?? '').localeCompare(String(a.po_number ?? ''), undefined, { numeric: true }))[0];
  if (latest) return { code: latest.code, source: 'po' };
  if (hasSoLine) {
    const coded = (binds ?? []).filter((b) => b.code);
    const main = coded.find((b) => b.is_main_supplier);
    if (main) return { code: main.code, source: 'so' };
    if (new Set(coded.map((b) => b.code)).size === 1) return { code: coded[0].code, source: 'so' };
  }
  return mainSupplier ? { code: mainSupplier, source: 'auto' } : null;
}
