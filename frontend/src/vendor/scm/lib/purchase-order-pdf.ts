// ----------------------------------------------------------------------------
// Purchase Order PDF — AutoCount/DSL-style layout (PR #102 + 2026-06-12
// rebuild to the owner's DSL reference printout).
//
// Layout:
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │              2990 HOME SDN. BHD.   (centered letterhead)         │
//   │              SSM 202501060667                                    │
//   │              E-28-02 & E-28-03, Menara SUEZCAP 2, KL Gateway,    │
//   │              No. 2, Jalan Kerinchi, …  59200 Kuala Lumpur …      │
//   ├──────────────────────────────────────────────────────────────────┤
//   │                       PURCHASE ORDER                             │
//   ├──────────────────────────────────────────────────────────────────┤
//   │  SUPPLIER NAME                  PO No.       : PO-2606-001       │
//   │  Address line 1                 Your Ref No. : SO-2605-014 (S/O) │
//   │  Address line 2                 Terms        : NET 30            │
//   │  TEL : …       FAX : …          Date         : 2026/06/12        │
//   │  Attn: …                        Delivery Date: 2026/06/19        │
//   │                                 Purchase Loc.: WH-KL · Main WH   │
//   │                                 Page         : 1 of N            │
//   ├──────────────────────────────────────────────────────────────────┤
//   │ For SO     | Supplier Code | Description | UOM | Qty | U/Price │
//   │            |               |             |     |     | Disc | Total
//   │  (Supplier Code = SUPPLIER code, bold. Description = model +
//   │   composition + supplier colour (our code) + variant attrs +
//   │   remark + per-line delivery date.)
//   ├──────────────────────────────────────────────────────────────────┤
//   │ RINGGIT MALAYSIA … ONLY                          TOTAL  9,999.00 │
//   │ E. & O.E.                                                        │
//   │ Sofa layout — front faces TV   ITEM PHOTOS · 照片对照 (row-chip  │
//   │ (orientation / LHF·RHF)        thumb groups, beside; wraps below)│
//   │ Authorised Signature          Supplier Acknowledgement           │
//   └──────────────────────────────────────────────────────────────────┘
//
// Letterhead comes from pdf-common COMPANY (= apps/pos legal.ts, the real
// registered entity). Page number prints on EVERY page header via the
// autotable didDrawPage hook + jsPDF putTotalPages.
// ----------------------------------------------------------------------------

import { buildDefaultSofaCells, effectiveDelivery, findModule, fmtMoneySen, SOFA_MODULES, type Cell, type Depth } from '@2990s/shared';
import { formatPhone } from '@2990s/shared/phone';
import { parseProvenanceNote } from '../../shared/transfer-vocabulary';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '@2990s/shared/so-line-display';
import { drawSofaLayout } from './sofa-layout-pdf';
import { COMPANY, amountInWordsMyr, deliverPdf, drawInfoColumns, ensurePdfCjkFont, fmtDocDate, fmtDocStamp, safeName, type PdfAction } from './pdf-common';
import { supplierBlock } from './pdf-party-blocks';
import { poDisplayNumber } from './po-status';
import {
  loadSupplierDocData,
  supplierCodeFor,
  docVariantLine,
  type SupplierRecord,
} from './supplier-doc-data';
import {
  blobToSquarePdfImage,
  buildPhotoGroups,
  collectPhotoImages,
  drawItemPhotosBlock,
  ITEM_PHOTOS_CJK_TEXT,
  PHOTO_MARKER,
  photoKeyOwners,
  photoKeysOf,
  type PdfPhotoImage,
  type PhotoRegion,
} from './pdf-item-photos';
import { fetchPoItemPhotoBlob } from './sales-order-queries';
import { THUMB_KEY_SUFFIX } from '../../../lib/imagePipeline';

type PoHeader = {
  po_number:     string;
  /** PO row id (uuid) — the per-line photo proxy routes are keyed by it
      (/mfg-purchase-orders/:id/items/:itemId/photos/…). Optional: the detail
      pages spread the API row (which carries it); a caller without it simply
      prints no photo block. */
  id?:           string | null;
  /** Mig 0080 — approved-revision counter. The PRINTED number carries the _R
      suffix (poDisplayNumber) so the supplier can tell a revised order sheet
      from the original: PO-xxx_R1, _R2… Optional: absent → no suffix. */
  revision?:     number | null;
  /** Supplier id — drives the print-time binding lookup for lines that never
      snapshotted a supplier_sku AND the full supplier-master top-up (fax /
      attention / payment terms). Optional: missing id → '—' fallback. */
  supplier_id?:  string | null;
  status:        string;
  po_date:       string;
  expected_at:   string | null;
  /* Migration 0180 — supplier-revised header delivery dates. The printed
     "Delivery Date" uses the EFFECTIVE (latest) of these + expected_at. */
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  supplier_delivery_date_4?: string | null;
  currency:      string;
  subtotal_sen: number;
  tax_sen:     number;
  total_sen:   number;
  notes:         string | null;
  /** PR #102 — header extras for the AutoCount layout. All optional; the PDF
      renders dashes when blank so old POs without these fields still print. */
  your_ref_no?:           string | null;
  source_so_doc_no?:      string | null;
  purchase_location_name?: string | null;
  /** #1 (Commander 2026-06-18) — deliver-to address (the bound warehouse's
      location). Printed in the meta block so the supplier knows where to ship. */
  delivery_address?: string | null;
  supplier?: {
    code:           string;
    name:           string;
    contact_person?: string | null;
    phone?:         string | null;
    fax?:           string | null;
    email?:         string | null;
    address?:       string | null;
    area?:          string | null;
    postcode?:      string | null;
    state?:         string | null;
    country?:       string | null;
    attention?:     string | null;
    payment_terms?: string | null;
  } | null;
};

