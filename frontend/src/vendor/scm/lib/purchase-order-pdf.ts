
import { buildDefaultSofaCells, CONSOLE_ATTACH_KEY, effectiveDelivery, findModule, fmtMoneySen, SOFA_MODULES, type Cell, type Depth } from '@2990s/shared';
import { formatPhone } from '@2990s/shared/phone';
import { parseProvenanceNote } from '../../shared/transfer-vocabulary';
import {
  orderSofaModuleRowsWithinBuilds,
  sortLinesByStoredLineNo,
  sortSoLinesByGroupRank,
} from '@2990s/shared/so-line-display';
import { drawSofaLayout, layoutDepth } from './sofa-layout-pdf';
import { COMPANY, amountInWordsMyr, docPageLabel, deliverPdf, drawInfoColumns, ensurePdfCjkFont, fmtDocDate, fmtDocStamp, safeName, type PdfAction } from './pdf-common';
import { supplierBlock } from './pdf-party-blocks';
import { poDisplayNumber } from './po-status';
import { ensureBrandingForActiveCompany } from '../../../hooks/useBranding';
import {
  loadSupplierDocData,
  supplierCodeFor,
  docVariantLine,
  type SupplierRecord,
} from './supplier-doc-data';
import { loadSofaCompartmentArtForPrint } from './sales-order-queries';
import { splitBackendSofa } from './sofa-walk-order';
import { DRAWER_DIAGRAM_H, drawDrawerDiagram, drawerSidesOf, frontDrawerCountOf } from './po-drawer-diagram';
import {
  blobToSquarePdfImage,
  PDF_EMAIL_PHOTO_PX,
  pdfImageAt,
  buildPhotoGroups,
  collectPhotoImages,
  drawItemPhotosBlock,
  fetchLinePhotoForPdf,
  PHOTO_MARKER,
  photoKeyOwners,
  photoKeysOf,
  type PdfPhotoImage,
  type PhotoRegion,
} from './pdf-item-photos';
import { fetchPoItemPhotoBlob } from './sales-order-queries';
import type { PoEmailPhotos } from './po-email-photos';
import { PDF_COMPRESS } from './pdf-options';

type PoHeader = {
  po_number:     string;
  id?:           string | null;
  revision?:     number | null;
  supplier_id?:  string | null;
  status:        string;
  po_date:       string;
  expected_at:   string | null;
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  supplier_delivery_date_4?: string | null;
  currency:      string;
  subtotal_sen: number;
  tax_sen:     number;
  total_sen:   number;
  notes:         string | null;
  your_ref_no?:           string | null;
  source_so_doc_no?:      string | null;
  purchase_location_name?: string | null;
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
  id?:           string | null;
  line_no?:      number | null;
  item_code: string;
  material_name: string;
  supplier_sku:  string | null;
  qty:           number;
  unit_price_sen: number;
  line_total_sen: number;
  uom?:           string | null;
  discount_sen?: number | null;
  delivery_date?: string | null;
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  supplier_delivery_date_4?: string | null;
  notes?:         string | null;
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
  photo_urls?:    string[] | null;
};

const fmtMoney = (centi: number, currency: string): string => fmtMoneySen(centi, currency);

const fmtAmount = (centi: number): string =>
  (centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** DEV-65 (Sim 2026-10-09): delivery under 2 weeks after the PO date prints
    "URGENT", under 1 week "TOP URGENT". Compared on MYT calendar days, the
    same days the PDF prints. */
export function poUrgencyLabel(
  poDate: string | null | undefined,
  deliveryDate: string | null | undefined,
): 'TOP URGENT' | 'URGENT' | null {
  const toUtcDay = (d: string | null | undefined): number | null => {
    const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(fmtDocDate(d));
    return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) : null;
  };
  const from = toUtcDay(poDate);
  const to = toUtcDay(deliveryDate);
  if (from === null || to === null) return null;
  const days = (to - from) / 86_400_000;
  if (days < 7) return 'TOP URGENT';
  if (days < 14) return 'URGENT';
  return null;
}

