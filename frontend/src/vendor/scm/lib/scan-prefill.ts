// ----------------------------------------------------------------------------
// scan-prefill — ONE shared reconciler for the handwritten-slip OCR → New SO
// prefill mapping, used by BOTH the desktop ScanOrderModal and the mobile
// MobileScan/MobileNewSO paths.
//
// WHY THIS FILE EXISTS
// The OCR EXTRACTION (the Claude-vision prompt) is already shared server-side
// (backend scan-so.ts). But the CLIENT-SIDE mapping of the extract result into
// the New SO form had DRIFTED between the two platforms:
//   - Desktop reconciled the raw OCR values to real catalog values (venue text
//     -> venue id, dropdown VALUE snapping, SOFA specialCodes, a structured
//     bank / plan / One-Shot payment block) before they reached the SO, which
//     is why desktop OCR "worked".
//   - Mobile took the raw strings with little reconciliation (no venue resolve,
//     no specialCodes, only method/amount/approval on payment, and its consumer
//     re-guarded dropdown values against STALE hardcoded lists), so scanned
//     values didn't match the maintained catalog -> "mobile OCR doesn't work".
//
// reconcileScanPrefill() is the single source of truth for that mapping. It is
// a PURE function (no hooks, no fetch) — every catalog it needs is passed in as
// an argument, so it runs identically in the desktop modal and in mobile's
// headless enqueue/legacy path, and is unit-testable.
//
// Value snapping is NON-DESTRUCTIVE (see snapValue): a value that already
// belongs to the live catalog is canonicalised to the catalog casing; a value
// the live list doesn't (yet) contain is kept as-is. Because the server already
// matched every dropdown value against the SAME maintained catalog these lists
// come from, snapping is a no-op for the desktop reference output — it only
// stops the mobile consumer from silently dropping a valid catalog value it
// didn't recognise.
// ----------------------------------------------------------------------------

import { normalizePhone } from '@2990s/shared/phone';
import type { ExtractedSlip } from '../components/ScanOrderModal';
import { findNearestSku, type SkuMatchSource } from './sku-nearest-match';

/* mfg_product_category -> SO line item_group (SoLineCard lowercases the product
   category; SERVICE lines carry item_group='service'). */
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

/* ── Catalog inputs (all passed in by the caller — keeps this pure) ────────── */
export type ReconcileSku = { code: string; name: string; category: string };
export type ReconcileVenue = { id: string; name: string };
/* Any option list with a `.value` — SoDropdownOption structurally satisfies it,
   so callers pass optionsOrFallback(...) directly. */
export type ReconcileOption = { value: string };

/* The option catalogs the payment block reconciles against. */
export type ReconcilePaymentCatalogs = {
  paymentMethod:   ReconcileOption[];
  paymentMerchant: ReconcileOption[];
  onlineType:      ReconcileOption[];
  installmentPlan: ReconcileOption[];
};

export type ReconcileCatalogs = ReconcilePaymentCatalogs & {
  /* From the /scan-so/extract response (d.catalog.skus) — resolves a matched
     SKU code to its display name + category. */
  skus:         ReconcileSku[];
  /* The SAME useVenues() master the New SO form's Venue dropdown renders. Pass
     [] when the platform's venue field is free-text (mobile) — venueText still
     carries the raw slip location so nothing is lost. */
  venues:       ReconcileVenue[];
  customerType: ReconcileOption[];
  buildingType: ReconcileOption[];
  /* distinctStates(localities) — the live my_localities state list the form's
     State dropdown renders. */
  states:       string[];
};

/* Structured payment (superset of both platforms' needs). depositRm is kept in
   RM (not centi) so the mapping stays currency-shape-agnostic — each caller
   formats/rounds it into its own row shape. */
export type ReconciledPayment = {
  methodValue:      string;
  bankValue:        string;
  installmentLabel: string;
  onlineTypeValue:  string;
  approvalCode:     string;
  depositRm:        number;
};

export type ReconciledLine = {
  itemCode:      string;   // '' when no SKU matched — operator picks in the form
  itemGroup:     string;   // 'sofa' | 'bedframe' | ... | 'others'
  description:   string;   // matched SKU name ('' = no match)
  qty:           number;
  unitPriceRm:   number;   // RM (each caller rounds to centi as needed)
  rawText:       string;   // verbatim slip row (source of truth for the edit-gate)
  fabricCode:    string;
  suggestedCode: string;   // the SKU code Claude suggested ('' = none)
  /* HOW itemCode was filled: 'exact' is the reader's code found verbatim in the
     catalog, the other three are near matches resolved by findNearestSku, null
     is no match. Carried through the prefill so a surface that AUTO-COMMITS the
     SKU can mark a near match for review — a fuzzy fill that looks identical to
     an exact one is how a wrong SKU reaches a sales order unnoticed. Mobile does
     not auto-commit (MobileNewSO seeds the line's NAME and leaves the picker to
     the operator), so there it is carried for the learning pairing. */
  matchSource:   SkuMatchSource | null;
  confidence:    number;
  specialCodes:  string[]; // configured SOFA special-add-on CODES (already model-gated server-side)
};

/* The fully-reconciled, platform-neutral prefill. Each platform adapts this to
   its own prefill shape (desktop ScanPrefill / mobile MobileScanPrefill). */