type PoItem = {
  /** Line id (uuid) — pairs with the header id for the photo proxy routes.
      Optional for callers that predate photos on the PO. */
  id?:           string | null;
  item_code: string;
  material_name: string;
  supplier_sku:  string | null;
  qty:           number;
  unit_price_sen: number;
  line_total_sen: number;
  /** PR #102 — AutoCount layout extras. All optional. */
  uom?:           string | null;
  discount_sen?: number | null;
  delivery_date?: string | null;
  /* Migration 0180 — per-line supplier-revised dates; the printed per-line
     "Delivery:" uses the EFFECTIVE (latest) of these + delivery_date. */
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  supplier_delivery_date_4?: string | null;
  notes?:         string | null;
  /** Supplier-facing dual-code layout — variants drive the Specs segment
      (fabric shows the SUPPLIER's colour code with ours alongside, plus
      divan/leg/seat heights and D1-style specials via buildVariantSummary). */
  item_group?:    string | null;
  description?:   string | null;
  description2?:  string | null;
  variants?:      Record<string, unknown> | null;
  /** "For SO" provenance column (relabelled from "Transf. SO", owner
      2026-08-07). GET /mfg-purchase-orders/:id stamps each line's source SO
      doc_no from the STORED link (so_item_id → mfg_sales_order_items →
      doc_no). Null for manually-added / MRP / consignment lines. Stored
      provenance only — a printed document is a snapshot, so it must never
      carry a floating MRP/READY pairing (Decision, owner 2026-08-06:
      docs/modules/purchase-order.md). */
  so_doc_no?:     string | null;
  /** Line reference photos (mig 0274 — carried from the source SO line on
      convert; same R2 objects). Optional for callers that predate the column.
      When present the description gains the " (图)" marker and the ITEM
      PHOTOS block prints the `.thumb` siblings. */
  photo_urls?:    string[] | null;
};

const fmtMoney = (centi: number, currency: string): string => fmtMoneySen(centi, currency);

