// ----------------------------------------------------------------------------
// Delivery Order PDF — customer-facing signed POD.
//
// 2026-09-08 REBUILT FOR THE PRINTER IT ACTUALLY GOES THROUGH. The DO is
// printed on an Epson LQ-310 dot-matrix printer onto 9.5 x 11 inch 2-ply
// continuous paper (owner). The Theme C "Ink & Petrol" sheet of 2026-08-07 was
// designed as CSS for a screen and printed unreadably there — see
// delivery-order-theme.ts for the three mechanisms. What changed:
//
//   · PAGE: Letter (8.5 x 11 in), not A4. 9.5 x 11 continuous paper is 8.5 in
//     wide once the tractor strips are torn off, and 11 in tall; A4 is 18mm
//     taller, so the print dialog was shrinking every sheet to fit — which
//     shrank the type with it.
//   · INK: black only. No grey text, no tinted fills, no pills, no rounded
//     paper panels or header bands — an impact printer dithers every one of
//     those into a field of dots.
//   · FACE: one family (helvetica) at the DO_SIZE scale, nothing under 9pt.
//     The courier identifier columns are gone.
//
// This renderer does NOT use the shared pdf-common letterhead / info block /
// signature helpers: the DO's header, panel and signature areas are specific
// to this document. The other seven documents keep the shared ones.
//
// Page anatomy (Letter portrait, padding 14/14/12mm): header → info panel →
// items table (the flexing item) → signature → footer. The signature and
// footer are pinned to the BOTTOM of the last page, so a 3-line DO and a
// 30-line DO both close the same way; the table absorbs the slack and repeats
// its header on every page it spills onto.
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
import { DO_SIZE as S, DO_THEME as T, SANS, charSpace, pt, type Rgb } from './delivery-order-theme';
import { docVariantLine, loadCustomerFabricMaps } from './supplier-doc-data';
import { drawQrIntoPdf } from './pdf-qr';
/* Owner spec 2026-08 — photos follow the line onto the printed document
   (SO → PO → DO). Same shared block the SO/PO PDFs print through; keys are
   the SO-carried `photo_urls` (mig 20260828T0746). All generated strings are
   WinAnsi by rule (pdf-item-photos.ts header). */
import {
  appendPhotoMarker,
  blobToSquarePdfImage,
  buildPhotoGroups,
  collectPhotoImages,
  drawItemPhotosBlock,
  fetchLinePhotoForPdf,
  photoKeyOwners,
  photoKeysOf,
  type PdfPhotoImage,
} from './pdf-item-photos';
import { fetchDoItemPhotoBlob } from './sales-order-queries';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from './status-pill';

type DoHeader = {
  /* Row id — the photo proxy route is keyed by it. Optional so the
     Consignment Note reuse (which has no DO row) stays valid; absent is the
     STRICTER direction: no photo fetch, the block simply does not print. */
  id?: string | null;
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
  /* Line row id — pairs with DoHeader.id on the photo proxy route. Optional
     for the same CN reuse; absent = that line fetches no photos (stricter). */
  id?: string | null;
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
  /* Line reference photos (R2 keys, delivery_order_items.photo_urls — carried
     from the SO line, mig 20260828T0746). Optional so the Consignment Note
     reuse stays valid. When present the row's first description line gains
     the " (photo)" marker and the ITEM PHOTOS block prints the `.thumb`
     siblings. */
  photo_urls?: string[] | null;
};

type Doc = import('jspdf').jsPDF;

// ── Page geometry ────────────────────────────────────────────────────────────
/* jsPDF 'letter': 8.5 x 11 in. The 9.5 x 11 continuous form is 8.5 in between
   its perforations, so this is the sheet the storekeeper tears off — not A4,
   which is 18mm taller and was being scaled down to fit (owner 2026-09-08). */
export const DO_PAGE_FORMAT = 'letter';
const PAGE_W = 215.9;
const PAGE_H = 279.4;
const M = 14;                       // left / right / top padding
const PAD_BOTTOM = 12;
const CONTENT_W = PAGE_W - M * 2;   // 187.9mm

