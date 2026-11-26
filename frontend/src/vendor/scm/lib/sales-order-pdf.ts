import { formatPhone } from '@2990s/shared/phone';
import { buildVariantSummary, withFabricSupplierCode } from '@2990s/shared';
import { customerRefOf } from '../../../lib/customer-ref';
import type { RowInput } from 'jspdf-autotable';
import {
  allocatePwpTriggerNotes,
  orderSofaModuleRowsWithinBuilds,
  pwpRewardNote,
  soLineGroupRank,
  type SoPwpCodeRow,
} from '@2990s/shared/so-line-display';
import { docPageLabel,
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
import { orderAddressLines } from './order-address';
import { ensureProductCategories, mfgCategoryLabel } from './product-categories-store';
import { loadFabricDescriptionMap, loadFabricSupplierMap } from './supplier-doc-data';
import { composeSoLineDescription } from './so-line-description';
import { stripBookText } from './book-text';
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
import { fetchSoItemPhotoBlob } from './sales-order-queries';
import {
  ensureBrandingLogoLoaded,
  ensureBrandLogoLoaded,
  getBrandLogoCache,
} from '../../../lib/branding';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from './status-pill';
import { PDF_COMPRESS } from './pdf-options';


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
  customer_so_no?: string | null;
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
  deposit_sen?: number;
  line_count: number;
  currency: string;
  note: string | null;
  sales_location?: string | null;
  customer_po?: string | null;
  customer_delivery_date?: string | null;
  processing_date?: string | null;
  ship_to_address?: string | null;
  email?: string | null;
  city?: string | null;
  postcode?: string | null;
  customer_state?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  emergency_contact_relationship?: string | null;
  salesperson_name?: string | null;
  salesperson_phone?: string | null;
  paid_sen_total?: number | null;
  paid_outside_ledger_sen?: number | null;
  signature_b64?: string | null;
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
  cancelled?: boolean | null;
  photo_urls?: string[] | null;
};

type SoPayment = {
  paid_at: string;
  /* 2026-06-06 payment-method unify — 'installment' is first-class;
     'converted' = money moved from a cancelled order (docs/bugs/0931). */
  method: 'merchant' | 'transfer' | 'cash' | 'installment' | 'converted';
  converted_from_so_doc_no?: string | null;
  /* A negative converted row is money that LEFT (owner 2026-09-16). */
  converted_to_so_doc_no?: string | null;
  refund_pv_id?: string | null;
  merchant_provider: string | null;
  installment_months: number | null;
  online_type?: string | null;
  approval_code: string | null;
  amount_sen: number;
  account_sheet: string | null;
  collected_by_name: string | null;
  note: string | null;
};

const receiptTerms = (noun: string): readonly string[] => [
  `This ${noun} becomes a binding tax invoice once goods are delivered and full payment is reconciled.`,
  'Balance due is payable in full before delivery. Bank transfer, DuitNow QR, and cheque accepted.',
  'Delivery date is best-effort and may shift ±3 working days subject to operation confirmation.',
  `Stair-carry surcharges (if any) are billed on this ${noun} and are not invoiced separately on the DO.`,
  'Once the delivery date has been confirmed, any subsequent request to change or extend the date will incur a rescheduling surcharge.',
];

/* A Consignment Order is signed by the customer as the record of a TEMPORARY
   PROVISION — goods lent while their own order is corrected or still in
   production — and replaces the "Temporary provision" letter Operations used
   to issue (HC-SL0047, owner 2026-10-05). The receipt terms above talk about
   tax invoices, balances and surcharges; none of that applies to a loan, so the
   CO prints these instead. The customer's signature box doubles as the
   letter's "Client Acknowledgment". */
export const CONSIGNMENT_LOAN_TERMS: readonly string[] = [
  'This consignment order records a temporary provision: the items listed are lent to the customer as a courtesy until the order the customer placed is delivered. It is not a sale and no tax invoice is issued for it.',
  'The items are provided in good condition. Please use them with normal, everyday care and return them in a similar condition.',
  'Collection: once the order the customer placed has been delivered, our team will contact the customer to arrange a convenient time to collect the items. Please have them ready for pick-up.',
  'Liability: normal wear and tear or minor stains during the loan period are not charged. The customer is responsible only for damage caused by misuse, negligence or intentional acts.',
  'By signing below, the customer accepts this temporary provision and agrees to the terms above.',
];

