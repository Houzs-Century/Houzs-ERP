import { formatPhone } from '@2990s/shared/phone';
import { buildVariantSummary } from '@2990s/shared';
import type { RowInput } from 'jspdf-autotable';
import {
  allocatePwpTriggerNotes,
  orderSofaModuleRowsWithinBuilds,
  pwpRewardNote,
  soLineGroupRank,
  type SoPwpCodeRow,
} from '@2990s/shared/so-line-display';
import {
  COMPANY,
  deliverPdf,
  DOC_TABLE_HEAD_STYLES,
  DOC_TABLE_STYLES,
  drawHeader,
  drawInfoColumns,
  amountInWordsMyr,
  ensurePdfCjkFont,
  fmtDocDate,
  fmtRm,
  safeName,
  type PdfAction,
} from './pdf-common';
import { billToBlock } from './pdf-party-blocks';
import { loadFabricDescriptionMap, loadFabricSupplierMap } from './supplier-doc-data';
import { composeSoLineDescription } from './so-line-description';
import {
  appendPhotoMarker,
  blobToSquarePdfImage,
  buildPhotoGroups,
  collectPhotoImages,
  drawItemPhotosBlock,
  photoKeyOwners,
  photoKeysOf,
  type PdfPhotoImage,
} from './pdf-item-photos';
import { fetchSoItemPhotoBlob } from './sales-order-queries';
import { THUMB_KEY_SUFFIX } from '../../../lib/imagePipeline';
import {
  ensureBrandingLogoLoaded,
  ensureBrandLogoLoaded,
  getBrandLogoCache,
} from '../../../lib/branding';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from './status-pill';

// ----------------------------------------------------------------------------
// Sales Order PDF generator — dynamic jspdf import so it doesn't bloat the
// main bundle. ~430 kB on its own (gzipped 143 kB); rendered into a vendor
// chunk by Vite's automatic chunk-splitter.
//
// 2026-06-12 REBUILD — layout mirrors the POS customer printout
// (apps/pos/src/pages/SalesOrderPrint.tsx), the document the owner signed
// off as the SO gold standard. INTERNAL + CUSTOMER-facing: our codes only,
// NO supplier data ever.
//
// Layout (A4 portrait):
//   1. Header: real letterhead (pdf-common COMPANY = legal.ts COMPANY_LEGAL)
//      left; SALES ORDER + SO no / date / status right
//   2. ORDER REFERENCE / DELIVERY ESTIMATE meta blocks (processing date +
//      delivery date — "To be confirmed" when null, like POS)
//   3. BILL TO / SOLD BY columns (delivery address = ship_to_address ??
//      address1-4; phone; family/emergency contact; agent + sales location)
//   4. Line items table: ONE ROW PER SO LINE ITEM (no sofa-build folding),
//      ordered SOFA+MATTRESS → BEDFRAME → ACCESSORY → others → SERVICE last.
//      SKU | Description (desc / description2 or remark / specs line —
//      fabric code enriched with the fabric_trackings description; PWP
//      notes after) | Qty | Unit | Disc | Line Total. A line carrying
//      photo_urls appends " (photo)" to its first description line.
//   4b. ITEM PHOTOS — row-number-keyed thumbnail groups for the
//      lines that carry photos (shared pdf-item-photos module); absent when
//      no line has photos
//   5. PAYMENTS RECEIVED ledger (mfg_sales_order_payments rows)
//   6. Totals: SUBTOTAL / PAID TO DATE / TOTAL / BALANCE DUE
//   7. Customer signature (stored signature_b64 image when present) +
//      name · phone, company authorised signature
//   8. Numbered terms — RECEIPT_TERMS wording from apps/pos/src/lib/legal.ts
//   9. Footer: doc no · portal label · page n of m
// ----------------------------------------------------------------------------

type SoHeader = {
  doc_no: string;
  so_date: string;
  status: string;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  branding: string | null;
  venue: string | null;
  ref: string | null;
  po_doc_no: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  mattress_sofa_sen: number;
  bedframe_sen: number;
  accessories_sen: number;
  others_sen: number;
  local_total_sen: number;
  /* Expected deposit target the commander sets on the SO. Distinct from
     amounts actually collected — those live in the payments ledger below. */
  deposit_sen?: number;
  line_count: number;
  currency: string;
  note: string | null;
  /* 2026-06-12 rebuild — POS-printout parity fields. All optional: every
     caller passes the raw GET /mfg-sales-orders/:docNo row verbatim, and the
     Consignment Order reuse path (no such columns) simply omits them. */
  sales_location?: string | null;
  customer_po?: string | null;
  customer_delivery_date?: string | null;
  processing_date?: string | null;
  ship_to_address?: string | null;
  email?: string | null;
  city?: string | null;
  postcode?: string | null;
  customer_state?: string | null;
  /* Second/family contact — the SO schema has no phone2/contact column; the
     emergency_contact_* trio (POS handover "Emergency" phase) is the family
     contact and prints as such. */
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  emergency_contact_relationship?: string | null;
  /* Owner batch 2026-07 — ORDER DETAILS additions. Stamped by GET /:docNo
     (scm.staff lookup on salesperson_id); optional so the Consignment Order
     reuse path (no such columns) simply omits them and the rows don't print. */
  salesperson_name?: string | null;
  salesperson_phone?: string | null;
  /* Authoritative received-to-date rollup stamped by GET /:docNo (ledger +
     legacy header deposit). Falls back to summing `payments` when absent. */
  paid_sen_total?: number | null;
  /* POS handover customer signature (data-URL or bare base64 PNG). */
  signature_b64?: string | null;
  /* Owner 2026-07 — brand letterhead. Stamped by GET /:docNo (SOFA→ZANOTTI,
     else first-item description-prefix match against project_brands). When
     set, the SO letterhead prints THIS brand's logo instead of the company
     logo (company stays the fallback). Optional so the Consignment Order
     reuse path simply omits it. */
  resolvedBrandLogoKey?: string | null;
  resolved_brand_logo_key?: string | null;
};