const EM_DASH = '—';

/** Line height as a multiple of the size, for stacked prose. */
const LINE = 1.4;

// jsPDF places text on its BASELINE; blocks here are placed by their top edge.
// This is the cap-height drop that converts one to the other, and it is the
// single number that keeps the two columns of the header optically level.
const BASELINE_DROP = 0.78;
const baselineOf = (topMm: number, sizePt: number): number => topMm + pt(sizePt) * BASELINE_DROP;

const setInk = (doc: Doc, rgb: Rgb): void => { doc.setTextColor(rgb[0], rgb[1], rgb[2]); };
const setStroke = (doc: Doc, rgb: Rgb): void => { doc.setDrawColor(rgb[0], rgb[1], rgb[2]); };

/* Rule weights. An impact printer forms a line out of pin strikes, so a
   0.1mm hairline prints broken; 0.25mm is the thinnest that comes out solid
   on the second ply. */
const RULE_THIN = 0.25;
const RULE_HEAVY = 0.6;

/** A horizontal rule. jsPDF strokes centred on the path. */
const rule = (doc: Doc, x1: number, y: number, x2: number, widthMm: number): void => {
  setStroke(doc, T.line);
  doc.setLineWidth(widthMm);
  doc.line(x1, y, x2, y);
};

/** Set the one face at a size. Every text call goes through here, so the sheet
 *  cannot grow a second family or a size under the floor by accident. */
const font = (doc: Doc, sizePt: number, style: 'normal' | 'bold' = 'normal'): void => {
  doc.setFont(SANS, style);
  doc.setFontSize(sizePt);
};