const fmtAmount = (centi: number): string =>
  (centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* A sofa is split into per-MODULE PO lines. Each line's `variants` carries that
   ONE module's spatial slot at the TOP LEVEL (x / y / rot + cellIndex), its module
   code lives in `item_code` ("{MODEL}-2A(RHF)"), and a shared `summary` string
   describes the whole sofa. So we build ONE cell per line and the caller groups
   lines by `summary` into the full layout. (The earlier `variants.cells`-array
   assumption was wrong — real lines store the slot flat, so nothing ever drew.)
   Returns null for non-sofa / malformed / unknown-module lines. Never throws. */
const SOFA_MODULE_IDS_BY_LEN = SOFA_MODULES.map((m) => m.id).sort((a, b) => b.length - a.length);
function sofaCellFromLine(
  variants: Record<string, unknown> | null | undefined,
  itemCode: string | null | undefined,
): { cell: Cell; depth: Depth; groupKey: string; idx: number } | null {
  if (!variants || typeof variants !== 'object') return null;
  const v = variants as Record<string, unknown>;
  const x = v.x;
  const y = v.y;
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  // Module id = the SOFA_MODULES id the item_code ENDS with (longest match):
  // "XAMMAR-2A(RHF)" → "2A(RHF)".
  const code = (itemCode ?? '').trim();
  const moduleId = SOFA_MODULE_IDS_BY_LEN.find((id) => code.endsWith(id)) ?? null;
  if (!moduleId || !findModule(moduleId)) return null;
  const rot: 0 | 90 | 180 | 270 = v.rot === 90 || v.rot === 180 || v.rot === 270 ? v.rot : 0;
  const depthRaw = v.depth;
  const depth: Depth = typeof depthRaw === 'string' && depthRaw.trim() ? depthRaw : '24';
  const groupKey = typeof v.summary === 'string' && v.summary.trim() ? v.summary.trim() : '';
  const idx = typeof v.cellIndex === 'number' && Number.isFinite(v.cellIndex) ? v.cellIndex : 0;
  return { cell: { moduleId, x, y, rot }, depth, groupKey, idx };
}

/* Resolve a sofa MODULE id (+ the BASE model it belongs to) from a
   geometry-less BACKEND line — a sofa added via SO New / Maintenance stores
   the module only as a per-line SKU ("{MODEL}-2A(RHF)"), never x/y/cells, so
   `sofaCellFromLine` (which needs stored x/y) returns null for it. The module
   is the longest SOFA_MODULES suffix the SKU code ENDS with; the base model is
   whatever precedes it ("XAMMAR-2A(RHF)" → base "XAMMAR", module "2A(RHF)").
   When the code carries no recognisable suffix we fall back to the trailing
   "MODULE(HAND)" token of the material_name / description ("SOFA XAMMAR
   2A(RHF)" → "2A(RHF)"). Returns null for non-sofa / unresolvable lines so the
   caller can skip them. Never throws. */
const SOFA_MODULE_TOKEN_RE = /([A-Za-z0-9]+(?:\([A-Za-z]+\))+|CNR|Console|STOOL|1NA|2NA|1S|2S|3S)\s*$/;
function sofaModuleFromLine(
  itemCode: string | null | undefined,
  fallbackText: string | null | undefined,
): { moduleId: string; baseModel: string } | null {
  // Preferred: the SKU code's longest known-module suffix.
  const code = (itemCode ?? '').trim();
  if (code) {
    const suffix = SOFA_MODULE_IDS_BY_LEN.find((id) => code.endsWith(id));
    if (suffix && findModule(suffix)) {
      // Base model = the code minus the module suffix (drop a trailing '-').
      const base = code.slice(0, code.length - suffix.length).replace(/[-\s]+$/, '');
      return { moduleId: suffix, baseModel: base };
    }
  }
  // Fallback: the trailing "MODULE(HAND)" token of the name / description.
  const text = (fallbackText ?? '').trim();
  const m = text.match(SOFA_MODULE_TOKEN_RE);
  const token = m?.[1]?.trim();
  if (token && findModule(token)) {
    return { moduleId: token, baseModel: '' };
  }
  return null;
}

type JsPdf = import('jspdf').jsPDF;
type AutoTableFn = (typeof import('jspdf-autotable'))['default'];

/* Draw ONE purchase order's content into `doc` (letterhead → meta → items →
   totals → notes → signature). Does NOT number pages / resolve total-pages /
   save — the caller finalizes ONCE, so several POs can share one doc (batch
   "Print documentation"). Returns what the finalizer needs. */
async function renderPurchaseOrderInto(
  doc: JsPdf,
  autoTable: AutoTableFn,
  header: PoHeader,
  items: PoItem[],
  opts?: { docTitle?: string; sofaPhotos?: Record<string, string> },
): Promise<{ supplierName: string }> {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 10; // tighter left/right than the SO's 14 (owner 2026-06-19)
  const docTitle = opts?.docTitle ?? 'PURCHASE ORDER';

  /* Print-time lookups (all fail-soft): supplier SKU bindings + Fabric
     Converter colour map + the FULL supplier master record (the PO detail
     endpoint embeds only 7 fields — no fax / attention / payment_terms). */
  const { skuMap, fabricMap, fabricDescMap, supplier: fullSupplier } = await loadSupplierDocData(header.supplier_id, items);

  /* Printed row order, resolved BEFORE any drawing: the ITEM PHOTOS block at
     the page bottom is keyed by the table's row positions and the photo bytes
     must be in hand before drawing starts, so the ordering the items table
     used to compute inline moved up here — the table below reads this same
     const. Canonical SKU/build order (sofa modules LHF→NA→RHF, mains→
     accessories→services) — mirror the sales side. The shared helper keys on
     `item_code`; sort a shimmed view that carries the original row back
     unchanged (render-time only, no persistence touched). */
  const orderedItems = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      items.map((it) => ({ ...it, item_code: it.item_code, __row: it })),
      (r) => r.item_group as string | null | undefined,
    ),
  ).map((r) => r.__row);

  /* Owner spec 2026-08 — photos follow the line onto the supplier PO. The
     code beside each row chip is the SUPPLIER code (the code they act on).
     Only `.thumb` siblings are fetched (never originals — PDF size), each
     photo best-effort: a key whose fetch or decode fails is skipped and the
     PDF renders without it. */
  const poId = (header.id ?? '').trim();
  const photoGroups = buildPhotoGroups(orderedItems.map((it) => ({
    code: supplierCodeFor(it, skuMap),
    photoKeys: photoKeysOf(it.photo_urls),
  })));
  const photoOwners = photoKeyOwners(orderedItems.map((it) => ({
    id: it.id ?? null,
    photoKeys: photoKeysOf(it.photo_urls),
  })));
  const photoImages: Map<string, PdfPhotoImage> = photoGroups.length > 0 && poId !== ''
    ? await collectPhotoImages(
        photoGroups,
        (key) => {
          const ownerId = photoOwners.get(key);
          if (!ownerId) return Promise.reject(new Error('photo_owner_missing'));
          return fetchPoItemPhotoBlob(poId, ownerId, key + THUMB_KEY_SUFFIX);
        },
        blobToSquarePdfImage,
      )
    : new Map<string, PdfPhotoImage>();

  /* Before ANY drawing, and after the supplier lookup so its name / address
     count too (a China supplier's are the likely CJK on this document): text
     carrying CJK needs the font embedded up front, or helvetica silently paints
     the whole field as mojibake. No-op for a pure-WinAnsi PO. The photo marker
     + heading are GENERATED text the payload walk cannot see, so they ride
     along whenever the photo block will print. */
  await ensurePdfCjkFont(doc, [
    header, items, fullSupplier, skuMap, fabricMap,
    photoGroups.length > 0 ? ITEM_PHOTOS_CJK_TEXT : '',
  ]);

  // ── Company letterhead (centered, AutoCount style) ────────────────
  let y = margin;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(COMPANY.name, pageW / 2, y, { align: 'center' });
  y += 5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(COMPANY.reg, pageW / 2, y, { align: 'center' });
  y += 4;
  for (const line of COMPANY.addressLines) {
    doc.text(line, pageW / 2, y, { align: 'center' });
    y += 4;
  }
  y += 2;

  doc.setDrawColor(0); doc.setLineWidth(0.4);
  doc.line(margin, y, pageW - margin, y);
  y += 6;

  // ── Title bar ─────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text(docTitle, pageW / 2, y, { align: 'center' });
  y += 8;

  // ── Supplier (left) + PO details (right) — borderless, like the SO ──
  /* Embedded 7-field supplier first, full master record as the top-up for
     anything the embed omits (fax / attention / payment_terms / area /
     postcode / state / country). */
  const s: Partial<SupplierRecord> = { ...(fullSupplier ?? {}), ...(header.supplier ?? {}) };
  const sFull = fullSupplier ?? {};
  const supplierAddressLines = [
    s.address,
    sFull.area,
    [sFull.postcode, sFull.state].filter(Boolean).join(' ').trim() || null,
    sFull.country,
  ].filter(Boolean) as string[];

  /* "Your Ref No." = the source S/O No.; falls back to the per-line so_doc_no roll-up. */
  const lineSoDocs = [...new Set(items.map((it) => (it.so_doc_no ?? '').trim()).filter(Boolean))];
  // MRP / bulk-convert POs record their source SO(s) only in the free-text
  // provenance note (they carry no per-line so_item_id), so the structured refs
  // above and the per-line roll-up are both empty — fall back to that note so
  // the source SO still prints. Owner 2026-07-20.
  //
  // Through the SHARED parser since 2026-08-18, not a fourth private regex.
  // Two things that were wrong here are fixed by that alone:
  //   - this copy omitted the `m` flag, so a note whose label sat on line 2
  //     printed NO source SO while the relationship map beside it showed one;
  //   - `noteSoDocs.includes(',')` decided single-vs-multi source by looking
  //     for a comma character, so a trailing comma ("SO-1,") read as multi.
  // Both disappear by counting parsed TOKENS instead of scanning a string.
  const noteSoDocTokens = parseProvenanceNote(header.notes);
  const noteSoDocs = noteSoDocTokens.join(', ');
  const yourRef = header.your_ref_no
    ?? header.source_so_doc_no
    ?? (lineSoDocs.length > 0 ? lineSoDocs.join(', ') : noteSoDocs);
  // When the whole PO traces to exactly ONE source SO a line with no per-line
  // link falls back to it, so the "For SO" column reads that SO instead of a
  // dash. Multi-SO POs keep the dash per line (all SOs are already listed in
  // Your Ref No above).
  const singleSourceSo = (!lineSoDocs.length && noteSoDocTokens.length === 1) ? noteSoDocTokens[0]! : '';

  y = drawInfoColumns(doc, y,
    /* Canonical supplier block — Company, Code, Address, Tel, Fax, Email,
       Attn, Terms — via the shared helper. formatPhone the tel like every
       other document (this was the one generator printing a supplier phone
       raw, so the same stored number read "+60123456789" on a PO and
       "+60 12-345 6789" on the SO beside it). Terms migrates to the LEFT
       column so every purchasing doc self-contains the negotiated credit
       window; the RIGHT PO DETAILS column drops its Terms row to avoid the
       duplication. */
    supplierBlock({
      name: s.name,
      code: s.code,
      address: supplierAddressLines.join(', '),
      phone: formatPhone(s.phone ?? sFull.mobile ?? '') || (s.phone ?? sFull.mobile),
      fax: sFull.fax,
      email: s.email ?? sFull.email,
      attention: sFull.attention ?? s.contact_person,
      paymentTerms: sFull.payment_terms ?? header.supplier?.payment_terms ?? null,
    }),
    {
      title: 'PO DETAILS',
      rows: [
        // _R suffix (owner 2026-07-27) — the printed number shows the revision.
        ['PO No', poDisplayNumber(header.po_number, header.revision)],
        ['Your Ref No', yourRef],
        ['Date', fmtDocDate(header.po_date)],
        /* Migration 0180 — print the EFFECTIVE (latest revised) delivery date. */
        ['Delivery Date', (() => {
          const eff = effectiveDelivery(
            header.expected_at,
            header.supplier_delivery_date_2,
            header.supplier_delivery_date_3,
            header.supplier_delivery_date_4,
          );
          return eff ? fmtDocDate(eff) : '';
        })()],
      ],
    },
    margin,
  );

  /* Deliver To — the purchase-location warehouse + its FULL address, wrapped
     full-width so the supplier sees exactly where to ship (owner 2026-06-19;
     the address is the warehouse `location` field). */
  const deliverToName = (header.purchase_location_name ?? '').trim();
  const deliverToAddr = (header.delivery_address ?? '').trim();
  if (deliverToName || deliverToAddr) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(110);
    doc.text('DELIVER TO', margin, y); doc.setTextColor(0);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    const dtW = pageW - margin * 2 - 26;
    const dtLines: string[] = [];
    if (deliverToName) dtLines.push(...(doc.splitTextToSize(deliverToName, dtW) as string[]));
    if (deliverToAddr) dtLines.push(...(doc.splitTextToSize(deliverToAddr, dtW) as string[]));
    doc.text(dtLines, margin + 26, y);
    y += Math.max(1, dtLines.length) * 4 + 2;
  }
  y += 2;

  // Owner's rule — supplier acts on THEIR codes; ours stay printed alongside.
  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(80);
  doc.text('Item codes shown are SUPPLIER codes; our model & reference appear in the Description.', margin, y + 2);
  doc.setFont('helvetica', 'normal'); doc.setTextColor(0);
  y += 6;

  // ── Items table ──────────────────────────────────────────────────
  // Supplier-facing layout (Commander 2026-06-16 — dropped the standalone "Our
  // Code" column: our model already reads inside the Description, and the SO
  // this PO serves now leads the row):
  //   For SO        = stored PROVENANCE, first column — the S/O this line was
  //                   bought for (so_doc_no / single-source note fallback).
  //                   Relabelled from "Transf. SO" (owner 2026-08-07): the
  //                   wording must read as provenance, not as an execution
  //                   binding — pre-DO pairing is decided live by the MRP
  //                   allocator and must never print (Decision, owner
  //                   2026-08-06, docs/modules/purchase-order.md).
  //   Supplier Code = SUPPLIER's code, bold (the code they act on)
  //   Description   = name/model + composition (description2) + Specs
  //                   (unified fabric format "CG-001 Pearl (KN390-1)" +
  //                   divan/leg/seat heights + D1 specials via
  //                   buildVariantSummary inside docVariantLine) + line remark +
  //                   per-line delivery date
  //   UOM | Qty | U/Price | Disc | Total
  /* orderedItems is computed up top (before drawing) so this table and the
     ITEM PHOTOS block share ONE row order — the photo chips point at these
     row positions. */
  type Row = [string, string, string, string, string, string, string, string];
  const rows: Row[] = orderedItems.map((it) => {
    // ONE variant line only: the unified fabric summary (`CG-001 Pearl
    // (KN390-1)`) when present, else the stored description2 — never BOTH.
    // Uses the SAME docVariantLine composer as every other document (owner
    // 2026-07-24): supplier code appended LAST in parens, our item code stays
    // in the Supplier-Code column, never duplicated into the fabric line.
    const specs = docVariantLine(it, fabricMap, fabricDescMap, { labelled: true })
      || (it.description2 ?? '').trim();
    /* Migration 0180 — per-line "Delivery:" prints the EFFECTIVE (latest
       revised) line date: MAX over non-null of [delivery_date, _2, _3, _4]. */
    const lineEff = effectiveDelivery(
      it.delivery_date,
      it.supplier_delivery_date_2,
      it.supplier_delivery_date_3,
      it.supplier_delivery_date_4,
    );
    /* Owner spec: a row carries NO image — the " (图)" marker on the first
       description line points the supplier at the ITEM PHOTOS block below. */
    const descParts = [
      `${it.description ?? it.material_name}${photoKeysOf(it.photo_urls).length > 0 ? PHOTO_MARKER : ''}`,
      specs || null,
      (it.notes ?? '').trim() ? `Remark: ${(it.notes ?? '').trim()}` : null,
      lineEff ? `Delivery: ${fmtDocDate(lineEff)}` : null,
    ].filter(Boolean) as string[];
    return [
      (it.so_doc_no ?? '').trim() || singleSourceSo || '—',
      supplierCodeFor(it, skuMap),
      // Dedupe consecutive identical segments (description2 often equals the
      // live specs line) so the cell doesn't read the same string twice.
      [...new Set(descParts)].join('\n'),
      (it.uom ?? 'UNIT').toUpperCase(),
      String(it.qty),
      fmtAmount(it.unit_price_sen),
      it.discount_sen ? fmtAmount(it.discount_sen) : '',
      fmtAmount(it.line_total_sen),
    ];
  });

  /* Page-number on EVERY page header (didDrawPage) using the jsPDF
     total-pages placeholder, resolved by putTotalPages below. */
  const totalPagesExp = '{total_pages}';
  const drawPageHeader = (pageNumber: number) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80);
    doc.text(
      `${poDisplayNumber(header.po_number, header.revision)} · Page ${pageNumber} of ${totalPagesExp}`,
      pageW - margin, 10, { align: 'right' },
    );
    doc.setTextColor(0);
  };

  autoTable(doc, {
    startY: y,
    head: [[
      'For SO', 'Supplier Code', 'Description', 'UOM', 'Qty',
      `U/Price ${header.currency}`, 'Disc.', `Total ${header.currency}`,
    ]],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { fontSize: 8.5, cellPadding: { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 }, lineColor: [120, 120, 120], lineWidth: 0.1 },
    headStyles: { fontStyle: 'bold', halign: 'left', valign: 'middle', lineWidth: { top: 0.4, bottom: 0.4 } as never },
    bodyStyles: { valign: 'top' },
    // Widths sum to 180mm — fits the A4 printable width (210 − 14×2 = 182).
    columnStyles: {
      0: { cellWidth: 25 },                    // For SO — fits "SO-2606-001" on one line
      1: { cellWidth: 27, fontStyle: 'bold' }, // Supplier Code (the code they act on)
      2: { cellWidth: 'auto' },                // Description — auto-fills (≈68mm with margin 10)
      3: { cellWidth: 11 },                    // UOM
      4: { cellWidth: 10, halign: 'right' },   // Qty
      5: { cellWidth: 19, halign: 'right' },   // U/Price
      6: { cellWidth: 11, halign: 'right' },   // Disc.
      7: { cellWidth: 19, halign: 'right' },   // Total
    },
    margin: { left: margin, right: margin, top: 16 },
    didDrawPage: (data) => drawPageHeader(data.pageNumber),
  });

  let lastY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 5;

  // ── Totals (right) + amount in words (left, AutoCount footer) ─────
  if (lastY > 250) { doc.addPage(); drawPageHeader(doc.getNumberOfPages()); lastY = 20; }
  const totalsX = pageW - margin - 70;
  const drawRow = (label: string, val: string, ry: number, bold = false, ruled = false) => {
    if (ruled) { doc.setDrawColor(0); doc.line(totalsX, ry - 3, pageW - margin, ry - 3); }
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.text(label, totalsX,        ry);
    doc.text(val,   pageW - margin, ry, { align: 'right' });
  };
  doc.setFontSize(9);
  let totY = lastY;
  drawRow('Subtotal', fmtMoney(header.subtotal_sen, header.currency), totY); totY += 4;
  if (header.tax_sen > 0) {
    drawRow('Tax',    fmtMoney(header.tax_sen,      header.currency), totY); totY += 4;
  }
  doc.setFontSize(11);
  drawRow('TOTAL',    fmtMoney(header.total_sen,    header.currency), totY + 2, true, true);

  /* Amount in words — wrapped to the left half so a long amount never
     collides with the totals column. */
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  const words = doc.splitTextToSize(amountInWordsMyr(header.total_sen), totalsX - margin - 6) as string[];
  doc.text(words, margin, lastY);
  doc.setFont('helvetica', 'normal');
  const wordsY = lastY + words.length * 3.6 + 2;
  doc.setFontSize(8); doc.setTextColor(110);
  doc.text('E. & O.E.', margin, wordsY);
  doc.setTextColor(0);
  lastY = Math.max(totY + 8, wordsY + 6);

  // ── Notes / Remarks block (if present) ───────────────────────────
  if (header.notes) {
    doc.setFont('helvetica', 'bold');  doc.setFontSize(9);
    doc.text('Remarks:', margin, lastY);
    doc.setFont('helvetica', 'normal');
    lastY += 4;
    header.notes.split('\n').forEach((line) => {
      doc.text(line, margin, lastY);
      lastY += 4;
    });
    lastY += 4;
  }

  // ── Sofa layout schematics (orientation aid for the supplier) ─────
  // (Removed by #1212, owner 2026-07-24; REINSTATED per owner 2026-07-27 —
  //  the supplier PO must carry the source SO's sofa layout diagram.)
  // A POS sofa is split across per-module lines that share a `variants.summary`
  // AND carry stored x/y geometry; group those lines (by SO no + summary) and
  // build the full cells array, ordered by cellIndex. A BACKEND sofa (SO New /
  // Maintenance) stores the module SKU per line but NO geometry — there was
  // never a real arrangement to lose — so we RECONSTRUCT a default left→right
  // layout from its module list (grouped by SO no + base model). Non-sofa /
  // malformed lines fall through and are skipped. Purely additive; most POs
  // draw nothing here. A group is EITHER geometry-based OR reconstructed, never
  // both: a POS sofa's lines all carry geometry (never enter the fallback map)
  // and a backend sofa's lines never carry geometry — and we additionally drop
  // any reconstructed group whose (SO, base model) already drew from geometry.
  type DistinctSofa = { cells: Cell[]; depth: Depth; model: string; soNo: string };
  const sofaGroups = new Map<
    string,
    { parts: Array<{ cell: Cell; idx: number }>; depth: Depth; model: string; soNo: string }
  >();
  /* Geometry-less backend sofa lines, grouped by SO no + base model, modules
     kept in line (= display) order for a deterministic left→right layout. */
  const fallbackGroups = new Map<
    string,
    { modules: Array<{ moduleId: string }>; depth: Depth; model: string; soNo: string }
  >();
  /* (SO, base model) keys that already produced a geometry-based sofa — used to
     suppress any reconstructed group that would double-draw the same build. */
  const geometryKeys = new Set<string>();
  const baseModelKey = (soNo: string, baseModel: string): string => `${soNo}|${baseModel.toUpperCase()}`;

  for (const it of items) {
    const soNo = (it.so_doc_no ?? '').trim();
    const part = sofaCellFromLine(it.variants, it.item_code);
    if (part) {
      // ── Stored-geometry path (POS-configured sofas) — UNCHANGED. ──
      const gk = `${soNo}|${part.groupKey}`;
      let g = sofaGroups.get(gk);
      if (!g) {
        // Caption = the whole-sofa modules ("L(LHF) + 2A(RHF)", the summary up
        // to the first '·'), else the per-line model name.
        const model = (part.groupKey ? (part.groupKey.split('·')[0] ?? '').trim() : '')
          || (it.material_name ?? '').trim()
          || (it.item_code ?? '').trim();
        g = { parts: [], depth: part.depth, model, soNo };
        sofaGroups.set(gk, g);
      }
      g.parts.push({ cell: part.cell, idx: part.idx });
      // Record the base model so a reconstructed group can't double-draw it.
      const bm = sofaModuleFromLine(it.item_code, it.material_name ?? it.description);
      if (bm) geometryKeys.add(baseModelKey(soNo, bm.baseModel));
      continue;
    }
    // ── Reconstruction path (geometry-less BACKEND / old sofas). ──
    if ((it.item_group ?? '').toLowerCase() !== 'sofa') continue;
    const mod = sofaModuleFromLine(it.item_code, it.material_name ?? it.description);
    if (!mod) continue;
    const depthRaw = (it.variants as { depth?: unknown } | null)?.depth;
    const depth: Depth = typeof depthRaw === 'string' && depthRaw.trim() ? depthRaw : '24';
    const fk = baseModelKey(soNo, mod.baseModel);
    let fg = fallbackGroups.get(fk);
    if (!fg) {
      const model = (it.material_name ?? '').trim() || (it.item_code ?? '').trim();
      fg = { modules: [], depth, model, soNo };
      fallbackGroups.set(fk, fg);
    }
    fg.modules.push({ moduleId: mod.moduleId });
  }

  const distinctSofas: DistinctSofa[] = [];
  for (const g of sofaGroups.values()) {
    const cells = g.parts.sort((a, b) => a.idx - b.idx).map((p) => p.cell);
    if (cells.length === 0) continue;
    distinctSofas.push({ cells, depth: g.depth, model: g.model, soNo: g.soNo });
  }
  for (const [fk, g] of fallbackGroups) {
    if (geometryKeys.has(fk)) continue; // already drawn from real geometry
    const cells = buildDefaultSofaCells(g.modules, g.depth);
    if (cells.length === 0) continue;
    // Caption from the module list ("L(LHF) + 2A(RHF)"), else the per-line name.
    const caption = cells.map((c) => c.moduleId).join(' + ') || g.model;
    distinctSofas.push({ cells, depth: g.depth, model: caption, soNo: g.soNo });
  }

  /* Where the last sofa-diagram row leaves usable width, the ITEM PHOTOS
     block starts BESIDE it (owner mockup 2026-08); groups that do not fit
     there wrap below the section. Null = no sofa section (or a full last
     row): the block renders alone, full width. */
  let photoSide: PhotoRegion | null = null;
  if (distinctSofas.length > 0) {
    const contentW = pageW - margin * 2;
    const DIAGRAM_W = 36;   // mm — ~32–38mm wide per owner
    const DIAGRAM_H = 34;   // mm — sofa + TV block
    const CAP_H = 4;        // mm — model + SO caption under each diagram
    const GAP_X = 6;        // mm — horizontal gap between diagrams
    const ROW_H = DIAGRAM_H + CAP_H + 6; // mm — one row of diagrams + caption + padding
    const perRow = Math.max(1, Math.floor((contentW + GAP_X) / (DIAGRAM_W + GAP_X)));

    // Section needs room for the title + at least one row; else new page.
    const TITLE_H = 8;
    if (lastY + TITLE_H + ROW_H > 285) {
      doc.addPage(); drawPageHeader(doc.getNumberOfPages()); lastY = 20;
    }

    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(0);
    doc.text('Sofa layout — front faces TV (orientation / LHF·RHF)', margin, lastY);
    lastY += 6;

    let col = 0;
    let rowTop = lastY;
    for (const sofa of distinctSofas) {
      // New row when the current row is full.
      if (col >= perRow) {
        col = 0;
        rowTop += ROW_H;
      }
      // New page when this row would overflow.
      if (rowTop + ROW_H > 290) {
        doc.addPage(); drawPageHeader(doc.getNumberOfPages());
        rowTop = 20;
        col = 0;
        // Repeat the section title at the top of the continued page.
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(0);
        doc.text('Sofa layout — front faces TV (orientation / LHF·RHF) (cont.)', margin, rowTop);
        rowTop += 6;
      }
      const dx = margin + col * (DIAGRAM_W + GAP_X);
      const drawn = drawSofaLayout(doc, sofa.cells, sofa.depth, dx, rowTop, DIAGRAM_W, DIAGRAM_H, opts?.sofaPhotos);
      // Caption: model + SO no, wrapped to the diagram width.
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(80);
      const capParts = [sofa.model, sofa.soNo].filter(Boolean);
      const capLines = doc.splitTextToSize(capParts.join(' · ') || 'Sofa', DIAGRAM_W) as string[];
      const capY = rowTop + Math.max(drawn, DIAGRAM_H) + 2.5;
      doc.text(capLines, dx + DIAGRAM_W / 2, capY, { align: 'center' });
      doc.setTextColor(0);
      col += 1;
    }
    if (col < perRow) {
      const sideX = margin + col * (DIAGRAM_W + GAP_X);
      photoSide = { x: sideX, y: rowTop, w: pageW - margin - sideX, bottom: rowTop + ROW_H };
    }
    lastY = rowTop + ROW_H;
  }

  // ── ITEM PHOTOS · 照片对照 (owner spec 2026-08) ───────────────────
  /* Page-bottom zone, beside the sofa layout when width remains; a PO with no
     sofa renders the block alone, full width. Row-position chips key each
     group back to the items table; a group never splits across pages (it
     moves whole, under a continued heading). Absent entirely when no photo
     actually fetched. */
  if (photoImages.size > 0) {
    const photoRes = drawItemPhotosBlock(doc, photoGroups, photoImages, {
      margin,
      contentW: pageW - margin * 2,
      startY: lastY,
      pageBottom: 275,
      pageTop: 20,
      side: photoSide,
      onNewPage: () => drawPageHeader(doc.getNumberOfPages()),
    });
    if (photoRes.drew) {
      lastY = photoRes.pagesAdded > 0
        ? photoRes.endY + 6
        : Math.max(lastY, photoRes.endY + 6);
    }
  }

  // ── Signature block ──────────────────────────────────────────────
  if (lastY > 240) { doc.addPage(); drawPageHeader(doc.getNumberOfPages()); lastY = 20; }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.setDrawColor(120); doc.setLineWidth(0.2);
  const sigW = (pageW - margin * 2) / 2 - 4;
  doc.rect(margin,            lastY, sigW, 24);
  doc.rect(margin + sigW + 8, lastY, sigW, 24);
  doc.text(`Authorised Signature (${COMPANY.name})`, margin + 2,            lastY + 21);
  doc.text('Supplier Acknowledgement',               margin + sigW + 8 + 2, lastY + 21);
  lastY += 28;

  return { supplierName: s.name ?? 'supplier' };
}