type SoItem = {
  id: string;
  item_group: string;
  item_code: string;
  description: string | null;
  description2?: string | null;
  uom: string;
  qty: number;
  unit_price_sen: number;
  discount_sen: number;
  total_sen: number;
  variants: Record<string, unknown> | null;
  remark?: string | null;
  /* A retired line. GET /:docNo returns cancelled rows along with the live ones
     (it is the SO's history), so every caller hands them to this generator —
     see the filter at the top of renderSalesOrderInto. Optional because older
     callers pass rows that predate the column. */
  cancelled?: boolean | null;
  /* Line reference photos (R2 keys, mfg_sales_order_items.photo_urls).
     Optional so callers that predate the column (Consignment Order reuse)
     stay valid. When present the row's first description line gains the
     " (photo)" marker and the ITEM PHOTOS block prints the `.thumb` siblings. */
  photo_urls?: string[] | null;
};

/* Mirrors flow-queries.ts `SoPayment`. Re-declared here to keep the PDF
   helper free of TanStack/Supabase imports — it's called from both the
   detail page (where the hook supplies the data) and the list page (where
   a one-shot fetch supplies it). Fields the PDF doesn't render are still
   accepted so callers can pass the row verbatim. */
type SoPayment = {
  paid_at: string;
  /* 2026-06-06 payment-method unify — 'installment' is first-class. */
  method: 'merchant' | 'transfer' | 'cash' | 'installment';
  /* Task #122 (cascade) — merchant_provider / installment_months are now
     open string + integer (driven by the so_dropdown_options cascade
     categories). online_type is the new Online sub-type column. */
  merchant_provider: string | null;
  installment_months: number | null;
  online_type?: string | null;
  approval_code: string | null;
  amount_sen: number;
  account_sheet: string | null;
  collected_by_name: string | null;
  note: string | null;
};

/* Numbered T&C — copied verbatim from apps/pos/src/lib/legal.ts
   RECEIPT_TERMS (the POS printout is the legal record; keep in sync). */
/* `noun` lets the Consignment Order reuse this template without printing
   "sales order" wording (Commander 2026-06-19 — same fix Hookka shipped). */
const receiptTerms = (noun: string): readonly string[] => [
  `This ${noun} becomes a binding tax invoice once goods are delivered and full payment is reconciled.`,
  'Balance due is payable in full before delivery. Bank transfer, DuitNow QR, and cheque accepted.',
  'Delivery date is best-effort and may shift ±3 working days subject to operation confirmation.',
  `Stair-carry surcharges (if any) are billed on this ${noun} and are not invoiced separately on the DO.`,
  'Once the delivery date has been confirmed, any subsequent request to change or extend the date will incur a rescheduling surcharge.',
];

/* The variant keys that can carry an internal fabric code, mirrored from
   supplier-doc-data's FABRIC_VARIANT_KEYS. The SO PDF maps each present code
   to "CODE — fabric_trackings.fabric_description" (customer-readable). */
const FABRIC_VARIANT_KEYS = ['fabricCode', 'colorCode', 'fabricColor'] as const;

/** Collect internal fabric codes riding in the items' variants JSONB. */
const collectFabricCodes = (items: SoItem[]): string[] => {
  const codes = new Set<string>();
  for (const it of items) {
    const v = it.variants;
    if (!v || typeof v !== 'object') continue;
    for (const key of FABRIC_VARIANT_KEYS) {
      const raw = v[key];
      if (typeof raw === 'string' && raw.trim()) codes.add(raw.trim());
    }
  }
  return [...codes];
};

/* Specs line for an item: the shared buildVariantSummary (same string every
   grid shows — fabric / DIVAN+LEG / GAP / SEAT / SPECIAL) with each fabric
   code enriched to "EZ-001 — <fabric_description>" when the Fabric Tracking
   master knows it. Returns '' when the line has no variants object —
   description2 prints on its own line, so no fallback to it here. */