/**
 * The letterhead: logo + company stack on the left, document title + number on
 * the right, closed by a heavy rule.
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
  opts: { docTitle: string; logo?: BrandingLogo | null },
): number {
  // ── Right column first: it is fixed-width and defines the left's measure ──
  const rightEdge = PAGE_W - M;
  const titleWords = opts.docTitle.trim().split(/\s+/);
  const titleTracking = charSpace(S.title, 0.06);

  font(doc, S.title, 'bold');
  let rightW = 0;
  for (const word of titleWords) {
    rightW = Math.max(rightW, doc.getTextWidth(word) + titleTracking * Math.max(0, word.length - 1));
  }

  let ty = baselineOf(M, S.title);
  setInk(doc, T.ink);
  for (const word of titleWords) {
    doc.text(word.toUpperCase(), rightEdge, ty, { align: 'right', charSpace: titleTracking });
    ty += pt(S.title * 1.1);
  }

  /* The DO number, bold and large: the one thing on the sheet the warehouse
     reads from across a desk. It used to be a brass pill. */
  const docNoBaseline = ty - pt(S.title * 1.1) + pt(S.docNo) + 2.5;
  font(doc, S.docNo, 'bold');
  doc.text(header.do_number, rightEdge, docNoBaseline, { align: 'right' });
  rightW = Math.max(rightW, doc.getTextWidth(header.do_number));

  const issuedBaseline = docNoBaseline + pt(S.meta) + 2;
  const issued = `Issued ${fmtDocDate(header.do_date)}`;
  font(doc, S.meta);
  doc.text(issued, rightEdge, issuedBaseline, { align: 'right' });
  rightW = Math.max(rightW, doc.getTextWidth(issued));

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

     It sits BESIDE the title column, not under it (2026-09-08). Stacked under
     the date it added ~18mm to the letterhead, and on the Letter sheet that
     alone pushed a three-line DO's signature onto a second form. Beside the
     title it costs the left column some measure and the letterhead no height.
     The header rule still clears whichever column ran longer. */
  if (header.scanToken && typeof window !== 'undefined') {
    /* 14mm, DOWN FROM 16 (owner, 2026-08-27: 「我不要 16mm，只想要 10mm，太大了可能
       会有影响」). 10mm was measured and refused back to him: the smallest QR that
       exists is 21 modules square, so 10mm cannot carry a URL at a readable module
       size no matter how short the link — it lands at 0.303mm, WORSE than the 16mm
       it replaced. 14mm with the shortened token is 0.424mm, which is both smaller
       on the sheet than today AND better to scan than today.

       This number is a FLOOR, not a promise: drawQrIntoPdf grows the code when the
       payload needs more room, so a delivery order still carrying a legacy 64-char
       token prints readable instead of silently unscannable. The code is drawn
       from its LEFT edge inside a 20mm reserve, so growing never runs it into
       the title column. */
    const QR = 14;
    const QR_BOX = 20;
    const QR_GAP = 6;
    const qrRight = rightEdge - rightW - QR_GAP;
    const url = `${window.location.origin}/d/${encodeURIComponent(header.scanToken)}`;
    const drawn = drawQrIntoPdf(doc, url, qrRight - QR_BOX, M, QR);
    font(doc, S.footer, 'bold');
    setInk(doc, T.ink);
    const caption = 'SCAN AT EACH STEP';
    const labelBaseline = baselineOf(M + Math.max(drawn, QR_BOX) + 1, S.footer);
    doc.text('SCAN AT EACH STEP', qrRight, labelBaseline, { align: 'right' });
    rightW += QR_GAP + Math.max(QR_BOX, drawn, doc.getTextWidth(caption));
    rightBottom = Math.max(rightBottom, labelBaseline + 0.8);
  }

  // ── Left column, wrapped into what the right one left ────────────────────
  const GUTTER = 7;
  let textX = M;
  let logoBottom = 0;
  const logo = opts.logo ?? getBrandingLogoCache();
  if (logo) {
    /* The box is 28.8 x 20mm: wide enough for 2990's WIDE mark (≈2.25:1) to
       fill edge to edge, tall enough that Houzs's stacked, near-square lockup
       covers about the same area (20² ≈ 28.8 x 12.8) so the two companies'
       documents carry equal weight (owner 2026-08-07).
       A logo is never distorted to fill the box: it is scaled to fit and
       CENTRED in it, because the text column starts after the box's full
       width either way, and a narrow mark pinned left reads as though it had
       drifted away from the wordmark. */
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

  font(doc, S.company, 'bold');
  const nameLines = doc.splitTextToSize(COMPANY.name, leftMaxW) as string[];
  let y = baselineOf(M, S.company);
  setInk(doc, T.ink);
  nameLines.forEach((line, i) => {
    if (i) y += pt(S.company * 1.15);
    doc.text(line, textX, y);
  });

  font(doc, S.meta);
  if (COMPANY.reg) {
    y += 2 + pt(S.meta);
    doc.text(COMPANY.reg, textX, y);
  }

  const addressLines = COMPANY.addressLines.flatMap(
    (line) => doc.splitTextToSize(line, leftMaxW) as string[],
  );
  let first = true;
  for (const line of addressLines) {
    y += first ? 2 + pt(S.meta) : pt(S.meta * LINE);
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
    const label = 'Customer Service';
    const labelW = doc.getTextWidth(label) + 2;
    const csLines = doc.splitTextToSize(cs.join('  ·  '), Math.max(30, leftMaxW - labelW)) as string[];
    csLines.forEach((line, i) => {
      y += i === 0 ? 2 + pt(S.meta) : pt(S.meta * LINE);
      if (i === 0) doc.text(label, textX, y);
      doc.text(line, textX + labelW, y);
    });
  }

  const ruleY = Math.max(y + 1.2, rightBottom, logoBottom) + 5;
  rule(doc, M, ruleY, PAGE_W - M, RULE_HEAVY);
  return ruleY;
}

/** Section caption — bold, uppercase. */
function drawCaption(doc: Doc, text: string, x: number, top: number): number {
  font(doc, S.caption, 'bold');
  setInk(doc, T.ink);
  doc.text(text.toUpperCase(), x, baselineOf(top, S.caption));
  return top + pt(S.caption) + 3;
}

