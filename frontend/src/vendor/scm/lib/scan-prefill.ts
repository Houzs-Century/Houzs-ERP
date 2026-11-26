
import { normalizePhone } from '@2990s/shared/phone';
import type { ExtractedSlip } from '../components/ScanOrderModal';
import { findNearestSku, type SkuMatchSource } from './sku-nearest-match';

export const CATEGORY_TO_GROUP: Record<string, string> = {
  SOFA: 'sofa',
  BEDFRAME: 'bedframe',
  MATTRESS: 'mattress',
  ACCESSORY: 'accessory',
  SERVICE: 'service',
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Owner rule (spec 6, 2026-06-24) — a card paid through a bank (Merchant) with
   NO written month/tenure defaults to "One Shot", NOT a 12-month plan. Only an
   explicitly-written tenure seeds N months. The value MUST equal the
   installment_plan "One Shot" option VALUE seeded for this category. */
export const ONE_SHOT_PLAN = 'One Shot';

export type ReconcileSku = { code: string; name: string; category: string };
export type ReconcileVenue = { id: string; name: string };
export type ReconcileOption = { value: string };

export type ReconcilePaymentCatalogs = {
  paymentMethod:   ReconcileOption[];
  paymentMerchant: ReconcileOption[];
  onlineType:      ReconcileOption[];
  installmentPlan: ReconcileOption[];
};

export type ReconcileCatalogs = ReconcilePaymentCatalogs & {
  skus:         ReconcileSku[];
  venues:       ReconcileVenue[];
  customerType: ReconcileOption[];
  buildingType: ReconcileOption[];
  states:       string[];
};

export type ReconciledPayment = {
  methodValue:      string;
  bankValue:        string;
  installmentLabel: string;
  onlineTypeValue:  string;
  approvalCode:     string;
  depositRm:        number;
};

export type ReconciledLine = {
  itemCode:      string;
  itemGroup:     string;
  description:   string;
  qty:           number;
  unitPriceRm:   number;
  rawText:       string;
  fabricCode:    string;
  suggestedCode: string;
  matchSource:   SkuMatchSource | null;
  confidence:    number;
  specialCodes:  string[];
};

export type ReconciledPrefill = {
  customerName:    string;
  phones:          string[];
  address1:        string;
  addressState:    string;
  addressCity:     string;
  addressPostcode: string;
  customerSoRef:   string;
  note:            string;
  deliveryDate:    string | null;
  slipDate:        string | null;
  customerType:    string;
  buildingType:    string;
  venueId:         string;
  venueText:       string;
  salesRep:        string;
  payment:         ReconciledPayment | null;
  lines:           ReconciledLine[];
};

function snapValue(value: string | null | undefined, options: ReconcileOption[]): string {
  const v = (value ?? '').trim();
  if (v === '') return '';
  const exact = options.find((o) => o.value === v);
  if (exact) return exact.value;
  const ci = options.find((o) => o.value.toLowerCase() === v.toLowerCase());
  return ci ? ci.value : v;
}

function snapState(value: string | null | undefined, states: string[]): string {
  const v = (value ?? '').trim();
  if (v === '') return '';
  const exact = states.find((s) => s === v);
  if (exact) return exact;
  const ci = states.find((s) => s.toLowerCase() === v.toLowerCase());
  return ci ? ci : v;
}

export function resolveVenueId(
  venues: ReconcileVenue[],
  locationMatch: string,
  rawLocation: string,
): string {
  const candidates = [locationMatch, rawLocation]
    .map((s) => (s ?? '').trim().toLowerCase())
    .filter((s) => s !== '');
  if (candidates.length === 0 || venues.length === 0) return '';

  for (const cand of candidates) {
    const exact = venues.find((v) => v.name.trim().toLowerCase() === cand);
    if (exact) return exact.id;
  }
  for (const cand of candidates) {
    const contains = venues.find((v) => {
      const name = v.name.trim().toLowerCase();
      if (name === '') return false;
      const a = name.length <= cand.length ? name : cand;
      const b = name.length <= cand.length ? cand : name;
      return a.length >= 3 && b.includes(a);
    });
    if (contains) return contains.id;
  }
  return '';
}

export function reconcilePayment(
  ex: ExtractedSlip,
  catalogs: ReconcilePaymentCatalogs,
): ReconciledPayment | null {
  const rawPmValue = ex.paymentMethodMatch?.value ?? '';
  const foldedMethod = rawPmValue === 'Installment' ? 'Merchant' : rawPmValue;
  const methodValue = snapValue(foldedMethod, catalogs.paymentMethod);
  if (!methodValue) return null;
  const isMerchant = methodValue === 'Merchant';
  const planValue = ex.installmentPlanMatch?.value ?? '';
  return {
    methodValue,
    bankValue:        snapValue(ex.bankMatch?.value ?? '', catalogs.paymentMerchant),
    installmentLabel: isMerchant ? (planValue || ONE_SHOT_PLAN) : '',
    onlineTypeValue:  snapValue(ex.onlineTypeMatch?.value ?? '', catalogs.onlineType),
    approvalCode:     ex.approvalCode ?? '',
    depositRm:        ex.depositRm ?? 0,
  };
}

export function reconcileScanPrefill(
  ex: ExtractedSlip,
  catalogs: ReconcileCatalogs,
): ReconciledPrefill {

  const phones = (ex.phones ?? [])
    .map((p) => normalizePhone(p) ?? '')
    .filter((p) => p.trim() !== '');

  const venueId = resolveVenueId(
    catalogs.venues,
    ex.locationMatch?.value ?? '',
    ex.location ?? '',
  );

  const noteParts: string[] = [];
  if (ex.remarks) noteParts.push(ex.remarks);

  return {
    customerName: ex.customerName ?? '',
    phones,
    address1: ex.addressLine1 ?? ex.address ?? '',
    addressState:    snapState(ex.addressStateMatch?.value ?? '', catalogs.states),
    addressCity:     ex.city ?? '',
    addressPostcode: ex.postcode ?? '',
    customerSoRef:   ex.customerSoRef ?? '',
    note: noteParts.join('\n'),
    deliveryDate:   ex.deliveryDate && ISO_DATE_RE.test(ex.deliveryDate) ? ex.deliveryDate : null,
    slipDate:       ex.slipDate && ISO_DATE_RE.test(ex.slipDate) ? ex.slipDate : null,
    customerType: snapValue(ex.customerTypeMatch?.value ?? '', catalogs.customerType),
    buildingType: snapValue(ex.buildingTypeMatch?.value ?? '', catalogs.buildingType),
    venueId,
    venueText: ex.location ?? '',
    salesRep: ex.salesRep ?? '',
    payment: reconcilePayment(ex, catalogs),
    lines: (ex.lines ?? []).map((l) => {
      const code = l.skuMatch?.code ?? '';
      /* Owner's rule (2026-08-05 handoff §2.3): resolve to the NEAREST picker
         entry, not just an exact hit. The old lookup was a single
         case-insensitive equality, so a code the reader got substantially right
         — different spacing, a dropped bracket, one misread character — landed
         as no match and the operator re-picked a SKU that had, in substance,
         already been found. findNearestSku refuses on any ambiguity, so this
         can only ever turn a NO-match into a match, never one match into a
         different one. */
      const { sku: matched, source: matchSource } = findNearestSku(code, catalogs.skus);
      const sku = matched ?? undefined;
      return {
        itemCode: sku?.code ?? '',
        itemGroup: sku ? (CATEGORY_TO_GROUP[sku.category] ?? 'others') : 'others',
        description: sku?.name ?? '',
        matchSource,
        qty: l.qtyGuess > 0 ? l.qtyGuess : 1,
        unitPriceRm: l.priceRmGuess ?? 0,
        rawText: l.rawText,
        fabricCode: l.fabricMatch?.code ?? '',
        suggestedCode: code,
        confidence: l.skuMatch?.confidence ?? 0,
        specialCodes: Array.isArray(l.specialsMatch)
          ? l.specialsMatch.map((s) => s.code).filter(Boolean)
          : [],
      };
    }),
  };
}