const variantLine = (
  it: SoItem,
  fabricDescMap: Map<string, string>,
  fabricExtMap: Map<string, string>,
): string => {
  const v = it.variants;
  if (!v || typeof v !== 'object') return '';
  let mapped: Record<string, unknown> = v;
  for (const key of FABRIC_VARIANT_KEYS) {
    const raw = v[key];
    if (typeof raw === 'string' && raw.trim()) {
      const code = raw.trim();
      const ext = fabricExtMap.get(code);   // supplier's EXTERNAL colour code
      const desc = fabricDescMap.get(code);  // our fabric_description
      if (ext || desc) {
        if (mapped === v) mapped = { ...v }; // clone once, on demand
        // Owner format ruling 2026-07-24 (screenshots, "还是有很多个地方没有跟着改
        // 过来"): the PDF must print the SAME final fabric format as the shared
        // on-screen summary — description joined bare, supplier parens LAST:
        // "CG-001 Pearl (KN390-1)". So the supplier code is no longer spliced
        // inline here; it is stamped as variants.fabricSupplierCode and
        // buildVariantSummary appends the parens at the end of the segment
        // (the single place that rule lives). Strip a redundant leading code
        // from the description ("EZ-008 Forest") so it doesn't read
        // "EZ-008 EZ-008 Forest" (Commander 2026-06-19, 2026-06-16).
        const cleanDesc = desc && desc.toLowerCase().startsWith(code.toLowerCase())
          ? desc.slice(code.length).trim()
          : desc;
        mapped[key] = `${code}${cleanDesc ? ` ${cleanDesc}` : ''}`;
        if (ext && !(mapped as Record<string, unknown>).fabricSupplierCode) {
          (mapped as Record<string, unknown>).fabricSupplierCode = ext;
        }
      }
    }
  }
  return buildVariantSummary(it.item_group ?? null, mapped);
};

/* Owner row-order rule (2026-06-12): SOFA + MATTRESS first (stored relative
   order preserved), then BEDFRAME, then ACCESSORY, then any other group,
   then SERVICE always LAST. Lifted to @2990s/shared/so-line-display
   (soLineGroupRank) so the SO create path persists the same rank order this
   PDF prints. */
const groupRank = soLineGroupRank;

/* Human-readable method label for the PDF Payments table.
   - merchant → "Merchant (GHL)" or "Merchant (GHL) · 6m installment"
   - transfer → "Online (TNG)" etc.
   - cash     → "Cash"
   Mirrors the on-screen METHOD_LABEL + provider/installment pill in
   SalesOrderDetail's PaymentCard but flattened to a single cell. */
const methodLabel = (p: SoPayment): string => {
  if (p.method === 'merchant') {
    const base = p.merchant_provider ? `Merchant (${p.merchant_provider})` : 'Merchant';
    return p.installment_months ? `${base} · ${p.installment_months}m installment` : base;
  }
  /* Task #122 (cascade) — surface the Online sub-type (Bank Transfer /
     TNG / Cheque / DuitNow) so the printed PDF reads as the user actually
     filed it, not a generic "Bank Transfer". */
  if (p.method === 'transfer') return p.online_type ? `Online (${p.online_type})` : 'Online';
  /* 2026-06-06 payment-method unify — installment rows print their term. */
  if (p.method === 'installment') {
    const base = p.merchant_provider ? `Installment (${p.merchant_provider})` : 'Installment';
    return p.installment_months ? `${base} · ${p.installment_months}m` : base;
  }
  return 'Cash';
};

/* Follow-up #83 introduced save / print / preview delivery HERE; every other
   document's generator only knew doc.save(). The Print preview rollout
   (2026-08-06) needs all of them to offer the same three exits, so the type and
   the iframe/blob plumbing now live in pdf-common alongside the letterhead
   helpers. Re-exported so the SO's existing importers keep their import path. */
export type { PdfAction } from './pdf-common';

type JsPdf = import('jspdf').jsPDF;
type AutoTableFn = (typeof import('jspdf-autotable'))['default'];

/* Draw ONE sales order's content into `doc` (letterhead → meta → items →
   payments → totals → signatures → terms → footer). Does NOT create the doc,
   save / output / preview — the caller finalizes ONCE, so several SOs can share
   one doc (batch "Export PDF" → one combined file). Mirrors the
   renderPurchaseOrderInto precedent in purchase-order-pdf.ts.

   The footer loop iterates ONLY this doc's pages (`startPage`…end), so the
   per-SO doc no / portal label / "Page p of N" line stays correct when several
   SOs are appended to one document. */