const PO_TOTAL_PAGES_EXP = '{total_pages}';

/* Footer page numbers on every page + resolve the {total_pages} placeholder.
   Runs ONCE after all POs are rendered. `pageOnePatch` (single-PO only) writes
   "1 of N" into the meta block's reserved Page row. */
function finalizePoPdf(doc: JsPdf): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(
      `Page ${p} of ${pageCount}    ·    Generated ${fmtDocStamp()}`,
      pageW / 2, 287, { align: 'center' },
    );
    doc.setTextColor(0);
  }
  const docWithTotals = doc as unknown as { putTotalPages?: (exp: string) => unknown };
  if (typeof docWithTotals.putTotalPages === 'function') {
    docWithTotals.putTotalPages(PO_TOTAL_PAGES_EXP);
  }
}

/* Single PO → its own file (unchanged behaviour). */
export async function generatePurchaseOrderPdf(
  header: PoHeader,
  items: PoItem[],
  opts?: { docTitle?: string; action?: PdfAction; sofaPhotos?: Record<string, string> },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const { supplierName } = await renderPurchaseOrderInto(doc, autoTable, header, items, opts);
  finalizePoPdf(doc);
  // Was a private copy of the old ASCII-only scrub — a China supplier's name is
  // exactly the case it destroyed, and the PO is the document that goes to them.
  deliverPdf(
    doc,
    `${poDisplayNumber(header.po_number, header.revision)}-${safeName(supplierName)}.pdf`,
    opts?.action,
  );
}