export function consignmentLoanTerms(): readonly string[] {
  const phone = COMPANY.csPhone || COMPANY.phone;
  const email = COMPANY.csEmail || COMPANY.email;
  const reach = [phone, email].filter(Boolean).join(' or ');
  const help = reach
    ? `If anything comes up while the items are with you, contact us at ${reach} and we will be happy to help.`
    : 'If anything comes up while the items are with you, let us know and we will be happy to help.';
  return [...CONSIGNMENT_LOAN_TERMS.slice(0, -1), help, CONSIGNMENT_LOAN_TERMS[CONSIGNMENT_LOAN_TERMS.length - 1]!];
}

export const CONSIGNMENT_ORDER_PDF_OPTS = {
  docTitle: 'CONSIGNMENT ORDER',
  docNoLabel: 'CO No',
  docNoun: 'consignment order',
  /* The customer's own order (the one being corrected) — always printed, so a
     CO raised without it shows a dash instead of silently omitting the row.
     Captioned "Ref No." like every other screen (owner 2026-09-25, refNoLabel
     gate). */
  refLabel: 'Ref No.',
  get terms(): readonly string[] { return consignmentLoanTerms(); },
  money: false,
} as const;

const FABRIC_VARIANT_KEYS = ['fabricCode', 'colorCode', 'fabricColor'] as const;

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