export async function renderSalesOrderInto(
  doc: JsPdf,
  autoTable: AutoTableFn,
  header: SoHeader,
  allItems: SoItem[],
  payments: SoPayment[] = [],
  /* PWP vouchers this SO's trigger items issued (GET /:docNo `pwpCodes`) —
     used to mark trigger lines. Optional so older callers stay valid. */
  pwpCodes: SoPwpCodeRow[] = [],
  opts?: { docTitle?: string; docNoLabel?: string; docNoun?: string },
): Promise<void> {
  /* A cancelled line must never reach a CUSTOMER document — not as a printed
     row and not inside a total. The gate lives HERE, in the one function both
     the single and the combined generator render through, rather than at the
     five callsites: the SO detail (desktop V2 filters, mobile did not), the SO
     list bulk print, and the consignment pages each build their own row list,
     and four of them are four chances to forget.

     GET /mfg-sales-orders/:docNo deliberately returns cancelled rows — they are
     the order's history and the detail screen may want to show them — so the
     filter belongs to whoever renders for the customer, which is this file.
     Production held zero cancelled rows until 2026-08-10 (PR #1937 reinstated
     two hard-deleted sofa modules as cancelled), so no print had ever met one.
     See docs/autocount-line-retirement-plan.md gap 4. */
  const items = allItems.filter((l) => !l.cancelled);

  // First page this SO occupies — the footer loop numbers from here so a
  // combined doc doesn't re-stamp earlier SOs' pages.
  const startPage = doc.getNumberOfPages();

  /* Fabric Tracking lookup (fail-soft, before any drawing): internal fabric
     code → fabric_description so the customer reads "EZ-001 — <description>"
     instead of a bare internal code. */
  const fabricDescMap = await loadFabricDescriptionMap(collectFabricCodes(items));
  /* Internal fabric code → supplier EXTERNAL colour code (Fabric Tracking), so
     the SO shows both like the supplier docs: "EZ-001 (KN390-1) — <desc>"
     (Commander 2026-06-16 — Fabric internal + external on the SO too). */
  const fabricExtMap = await loadFabricSupplierMap(collectFabricCodes(items));

  /* Printed row order, resolved BEFORE any drawing: the ITEM PHOTOS block is
     keyed by the row numbers the items table prints (#1, #2-4…) and the photo
     bytes must be in hand before drawing starts, so the ordering the table
     used to compute inline moved up here — the table below reads this same
     const. (Within a buildKey group the module rows print LEFT-TO-RIGHT, Loo
     2026-06-12 — the create path persists that order on new SOs; the in-place
     permute fixes SOs booked before it without moving any other row.) */
  const orderedItems = orderSofaModuleRowsWithinBuilds(
    [...items].sort((a, b) => groupRank(a.item_group) - groupRank(b.item_group)),
  );

  /* Owner spec 2026-08 — photos follow the line onto the printed document.
     Only `.thumb` siblings are fetched (never originals — PDF size), each
     photo best-effort: a key whose fetch or decode fails is skipped and the
     PDF renders without it. */
  const photoGroups = buildPhotoGroups(orderedItems.map((it) => ({
    code: it.item_code,
    photoKeys: photoKeysOf(it.photo_urls),
  })));
  const photoOwners = photoKeyOwners(orderedItems.map((it) => ({
    id: it.id,
    photoKeys: photoKeysOf(it.photo_urls),
  })));
  const photoImages: Map<string, PdfPhotoImage> = photoGroups.length > 0
    ? await collectPhotoImages(
        photoGroups,
        (key) => {
          const ownerId = photoOwners.get(key);
          if (!ownerId) return Promise.reject(new Error('photo_owner_missing'));
          return fetchSoItemPhotoBlob(header.doc_no, ownerId, key + THUMB_KEY_SUFFIX);
        },
        blobToSquarePdfImage,
      )
    : new Map<string, PdfPhotoImage>();

  /* Before ANY drawing, and after the print-time lookups so their text counts
     too: a customer name / delivery address / remark carrying CJK needs the
     font embedded up front, or helvetica paints the whole field as mojibake.
     No-op for a pure-WinAnsi SO. The photo marker + heading are WinAnsi by
     rule (pdf-item-photos.ts header) — a CJK char there re-fonts every
     photo-carrying document, which the owner refused on his first print. */
  await ensurePdfCjkFont(doc, [
    header, items, payments, fabricDescMap, fabricExtMap,
  ]);

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  /* Branding logo — make sure the module-level memo is warm BEFORE drawing
     (drawHeader reads it synchronously). Memoized + fail-soft inside: a
     multi-SO combined export awaits a resolved promise after the first doc,
     and a broken logo just renders the historic text-only header. */
  await ensureBrandingLogoLoaded();
  /* Brand letterhead (owner 2026-07) — GET /:docNo stamps the resolved brand
     logo key (SOFA→ZANOTTI, else first-item description-prefix match). Warm
     the per-key memo and pass the image to drawHeader IN PLACE OF the company
     logo. Fail-soft end to end: a missing/broken brand logo leaves the memo
     empty (getBrandLogoCache → null) and drawHeader falls back to the company
     logo, then the text-only header. Dual-read camelCase ?? snake_case (#1
     recurring bug). */
  const brandLogoKey =
    (header.resolvedBrandLogoKey ?? header.resolved_brand_logo_key ?? null) || null;
  if (brandLogoKey) await ensureBrandLogoLoaded(brandLogoKey);

  // ── Header (shared pdf-common letterhead) ─────────────────────────
  let y = drawHeader(doc, {
    docTitle: opts?.docTitle ?? 'SALES ORDER',
    rightMeta: [
      { label: opts?.docNoLabel ?? 'Doc No', value: header.doc_no },
      { label: 'Date', value: fmtDocDate(header.so_date) },
    ],
    logo: getBrandLogoCache(brandLogoKey),
  });

  // ── Resolve processing + delivery dates (folded into ORDER DETAILS below).
  /* Owner 2026-06-12 — Processing Date lives in processing_date: one column
     (0189), one name (0284). */
  const processingDate = header.processing_date ?? null;
  const deliveryDate = header.customer_delivery_date ?? null;

  // ── BILL TO + ORDER DETAILS (unified Hookka-tidy info block) ──────
  /* DELIVERY address rule (owner): ship_to_address wins; otherwise mirror
     the Detail page's Customer card EXACTLY — Address line 1, Address line 2,
     then ONE locality line "postcode city state" where city = city ?? address3
     and postcode = postcode ?? address4 (the PR #39 POS column mapping; the
     page never renders address3/address4 as raw lines).

     Owner 2026-06-12 ("crossed address") — POS-composed rows already carry
     the postcode/city/state INSIDE the address lines, so the old code printed
     them twice (and city == state on KL doubled again). Each locality part is
     appended ONLY when it doesn't already appear in the lines above, locality
     parts are deduped against each other, and exact-duplicate lines drop. */
  const baseAddressLines = (header.ship_to_address ?? '').trim()
    ? (header.ship_to_address as string).split('\n').map((s) => s.trim()).filter(Boolean)
    : [header.address1, header.address2]
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean);
  const addressHaystack = baseAddressLines.join(' ').toLowerCase();
  const localityParts: string[] = [];
  for (const part of [
    (header.postcode ?? header.address4 ?? '').trim(),
    (header.city ?? header.address3 ?? '').trim(),
    (header.customer_state ?? '').trim(),
  ]) {
    if (!part) continue;
    if (addressHaystack.includes(part.toLowerCase())) continue;   // already inside an address line
    if (localityParts.some((p) => p.toLowerCase() === part.toLowerCase())) continue; // e.g. city == state (KL)
    localityParts.push(part);
  }
  const seenAddressLines = new Set<string>();
  const addressLines = [...baseAddressLines, localityParts.join(' ')].filter((l) => {
    if (!l) return false;
    const k = l.toLowerCase();
    if (seenAddressLines.has(k)) return false;
    seenAddressLines.add(k);
    return true;
  });
  /* Family / second contact = the emergency_contact_* trio (POS handover
     "Emergency" phase). The SO schema has NO phone2/contact-person column —
     this is the only second-contact field family, so it prints here. */
  const familyContact = (header.emergency_contact_name ?? '').trim() || (header.emergency_contact_phone ?? '').trim()
    ? [
        (header.emergency_contact_name ?? '').trim(),
        (header.emergency_contact_phone ?? '').trim() ? formatPhone((header.emergency_contact_phone ?? '').trim()) : '',
        (header.emergency_contact_relationship ?? '').trim() ? `(${(header.emergency_contact_relationship ?? '').trim()})` : '',
      ].filter(Boolean).join(' · ')
    : null;
  const statusText = statusLabel('so', header.status);
  /* Owner batch 2026-07 — ORDER DETAILS additions. Dual-read camelCase ??
     snake_case (repo #1 recurring bug) since these fields are stamped onto the
     GET /:docNo payload. Blank values are skipped by drawInfoColumns, so a CO
     header (which has none of these) or a phone-less salesperson prints no
     empty ": -" row. */
  const hx = header as unknown as Record<string, unknown>;
  const s = (camel: string, snake: string): string => {
    const v = hx[camel] ?? hx[snake];
    return v == null ? '' : String(v).trim();
  };
  const salespersonName = s('salespersonName', 'salesperson_name');
  const salespersonPhone = s('salespersonPhone', 'salesperson_phone');
  const salespersonText = salespersonName
    ? [salespersonName, salespersonPhone ? formatPhone(salespersonPhone) : '']
        .filter(Boolean).join(' · ')
    : null;
  const emergencyPhone = s('emergencyContactPhone', 'emergency_contact_phone');
  const emergencyText = emergencyPhone ? formatPhone(emergencyPhone) : null;
  y = drawInfoColumns(doc, y,
    billToBlock({
      name: header.debtor_name,
      code: header.debtor_code,
      address: addressLines.join(', '),
      phone: header.phone ? formatPhone(header.phone) : null,
      email: header.email,
      /* Family / second contact is SO-only (POS handover's Emergency phase);
         slots into the party block via extras so the shared helper stays
         narrow to the canonical bill-to shape. */
      extras: [['Family', familyContact]],
      note: header.note,
    }),
    {
      title: 'ORDER DETAILS',
      rows: [
        [opts?.docNoLabel ?? 'Doc No', header.doc_no],
        ['Customer PO', header.customer_po ?? header.po_doc_no],
        ['Reference', header.ref],
        ['Agent', header.agent],
        ['Sales Location', header.sales_location],
        ['Venue', header.venue],
        /* Owner batch 2026-07 — salesperson name (· phone when scm.staff has
           one) + the customer's emergency contact phone. Value-gated: rows
           with no data don't print (drawInfoColumns skips blanks). */
        ['Salesperson', salespersonText],
        ['Emergency Contact', emergencyText],
        ['Branding', header.branding],
        ['Date', fmtDocDate(header.so_date)],
        ['Delivery Date', deliveryDate ? fmtDocDate(deliveryDate) : 'To be confirmed'],
        ['Processing Date', processingDate ? fmtDocDate(processingDate) : '—'],
        ['Status', statusText],
      ],
    },
  );

  // ── Line items table ─────────────────────────────────────────────
  /* Owner correction 2026-06-12 — ONE ROW PER SO LINE ITEM, exactly the
     items as stored ("有几个 SKU 就有几行"): no sofa-build folding, every
     SKU prints its own qty / unit price / disc / line total. Rows ordered
     by category (SOFA+MATTRESS → BEDFRAME → ACCESSORY → others → SERVICE
     last), stable within each group. Description cell = up to 3 lines:
       1. description ("SOFA BOOQIT 1B(LHF)")
       2. description2 / remark (when present)
       3. specs — fabric code — description / SEAT / LEG (variantLine)
     PWP notes (reward voucher consumed / trigger codes issued) come after. */
  /* orderedItems is computed up top (before drawing) so this table and the
     ITEM PHOTOS block share ONE row order — the photo chips point at these
     row numbers. */
  /* Each issued voucher prints ONCE across the whole doc — two lines of the
     same trigger SKU used to repeat the full list under both (SO-2606-013,
     Loo 2026-06-12). */
  const triggerNotesByLine = allocatePwpTriggerNotes(
    orderedItems.map((it) => [it.item_code]),
    pwpCodes,
  );
  const tableRows = orderedItems.map((it, itIdx) => {
    const notes = [
      pwpRewardNote(it.variants),
      ...(triggerNotesByLine[itIdx] ?? []),
    ].filter((n): n is NonNullable<typeof n> => n != null).map((n) => n.text);
    /* Description cell — the stored description2 and the recomputed `specs`
       (variantLine) are both buildVariantSummary outputs, so on a variant line
       they fully overlap. composeSoLineDescription prints the variant summary
       ONCE (the fresh, fabric-expanded `specs` preferred over the stored
       description2) so a split-sofa module line no longer shows SEAT/SPECIAL
       twice (Loo 2026-06-13); it also keeps the legacy remark dedup. */
    const composed = composeSoLineDescription({
      description: it.description ?? it.item_code,
      description2: (it.description2 ?? '').trim(),
      specs: variantLine(it, fabricDescMap, fabricExtMap) ?? '',
      remark: typeof it.remark === 'string' ? it.remark : null,
      notes,
    });
    /* Owner spec: a row carries NO image — the " (photo)" marker on the first
       description line points the reader at the ITEM PHOTOS block below. */
    const lines = photoKeysOf(it.photo_urls).length > 0
      ? appendPhotoMarker(composed)
      : composed;
    return [
      String(itIdx + 1),
      it.item_code,
      lines.join('\n'),
      `${it.qty} ${it.uom}`,
      fmtRm(it.unit_price_sen, header.currency),
      it.discount_sen > 0 ? fmtRm(it.discount_sen, header.currency) : '—',
      fmtRm(it.total_sen, header.currency),
    ];
  });

  /* Interleave category section header rows (SOFA / BEDFRAME / …) above each
     group, matching the on-screen grouping. Bold under a rule rather than the
     grey band it used to carry (owner 2026-08-07: no fills on printed
     documents) — the row still has to read as a divider, so the weight moves
     from ink to a line. */
  const bodyRows: RowInput[] = [];
  let lastGroup: string | null = null;
  orderedItems.forEach((it, itIdx) => {
    const grp = (it.item_group || 'OTHER').toUpperCase();
    if (grp !== lastGroup) {
      bodyRows.push([{
        content: grp, colSpan: 7,
        styles: { fontStyle: 'bold', textColor: 40, halign: 'left', lineWidth: { top: 0.4 } as never },
      }]);
      lastGroup = grp;
    }
    bodyRows.push(tableRows[itIdx]!);
  });

  autoTable(doc, {
    startY: y,
    head: [['#', 'Item Code', 'Description', 'Qty', 'Unit Price', 'Discount', 'Amount (RM)']],
    body: bodyRows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    /* Money cells must stay on ONE line ("MYR 2,990.00", never wrapped):
       numeric columns are 7.5 pt, right-aligned. Fixed widths sum to ~114 mm of
       182 usable (A4 − 2×14 margins), leaving ~68 mm for Description ('auto',
       the only column allowed to wrap). */
    columnStyles: {
      0: { cellWidth: 8, halign: 'right', fontSize: 7.5 },
      1: { cellWidth: 28 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 14, halign: 'right', fontSize: 7.5 },
      4: { cellWidth: 24, halign: 'right', fontSize: 7.5 },
      5: { cellWidth: 16, halign: 'right', fontSize: 7.5 },
      6: { cellWidth: 24, halign: 'right', fontSize: 7.5 },
    },
    margin: { left: margin, right: margin },
  });
  // jspdf-autotable mutates doc by assigning the finished Table to
  // `doc.lastAutoTable`, whose `finalY` is the y the table ended on. jsPDF's
  // own types do not declare it, so read it off the shim. Verified against
  // jspdf-autotable 5.0.8 (tableDrawer.ts sets `table.finalY = cursor.y;
  // jsPDFDoc.lastAutoTable = table` on every autoTable() call, so the SECOND
  // read below picks up the payments table, not this one).
  // Covered by pdf-money-layout.test.ts.
  let ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  // ── ITEM PHOTOS (owner spec 2026-08) ───────────────────
  /* One block per document, AFTER the items table and BEFORE the payments
     ledger. Row-number chips key each group back to the table above; a group
     never splits across pages (it moves whole, under a continued heading).
     Absent entirely when no photo actually fetched. */
  if (photoImages.size > 0) {
    const photoRes = drawItemPhotosBlock(doc, photoGroups, photoImages, {
      margin,
      contentW: pageW - margin * 2,
      startY: ty,
      pageBottom: 272,
      pageTop: margin,
      side: null,
      onNewPage: null,
    });
    if (photoRes.drew) ty = photoRes.endY + 6;
  }

  // ── PAYMENTS RECEIVED ledger ──────────────────────────────────────
  // Sources transactions from the payments ledger (mfg_sales_order_payments)
  // instead of the legacy single-row header columns (deprecated PR-C).
  if (ty > 250) { doc.addPage(); ty = margin; }
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('PAYMENTS RECEIVED', margin, ty);
  ty += 4;

  if (payments.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text('No payments recorded.', margin, ty);
    doc.setTextColor(0);
    ty += 6;
  } else {
    const payRows = payments.map((p) => [
      fmtDocDate(p.paid_at),
      methodLabel(p),
      p.approval_code ?? '—',
      p.collected_by_name ?? '—',
      fmtRm(p.amount_sen, header.currency),
    ]);
    autoTable(doc, {
      startY: ty,
      head: [['Date', 'Method', 'Approval Code', 'Collected By', 'Amount']],
      body: payRows,
      theme: 'plain',
      rowPageBreak: 'avoid',
      styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
      headStyles: DOC_TABLE_HEAD_STYLES,
      columnStyles: {
        0: { cellWidth: 24 },
        1: { cellWidth: 60 },
        2: { cellWidth: 32 },
        3: { cellWidth: 'auto' },
        4: { cellWidth: 28, halign: 'right' },
      },
      margin: { left: margin, right: margin },
    });
    ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? ty) + 6;
  }

  // ── Totals: SUBTOTAL / PAID TO DATE / TOTAL / BALANCE DUE ─────────
  /* POS-printout parity: the SO model has no separate subtotal — the grand
     total stands in (add-ons ride inside the line totals). Paid-to-date
     prefers the authoritative paid_sen_total stamped by GET /:docNo
     (ledger + legacy header deposit), falling back to summing the rows. */
  const subtotalSen = header.local_total_sen;
  const paidSen = typeof header.paid_sen_total === 'number'
    ? header.paid_sen_total
    : payments.reduce((sum, p) => sum + (p.amount_sen || 0), 0);
  /* SIGNED (owner 2026-08-16) — over-collection is allowed, so the print must
     not floor the excess away and quietly tell the customer he is square when
     the business is holding RM 250 of his money. Negative flips the LABEL
     rather than printing "BALANCE DUE −250.00", which reads as a debt with a
     typo; the figure itself is shown as the positive credit it is. */
  const balanceSen = subtotalSen - paidSen;
  const overpaidSen = balanceSen < 0 ? -balanceSen : 0;
  if (ty > 240) { doc.addPage(); ty = margin; }
  const awTopY = ty;
  const totalsX = pageW - margin - 70;
  doc.setFontSize(9);
  const drawRow = (label: string, val: string, ry: number, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.text(label, totalsX, ry);
    doc.text(val, pageW - margin, ry, { align: 'right' });
  };
  drawRow('Subtotal',     fmtRm(subtotalSen, header.currency), ty);     ty += 4;
  /* Standard-checklist tax line — the SO model carries no header tax (prices
     are tax-inclusive / exempt), so this prints as a dash, not a number. */
  drawRow('Tax',          '—',                                   ty);     ty += 4;
  drawRow('Total',        fmtRm(subtotalSen, header.currency), ty);     ty += 4;
  drawRow('Paid to date', fmtRm(paidSen,     header.currency), ty);     ty += 2;
  doc.setDrawColor(0);
  doc.line(totalsX, ty, pageW - margin, ty);
  doc.setFontSize(11);
  drawRow(
    overpaidSen > 0 ? 'CREDIT BALANCE' : 'BALANCE DUE',
    fmtRm(overpaidSen > 0 ? overpaidSen : balanceSen, header.currency),
    ty + 5,
    true,
  );
  ty += 12;

  // Expected-deposit line — only shown when the commander has set one
  // on the header. Keeps the "target vs. collected" distinction visible.
  if ((header.deposit_sen ?? 0) > 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(
      `Expected deposit: ${fmtRm(header.deposit_sen ?? 0, header.currency)}`,
      margin, ty,
    );
    doc.setTextColor(0);
    ty += 5;
  }

  // Amount in words (left, aligned with the totals block).
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80);
  doc.text(
    doc.splitTextToSize(`Amount in words: ${amountInWordsMyr(subtotalSen)}`, totalsX - margin - 8) as string[],
    margin, awTopY + 1,
  );
  doc.setTextColor(0);

  // ── Signature boxes — customer (with stored POS signature) + company ──
  if (ty > 225) { doc.addPage(); ty = margin; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text('Customer Signature', margin, ty);
  doc.text(`${COMPANY.name} Authorised Signature`, pageW / 2 + 5, ty);
  ty += 2;
  doc.setLineDashPattern([1.5, 1.5], 0);
  doc.setDrawColor(120);
  const sigW = (pageW - margin * 2) / 2 - 5;
  doc.rect(margin, ty, sigW, 22);
  doc.rect(pageW / 2 + 5, ty, sigW, 22);
  doc.setLineDashPattern([], 0);
  /* POS handover signature (signature_b64) renders INSIDE the customer box —
     same as the POS printout. Fail-soft: a malformed image just leaves the
     box blank for a wet-ink signature. */
  const rawSig = (header.signature_b64 ?? '').trim();
  if (rawSig) {
    try {
      const dataUrl = rawSig.startsWith('data:') ? rawSig : `data:image/png;base64,${rawSig}`;
      doc.addImage(dataUrl, 'PNG', margin + 2, ty + 1, sigW - 4, 20);
    } catch { /* leave the box blank */ }
  }
  ty += 26;
  // Name · phone under the customer box, mirroring SalesOrderPrint.tsx.
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80);
  doc.text(
    [header.debtor_name, header.phone ? formatPhone(header.phone) : null].filter(Boolean).join(' · '),
    margin, ty,
  );
  doc.setTextColor(0);
  ty += 6;

  // ── Numbered terms (POS RECEIPT_TERMS wording) ────────────────────
  if (ty > 255) { doc.addPage(); ty = margin; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.text('Terms & Conditions', margin, ty);
  ty += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(110);
  receiptTerms(opts?.docNoun ?? 'sales order').forEach((t, i) => {
    const wrapped = doc.splitTextToSize(`${i + 1}. ${t}`, pageW - margin * 2) as string[];
    doc.text(wrapped, margin, ty);
    ty += wrapped.length * 3.2 + 0.8;
  });
  doc.setTextColor(0);

  // ── Footer: doc no · portal label · page n of m on every page ────
  /* Number ONLY this SO's pages (startPage…end). For a combined doc this reads
     per absolute page, which is acceptable (matches the PO precedent — we don't
     over-engineer per-doc relative numbering). */
  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.doc_no, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.so_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(`Page ${p} of ${pageCount}`, pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

/* Single SO → its own file (or print / preview). EXACT same signature and
   behaviour as before the renderSalesOrderInto extraction — single-doc output
   is byte-identical to the pre-refactor generator. */
export async function generateSalesOrderPdf(
  header: SoHeader,
  items: SoItem[],
  payments: SoPayment[] = [],
  action: PdfAction = 'save',
  /* PWP vouchers this SO's trigger items issued (GET /:docNo `pwpCodes`) —
     used to mark trigger lines. Optional so older callers stay valid. */
  pwpCodes: SoPwpCodeRow[] = [],
  opts?: { docTitle?: string; docNoLabel?: string; docNoun?: string },
): Promise<void> {
  // Dynamic import — code-split into a vendor chunk.
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderSalesOrderInto(doc, autoTable, header, items, payments, pwpCodes, opts);

  // Filename: SO-009001-DebtorName.pdf
  const filename = `${header.doc_no}-${safeName(header.debtor_name || 'customer')}.pdf`;
  deliverPdf(doc, filename, action);
}

/* Several SOs → ONE combined file, each SO starting on a new page. For the
   batch "Export PDF" action on the SO list (one combined attachment). Each SO's
   footer numbers its own pages; the whole file saves once. */
export async function generateCombinedSalesOrderPdf(
  docs: Array<{ header: SoHeader; items: SoItem[]; payments?: SoPayment[]; pwpCodes?: SoPwpCodeRow[] }>,
  opts?: { fileName?: string; docTitle?: string; docNoLabel?: string; docNoun?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderSalesOrderInto(
      doc, autoTable,
      docs[i]!.header, docs[i]!.items,
      docs[i]!.payments ?? [], docs[i]!.pwpCodes ?? [],
      opts,
    );
  }
  deliverPdf(doc, opts?.fileName ?? 'sales-orders.pdf', opts?.action);
}