/* The SAME PO PDF, returned as raw base64 instead of downloaded — for emailing it
   to the supplier. The backend bars a PDF engine, so the browser renders it here
   and posts the base64 to POST /:id/send-to-supplier, which attaches it. */
export async function purchaseOrderPdfBase64(
  header: PoHeader,
  items: PoItem[],
  opts?: { docTitle?: string; sofaPhotos?: Record<string, string> },
): Promise<string> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderPurchaseOrderInto(doc, autoTable, header, items, opts);
  finalizePoPdf(doc);
  // 'datauristring' → "data:application/pdf;base64,XXXX"; keep the base64 tail.
  const uri = doc.output('datauristring');
  return uri.slice(uri.indexOf(',') + 1);
}

/* Several POs → ONE combined file, each PO starting on a new page. For the
   batch "Print documentation" action (send a supplier all their POs in one
   attachment). The per-PO "1 of N" meta patch is skipped (cosmetic in a
   multi-PO doc); each page still carries its own PO number header + a global
   "Page p of N" footer. */
export async function generateCombinedPurchaseOrderPdf(
  pos: Array<{ header: PoHeader; items: PoItem[] }>,
  opts?: { docTitle?: string; fileName?: string; action?: PdfAction; sofaPhotos?: Record<string, string> },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  for (let i = 0; i < pos.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderPurchaseOrderInto(doc, autoTable, pos[i]!.header, pos[i]!.items, opts);
  }
  finalizePoPdf(doc);
  deliverPdf(doc, opts?.fileName ?? 'purchase-orders.pdf', opts?.action);
}
