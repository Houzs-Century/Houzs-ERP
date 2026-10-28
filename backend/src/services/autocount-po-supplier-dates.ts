/**
 * A purchase order's supplier delivery dates, as the account book's PO UDFs.
 *
 * Owner 2026-09-15 chose to send them ERP -> AutoCount: the ERP is the only
 * editing surface (「我们只操作erp 不操作autocount」), and until this the PO
 * write-back sent `UDF: {}`, so a supplier date entered in the ERP never reached
 * the book's PO chasing list (docs/bugs/0918).
 *
 * THE KEYS are the book's `UDF.FieldName`, unprefixed — the same convention the
 * sales order's `PDate` rides on, which lands in `SO.UDF_PDate` (a datetime
 * column) through the same `ApplyUdf` (read back from the live book 2026-09-15:
 * SO-011331 sent PDate 2026-09-15 at 03:26Z, book UDF_PDate 2026-09-15, modified
 * by MASTER at 11:26 book time). The PO's UDF table rows, read the same day:
 *
 *   EDate   "Supplier Delivery Date"    -> PO.UDF_EDate   <- supplier_delivery_date_2
 *   EDate2  "Supplier Delivery Date 2"  -> PO.UDF_EDate2  <- supplier_delivery_date_3
 *   EDate3  "Supplier Delivery Date 3"  -> PO.UDF_EDate3  <- supplier_delivery_date_4
 *
 * The ERP's first date is the base (`expected_at` / line `delivery_date`), so
 * its slots 2/3/4 are the book's three supplier dates.
 *
 * A BLANK SLOT IS OMITTED, NEVER SENT AS NULL. AcSyncService turns a present
 * null into "" and BLANKS the book's field; an absent key leaves the book's own.
 * Every PO edit republishes the whole header, so a null here would wipe a book
 * date on any unrelated save. The cost, accepted: clearing a date in the ERP
 * does not clear it in the book.
 */
import { acUdfDate } from './autocount-writeback';

export interface PoSupplierDates {
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  supplier_delivery_date_4?: string | null;
}

export const PO_SUPPLIER_DATE_AC_UDF = [
  ['supplier_delivery_date_2', 'EDate'],
  ['supplier_delivery_date_3', 'EDate2'],
  ['supplier_delivery_date_4', 'EDate3'],
] as const;

export function poSupplierDateUdf(header: PoSupplierDates): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [col, key] of PO_SUPPLIER_DATE_AC_UDF) {
    const d = acUdfDate(header[col]);
    if (d) out[key] = d;
  }
  return out;
}

/**
 * The source sales order's number, as the book's `UDF_SONo` ("SO Doc No."), the
 * field the office plug-in fills on every purchase order it makes: 908 of 910
 * plug-in pairs since 2026-06-01 (live book, 2026-09-15), where the ERP's own
 * purchase orders carried none (docs/bugs/0926). Omitted when the ERP cannot
 * name ONE order, so the book keeps its own.
 */
export function poSourceSoUdf(header: { source_so_no: string | null }): Record<string, string> {
  const no = (header.source_so_no ?? '').trim();
  return no ? { SONo: no } : {};
}

/**
 * The header a PO EDIT sends. /edit applies only the keys it is given
 * (AcSyncService.cs `Edit`: `h.ContainsKey`, then `ApplyUdf(h, ...)` reads
 * `Header.UDF`), so a blank CreditorName / Description / Ref is dropped and the
 * book keeps its own, and `UDF` is present only when there is something to say.
 * Ref is the source order's reference, which is what the plug-in copies onto its
 * purchase orders (897 of 910 pairs).
 */
export function poEditHeader(
  header: { creditor_name: string | null; notes: string | null; ref: string | null; source_so_no: string | null } & PoSupplierDates,
): Record<string, string | Record<string, string>> {
  const out: Record<string, string | Record<string, string>> = {};
  const creditor = (header.creditor_name ?? '').trim();
  const notes = (header.notes ?? '').trim();
  const ref = (header.ref ?? '').trim();
  if (creditor) out.CreditorName = creditor;
  if (notes) out.Description = notes;
  if (ref) out.Ref = ref;
  const udf = { ...poSupplierDateUdf(header), ...poSourceSoUdf(header) };
  if (Object.keys(udf).length) out.UDF = udf;
  return out;
}
