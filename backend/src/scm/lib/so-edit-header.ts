// ----------------------------------------------------------------------------
// so-edit-header — the AutoCount header an EDIT of a sales order carries.
//
// Moved out of autocount-outbox.ts unchanged. That file is IO — enqueue,
// dispatch, drain — and hit its 2,000-line cap three times on 2026-08-15 as
// PAYEMENT, the clearing rule and the SO-to-PO decision all landed in it. This
// is a pure composer with no client and no env, so it belongs beside the other
// composers rather than inside the queue.
//
// THE ONE RULE THAT GOVERNS EVERY KEY HERE: omit what the ERP has no value for,
// so the account book keeps its own — EXCEPT a field the route says it just
// WROTE and which is now empty, which is a deletion and travels as an explicit
// null. clearedAcKeys owns that distinction and its exclusions.
// ----------------------------------------------------------------------------
import {
  BRANDING_MAP, LOCATION_MAP, VENUE_MAP,
} from '../../services/autocount-master-maps';
import {
  acUdfDate,
  acUdfMoney,
  bookSpelling,
  bookSpellingOrOwn,
  clearedAcKeys,
  composePaymentUdf,
  resolveAcAgent,
  soBranding,
  soCustomerRef,
  soInvoiceAddress,
  type ErpLine,
  type ErpPaymentRef,
} from '../../services/autocount-writeback';

/** Drops every null, so an absent value never reaches the service as "". */
const present = (o: Record<string, string | null>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '') out[k] = v;
  return out;
};

export /**
 * The SO header fields an EDIT carries.
 *
 * A create sends the salesperson, the sales location, the document date and the
 * three UDFs; an edit used to send none of them, so changing any one of those on
 * a live order never reached AutoCount at all (divergence D8). The account book
 * accepts every one of them on `/edit` — `AcSyncService.Edit()` has them in its
 * allow-list and calls `ApplyUdf` — so this was the ERP declining to speak, not
 * AutoCount refusing to listen.
 *
 * A NULL VALUE IS OMITTED, NEVER SENT. The service's header loop is
 * `ContainsKey`-gated and `Str` turns a present-but-null into `""`, so sending
 * `{Agent: null}` does not mean "unchanged" — it means "blank the salesperson
 * the account book has". The same rule as the line-level Location, one level up.
 *
 * THAT RULE IS NOW APPLIED TO EVERY KEY, WHICH IT WAS NOT. Eight of them —
 * `DebtorName`, `Attention`, `Ref`, `Phone1` and the four `InvAddr` lines —
 * were emitted as `x ?? null` unconditionally while the doc comment above
 * already said they were not, so every edit of a sales order blanked whatever
 * the account book held in those fields wherever the ERP's column was empty.
 * Measured on production 2026-08-14: `ref` is blank on 112 of 115 unpushed
 * orders and `address3` / `address4` on 94 of them (audit finding 10).
 *
 * AN EDIT IS NEVER REFUSED FOR A MISSING AGENT, which is where it parts company
 * with the create. On a create a blank Agent is a foreign-key failure that
 * loses the whole document; here the account book already holds a value and
 * omitting the key leaves it alone. Refusing would strand every legacy order
 * that has no salesperson on either source and gain nothing. `SalesLocation`
 * runs under the same asymmetry — the create falls back to the lines because
 * it MUST send something, the edit simply says nothing.
 */
function soEditHeader(
  h: Record<string, unknown>,
  /** REQUIRED, never optional: it decides whether Agent is sent at all. */
  salespersonName: string | null,
  /** REQUIRED, never optional: it decides what BRANDING is, and the header
   *  column is NULL on every ERP-created order. See `soBranding`. */
  lines: ErpLine[],
  /** REQUIRED, never optional: it decides what the account book says a live
   *  customer still owes. `null` omits the key and keeps the book's own. */
  outstandingCenti: number | null,
  /** The payment references, oldest first — REQUIRED for the same reason as
   *  the three above: it decides what the book's PAYEMENT field says. An empty
   *  array omits the key and the book keeps whatever the cutover left. */
  paymentRefs: readonly ErpPaymentRef[],
  /** ERP columns THIS REQUEST wrote. Optional: absence is the STRICTER
   *  direction. Rule and exclusions live on clearedAcKeys. */
  touchedFields: readonly string[] = [],
): Record<string, string | null | Record<string, string>> {
  const out: Record<string, string | null | Record<string, string>> = present({
    DebtorName: (h.debtor_name as string) ?? null,
    Attention: (h.debtor_name as string) ?? null,
    Ref: (h.ref as string) ?? null,
    Phone1: (h.phone as string) ?? null,
    /* The DELIVERY contact, which is not `phone`. On a CREATE the service falls
       back to Phone when this is absent; on an EDIT nothing falls back, so a
       changed delivery number never reached the book at all until this key did.
       Blank still omits — the book keeps whatever it has. */
    DeliverPhone1: (h.emergency_contact_phone as string) ?? null,
    ...soInvoiceAddress(h),
    /* The delivery date, in the field this book keeps it in. Omit-when-absent
       like the rest; a cleared one travels through clearedAcKeys, which lists it
       as a date with no foreign key behind it. */
    SalesExemptionExpiryDate: acUdfDate(h.customer_delivery_date as string | null | undefined),
  });
  const agent = resolveAcAgent((h.agent as string) ?? null, salespersonName);
  if (agent) out.Agent = agent;
  const loc = bookSpellingOrOwn((h.sales_location as string) ?? null, LOCATION_MAP);
  if (loc) out.SalesLocation = loc;
  if (h.so_date) out.DocDate = String(h.so_date);

  const udf: Record<string, string> = {};
  /* bookSpelling, NOT bookSpellingOrOwn: BRANDING_MAP is the one allow-list of
     the four, because the ERP column behind it holds CATEGORIES. */
  const branding = bookSpelling(soBranding((h.branding as string) ?? null, lines), BRANDING_MAP);
  if (branding) udf.BRANDING = branding;
  const venue = bookSpellingOrOwn((h.venue as string) ?? null, VENUE_MAP);
  if (venue) udf.VENUE = venue;
  const customerRef = soCustomerRef(h);
  if (customerRef) udf.ToPONo = customerRef;
  /* The SO's "Processing date" (owner: 账目日期). Owner 2026-08-12: editing it
     in the ERP must reach AutoCount. Same omit-when-absent rule as the rest of
     this function — a cleared date sends nothing rather than blanking the
     account book's value, which is the conservative half of the pair and the
     one that cannot destroy data. */
  const pdate = acUdfDate(h.processing_date as string | null | undefined);
  if (pdate) udf.PDate = pdate;
  /* The outstanding balance, and the one UDF whose ZERO must be sent: an order
     the customer has now settled has to stop showing a debt in the account
     book, and `acUdfMoney` renders that as "0.00" precisely so this `if` does
     not drop it. Only a null — the ERP has no answer — omits the key. */
  const balance = acUdfMoney(outstandingCenti);
  if (balance != null) udf.BALANCE = balance;

  /* AN EXPLICIT NULL IS THE MESSAGE — `Str` turns it into "", and the book's
     value goes. */
  const cleared = clearedAcKeys(touchedFields, h);
  for (const key of cleared.header) out[key] = null;
  for (const key of cleared.udf) udf[key] = '';
  /* Omit-when-absent like the rest: a blank would erase the book's own text. */
  const payement = composePaymentUdf(paymentRefs);
  if (payement) udf.PAYEMENT = payement;
  if (Object.keys(udf).length) out.UDF = udf;

  return out;
}