/**
 * DELIVER TO / DELIVERY DETAILS — one ruled box, two columns.
 *
 * Drawn in two passes: the columns are measured first (so the box can be
 * sized to the taller one), then the box is stroked and the content is drawn
 * on top. Measuring by drawing into a throwaway pass would double every text
 * call, so instead each column's writer is run once in `measure` mode.
 */
function drawInfoPanel(doc: Doc, top: number, header: DoHeader): number {
  const PAD_X = 5;
  const PAD_Y = 4.5;
  const GAP = 8;
  /* Space between the customer name and the debtor code that follows it. */
  const CODE_GAP = 3;
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
    let y = draw ? drawCaption(doc, 'Deliver To', leftX, contentTop) : contentTop + pt(S.caption) + 3;

    font(doc, S.customer, 'bold');
    const nameLines = doc.splitTextToSize(
      `Customer :  ${header.debtor_name || EM_DASH}`,
      colW,
    ) as string[];
    for (const line of nameLines) {
      y += pt(S.customer) * 1.2;
      if (draw) { setInk(doc, T.ink); doc.text(line, leftX, y); }
    }
    /* The debtor code rides on the name's last line — it is how the warehouse
       and the customer's own AP team match the account, and it costs no height
       there. Omitted rather than dashed when a record has none.

       IT ONLY RIDES IF IT FITS. `splitTextToSize` wraps the NAME to colW, so a
       name whose last line ends near the column edge left no room, and the code
       was drawn past it — straight over "SO No" in the details column
       (docs/bugs/0550). When it does not fit it takes its own line instead, and
       the MEASURE pass counts that line too, so the panel grows with it rather
       than the code falling out of the bottom. */
    const codeFits = (): boolean => {
      if (!header.debtor_code) return true;
      const lastLine = nameLines[nameLines.length - 1] ?? '';
      font(doc, S.customer, 'bold');
      const nameW = doc.getTextWidth(lastLine);
      font(doc, S.body);
      return nameW + CODE_GAP + doc.getTextWidth(header.debtor_code) <= colW;
    };
    if (header.debtor_code) {
      const inline = codeFits();
      const lastLine = nameLines[nameLines.length - 1] ?? '';
      let codeX = leftX;
      if (inline) {
        font(doc, S.customer, 'bold');
        codeX = leftX + doc.getTextWidth(lastLine) + CODE_GAP;
      } else {
        y += pt(S.body) * 1.2;
      }
      if (draw) {
        font(doc, S.body);
        doc.text(header.debtor_code, codeX, y);
      }
    }

    font(doc, S.body);
    // The address measure is capped so it never crowds the details column.
    const addrLines = doc.splitTextToSize(address || EM_DASH, Math.min(78, colW)) as string[];
    y += 2.5 + pt(S.body);
    if (draw) doc.text('Address:', leftX, y);
    for (const line of addrLines) {
      y += pt(S.body * LINE);
      if (draw) doc.text(line, leftX, y);
    }

    y += 2 + pt(S.body);
    if (draw) {
      const tel = header.phone ? formatPhone(header.phone) : EM_DASH;
      font(doc, S.body);
      doc.text('Tel :', leftX, y);
      const labelW = doc.getTextWidth('Tel :') + 1.6;
      font(doc, S.body, 'bold');
      doc.text(tel, leftX + labelW, y);
    }

    // Delivery note from the order — the "ring the bell twice", "leave with the
    // guardhouse" line. Whatever it says, the driver is the one who needs it,
    // so it prints on the driver's sheet. Absent when blank.
    const note = (header.notes || '').trim();
    if (note) {
      font(doc, S.body);
      const noteLines = doc.splitTextToSize(note, Math.min(78, colW)) as string[];
      y += 2.5 + pt(S.body);
      if (draw) doc.text('Note:', leftX, y);
      for (const line of noteLines) {
        y += pt(S.body * LINE);
        if (draw) doc.text(line, leftX, y);
      }
    }
    return y;
  };

  // ── Right column: label gutter + value ───────────────────────────────────
  const LABEL_W = 30;
  const ROW_GAP = 2.2;
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

  const rows: Array<{ label: string; value: string | null; bold?: boolean }> = [
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
    /* The status WORD, bold and upper-cased. It used to be a teal pill, which
       an impact printer turns into a speckled box. */
    {
      label: 'Status',
      value: header.status ? statusLabel('do', header.status).toUpperCase() : null,
      bold: true,
    },
  ];

  const drawRight = (draw: boolean): number => {
    let y = draw ? drawCaption(doc, 'Delivery Details', rightX, contentTop) : contentTop + pt(S.caption) + 3;
    for (const row of rows) {
      const value = row.value || EM_DASH;
      y += ROW_GAP + pt(S.body);
      if (draw) {
        font(doc, S.body);
        doc.text(row.label, rightX, y);
        font(doc, S.body, row.bold ? 'bold' : 'normal');
        doc.text(value, rightX + LABEL_W + 4, y);
      }
    }
    return y;
  };

  const bottom = Math.max(drawLeft(false), drawRight(false)) + PAD_Y;
  const panelH = bottom - top;

  /* Stroke only. A filled panel — even the palest tint — dithers into dots
     under every word inside it. */
  setStroke(doc, T.line);
  doc.setLineWidth(RULE_THIN);
  doc.rect(M, top, CONTENT_W, panelH, 'S');

  drawLeft(true);
  drawRight(true);
  return top + panelH;
}