const SOFA_MODULE_IDS_BY_LEN = SOFA_MODULES.map((m) => m.id).sort((a, b) => b.length - a.length);
/* Maintenance names the consoles "Console Fabric" / "Console Wooden" and their
   SKUs carry that upper-case ("9050-CONSOLE WOODEN"), so the exact "Console"
   suffix never matched and the piece fell off the layout (HC-0184,
   HC-PO-2610-438). Any trailing CONSOLE word draws as the one Console module. */
const CONSOLE_TAIL_RE = /(?:^|[-\s])CONSOLE(?:\s+[A-Z]+)*$/i;
function sofaModuleSuffixOf(code: string): { moduleId: string; suffixLen: number } | null {
  const exact = SOFA_MODULE_IDS_BY_LEN.find((id) => code.endsWith(id));
  if (exact) return { moduleId: exact, suffixLen: exact.length };
  const tail = CONSOLE_TAIL_RE.exec(code);
  return tail ? { moduleId: 'Console', suffixLen: tail[0].length } : null;
}
function sofaCellFromLine(
  variants: Record<string, unknown> | null | undefined,
  itemCode: string | null | undefined,
): { cell: Cell; depths: unknown[]; groupKey: string; idx: number } | null {
  if (!variants || typeof variants !== 'object') return null;
  const v = variants as Record<string, unknown>;
  const x = v.x;
  const y = v.y;
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  const moduleId = sofaModuleSuffixOf((itemCode ?? '').trim())?.moduleId ?? null;
  if (!moduleId || !findModule(moduleId)) return null;
  const rot: 0 | 90 | 180 | 270 = v.rot === 90 || v.rot === 180 || v.rot === 270 ? v.rot : 0;
  const groupKey = typeof v.summary === 'string' && v.summary.trim() ? v.summary.trim() : '';
  const idx = typeof v.cellIndex === 'number' && Number.isFinite(v.cellIndex) ? v.cellIndex : 0;
  const summaryDepth = /·\s*(\d+)(?:"|″)/.exec(groupKey)?.[1];
  const depths = [v.depth, v.seatHeight, summaryDepth, '24'];
  return { cell: { moduleId, x, y, rot }, depths, groupKey, idx };
}

const SOFA_MODULE_TOKEN_RE = /([A-Za-z0-9]+(?:\([A-Za-z]+\))+|CNR|Console|STOOL|1NA|2NA|1S|2S|3S)\s*$/;
function sofaModuleFromLine(
  itemCode: string | null | undefined,
  fallbackText: string | null | undefined,
): { moduleId: string; baseModel: string } | null {
  const code = (itemCode ?? '').trim();
  if (code) {
    const suffix = sofaModuleSuffixOf(code);
    if (suffix && findModule(suffix.moduleId)) {
      const base = code.slice(0, code.length - suffix.suffixLen).replace(/[-\s]+$/, '');
      return { moduleId: suffix.moduleId, baseModel: base };
    }
  }
  const text = (fallbackText ?? '').trim();
  if (CONSOLE_TAIL_RE.test(text)) return { moduleId: 'Console', baseModel: '' };
  const m = text.match(SOFA_MODULE_TOKEN_RE);
  const token = m?.[1]?.trim();
  if (token && findModule(token)) {
    return { moduleId: token, baseModel: '' };
  }
  return null;
}

function backendSofaKey(it: PoItem): { key: string; moduleId: string } | null {
  if ((it.item_group ?? '').toLowerCase() !== 'sofa') return null;
  if (sofaCellFromLine(it.variants, it.item_code)) return null;
  const mod = sofaModuleFromLine(it.item_code, it.material_name || it.description);
  if (!mod) return null;
  return { key: `${(it.so_doc_no ?? '').trim()}|${mod.baseModel.toUpperCase()}`, moduleId: mod.moduleId };
}

function walkBackendSofaRows<T extends PoItem>(rows: T[]): T[] {
  const byKey = new Map<string, number[]>();
  rows.forEach((it, i) => {
    const k = backendSofaKey(it);
    if (!k) return;
    byKey.set(k.key, [...(byKey.get(k.key) ?? []), i]);
  });
  const out = [...rows];
  for (const positions of byKey.values()) {
    const walked = splitBackendSofa(positions.map((i) => rows[i]!), (it) => backendSofaKey(it)!.moduleId).flat();
    positions.forEach((pos, k) => { out[pos] = walked[k]!; });
  }
  return out;
}

type JsPdf = import('jspdf').jsPDF;
type AutoTableFn = (typeof import('jspdf-autotable'))['default'];

async function renderPurchaseOrderInto(
  doc: JsPdf,
  autoTable: AutoTableFn,
  header: PoHeader,
  items: PoItem[],
  opts?: { docTitle?: string; sofaPhotos?: Record<string, string>; purchaseLocation?: string | null; photoMaxPx?: number },
): Promise<{ supplierName: string; firstPage: number; label: string }> {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 10; // tighter left/right than the SO's 14 (owner 2026-06-19)
  const docTitle = opts?.docTitle ?? 'PURCHASE ORDER';
  const firstPage = doc.getNumberOfPages();

  await ensureBrandingForActiveCompany();

  const { skuMap, fabricMap, fabricDescMap, supplier: fullSupplier } = await loadSupplierDocData(header.supplier_id, items);



  /* Printed row order, resolved BEFORE any drawing: the ITEM PHOTOS block at
     the page bottom is keyed by the table's row positions and the photo bytes
     must be in hand before drawing starts, so the ordering the items table
     used to compute inline moved up here — the table below reads this same
     const. Canonical SKU/build order (sofa modules LHF→NA→RHF, mains→
     accessories→services) — mirror the sales side. The shared helper keys on
     `item_code`; sort a shimmed view that carries the original row back
     unchanged (render-time only, no persistence touched).

     `sortLinesByStoredLineNo` is the BASE (owner 2026-09-10: 「我们的 Sales
     Order 都是从 L 到 R」, 「照片是根据 line item 的顺序来的」) — the document's
     own stored order, mig 20260910T0547. The two sorts above it are stable, so
     a line's place survives them, and this const drives BOTH the table and the
     photo block, which is why the photos scrambled with the lines. It is
     applied here as well as in the detail route's SQL because a caller may have
     fetched the items from somewhere with no ORDER BY. */
  const orderedItems = orderSofaModuleRowsWithinBuilds(
    walkBackendSofaRows(sortSoLinesByGroupRank(
      sortLinesByStoredLineNo(items.map((it) => ({ ...it, item_code: it.item_code, __row: it }))),
      (r) => r.item_group as string | null | undefined,
    )),
  ).map((r) => r.__row);

  /* Owner spec 2026-08 — photos follow the line onto the supplier PO. The
     code beside each row chip is the SUPPLIER code (the code they act on).
     The `.thumb` sibling is fetched first and a line whose thumb 404s falls
     back to its original (fetchLinePhotoForPdf — the AutoCount cutover keys
     have no thumb; docs/bugs/0815), each photo best-effort: a key whose fetch
     or decode fails is skipped and the PDF renders without it. */
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
          return fetchLinePhotoForPdf((k) => fetchPoItemPhotoBlob(poId, ownerId, k), key);
        },
        opts?.photoMaxPx != null ? pdfImageAt(opts.photoMaxPx) : blobToSquarePdfImage,
      )
    : new Map<string, PdfPhotoImage>();

  await ensurePdfCjkFont(doc, [
    header, items, fullSupplier, skuMap, fabricMap,
  ]);

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

  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text(docTitle, pageW / 2, y, { align: 'center' });
  y += 8;

  const s: Partial<SupplierRecord> = { ...(fullSupplier ?? {}), ...(header.supplier ?? {}) };
  const sFull = fullSupplier ?? {};
  const supplierAddressLines = [
    s.address,
    sFull.area,
    [sFull.postcode, sFull.state].filter(Boolean).join(' ').trim() || null,
    sFull.country,
  ].filter(Boolean) as string[];

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
  const singleSourceSo = (!lineSoDocs.length && noteSoDocTokens.length === 1) ? noteSoDocTokens[0]! : '';

  const effDelivery = effectiveDelivery(
    header.expected_at,
    header.supplier_delivery_date_2,
    header.supplier_delivery_date_3,
    header.supplier_delivery_date_4,
  );
  const poDetailRows: Array<[string, string]> = [
    // _R suffix (owner 2026-07-27) — the printed number shows the revision.
    ['PO No', poDisplayNumber(header.po_number, header.revision)],
    ['Your Ref No', yourRef],
    ['Date', fmtDocDate(header.po_date)],
    ['Delivery Date', effDelivery ? fmtDocDate(effDelivery) : ''],
    ...(opts?.purchaseLocation ? [['Purchase Location', opts.purchaseLocation] as [string, string]] : []),
  ];
  const infoTop = y;
  y = drawInfoColumns(doc, y,
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
    { title: 'PO DETAILS', rows: poDetailRows },
    margin,
  );

  if (Number(header.revision ?? 1) > 1) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(220, 38, 38);
    doc.text('AMENDED', pageW / 2 + 2 + 33, infoTop + 1);
    doc.setTextColor(0); doc.setFont('helvetica', 'normal');
  }

  const urgency = poUrgencyLabel(header.po_date, header.expected_at);
  if (urgency) {
    const printedRows = poDetailRows.filter(([, v]) => v.trim()).length;
    const boxX = pageW / 2 + 2;
    const boxY = infoTop + 4.6 + printedRows * 4 - 1;
    const boxW = 50;
    const boxH = 8;
    const prevLineWidth = doc.getLineWidth();
    doc.setDrawColor(220, 38, 38); doc.setLineWidth(0.5);
    doc.rect(boxX, boxY, boxW, boxH);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(220, 38, 38);
    doc.text(urgency, boxX + boxW / 2, boxY + boxH / 2 + 1.4, { align: 'center' });
    doc.setTextColor(0); doc.setDrawColor(0); doc.setLineWidth(prevLineWidth);
    doc.setFont('helvetica', 'normal');
    y = Math.max(y, boxY + boxH + 4);
  }

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
  type Row = [string, string, string, string, string, string, string, string];
  const rows: Row[] = orderedItems.map((it) => {
    const specs = docVariantLine(it, fabricMap, fabricDescMap, { labelled: true })
      || (it.description2 ?? '').trim();
    const lineEff = effectiveDelivery(
      it.delivery_date,
      it.supplier_delivery_date_2,
      it.supplier_delivery_date_3,
      it.supplier_delivery_date_4,
    );
    const descParts = [
      `${it.description ?? it.material_name}${photoKeysOf(it.photo_urls).length > 0 ? PHOTO_MARKER : ''}`,
      specs || null,
      (it.notes ?? '').trim() ? `Remark: ${(it.notes ?? '').trim()}` : null,
      lineEff ? `Delivery: ${fmtDocDate(lineEff)}` : null,
    ].filter(Boolean) as string[];
    return [
      (it.so_doc_no ?? '').trim() || singleSourceSo || '—',
      supplierCodeFor(it, skuMap),
      [...new Set(descParts)].join('\n'),
      (it.uom ?? 'UNIT').toUpperCase(),
      String(it.qty),
      fmtAmount(it.unit_price_sen),
      it.discount_sen ? fmtAmount(it.discount_sen) : '',
      fmtAmount(it.line_total_sen),
    ];
  });

  const drawerSides = orderedItems.map((it) => drawerSidesOf(it.variants));
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
    columnStyles: {
      0: { cellWidth: 34 },
      1: { cellWidth: 27, fontStyle: 'bold' },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 11 },
      4: { cellWidth: 10, halign: 'right' },
      5: { cellWidth: 19, halign: 'right' },
      6: { cellWidth: 11, halign: 'right' },
      7: { cellWidth: 19, halign: 'right' },
    },
    margin: { left: margin, right: margin, top: 16 },
    didParseCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 2 || drawerSides[data.row.index]!.length === 0) return;
      data.cell.styles.cellPadding = { top: 1.5, right: 1.5, bottom: 1.5 + DRAWER_DIAGRAM_H, left: 1.5 };
    },
    didDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 2) return;
      const sides = drawerSides[data.row.index]!;
      if (sides.length === 0) return;
      drawDrawerDiagram(
        doc, sides, data.cell.x + 1.5, data.cell.y + data.cell.height - DRAWER_DIAGRAM_H - 1,
        frontDrawerCountOf(orderedItems[data.row.index]!.item_code),
      );
    },
  });

  let lastY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 5;

  if (lastY > 250) { doc.addPage(); lastY = 20; }
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

  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  const words = doc.splitTextToSize(amountInWordsMyr(header.total_sen), totalsX - margin - 6) as string[];
  doc.text(words, margin, lastY);
  doc.setFont('helvetica', 'normal');
  const wordsY = lastY + words.length * 3.6 + 2;
  doc.setFontSize(8); doc.setTextColor(110);
  doc.text('E. & O.E.', margin, wordsY);
  doc.setTextColor(0);
  lastY = Math.max(totY + 8, wordsY + 6);

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
    { parts: Array<{ cell: Cell; idx: number }>; depths: unknown[]; model: string; soNo: string }
  >();
  const fallbackGroups = new Map<
    string,
    { modules: Array<{ moduleId: string; attachTo: string | null }>; depth: Depth; model: string; soNo: string }
  >();
  const geometryKeys = new Set<string>();
  const baseModelKey = (soNo: string, baseModel: string): string => `${soNo}|${baseModel.toUpperCase()}`;

  for (const it of orderedItems) {
    const soNo = (it.so_doc_no ?? '').trim();
    const part = sofaCellFromLine(it.variants, it.item_code);
    if (part) {
      const gk = `${soNo}|${part.groupKey}`;
      let g = sofaGroups.get(gk);
      if (!g) {
        const model = (part.groupKey ? (part.groupKey.split('·')[0] ?? '').trim() : '')
          || (it.material_name ?? '').trim()
          || (it.item_code ?? '').trim();
        g = { parts: [], depths: part.depths, model, soNo };
        sofaGroups.set(gk, g);
      }
      g.parts.push({ cell: part.cell, idx: part.idx });
      const bm = sofaModuleFromLine(it.item_code, it.material_name ?? it.description);
      if (bm) geometryKeys.add(baseModelKey(soNo, bm.baseModel));
      continue;
    }
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
    const pieces = Math.max(1, Math.min(20, Math.round(Number(it.qty) || 1)));
    const attachRaw = (it.variants as Record<string, unknown> | null)?.[CONSOLE_ATTACH_KEY];
    const attachTo = typeof attachRaw === 'string' ? attachRaw : null;
    for (let i = 0; i < pieces; i++) fg.modules.push({ moduleId: mod.moduleId, attachTo });
  }

  const distinctSofas: DistinctSofa[] = [];
  for (const g of sofaGroups.values()) {
    const cells = g.parts.sort((a, b) => a.idx - b.idx).map((p) => p.cell);
    if (cells.length === 0) continue;
    const caption = cells.map((c) => c.moduleId).filter(Boolean).join(' + ') || g.model;
    distinctSofas.push({ cells, depth: layoutDepth(cells, g.depths), model: caption, soNo: g.soNo });
  }
  for (const [fk, g] of fallbackGroups) {
    if (geometryKeys.has(fk)) continue;
    for (const pieces of splitBackendSofa(g.modules, (m) => m.moduleId)) {
      const cells = buildDefaultSofaCells(pieces, g.depth);
      if (cells.length === 0) continue;
      const caption = cells.map((c) => c.moduleId).join(' + ') || g.model;
      distinctSofas.push({ cells, depth: g.depth, model: caption, soNo: g.soNo });
    }
  }

  let photoSide: PhotoRegion | null = null;
  if (distinctSofas.length > 0) {
    const contentW = pageW - margin * 2;
    const DIAGRAM_W = 36;
    const DIAGRAM_H = 34;
    const CAP_H = 4;
    const GAP_X = 6;
    const ROW_H = DIAGRAM_H + CAP_H + 6;
    const perRow = Math.max(1, Math.floor((contentW + GAP_X) / (DIAGRAM_W + GAP_X)));

    const TITLE_H = 8;
    if (lastY + TITLE_H + ROW_H > 285) {
      doc.addPage(); lastY = 20;
    }

    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(0);
    /* PLAIN WORDS, because a supplier reads this, not an engineer. The old
       heading ended "(orientation / LHF·RHF)" — that parenthesis was a note to
       ourselves about which convention the drawing follows, and the owner
       flagged it as odd (2026-08-28: 「这个字眼也是奇怪？」). What the reader needs
       is the two facts the picture depends on: it is a plan view, and the front
       is the edge facing the TV. LHF/RHF still print in every line's own
       description, where they identify a part. */
    doc.text('Sofa layout — viewed from above, front faces the TV', margin, lastY);
    lastY += 6;

    let col = 0;
    let rowTop = lastY;
    /* THE ARTWORK IS FETCHED HERE, NOT PASSED IN, and only for the codes THIS
       sheet needs (2026-08-28). Five surfaces print a Purchase Order and only
       one of them was passing `sofaPhotos`, so the same document looked
       different depending on which button raised it — the owner found it by
       printing three and asking why they did not match. A caller that must
       remember to pass something is a caller that will forget.

       Keyed by module code because the code IS the artwork's name: the stored
       config carries no imageKey for the defaults (Products.tsx seeds those
       client-side), so a config lookup alone found nothing and drew schematics.
       See docs/bugs/0561.

       A supplied map only OVERRIDES per code, never replaces the lookup: the
       PO detail page passed the codes that had a stored imageKey, so once
       Maintenance stored "Console Fabric" every 1A/Console/2S on HC-PO-2610-007
       printed as a bare box (owner 2026-10-03: 为什么没有cupholder?). */
    const sofaArt = {
      ...await loadSofaCompartmentArtForPrint(
        distinctSofas.flatMap((s2) => s2.cells.map((c) => c.moduleId)),
      ),
      ...opts?.sofaPhotos,
    };
    for (const sofa of distinctSofas) {
      if (col >= perRow) {
        col = 0;
        rowTop += ROW_H;
      }
      if (rowTop + ROW_H > 290) {
        doc.addPage();
        rowTop = 20;
        col = 0;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(0);
        doc.text('Sofa layout — viewed from above, front faces the TV (cont.)', margin, rowTop);
        rowTop += 6;
      }
      const dx = margin + col * (DIAGRAM_W + GAP_X);
      const drawn = drawSofaLayout(doc, sofa.cells, sofa.depth, dx, rowTop, DIAGRAM_W, DIAGRAM_H, sofaArt);
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

  if (photoImages.size > 0) {
    const photoRes = drawItemPhotosBlock(doc, photoGroups, photoImages, {
      margin,
      contentW: pageW - margin * 2,
      startY: lastY,
      pageBottom: 275,
      pageTop: 20,
      side: photoSide,
      onNewPage: null,
    });
    if (photoRes.drew) {
      lastY = photoRes.pagesAdded > 0
        ? photoRes.endY + 6
        : Math.max(lastY, photoRes.endY + 6);
    }
  }

  if (lastY > 240) { doc.addPage(); lastY = 20; }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.setDrawColor(120); doc.setLineWidth(0.2);
  const sigW = (pageW - margin * 2) / 2 - 4;
  doc.rect(margin,            lastY, sigW, 24);
  doc.rect(margin + sigW + 8, lastY, sigW, 24);
  doc.text(`Authorised Signature (${COMPANY.name})`, margin + 2,            lastY + 21);
  doc.text('Supplier Acknowledgement',               margin + sigW + 8 + 2, lastY + 21);
  lastY += 28;

  if (header.status === 'CANCELLED') {
    const pageH = doc.internal.pageSize.getHeight();
    for (let p = firstPage; p <= doc.getNumberOfPages(); p += 1) {
      doc.setPage(p);
      doc.saveGraphicsState();
      doc.setGState(doc.GState({ opacity: 0.14 }));
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(72);
      doc.setTextColor(180, 30, 30);
      doc.text('CANCELLED', pageW / 2, pageH / 2, { align: 'center', angle: 30 });
      doc.restoreGraphicsState();
      doc.setTextColor(0, 0, 0);
    }
  }

  return { supplierName: s.name ?? 'supplier', firstPage, label: poDisplayNumber(header.po_number, header.revision) };
}

type PoPages = { firstPage: number; label: string };

function finalizePoPdf(doc: JsPdf, pos: PoPages[]): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageCount = doc.getNumberOfPages();
  pos.forEach((po, i) => {
    const lastPage = i + 1 < pos.length ? pos[i + 1]!.firstPage - 1 : pageCount;
    for (let p = po.firstPage; p <= lastPage; p += 1) {
      const pageLabel = docPageLabel(p, po.firstPage, lastPage);
      doc.setPage(p);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80);
      doc.text(`${po.label} · ${pageLabel}`, pageW - 10, 10, { align: 'right' });
      doc.setTextColor(110);
      doc.text(`${pageLabel}    ·    Generated ${fmtDocStamp()}`, pageW / 2, 287, { align: 'center' });
      doc.setTextColor(0);
    }
  });
}

