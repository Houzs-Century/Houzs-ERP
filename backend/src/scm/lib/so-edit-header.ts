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
  soReference,
  soInvoiceAddress,
  type ErpLine,
  type ErpPaymentRef,
} from '../../services/autocount-writeback';
import {
  SO_PROCESSING_DATE_AC_UDF,
  SO_PROCESSING_DATE_COLUMN,
} from '../shared/so-processing-date';

const present = (o: Record<string, string | null>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '') out[k] = v;
  return out;
};

function deliverAddressOf(h: Record<string, unknown>): Record<string, string | null> {
  const inv = soInvoiceAddress(h);
  return {
    DeliverAddr1: inv.InvAddr1,
    DeliverAddr2: inv.InvAddr2,
    DeliverAddr3: inv.InvAddr3,
    DeliverAddr4: inv.InvAddr4,
  };
}

export function soEditHeader(
  h: Record<string, unknown>,
  salespersonName: string | null,
  lines: ErpLine[],
  outstandingSen: number | null,
  paymentRefs: readonly ErpPaymentRef[],
  touchedFields: readonly string[] = [],
): Record<string, string | null | Record<string, string>> {
  const out: Record<string, string | null | Record<string, string>> = present({
    DebtorName: (h.debtor_name as string) ?? null,
    Attention: (h.debtor_name as string) ?? null,
    Ref: soReference(h),
    Phone1: (h.phone as string) ?? null,
    DeliverPhone1: (h.emergency_contact_phone as string) ?? null,
    ...soInvoiceAddress(h),
    ...deliverAddressOf(h),
    SalesExemptionExpiryDate: acUdfDate(h.customer_delivery_date as string | null | undefined),
  });
  const agent = resolveAcAgent((h.agent as string) ?? null, salespersonName);
  if (agent) out.Agent = agent;
  const loc = bookSpellingOrOwn((h.sales_location as string) ?? null, LOCATION_MAP);
  if (loc) out.SalesLocation = loc;
  if (h.so_date) out.DocDate = String(h.so_date);

  const udf: Record<string, string> = {};
  const branding = bookSpelling(soBranding((h.branding as string) ?? null, lines), BRANDING_MAP);
  if (branding) udf.BRANDING = branding;
  const venue = bookSpellingOrOwn((h.venue as string) ?? null, VENUE_MAP);
  if (venue) udf.VENUE = venue;
  /* The SO's "Processing date" — the date this order is RELEASED for purchasing
     to order goods (owner 2026-08-18; also the owner's 账目日期). Owner
     2026-08-12: editing it in the ERP must reach AutoCount. Same omit-when-absent
     rule as the rest of this function — a cleared date sends nothing rather than
     blanking the account book's value, which is the conservative half of the pair
     and the one that cannot destroy data.

     `PDate` IS AUTOCOUNT'S OWN NAME, NOT OURS — DO NOT "UNIFY" IT. Every other
     name for this date is being collapsed onto `processing_date` /
     `processingDate`; this one belongs to the other system and stays. Renaming
     it does not rename anything in AutoCount — the connector drops an unknown
     UDF, the edit posts 200, and the date silently stops arriving in the account
     book. See SO_PROCESSING_DATE_AC_UDF. */
  const pdate = acUdfDate(h[SO_PROCESSING_DATE_COLUMN] as string | null | undefined);
  if (pdate) udf[SO_PROCESSING_DATE_AC_UDF] = pdate;
  const balance = acUdfMoney(outstandingSen);
  if (balance != null) udf.BALANCE = balance;

  const cleared = clearedAcKeys(touchedFields, h);
  for (const key of cleared.header) out[key] = null;
  for (const key of cleared.udf) udf[key] = '';
  const payement = composePaymentUdf(paymentRefs);
  if (payement) udf.PAYEMENT = payement;
  if (Object.keys(udf).length) out.UDF = udf;

  return out;
}