const variantLine = (
  it: SoItem,
  fabricDescMap: Map<string, string>,
  fabricExtMap: Map<string, string>,
): string => {
  const v = it.variants;
  if (!v || typeof v !== 'object') return '';
  let mapped: Record<string, unknown> = v;
  let stamped = false;
  for (const key of FABRIC_VARIANT_KEYS) {
    const raw = v[key];
    if (typeof raw === 'string' && raw.trim()) {
      const code = raw.trim();
      const ext = fabricExtMap.get(code);
      const desc = fabricDescMap.get(code);
      if (ext || desc) {
        if (mapped === v) mapped = { ...v };
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
        if (ext && !stamped) { mapped = withFabricSupplierCode(mapped, ext); stamped = true; }
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

const methodLabel = (p: SoPayment): string => {
  if (p.method === 'merchant') {
    const base = p.merchant_provider ? `Merchant (${p.merchant_provider})` : 'Merchant';
    return p.installment_months ? `${base} · ${p.installment_months}m installment` : base;
  }
  if (p.method === 'transfer') return p.online_type ? `Online (${p.online_type})` : 'Online';
  if (p.method === 'installment') {
    const base = p.merchant_provider ? `Installment (${p.merchant_provider})` : 'Installment';
    return p.installment_months ? `${base} · ${p.installment_months}m` : base;
  }
  /* Money moved from a cancelled order (docs/bugs/0931): the order it came from. */
  if (p.method === 'converted' && Number(p.amount_sen) < 0) return p.refund_pv_id ? `Refund${p.account_sheet ? ` ${p.account_sheet.replace(/^Refund\s*/, '')}` : ''}` : p.converted_to_so_doc_no ? `Moved to ${p.converted_to_so_doc_no}` : 'Moved out';
  if (p.method === 'converted') return p.converted_from_so_doc_no ? `Moved from ${p.converted_from_so_doc_no}` : 'Moved from a cancelled order';
  return 'Cash';
};

export type { PdfAction } from './pdf-common';

type JsPdf = import('jspdf').jsPDF;
type AutoTableFn = (typeof import('jspdf-autotable'))['default'];

export async function renderSalesOrderInto(
  doc: JsPdf,
  autoTable: AutoTableFn,
  header: SoHeader,
  allItems: SoItem[],
  payments: SoPayment[] = [],
  pwpCodes: SoPwpCodeRow[] = [],
  opts?: { docTitle?: string; docNoLabel?: string; docNoun?: string; refLabel?: string; terms?: readonly string[]; money?: boolean },
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

  const startPage = doc.getNumberOfPages();

  await ensureProductCategories().catch((e: unknown) => console.warn("product categories not loaded; headings read the code", e));
  const fabricDescMap = await loadFabricDescriptionMap(collectFabricCodes(items));
  const fabricExtMap = await loadFabricSupplierMap(collectFabricCodes(items));

  const orderedItems = orderSofaModuleRowsWithinBuilds(
    [...items].sort((a, b) => groupRank(a.item_group) - groupRank(b.item_group)),
  );

  /* Owner spec 2026-08 — photos follow the line onto the printed document.
     The `.thumb` sibling is fetched first and a line whose thumb 404s falls
     back to its original (fetchLinePhotoForPdf — the AutoCount cutover keys
     have no thumb; docs/bugs/0815), each photo best-effort: a key whose fetch
     or decode fails is skipped and the PDF renders without it. */
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
          return fetchLinePhotoForPdf((k) => fetchSoItemPhotoBlob(header.doc_no, ownerId, k), key);
        },
        blobToSquarePdfImage,
      )
    : new Map<string, PdfPhotoImage>();

  await ensurePdfCjkFont(doc, [
    header, items, payments, fabricDescMap, fabricExtMap,
  ]);

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  await ensureBrandingLogoLoaded();
  const brandLogoKey =
    (header.resolvedBrandLogoKey ?? header.resolved_brand_logo_key ?? null) || null;
  if (brandLogoKey) await ensureBrandLogoLoaded(brandLogoKey);

  let y = drawHeader(doc, {
    docTitle: opts?.docTitle ?? 'SALES ORDER',
    rightMeta: [
      { label: opts?.docNoLabel ?? 'Doc No', value: header.doc_no },
      { label: 'Date', value: fmtDocDate(header.so_date) },
    ],
    logo: getBrandLogoCache(brandLogoKey),
  });

  /* Owner 2026-06-12 — Processing Date lives in processing_date: one column
     (0189), one name (0284). */
  const processingDate = header.processing_date ?? null;
  const deliveryDate = header.customer_delivery_date ?? null;

  /* DELIVERY address rule (owner): ship_to_address wins; otherwise mirror
     the Detail page's Customer card EXACTLY — Address line 1, Address line 2,
     then ONE locality line "postcode city state" where city = city ?? address3
     and postcode = postcode ?? address4 (the PR #39 POS column mapping; the
     page never renders address3/address4 as raw lines).

     Owner 2026-06-12 ("crossed address") — POS-composed rows already carry
     the postcode/city/state INSIDE the address lines, so the old code printed
     them twice (and city == state on KL doubled again). Each locality part is
     appended ONLY when it doesn't already appear in the lines above, locality
     parts are deduped against each other, and exact-duplicate lines drop.
     The rule lives in order-address.ts — the Deposit Invoice prints the same
     lines off the same order. */
  const addressLines = orderAddressLines(header);
  const familyContact = (header.emergency_contact_name ?? '').trim() || (header.emergency_contact_phone ?? '').trim()
    ? [
        (header.emergency_contact_name ?? '').trim(),
        (header.emergency_contact_phone ?? '').trim() ? formatPhone((header.emergency_contact_phone ?? '').trim()) : '',
        (header.emergency_contact_relationship ?? '').trim() ? `(${(header.emergency_contact_relationship ?? '').trim()})` : '',
      ].filter(Boolean).join(' · ')
    : null;
  const statusText = statusLabel('so', header.status);
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
      extras: [['Family', familyContact]],
      note: header.note,
    }),
    {
      title: 'ORDER DETAILS',
      rows: [
        [opts?.docNoLabel ?? 'Doc No', header.doc_no],
        ['Customer PO', header.customer_po ?? header.po_doc_no],
        /* The customer's own reference, resolved by the ONE rule (lib/customer-ref):
           `ref` leads, `customer_so_no` is the transitional fallback. The CO form
           writes customer_so_no, so reading header.ref alone printed a dash under
           "Ref No." while the screen showed HC12457 (owner, 2026-10-06). */
        [opts?.refLabel ?? 'Reference', opts?.refLabel ? (customerRefOf(header) || '—') : (customerRefOf(header) || null)],
        ['Agent', header.agent],
        ['Sales Location', header.sales_location],
        ['Venue', header.venue],
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

  /* Owner correction 2026-06-12 — ONE ROW PER SO LINE ITEM, exactly the
     items as stored ("有几个 SKU 就有几行"): no sofa-build folding, every
     SKU prints its own qty / unit price / disc / line total. Rows ordered
     by category (SOFA+MATTRESS → BEDFRAME → ACCESSORY → others → SERVICE
     last), stable within each group. Description cell = up to 3 lines:
       1. description ("SOFA BOOQIT 1B(LHF)")
       2. description2 / remark (when present)
       3. specs — fabric code — description / SEAT / LEG (variantLine)
     PWP notes (reward voucher consumed / trigger codes issued) come after. */
  const triggerNotesByLine = allocatePwpTriggerNotes(
    orderedItems.map((it) => [it.item_code]),
    pwpCodes,
  );
  const tableRows = orderedItems.map((it, itIdx) => {
    const notes = [
      pwpRewardNote(it.variants),
      ...(triggerNotesByLine[itIdx] ?? []),
    ].filter((n): n is NonNullable<typeof n> => n != null).map((n) => n.text);
    const composed = composeSoLineDescription({
      description: it.description ?? it.item_code,
      description2: (it.description2 ?? '').trim(),
      specs: variantLine(it, fabricDescMap, fabricExtMap) ?? '',
      /* The migrated AutoCount book text (`账本原文: …`) is stripped from the
         CUSTOMER's copy here; it stays on the ERP screen. See book-text.ts. */
      remark: stripBookText(typeof it.remark === 'string' ? it.remark : null) || null,
      notes,
    });
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
        /* The category's NAME, not its code: `fabric_accessory` printed as
           FABRIC_ACCESSORY on HC-SO-2609-071 while every screen says Sofa
           Accessory (owner 2026-09-15). An unknown group still prints as stored. */
        content: mfgCategoryLabel(grp).toUpperCase(), colSpan: 7,
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
  let ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

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

  /* A Consignment Order is a loan, not a sale: no payments are ever taken
     against it, so the ledger, totals, deposit and amount-in-words block are
     noise on a document the customer signs for goods they will give back
     (owner 2026-10-05). `money: false` drops the whole block. */
  if (opts?.money !== false) {
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

    const subtotalSen = header.local_total_sen;
    const paidSen = soPdfPaidSen(header, payments);
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

    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80);
    doc.text(
      doc.splitTextToSize(`Amount in words: ${amountInWordsMyr(subtotalSen)}`, totalsX - margin - 8) as string[],
      margin, awTopY + 1,
    );
    doc.setTextColor(0);

  }

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
  const rawSig = (header.signature_b64 ?? '').trim();
  if (rawSig) {
    try {
      const dataUrl = rawSig.startsWith('data:') ? rawSig : `data:image/png;base64,${rawSig}`;
      doc.addImage(dataUrl, 'PNG', margin + 2, ty + 1, sigW - 4, 20);
    } catch { }
  }
  ty += 26;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80);
  doc.text(
    [header.debtor_name, header.phone ? formatPhone(header.phone) : null].filter(Boolean).join(' · '),
    margin, ty,
  );
  doc.setTextColor(0);
  ty += 6;

  if (ty > 255) { doc.addPage(); ty = margin; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.text('Terms & Conditions', margin, ty);
  ty += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(110);
  (opts?.terms ?? receiptTerms(opts?.docNoun ?? 'sales order')).forEach((t, i) => {
    const wrapped = doc.splitTextToSize(`${i + 1}. ${t}`, pageW - margin * 2) as string[];
    doc.text(wrapped, margin, ty);
    ty += wrapped.length * 3.2 + 0.8;
  });
  doc.setTextColor(0);

  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.doc_no, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.so_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(docPageLabel(p, startPage, pageCount), pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

/** "Paid to date" on the SO print: the rows listed under PAYMENTS RECEIVED
    plus the part of the paid total outside both (a legacy header deposit), so the figure always agrees with the rows
    printed beside it. Taking the header's paid_sen_total whole let a cached header disagree with freshly read rows
    (both payments listed, "Paid to date" from before the second). Without the split (an older server, a consignment
    order) it falls back to the header total, then to the rows. */
export function soPdfPaidSen(
  header: Pick<SoHeader, 'paid_sen_total' | 'paid_outside_ledger_sen'>,
  payments: ReadonlyArray<Pick<SoPayment, 'amount_sen'>>,
): number {
  const rows = payments.reduce((sum, p) => sum + (p.amount_sen || 0), 0);
  if (typeof header.paid_outside_ledger_sen === 'number') return header.paid_outside_ledger_sen + rows;
  return typeof header.paid_sen_total === 'number' ? header.paid_sen_total : rows;
}

export async function generateSalesOrderPdf(
  header: SoHeader,
  items: SoItem[],
  payments: SoPayment[] = [],
  action: PdfAction = 'save',
  pwpCodes: SoPwpCodeRow[] = [],
  opts?: { docTitle?: string; docNoLabel?: string; docNoun?: string; refLabel?: string; terms?: readonly string[]; money?: boolean },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderSalesOrderInto(doc, autoTable, header, items, payments, pwpCodes, opts);

  const filename = `${header.doc_no}-${safeName(header.debtor_name || 'customer')}.pdf`;
  deliverPdf(doc, filename, action);
}

export async function generateCombinedSalesOrderPdf(
  docs: Array<{ header: SoHeader; items: SoItem[]; payments?: SoPayment[]; pwpCodes?: SoPwpCodeRow[] }>,
  opts?: { fileName?: string; docTitle?: string; docNoLabel?: string; docNoun?: string; refLabel?: string; terms?: readonly string[]; money?: boolean; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
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