export async function generatePurchaseOrderPdf(
  header: PoHeader,
  items: PoItem[],
  opts?: { docTitle?: string; action?: PdfAction; sofaPhotos?: Record<string, string>; purchaseLocation?: string | null },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  const rendered = await renderPurchaseOrderInto(doc, autoTable, header, items, opts);
  finalizePoPdf(doc, [rendered]);
  const { supplierName } = rendered;
  deliverPdf(
    doc,
    `${poDisplayNumber(header.po_number, header.revision)}-${safeName(supplierName)}.pdf`,
    opts?.action,
  );
}

export async function purchaseOrderPdfBase64(
  header: PoHeader,
  items: PoItem[],
  opts?: { docTitle?: string; sofaPhotos?: Record<string, string>; photoMaxPx?: number },
): Promise<string> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  finalizePoPdf(doc, [await renderPurchaseOrderInto(doc, autoTable, header, items, opts)]);
  const uri = doc.output('datauristring');
  return uri.slice(uri.indexOf(',') + 1);
}

export const PO_EMAIL_PDF_CAP_BYTES = 5 * 1024 * 1024;

export function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export async function purchaseOrderPdfForEmail(
  header: PoHeader,
  items: PoItem[],
): Promise<{ pdfBase64: string; photos: PoEmailPhotos }> {
  const full = await purchaseOrderPdfBase64(header, items);
  if (base64Bytes(full) <= PO_EMAIL_PDF_CAP_BYTES) return { pdfBase64: full, photos: 'full' };
  const reduced = await purchaseOrderPdfBase64(header, items, { photoMaxPx: PDF_EMAIL_PHOTO_PX });
  if (base64Bytes(reduced) <= PO_EMAIL_PDF_CAP_BYTES) return { pdfBase64: reduced, photos: 'reduced' };
  const bare = await purchaseOrderPdfBase64(header, items.map((it) => ({ ...it, photo_urls: [] })));
  return { pdfBase64: bare, photos: 'omitted' };
}

export async function generateCombinedPurchaseOrderPdf(
  pos: Array<{ header: PoHeader; items: PoItem[] }>,
  opts?: { docTitle?: string; fileName?: string; action?: PdfAction; sofaPhotos?: Record<string, string> },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  const pages: PoPages[] = [];
  for (let i = 0; i < pos.length; i += 1) {
    if (i > 0) doc.addPage();
    pages.push(await renderPurchaseOrderInto(doc, autoTable, pos[i]!.header, pos[i]!.items, opts));
  }
  finalizePoPdf(doc, pages);
  deliverPdf(doc, opts?.fileName ?? 'purchase-orders.pdf', opts?.action);
}
