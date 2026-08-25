// ----------------------------------------------------------------------------
// Delivery Order PDF — customer-facing signed POD.
//
// 2026-08-07 REBUILD to Theme C "Ink & Petrol" (owner handoff: design project
// "DO Layout 重新设计" / HANDOFF-delivery-order.md). The handoff is written as
// CSS; this document is drawn by jsPDF, so it is a reproduction, not a
// stylesheet — see delivery-order-theme.ts for how the palette is bound and
// which three colours have no DS token.
//
// This renderer does NOT use the shared pdf-common letterhead / info block /
// signature helpers: the DO's header, panel and signature areas are now
// specific to this document (logo + wordmark stack, doc-number chip, rounded
// paper panel, status chip). The other seven documents keep the shared ones.
//
// Page anatomy (A4 portrait, padding 14/14/12mm), mirroring the handoff's flex
// column: header → info panel → items table (the flexing item) → signature →
// footer. The signature and footer are pinned to the BOTTOM of the last page,
// so a 3-line DO and a 30-line DO both close the same way; the table absorbs
// the slack and repeats its header on every page it spills onto.
// ----------------------------------------------------------------------------

import { formatPhone } from '@2990s/shared/phone';
import {
  COMPANY,
  deliverPdf,
  ensurePdfCjkFont,
  fmtDocDate,
  safeName,
  type PdfAction,
} from './pdf-common';
import {
  getBrandingCompanyCode,
  getBrandingLogoCache,
  HOUZS_COMPANY_CODE,
  type BrandingLogo,
} from '../../../lib/branding';
import { DO_THEME as T, MONO, SANS, charSpace, monoFor, pt, type Rgb } from './delivery-order-theme';
import { docVariantLine, loadCustomerFabricMaps } from './supplier-doc-data';
import { drawQrIntoPdf } from './pdf-qr';

type DoHeader = {
  do_number: string;
  status: string;
  /* When set, the header carries a "scan to mark loaded" QR encoding
     /scm/do-load?id=<this>. EXPLICIT opt-in by name, not a generic id: the
     Consignment Note print reuses this renderer, and a CN must never grow a
     control that flips a DELIVERY ORDER's status. Only the DO surfaces set it. */
  /* The PUBLIC scan token (64 hex), stamped by armDoScanToken. Not a row id:
     the QR encodes /d/<token>, which opens with no login, because a driver has
     no account (owner: 「就跟hookka一样」). Absent = print no QR. */
  scanToken?: string | null;
  do_date: string;
  so_doc_no: string | null;
  debtor_code: string | null;
  debtor_name: string;
  expected_delivery_at: string | null;
  dispatched_at: string | null;
  signed_at: string | null;
  delivered_at: string | null;
  driver_name: string | null;
  vehicle: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  notes: string | null;
  m3_total_milli: number | null;
  /* The customer's OWN reference for this order. Houzs prints it beside our SO
     number; 2990 does not (owner 2026-08-07). Resolution mirrors the DO detail
     page's refOf() so the document and the screen never disagree. All optional:
     the Consignment Note reuse passes a header without them. */
  po_doc_no?: string | null;
  customer_so_no?: string | null;
  ref?: string | null;
};

type DoItem = {
  item_code: string;
  description: string | null;
  qty: number;
  m3_milli: number | null;
  unit_price_sen: number;
  /* Variant info snapshotted from the SO (migration 0058) — drives the unified
     variant line so DO/Consignment Note read like SO/PO/etc. */
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  /* Storekeeper picking (resolved server-side on the DO detail): the supplier
     PO(s) that supplied this line's goods, and the physical rack(s) they are
     stored on. Both optional / possibly empty → the cell shows a dash. */
  source_pos?: string[] | null;
  racks?: string[] | null;
};

type Doc = import('jspdf').jsPDF;

// ── Page geometry (handoff: A4, padding 14mm 14mm 12mm) ─────────────────────
const PAGE_W = 210;
const PAGE_H = 297;
const M = 14;                       // left / right / top padding
const PAD_BOTTOM = 12;
const CONTENT_W = PAGE_W - M * 2;   // 182mm

/** CSS px → mm at the 96dpi the handoff's radii are authored in. */
const px = (v: number): number => (v * 25.4) / 96;

const EM_DASH = '—';

// jsPDF places text on its BASELINE; the handoff places blocks by their top
// edge. This is the cap-height drop that converts one to the other, and it is
// the single number that keeps the two columns of the header optically level.
const BASELINE_DROP = 0.78;
const baselineOf = (topMm: number, sizePt: number): number => topMm + pt(sizePt) * BASELINE_DROP;