export type ReconciledPrefill = {
  customerName:    string;
  phones:          string[];       // canonical +60 E.164 (first = main)
  address1:        string;
  addressState:    string;         // snapped my_localities state VALUE ('' = none)
  addressCity:     string;
  addressPostcode: string;
  customerSoRef:   string;
  note:            string;
  deliveryDate:    string | null;  // only when a clean YYYY-MM-DD
  processingDate:  string | null;
  customerType:    string;         // snapped customer_type VALUE ('' = none)
  buildingType:    string;         // snapped building_type VALUE ('' = none)
  venueId:         string;         // resolved venue id ('' = no confident match)
  venueText:       string;         // raw slip location (free-text venue fallback)
  salesRep:        string;
  payment:         ReconciledPayment | null;
  lines:           ReconciledLine[];
};

/* Non-destructive value snap: canonicalise `value` to the catalog's casing when
   the catalog contains it (exact first, then case-insensitive), otherwise keep
   the value unchanged. Never invents and never drops — a value the live list
   doesn't recognise survives verbatim (matching the desktop reference, which
   passed the server-matched value straight through). */
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

/* ── Venue unify helper ─────────────────────────────────────────────────
   Resolve the OCR's venue text to a REAL venue id from the SAME useVenues()
   master the New SO form's Venue dropdown renders. Try, in order, the server's
   so_dropdown_options match value (locationMatch) then the raw location text,
   against each venue's name (case-insensitive, trim). A confident hit returns
   the venue id; no hit returns '' so the form keeps its salesperson-default
   venue (never a wrong forced pick). Substring matching is intentionally
   conservative: only when one side fully contains the other AND the shorter side
   is at least 3 chars, so "PJ" never collides with a longer unrelated name. */
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
    // Exact name match first (the dropdown's source of truth).
    const exact = venues.find((v) => v.name.trim().toLowerCase() === cand);
    if (exact) return exact.id;
  }
  for (const cand of candidates) {
    // Conservative containment — only with a meaningful overlap length.
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

/* Reconcile ONE extracted slip's payment fields into the structured payment
   block, or null when the slip carries no payment. Shared by the full-prefill
   reconcile below AND mobile's per-payment-slip loop (each additional payment
   slip is OCR'd in its own /extract call and reconciled identically).

   3-method model (spec 1 + 6, 2026-06-24) — top-level method is only Merchant /
   Online / Cash; "Installment" is no longer a returnable method (a bank EPP is
   Merchant + an installment plan). Fold any legacy "Installment" match to
   Merchant so a stale backend never seeds a dropped method. A Merchant card with
   no matched tenure defaults to "One Shot" (a plain swipe is a one-shot Merchant
   payment, not a 12-month plan); an explicitly-matched plan wins; Online / Cash
   carry no plan. */
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
    /* Plan default (spec 6) — a Merchant card with no matched tenure seeds "One
       Shot". Kept verbatim (not snapped) because "One Shot" is a maintained
       installment_plan VALUE that need not exist in a fallback list. */
    installmentLabel: isMerchant ? (planValue || ONE_SHOT_PLAN) : '',
    onlineTypeValue:  snapValue(ex.onlineTypeMatch?.value ?? '', catalogs.onlineType),
    approvalCode:     ex.approvalCode ?? '',
    depositRm:        ex.depositRm ?? 0,
  };
}

/* THE shared reconciler: raw extracted slip + live catalogs -> fully-reconciled,
   platform-neutral New SO prefill. Pure. */
export function reconcileScanPrefill(
  ex: ExtractedSlip,
  catalogs: ReconcileCatalogs,
): ReconciledPrefill {

  /* Seed phones in canonical +60 E.164 so the New SO PhoneInput's country
     selector resolves to Malaysia, never US +1 (the OCR returns the national
     form which, plus-less, the dial-code split would mis-claim as US).
     normalizePhone prepends +60 (any explicit international number is preserved). */
  const phones = (ex.phones ?? [])
    .map((p) => normalizePhone(p) ?? '')
    .filter((p) => p.trim() !== '');

  const venueId = resolveVenueId(
    catalogs.venues,
    ex.locationMatch?.value ?? '',
    ex.location ?? '',
  );

  /* Note carries ONLY the genuine order remark. Venue, payment, deposit, total,
     sales rep and extra phones all have their own dedicated fields, so they must
     NOT be piled into the Note (owner: it over-stuffed the Note). */
  const noteParts: string[] = [];
  if (ex.remarks) noteParts.push(ex.remarks);

  return {
    customerName: ex.customerName ?? '',
    phones,
    /* Prefer the parsed street-only addressLine1 so State/City/Postcode don't
       double up in Address Line 1; fall back to the full address string. */
    address1: ex.addressLine1 ?? ex.address ?? '',
    addressState:    snapState(ex.addressStateMatch?.value ?? '', catalogs.states),
    addressCity:     ex.city ?? '',
    addressPostcode: ex.postcode ?? '',
    customerSoRef:   ex.customerSoRef ?? '',
    note: noteParts.join('\n'),
    deliveryDate:   ex.deliveryDate && ISO_DATE_RE.test(ex.deliveryDate) ? ex.deliveryDate : null,
    processingDate: ex.processingDate && ISO_DATE_RE.test(ex.processingDate) ? ex.processingDate : null,
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
        /* Owner core rule (Task #73) — a NO-MATCH line seeds an EMPTY, unpicked
           product so the New SO form renders the SKU picker the operator is
           forced to fill; the rawText still rides along below. A MATCHED line
           keeps its picked SKU name. */
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