// ── Closing block geometry, shared by the drawer and the page-break check ────
const FOOTER_RULE_Y = PAGE_H - PAD_BOTTOM - 6;
const SIG_BOX_H = 20;
const SIG_FIELD_ROW = pt(S.sigField) + 3.6;
const SIG_TITLE_TOP = FOOTER_RULE_Y - 6 - SIG_FIELD_ROW * 2 - 2 - pt(S.sigTitle) - 2.5;
const SIG_BOX_TOP = SIG_TITLE_TOP - SIG_BOX_H;
/** Content must end above this or the closing block takes a fresh page. */
const CLOSING_TOP = SIG_BOX_TOP - 6;

/** Signature blocks + footer, pinned to the bottom of the page they close. */
function drawClosing(doc: Doc, header: DoHeader, pageOf: { page: number; total: number }): void {
  const colW = (CONTENT_W - 10) / 2;
  const blocks: Array<{ x: number; title: string }> = [
    { x: M, title: 'Customer Acknowledged Receipt' },
    { x: M + colW + 10, title: `${COMPANY.name} — Driver Signature` },
  ];

  for (const block of blocks) {
    rule(doc, block.x, SIG_BOX_TOP + SIG_BOX_H, block.x + colW, RULE_THIN);

    font(doc, S.sigTitle, 'bold');
    setInk(doc, T.ink);
    const titleLines = doc.splitTextToSize(block.title, colW) as string[];
    doc.text(titleLines[0]!, block.x, baselineOf(SIG_TITLE_TOP + 2.5, S.sigTitle));

    font(doc, S.sigField);
    let y = SIG_TITLE_TOP + 2.5 + pt(S.sigTitle) + 2;
    for (const label of ['Name', 'Date']) {
      const baseline = baselineOf(y, S.sigField);
      doc.text(label, block.x, baseline);
      const labelW = doc.getTextWidth('Date') + 3;
      /* Solid, not dotted: a row of 0.1mm dots is exactly the mark an impact
         printer cannot form, and the field read as a smear. */
      rule(doc, block.x + labelW, baseline + 0.8, block.x + colW, RULE_THIN);
      y += SIG_FIELD_ROW;
    }
  }

  rule(doc, M, FOOTER_RULE_Y, PAGE_W - M, RULE_THIN);
  const footBaseline = baselineOf(FOOTER_RULE_Y + 3, S.footer);
  font(doc, S.footer);
  setInk(doc, T.ink);
  doc.text(
    'By signing above, the customer confirms receipt of the items listed in good order and condition.',
    M,
    footBaseline,
  );
  doc.text(`${header.do_number} · Page ${pageOf.page} of ${pageOf.total}`, PAGE_W - M, footBaseline, { align: 'right' });
}