const setInk = (doc: Doc, rgb: Rgb): void => { doc.setTextColor(rgb[0], rgb[1], rgb[2]); };
const setFill = (doc: Doc, rgb: Rgb): void => { doc.setFillColor(rgb[0], rgb[1], rgb[2]); };
const setStroke = (doc: Doc, rgb: Rgb): void => { doc.setDrawColor(rgb[0], rgb[1], rgb[2]); };

/** A rule of a given thickness. jsPDF strokes centred on the path, which is why
 *  the 2px brand rules sit a hair lower than a CSS border would — negligible at
 *  0.5mm, and consistent for every rule on the page. */
const rule = (doc: Doc, x1: number, y: number, x2: number, widthMm: number, rgb: Rgb): void => {
  setStroke(doc, rgb);
  doc.setLineWidth(widthMm);
  doc.line(x1, y, x2, y);
};

/** A pill (border-radius: 999px) sized to its text, returning its width so the
 *  caller can right-align it. */
function drawChip(
  doc: Doc,
  opts: {
    text: string;
    /** Left edge, or — with `alignRight` — the right edge to hang it from. */
    x: number;
    top: number;
    sizePt: number;
    padX: number;
    padY: number;
    bg: Rgb;
    ink: Rgb;
    font?: string;
    style?: 'normal' | 'bold';
    tracking?: number;
    alignRight?: boolean;
  },
): { width: number; height: number } {
  const font = opts.font ?? SANS;
  const style = opts.style ?? 'bold';
  const tracking = opts.tracking ?? 0;
  doc.setFont(font, style);
  doc.setFontSize(opts.sizePt);
  const textW = doc.getTextWidth(opts.text) + tracking * Math.max(0, opts.text.length - 1);
  const w = textW + opts.padX * 2;
  const h = pt(opts.sizePt) + opts.padY * 2;
  const x = opts.alignRight ? opts.x - w : opts.x;
  setFill(doc, opts.bg);
  // Radius = half the height: the handoff's 999px, which is what makes it a
  // pill rather than a rounded box at any font size.
  doc.roundedRect(x, opts.top, w, h, h / 2, h / 2, 'F');
  setInk(doc, opts.ink);
  doc.text(opts.text, x + opts.padX, baselineOf(opts.top + opts.padY, opts.sizePt), { charSpace: tracking });
  return { width: w, height: h };
}

/** A dotted field rule — the Name / Date lines under each signature. jsPDF has
 *  no dotted stroke, so it is drawn as dots; `setLineDashPattern` exists but
 *  renders as dashes at this weight and reads as a strikethrough on paper. */
function dottedRule(doc: Doc, x1: number, x2: number, y: number, rgb: Rgb): void {
  setFill(doc, rgb);
  const step = 0.9;
  const r = 0.11;
  for (let x = x1; x <= x2; x += step) doc.circle(x, y, r, 'F');
}

/**
 * The letterhead: logo + company stack on the left, document title + number
 * chip on the right, closed by the 2px petrol rule.
 *
 * Both columns are laid out from their own top edge and the rule clears
 * whichever ran longer — the two never consult each other's width because the
 * right column is right-aligned and the left is wrapped into the measure that
 * remains. (That measure is the fix from 2026-08-07: the old shared letterhead
 * let a long address run straight under the meta column.)
 */
function drawDoHeader(
  doc: Doc,
  header: DoHeader,
  opts: { docTitle: string; docNoLabel: string; logo?: BrandingLogo | null },
): number {
  // ── Right column first: it is fixed-width and defines the left's measure ──
  const rightEdge = PAGE_W - M;
  const titleWords = opts.docTitle.trim().split(/\s+/);
  const titleTracking = charSpace(16, 0.1);

  doc.setFont(SANS, 'bold');
  doc.setFontSize(16);
  let rightW = 0;
  for (const word of titleWords) {
    rightW = Math.max(rightW, doc.getTextWidth(word) + titleTracking * Math.max(0, word.length - 1));
  }

  let ty = baselineOf(M, 16);
  setInk(doc, T.ink);
  for (const word of titleWords) {
    doc.text(word.toUpperCase(), rightEdge, ty, { align: 'right', charSpace: titleTracking });
    ty += pt(16 * 1.1);
  }

  const chipTop = ty - pt(16 * 1.1) + pt(16) * 0.3 + 3;
  const chip = drawChip(doc, {
    text: header.do_number,
    x: rightEdge,
    top: chipTop,
    sizePt: 10,
    padX: 3.4,
    padY: 1.4,
    bg: T.brassSoft,
    ink: T.brass,
    font: monoFor(header.do_number),
    tracking: charSpace(10, 0.04),
    alignRight: true,
  });
  rightW = Math.max(rightW, chip.width);

  const issuedTop = chipTop + chip.height + 2.5;
  const issuedBaseline = baselineOf(issuedTop, 8.5);
  const issuedDate = fmtDocDate(header.do_date);
  doc.setFont(monoFor(issuedDate), 'normal');
  doc.setFontSize(8.5);
  const dateW = doc.getTextWidth(issuedDate);
  setInk(doc, T.ink);
  doc.text(issuedDate, rightEdge, issuedBaseline, { align: 'right' });
  doc.setFont(SANS, 'normal');
  setInk(doc, T.inkMuted);
  doc.text('Issued', rightEdge - dateW - 1.2, issuedBaseline, { align: 'right' });
  rightW = Math.max(rightW, dateW + 1.2 + doc.getTextWidth('Issued'));

  let rightBottom = issuedBaseline + 1.2;

  /* THE SCAN QR. It points at the PUBLIC page now (2026-08-26): the driver has
     no account, so the link must open without one — the owner's call,
     「就跟hookka一样」 — and the 64-hex token in it is the only credential. It
     used to encode /scm/do-load?id=<uuid>, which only signed-in office staff
     could open.

     THE CAPTION CHANGED WITH IT, and had to. "SCAN · MARK LOADED" was written
     when the code did exactly one thing (DRAFT -> LOADED). Since the three-scan
     ladder it does four — confirm loading, confirm loaded onto the lorry,
     confirm departure, confirm delivered — so a caption naming one of them is
     wrong on three of the four papers a storekeeper picks up, and the one it
     names is the rung most papers never see. "SCAN AT EACH STEP" is what is
     true of every rung, and it tells the person holding the paper the thing the
     old caption did not: that this code is scanned more than once.

     Right column only — the header rule clears whichever column ran longer, so
     growing this column is layout-safe by construction. */
  if (header.scanToken && typeof window !== 'undefined') {
    const QR = 16;
    const qrTop = rightBottom + 2.5;
    const url = `${window.location.origin}/d/${encodeURIComponent(header.scanToken)}`;
    drawQrIntoPdf(doc, url, rightEdge - QR, qrTop, QR);
    doc.setFont(SANS, 'normal');
    doc.setFontSize(6.5);
    setInk(doc, T.inkMuted);
    const labelBaseline = baselineOf(qrTop + QR + 0.8, 6.5);
    doc.text('SCAN AT EACH STEP', rightEdge, labelBaseline, { align: 'right', charSpace: charSpace(6.5, 0.08) });
    rightW = Math.max(rightW, QR);
    rightBottom = labelBaseline + 0.8;
  }

  // ── Left column, wrapped into what the right one left ────────────────────
  const GUTTER = 7; // the handoff's header gap
  let textX = M;
  let logoBottom = 0;
  const logo = opts.logo ?? getBrandingLogoCache();
  if (logo) {
    /* The handoff's box is 28.8 x 14.6mm, sized around 2990's WIDE mark
       (≈2.25:1), which fills it edge to edge. Houzs's lockup is a stacked,
       near-square one: in a box that flat it is height-bound and lands at half
       the width, which is what the owner saw (2026-08-07).
       The height allowance is therefore 20mm, chosen so a SQUARE mark covers
       about the same area (20² ≈ 28.8 x 12.8) and the two companies' documents
       carry equal weight. A wide mark is unaffected — 2990's is still
       width-bound and renders exactly as before.
       A logo is never distorted to fill the box: it is scaled to fit and
       CENTRED in it. Centring matters because the text column starts after the
       box's full width either way — a mark narrower than the box, pinned left,
       leaves all its slack on one side and reads as though it had drifted away
       from the wordmark (owner 2026-08-07). A mark that fills the box (2990's)
       is unmoved by centring. */
    const BOX_W = 28.8;
    const BOX_H = 20;
    const scale = Math.min(BOX_W / logo.width, BOX_H / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;
    try {
      doc.addImage(logo.dataUrl, logo.format, M + (BOX_W - w) / 2, M + 1, w, h);
      textX = M + BOX_W + 4;
      logoBottom = M + 1 + h;
    } catch { /* fail-soft: text-only letterhead */ }
  }

  const leftMaxW = Math.max(40, rightEdge - rightW - GUTTER - textX);

  doc.setFont(SANS, 'bold');
  doc.setFontSize(15);
  const nameLines = doc.splitTextToSize(COMPANY.name, leftMaxW) as string[];
  let y = baselineOf(M, 15);
  setInk(doc, T.ink);
  nameLines.forEach((line, i) => {
    if (i) y += pt(15 * 1.15);
    doc.text(line, textX, y, { charSpace: charSpace(15, -0.01) });
  });

  if (COMPANY.reg) {
    y += 2 + pt(8);
    doc.setFont(monoFor(COMPANY.reg), 'normal');
    doc.setFontSize(8);
    setInk(doc, T.inkMuted);
    doc.text(COMPANY.reg, textX, y, { charSpace: charSpace(8, 0.02) });
  }

  doc.setFont(SANS, 'normal');
  doc.setFontSize(8.5);
  setInk(doc, T.inkSecondary);
  const addressLines = COMPANY.addressLines.flatMap(
    (line) => doc.splitTextToSize(line, leftMaxW) as string[],
  );
  let first = true;
  for (const line of addressLines) {
    y += first ? 2 + pt(8.5) : pt(8.5 * 1.5);
    first = false;
    doc.text(line, textX, y);
  }

  /* Customer-service contact (owner 2026-08-07). A delivery note is the one
     document a customer holds while something is wrong with the delivery, so
     the desk to call belongs on it.
     The dedicated Branding fields are an OVERRIDE, not a requirement: a company
     that has not set them falls back to its own headline phone / email, which
     is what the letterhead would print anyway and is the number a customer
     would find regardless. Houzs's headline number IS its service desk.
     The fallback reads THIS company's row, so a 2990 sheet still cannot print a
     Houzs contact — the invariant survives. Both blank ⇒ the line is omitted. */
  const cs = [COMPANY.csPhone || COMPANY.phone, COMPANY.csEmail || COMPANY.email]
    .map((v) => (v || '').trim())
    .filter(Boolean);
  if (cs.length > 0) {
    doc.setFont(SANS, 'normal');
    doc.setFontSize(8.5);
    const label = 'Customer Service';
    const labelW = doc.getTextWidth(label) + 2;
    const csLines = doc.splitTextToSize(cs.join('  ·  '), Math.max(30, leftMaxW - labelW)) as string[];
    csLines.forEach((line, i) => {
      y += i === 0 ? 2 + pt(8.5) : pt(8.5 * 1.35);
      if (i === 0) {
        setInk(doc, T.inkMuted);
        doc.setFont(SANS, 'normal');
        doc.text(label, textX, y);
      }
      setInk(doc, T.inkSecondary);
      doc.setFont(monoFor(line), 'normal');
      doc.text(line, textX + labelW, y);
    });
    doc.setFont(SANS, 'normal');
    setInk(doc, T.inkSecondary);
  }

  const ruleY = Math.max(y + 1.2, rightBottom, logoBottom) + 5;
  rule(doc, M, ruleY, PAGE_W - M, 0.5, T.petrol);
  return ruleY;
}

/** Eyebrow label — mono, uppercase, wide tracking, brass. */
function drawEyebrow(doc: Doc, text: string, x: number, top: number): number {
  doc.setFont(MONO, 'bold');
  doc.setFontSize(8.5);
  setInk(doc, T.brass);
  doc.text(text.toUpperCase(), x, baselineOf(top, 8.5), { charSpace: charSpace(8.5, 0.14) });
  return top + pt(8.5) + 3;
}

/**
 * DELIVER TO / DELIVERY DETAILS — one rounded paper panel, two columns.
 *
 * Drawn in two passes: the columns are measured first (so the panel can be
 * sized to the taller one), then the panel is filled and the content is drawn
 * on top. Measuring by drawing into a throwaway pass would double every text
 * call, so instead each column's writer is run once in `measure` mode.
 */
function drawInfoPanel(
  doc: Doc,
  top: number,
  header: DoHeader,
  opts: { docNoLabel: string },
): number {
  const PAD_X = 6;
  const PAD_Y = 5;
  const GAP = 8;
  const innerW = CONTENT_W - PAD_X * 2;
  const colW = (innerW - GAP) / 2;
  const leftX = M + PAD_X;
  const rightX = leftX + colW + GAP;
  const contentTop = top + PAD_Y;

  const address = [
    header.address1,
    header.address2,
    [header.postcode, header.city, header.state]
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
      .join(' '),
  ]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join(', ');

  // ── Left column ──────────────────────────────────────────────────────────
  const drawLeft = (draw: boolean): number => {
    let y = draw ? drawEyebrow(doc, 'Deliver To', leftX, contentTop) : contentTop + pt(8.5) + 3;

    doc.setFont(SANS, 'bold');
    doc.setFontSize(12);
    const nameLines = doc.splitTextToSize(
      `Customer :  ${header.debtor_name || EM_DASH}`,
      colW,
    ) as string[];
    for (const line of nameLines) {
      y += pt(12) * 1.2;
      if (draw) { setInk(doc, T.ink); doc.text(line, leftX, y); }
    }
    // The debtor code rides on the name's last line — it is how the warehouse
    // and the customer's own AP team match the account, and it costs no height
    // there. Omitted rather than dashed when a record has none.
    if (draw && header.debtor_code) {
      const lastLine = nameLines[nameLines.length - 1] ?? '';
      doc.setFont(SANS, 'bold');
      doc.setFontSize(12);
      const nameW = doc.getTextWidth(lastLine);
      doc.setFont(monoFor(header.debtor_code), 'normal');
      doc.setFontSize(9);
      setInk(doc, T.inkMuted);
      doc.text(header.debtor_code, leftX + nameW + 3, y);
    }

    doc.setFont(SANS, 'normal');
    doc.setFontSize(9);
    // The handoff caps the address measure at 72mm so it never crowds the
    // details column even on a wide page.
    const addrLines = doc.splitTextToSize(address || EM_DASH, Math.min(72, colW)) as string[];
    y += 2.5 + pt(9);
    if (draw) { setInk(doc, T.inkSecondary); doc.text('Address:', leftX, y); }
    for (const line of addrLines) {
      y += pt(9 * 1.5);
      if (draw) doc.text(line, leftX, y);
    }

    y += 2 + pt(9);
    if (draw) {
      const tel = header.phone ? formatPhone(header.phone) : EM_DASH;
      setInk(doc, T.inkSecondary);
      doc.setFont(SANS, 'normal');
      doc.setFontSize(9);
      doc.text('Tel :', leftX, y);
      const labelW = doc.getTextWidth('Tel :') + 1.6;
      doc.setFont(monoFor(tel), 'normal');
      setInk(doc, T.ink);
      doc.text(tel, leftX + labelW, y);
    }

    // Delivery note from the order — the "ring the bell twice", "leave with the
    // guardhouse" line. Whatever it says, the driver is the one who needs it,
    // so it prints on the driver's sheet. Absent when blank.
    const note = (header.notes || '').trim();
    if (note) {
      doc.setFont(SANS, 'normal');
      doc.setFontSize(9);
      const noteLines = doc.splitTextToSize(note, Math.min(72, colW)) as string[];
      y += 2.5 + pt(9);
      if (draw) { setInk(doc, T.inkSecondary); doc.text('Note:', leftX, y); }
      for (const line of noteLines) {
        y += pt(9 * 1.5);
        if (draw) doc.text(line, leftX, y);
      }
    }
    return y;
  };

  // ── Right column: label gutter + value ───────────────────────────────────
  const LABEL_W = 26;
  const ROW_GAP = 2;
  /* Houzs prints OUR number and the CUSTOMER'S own reference on separate lines;
     2990 prints the single "SO Ref" (owner 2026-08-07). The customer reference
     resolves exactly as the DO detail page's refOf() does — po_doc_no, then
     customer_so_no, then ref — so the document and the screen can never
     disagree about which of the three a given record actually carries. */
  const isHouzs = getBrandingCompanyCode() === HOUZS_COMPANY_CODE;
  const customerRef = header.po_doc_no || header.customer_so_no || header.ref || null;
  const soRows = isHouzs
    ? [
        { label: 'SO No', value: header.so_doc_no, bold: true },
        { label: 'Ref No.', value: customerRef },
      ]
    : [{ label: 'SO Ref', value: header.so_doc_no, bold: true }];

  const rows: Array<{ label: string; value: string | null; bold?: boolean; chip?: boolean }> = [
    ...soRows,
    { label: 'Issued Date', value: fmtDocDate(header.do_date) },
    {
      label: 'Delivery Date',
      value: header.expected_delivery_at ? fmtDocDate(header.expected_delivery_at) : null,
    },
    // Who is bringing it, and in what. Printed only once the run is assigned —
    // a dashed "Driver —" on an unassigned DO is noise on the driver's sheet.
    ...(header.driver_name ? [{ label: 'Driver', value: header.driver_name }] : []),
    ...(header.vehicle ? [{ label: 'Vehicle', value: header.vehicle }] : []),
    {
      label: 'Status',
      value: header.status
        ? header.status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
        : null,
      chip: true,
    },
  ];

  const drawRight = (draw: boolean): number => {
    let y = draw ? drawEyebrow(doc, 'Delivery Details', rightX, contentTop) : contentTop + pt(8.5) + 3;
    for (const row of rows) {
      const value = row.value || EM_DASH;
      if (row.chip) {
        // The chip is a box, not a line of text: advance by its height so the
        // rows below (there are none today) would still clear it.
        const top2 = y + ROW_GAP;
        if (draw) {
          doc.setFont(SANS, 'normal');
          doc.setFontSize(9);
          setInk(doc, T.inkMuted);
          doc.text(row.label, rightX, baselineOf(top2 + 0.9, 7.5));
          drawChip(doc, {
            text: value.toUpperCase(),
            x: rightX + LABEL_W + 4,
            top: top2,
            sizePt: 7.5,
            padX: 3,
            padY: 0.9,
            bg: T.statusBg,
            ink: T.statusInk,
            tracking: charSpace(7.5, 0.08),
          });
        }
        y = top2 + pt(7.5) + 1.8;
        continue;
      }
      y += ROW_GAP + pt(9);
      if (draw) {
        doc.setFont(SANS, 'normal');
        doc.setFontSize(9);
        setInk(doc, T.inkMuted);
        doc.text(row.label, rightX, y);
        doc.setFont(monoFor(value), row.bold ? 'bold' : 'normal');
        setInk(doc, T.ink);
        doc.text(value, rightX + LABEL_W + 4, y);
      }
    }
    return y;
  };

  const bottom = Math.max(drawLeft(false), drawRight(false)) + PAD_Y;
  const panelH = bottom - top;

  setFill(doc, T.paper);
  setStroke(doc, T.line);
  doc.setLineWidth(0.2);
  doc.roundedRect(M, top, CONTENT_W, panelH, px(10), px(10), 'FD');

  drawLeft(true);
  drawRight(true);
  return top + panelH;
}

/** Signature blocks + footer, pinned to the bottom of the page they close. */
function drawClosing(doc: Doc, header: DoHeader, pageOf: { page: number; total: number }): void {
  const footerRuleY = PAGE_H - PAD_BOTTOM - 6;
  const SIG_BOX_H = 24;
  const NAME_ROW = pt(8) + 3.2;
  const sigTitleTop = footerRuleY - 6 - NAME_ROW * 2 - 2 - pt(10) - 2.5;
  const sigBoxTop = sigTitleTop - SIG_BOX_H;

  const colW = (CONTENT_W - 10) / 2;
  const blocks: Array<{ x: number; title: string }> = [
    { x: M, title: 'Customer Acknowledged Receipt' },
    { x: M + colW + 10, title: `${COMPANY.name} — Driver Signature` },
  ];

  for (const block of blocks) {
    rule(doc, block.x, sigBoxTop + SIG_BOX_H, block.x + colW, 0.2, T.lineStrong);

    doc.setFont(SANS, 'bold');
    doc.setFontSize(10);
    setInk(doc, T.ink);
    const titleLines = doc.splitTextToSize(block.title, colW) as string[];
    doc.text(titleLines[0]!, block.x, baselineOf(sigTitleTop + 2.5, 10));

    doc.setFont(SANS, 'normal');
    doc.setFontSize(8);
    setInk(doc, T.inkMuted);
    let y = sigTitleTop + 2.5 + pt(10) + 2;
    for (const label of ['Name', 'Date']) {
      const baseline = baselineOf(y, 8);
      doc.text(label, block.x, baseline);
      const labelW = doc.getTextWidth('Date') + 3;
      dottedRule(doc, block.x + labelW, block.x + colW, baseline + 0.6, T.lineStrong);
      y += NAME_ROW;
    }
  }

  rule(doc, M, footerRuleY, PAGE_W - M, 0.2, T.line);
  const footBaseline = baselineOf(footerRuleY + 3, 7.5);
  doc.setFont(SANS, 'normal');
  doc.setFontSize(7.5);
  setInk(doc, T.inkMuted);
  doc.text(
    'By signing above, the customer confirms receipt of the items listed in good order and condition.',
    M,
    footBaseline,
  );
  const pageLabel = `${header.do_number} · Page ${pageOf.page} of ${pageOf.total}`;
  doc.setFont(monoFor(pageLabel), 'normal');
  doc.text(pageLabel, PAGE_W - M, footBaseline, { align: 'right' });
}

/** The footer alone — every page that is not the one carrying the signature. */
function drawFooterOnly(doc: Doc, header: DoHeader, pageOf: { page: number; total: number }): void {
  const footerRuleY = PAGE_H - PAD_BOTTOM - 6;
  rule(doc, M, footerRuleY, PAGE_W - M, 0.2, T.line);
  const footBaseline = baselineOf(footerRuleY + 3, 7.5);
  doc.setFont(SANS, 'normal');
  doc.setFontSize(7.5);
  setInk(doc, T.inkMuted);
  doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.do_date)}`, M, footBaseline);
  const pageLabel = `${header.do_number} · Page ${pageOf.page} of ${pageOf.total}`;
  doc.setFont(monoFor(pageLabel), 'normal');
  doc.text(pageLabel, PAGE_W - M, footBaseline, { align: 'right' });
}

/* Draw ONE delivery order's content into `doc`. Does NOT create the doc or
   save — the caller finalizes, so several DOs can share one doc (batch "Export
   PDF"). The footer loop starts at the page this DO began on (startPage) so
   combined docs keep each DO's own "page n of m" scoped to its own pages. */
export async function renderDeliveryOrderInto(
  doc: Doc,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: DoHeader,
  items: DoItem[],
  opts?: {
    docTitle?: string;
    docNoLabel?: string;
    showPicking?: boolean;
    /** Per-document logo override, same contract as pdf-common's drawHeader:
     *  null/undefined falls back to the company logo memo. */
    logo?: BrandingLogo | null;
  },
): Promise<void> {
  /* Before ANY drawing — the delivery address is the field that strands a
     driver when it prints as mojibake. No-op for a pure-WinAnsi DO. */
  await ensurePdfCjkFont(doc, [header, items]);

  // Source PO + Rack picking columns are a DELIVERY-ORDER aid; the Consignment
  // Note reuses this renderer but opts out (showPicking: false).
  const showPicking = opts?.showPicking !== false;
  const docNoLabel = opts?.docNoLabel ?? 'DO No';
  const startPage = doc.getNumberOfPages();

  const ruleY = drawDoHeader(doc, header, {
    docTitle: opts?.docTitle ?? 'DELIVERY ORDER',
    docNoLabel,
    logo: opts?.logo,
  });
  const panelBottom = drawInfoPanel(doc, ruleY + 6, header, { docNoLabel });

  // ── Line items ────────────────────────────────────────────────────
  // Description cell = SKU description + the UNIFIED variant line (same composer
  // as SO/DR/SI/consignment), so the line reads identically on every customer
  // document (Commander 2026-06-16).
  const fabric = await loadCustomerFabricMaps(items);
  // DO is QUANTITY-only (Owner 2026-06-26) — a delivery doc shows quantity /
  // volume, not money. The unit_price_sen still flows to the Sales Invoice.
  const listCell = (vals?: string[] | null): string =>
    vals && vals.length > 0 ? vals.join('\n') : EM_DASH;
  const descOf = (it: DoItem): string =>
    [it.description, docVariantLine(it, fabric.ext, fabric.desc)].filter(Boolean).join('\n') || EM_DASH;
  const m3Of = (it: DoItem): string => (it.m3_milli != null ? (it.m3_milli / 1000).toFixed(3) : EM_DASH);

  const rows = items.map((it, idx) => {
    // Row numbers are zero-padded (01, 02 …) so the column stays a fixed-width
    // rail rather than jittering at the tenth row.
    const seq = String(idx + 1).padStart(2, '0');
    return showPicking
      ? [seq, it.item_code, descOf(it), listCell(it.source_pos), listCell(it.racks), String(it.qty), m3Of(it)]
      : [seq, it.item_code, descOf(it), String(it.qty), m3Of(it)];
  });

  const qtyTotal = items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
  const m3Total = items.reduce((sum, it) => sum + (it.m3_milli ?? 0), 0) / 1000;
  // The label spans everything left of the numbers: at 5% the first column is
  // a row-number rail, and "TOTAL" dropped into it wraps to "TOT / AL".
  const foot = [[
    { content: 'TOTAL', colSpan: showPicking ? 5 : 3 },
    String(qtyTotal),
    m3Total.toFixed(3),
  ]];

  // Column widths are the handoff's percentages of the 182mm measure.
  const pct = (p: number): number => (CONTENT_W * p) / 100;
  const columnStyles = showPicking
    ? {
        0: { cellWidth: pct(5), textColor: T.tableHeadInk, fontStyle: 'bold' as const },
        1: { cellWidth: pct(19), fontSize: 8, fontStyle: 'bold' as const },
        2: { cellWidth: 'auto' as const, fontStyle: 'bold' as const },
        3: { cellWidth: pct(20), fontSize: 8, textColor: T.inkSecondary },
        4: { cellWidth: pct(8) },
        5: { cellWidth: pct(8), halign: 'right' as const, fontStyle: 'bold' as const },
        6: { cellWidth: pct(10), halign: 'right' as const, textColor: T.inkSecondary },
      }
    : {
        0: { cellWidth: pct(5), textColor: T.tableHeadInk, fontStyle: 'bold' as const },
        1: { cellWidth: pct(19), fontSize: 8, fontStyle: 'bold' as const },
        2: { cellWidth: 'auto' as const, fontStyle: 'bold' as const },
        3: { cellWidth: pct(8), halign: 'right' as const, fontStyle: 'bold' as const },
        4: { cellWidth: pct(10), halign: 'right' as const, textColor: T.inkSecondary },
      };

  const headRow = showPicking
    ? ['#', 'Item Code', 'Description', 'Source PO', 'Rack', 'Qty', 'm³']
    : ['#', 'Item Code', 'Description', 'Qty', 'm³'];
  const rightAlignedHead = new Set(showPicking ? [5, 6] : [3, 4]);

  autoTable(doc, {
    startY: panelBottom + 7,
    head: [headRow],
    body: rows,
    foot,
    // The header repeats on every page the table spills onto — a second sheet
    // of unlabelled numbers is not a delivery note.
    showFoot: 'lastPage',
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: {
      font: MONO,
      fontSize: 9,
      cellPadding: { top: 2.6, right: 2, bottom: 2.6, left: 2 },
      valign: 'top',
      textColor: T.ink,
      lineColor: T.line,
      lineWidth: { bottom: 0.1 } as never,
    },
    // Only the numeric / identifier columns are mono; Description is prose and
    // stays on the UI face. autoTable applies `font` per table, so the prose
    // column is switched back in didParseCell below.
    headStyles: { fillColor: false as never, textColor: T.tableHeadInk },
    footStyles: {
      fillColor: false as never,
      lineWidth: { top: 0.5 } as never,
      lineColor: T.petrol,
      textColor: T.burnt,
    },
    columnStyles,
    margin: { left: M, right: M, bottom: PAGE_H - (PAGE_H - PAD_BOTTOM - 6) + 6 },
    didParseCell: (data: { section: string; column: { index: number }; cell: { styles: Record<string, unknown> } }) => {
      const isDescription = data.column.index === 2;
      if (data.section === 'body') {
        if (isDescription) data.cell.styles.font = SANS;
        // The em-dash placeholder is deliberately fainter than a real value —
        // "nothing here" should not read as loudly as a rack number.
        if (String((data.cell as unknown as { text: string[] }).text?.join('') ?? '') === EM_DASH) {
          data.cell.styles.textColor = T.inkFaint;
        }
      }
      if (data.section === 'foot') {
        data.cell.styles.font = MONO;
        if (data.column.index === 0) {
          // The merged TOTAL label.
          data.cell.styles.fontSize = 7.5;
          data.cell.styles.textColor = T.inkMuted;
          data.cell.styles.fontStyle = 'bold';
        } else {
          data.cell.styles.fontSize = 10;
          data.cell.styles.fontStyle = 'bold';
        }
      }
    },
    /* The header row is a rounded paper band with tracked-out mono labels.
       autoTable can do neither — a per-cell fill would square the ends and it
       has no letter-spacing — so the band is drawn once (from the first cell)
       and every head cell paints its own text, then cancels autoTable's. */
    willDrawCell: (data: {
      section: string;
      column: { index: number };
      cell: {
        x: number; y: number; width: number; height: number;
        text: string[]; styles: { halign?: string };
      };
    }): boolean | void => {
      if (data.section !== 'head') return;
      if (data.column.index === 0) {
        setFill(doc, T.paper);
        doc.roundedRect(M, data.cell.y, CONTENT_W, data.cell.height, px(6), px(6), 'F');
      }
      const label = data.cell.text.join(' ');
      const tracking = charSpace(7.5, 0.12);
      doc.setFont(MONO, 'bold');
      doc.setFontSize(7.5);
      setInk(doc, T.tableHeadInk);
      const right = rightAlignedHead.has(data.column.index);
      const baseline = baselineOf(data.cell.y + 2.2, 7.5);
      if (right) {
        const w = doc.getTextWidth(label) + tracking * Math.max(0, label.length - 1);
        doc.text(label.toUpperCase(), data.cell.x + data.cell.width - 2 - w, baseline, { charSpace: tracking });
      } else {
        doc.text(label.toUpperCase(), data.cell.x + 2, baseline, { charSpace: tracking });
      }
      return false;
    },
  });

  // ── Closing: signature + footer, pinned to the bottom ──────────────
  const finalY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? panelBottom);
  const CLOSING_TOP = PAGE_H - PAD_BOTTOM - 6 - 6 - (24 + 2.5 + pt(10) + 2 + (pt(8) + 3.2) * 2);
  if (finalY > CLOSING_TOP) doc.addPage();

  const pageCount = doc.getNumberOfPages();
  const total = pageCount - startPage + 1;
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    const pageOf = { page: p - startPage + 1, total };
    if (p === pageCount) drawClosing(doc, header, pageOf);
    else drawFooterOnly(doc, header, pageOf);
  }
  setInk(doc, T.ink);
}

/* Single DO → its own file (unchanged behaviour). */
export async function generateDeliveryOrderPdf(
  header: DoHeader,
  items: DoItem[],
  opts?: { docTitle?: string; docNoLabel?: string; showPicking?: boolean; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderDeliveryOrderInto(doc, autoTable, header, items, opts);
  deliverPdf(doc, `${header.do_number}-${safeName(header.debtor_name || 'customer')}.pdf`, opts?.action);
}

/* Several DOs → ONE combined file, each DO starting on a new page. For the
   batch "Export PDF" action (download a customer's DOs in one attachment). */
export async function generateCombinedDeliveryOrderPdf(
  docs: Array<{ header: DoHeader; items: DoItem[] }>,
  opts?: { fileName?: string; docTitle?: string; docNoLabel?: string; showPicking?: boolean; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderDeliveryOrderInto(doc, autoTable, docs[i]!.header, docs[i]!.items, opts);
  }
  deliverPdf(doc, opts?.fileName ?? 'delivery-orders.pdf', opts?.action);
}