/** The footer alone — every page that is not the one carrying the signature. */
function drawFooterOnly(doc: Doc, header: DoHeader, pageOf: { page: number; total: number }): void {
  rule(doc, M, FOOTER_RULE_Y, PAGE_W - M, RULE_THIN);
  const footBaseline = baselineOf(FOOTER_RULE_Y + 3, S.footer);
  font(doc, S.footer);
  setInk(doc, T.ink);
  doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.do_date)}`, M, footBaseline);
  doc.text(`${header.do_number} · Page ${pageOf.page} of ${pageOf.total}`, PAGE_W - M, footBaseline, { align: 'right' });
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
  const startPage = doc.getNumberOfPages();

  /* Photos follow the line (owner spec 2026-08): fetch the `.thumb` sibling of
     every carried photo key up front, falling back to the original when the
     thumb 404s (fetchLinePhotoForPdf — the AutoCount cutover keys have no
     thumb; docs/bugs/0815), best-effort — a key whose fetch or decode fails is
     skipped and the PDF renders without it. The CN reuse has no header id, so
     it fetches nothing by construction. */
  const doId = header.id ?? null;
  const photoGroups = doId
    ? buildPhotoGroups(items.map((it) => ({
        code: it.item_code,
        photoKeys: photoKeysOf(it.photo_urls),
      })))
    : [];
  const photoOwners = photoKeyOwners(
    items.flatMap((it) => (it.id ? [{ id: it.id, photoKeys: photoKeysOf(it.photo_urls) }] : [])),
  );
  const photoImages: Map<string, PdfPhotoImage> = doId && photoGroups.length > 0
    ? await collectPhotoImages(
        photoGroups,
        (key) => {
          const ownerId = photoOwners.get(key);
          if (!ownerId) return Promise.reject(new Error('photo_owner_missing'));
          return fetchLinePhotoForPdf((k) => fetchDoItemPhotoBlob(doId, ownerId, k), key);
        },
        blobToSquarePdfImage,
      )
    : new Map<string, PdfPhotoImage>();

  const ruleY = drawDoHeader(doc, header, {
    docTitle: opts?.docTitle ?? 'DELIVERY ORDER',
    logo: opts?.logo,
  });
  const panelBottom = drawInfoPanel(doc, ruleY + 6, header);

  // ── Line items ────────────────────────────────────────────────────
  // Description cell = SKU description + the UNIFIED variant line (same composer
  // as SO/DR/SI/consignment), so the line reads identically on every customer
  // document (Commander 2026-06-16).
  const fabric = await loadCustomerFabricMaps(items);
  // DO is QUANTITY-only (Owner 2026-06-26) — a delivery doc shows quantity /
  // volume, not money. The unit_price_sen still flows to the Sales Invoice.
  const listCell = (vals?: string[] | null): string =>
    vals && vals.length > 0 ? vals.join('\n') : EM_DASH;
  const descOf = (it: DoItem): string => {
    const composed = [it.description, docVariantLine(it, fabric.ext, fabric.desc)]
      .filter((s): s is string => Boolean(s));
    if (composed.length === 0) return EM_DASH;
    /* Owner spec: a row carries NO image — the " (photo)" marker on the first
       description line points the reader at the ITEM PHOTOS block below. */
    const lines = photoKeysOf(it.photo_urls).length > 0 ? appendPhotoMarker(composed) : composed;
    return lines.join('\n');
  };
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

  // Column widths as percentages of the measure. The identifier columns (item
  // code, Source PO) sit one step below body size so a 17-character PO number
  // fits its column on one line — a document number broken mid-string is the
  // one thing the storekeeper cannot read back.
  const pct = (p: number): number => (CONTENT_W * p) / 100;
  const idCol = { fontSize: S.tableHead, fontStyle: 'bold' as const };
  const columnStyles = showPicking
    ? {
        0: { cellWidth: pct(6), fontStyle: 'bold' as const },
        1: { cellWidth: pct(19), ...idCol },
        2: { cellWidth: 'auto' as const, fontStyle: 'bold' as const },
        3: { cellWidth: pct(22), ...idCol },
        4: { cellWidth: pct(7) },
        5: { cellWidth: pct(6), halign: 'right' as const, fontStyle: 'bold' as const },
        6: { cellWidth: pct(11), halign: 'right' as const },
      }
    : {
        0: { cellWidth: pct(6), fontStyle: 'bold' as const },
        1: { cellWidth: pct(19), ...idCol },
        2: { cellWidth: 'auto' as const, fontStyle: 'bold' as const },
        3: { cellWidth: pct(6), halign: 'right' as const, fontStyle: 'bold' as const },
        4: { cellWidth: pct(11), halign: 'right' as const },
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
      font: SANS,
      fontSize: S.body,
      cellPadding: { top: 1.8, right: 2, bottom: 1.8, left: 2 },
      valign: 'top',
      textColor: T.ink,
      lineColor: T.line,
      lineWidth: { bottom: RULE_THIN } as never,
    },
    headStyles: { fillColor: false as never, textColor: T.ink },
    footStyles: {
      fillColor: false as never,
      lineWidth: { top: RULE_HEAVY } as never,
      lineColor: T.line,
      textColor: T.ink,
      fontSize: S.tableFoot,
      fontStyle: 'bold',
    },
    columnStyles,
    margin: { left: M, right: M, bottom: PAGE_H - FOOTER_RULE_Y + 6 },
    /* The header row: bold upper-cased labels over a heavy rule. autoTable
       cannot upper-case a cell, so each head cell paints its own text and
       cancels autoTable's; the rule is drawn once, from the first cell. */
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
        rule(doc, M, data.cell.y + data.cell.height, PAGE_W - M, RULE_HEAVY);
      }
      const label = data.cell.text.join(' ').toUpperCase();
      font(doc, S.tableHead, 'bold');
      setInk(doc, T.ink);
      const baseline = baselineOf(data.cell.y + 2, S.tableHead);
      if (rightAlignedHead.has(data.column.index)) {
        doc.text(label, data.cell.x + data.cell.width - 2, baseline, { align: 'right' });
      } else {
        doc.text(label, data.cell.x + 2, baseline);
      }
      return false;
    },
  });

  // ── ITEM PHOTOS (owner spec 2026-08) ───────────────────────────────
  /* One block per document, AFTER the items table and BEFORE the pinned
     signature/footer. Row-number chips key each group back to the table
     above; a group never splits across pages (it moves whole, under a
     continued heading). Pages the block adds are swept up by the closing
     loop below, so they get the footer like any table spill page. The
     block draws in jsPDF's built-in helvetica, the same face as the rest of
     this sheet. Absent entirely when no photo actually fetched. */
  let finalY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? panelBottom);
  if (photoImages.size > 0) {
    const photoRes = drawItemPhotosBlock(doc, photoGroups, photoImages, {
      margin: M,
      contentW: CONTENT_W,
      startY: finalY + 6,
      pageBottom: FOOTER_RULE_Y - 6, // the items table's own bottom rail
      pageTop: M,
      side: null,
      onNewPage: null,
    });
    if (photoRes.drew) finalY = photoRes.endY;
  }

  // ── Closing: signature + footer, pinned to the bottom ──────────────
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
  const doc = new jsPDF({ unit: 'mm', format: DO_PAGE_FORMAT });
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
  const doc = new jsPDF({ unit: 'mm', format: DO_PAGE_FORMAT });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderDeliveryOrderInto(doc, autoTable, docs[i]!.header, docs[i]!.items, opts);
  }
  deliverPdf(doc, opts?.fileName ?? 'delivery-orders.pdf', opts?.action);
}
