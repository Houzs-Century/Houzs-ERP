// Delivery Order layout — the two things the owner reported on a real prod DO
// (2026-08-07), both of which render fine in code review and only show up in
// the printed sheet.
//
// 1. The letterhead's left block was drawn with NO width limit, so a long
//    company address simply ran under the right-hand meta column: on 2990's DO
//    "…Wilayah Persekutuan KL" ended up touching "Date: 06/08/2026". Nothing
//    threw — the two blocks are drawn by separate calls that never consult each
//    other.
// 2. The item table printed a near-black header band and striped rows. The
//    owner wants no fills on printed documents — first the DO, then (same
//    session) every other document that carried the same treatment.
//
// The DO itself has since been rebuilt on its own Theme C template, where pale
// paper panels and chips are deliberate; its assertions live in
// delivery-order-template.test.ts. What remains here covers the seven documents
// still drawn by the shared helpers.
//
// Both are pinned by measuring the DRAWN output (doc.text / doc.rect), not by
// asserting the options object — a theme or style rename would keep an
// options-level test green while the sheet changed.
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  setBrandingCache,
} from '../../../lib/branding';

type JsPdf = import('jspdf').jsPDF;

/* The real 2990 letterhead from the reported DO — long enough that the two
   address lines reach the right margin, which is what caused the collision. */
const CROWDED_BRANDING = {
  ...DEFAULT_BRANDING,
  companyName: '2990 HOME SDN. BHD.',
  registrationNo: '202501060667',
  address:
    'E-28-02 & E-28-03, Menara SUEZCAP 2, KL Gateway, No. 2, Jalan Kerinchi, '
    + 'Gerbang Kerinchi Lestari, 59200 Kuala Lumpur, Wilayah Persekutuan KL',
  postcode: '59200',
  logoR2Key: '',
};

/* A logo is not incidental to this bug — it is the cause. The letterhead text
   starts 46mm in when one is present, and that is what pushed 2990's address
   into the meta column. A 1x1 PNG stands in for the artwork; only the declared
   width/height feed the layout. */
const LOGO_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlE'
  + 'QVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const FAKE_LOGO = { key: 'test-logo', dataUrl: LOGO_PNG, format: 'PNG' as const, width: 400, height: 160 };

/* Every text draw with the horizontal extent it actually occupied. The width is
   measured INSIDE the spy, while the font and size that drew it are still in
   effect — measuring afterwards would use whatever font was left set last. */
type Span = { text: string; left: number; right: number; y: number };

function captureSpans(doc: JsPdf): Span[] {
  const spans: Span[] = [];
  const original = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value, x, y, options] = args;
    if (typeof x === 'number' && typeof y === 'number') {
      const lines = Array.isArray(value) ? value.map(String) : [String(value)];
      for (const line of lines) {
        const w = doc.getTextWidth(line);
        const rightAligned = (options as { align?: string } | undefined)?.align === 'right';
        spans.push({
          text: line,
          left: rightAligned ? x - w : x,
          right: rightAligned ? x : x + w,
          y,
        });
      }
    }
    return original(...args);
  }) as typeof doc.text);
  return spans;
}

/* Filled rectangles. jsPDF's rect() takes a style: 'F'/'FD'/'DF' paint, 'S' (or
   nothing) only strokes — so this counts fills and ignores the dashed
   signature boxes and the letterhead rule. */
function captureFills(doc: JsPdf): string[] {
  const fills: string[] = [];
  const original = doc.rect.bind(doc);
  vi.spyOn(doc, 'rect').mockImplementation(((...args: Parameters<typeof doc.rect>) => {
    const style = args[4];
    if (typeof style === 'string' && /f/i.test(style)) fills.push(style);
    return original(...args);
  }) as typeof doc.rect);
  return fills;
}

const HEADER = {
  do_number: '2990-DO-2608-006',
  status: 'Dispatched',
  do_date: '2026-08-06',
  so_doc_no: '2990-SO-2606-015',
  debtor_code: 'C-001',
  debtor_name: 'Jackal',
  expected_delivery_at: '2026-08-07',
  dispatched_at: null,
  signed_at: null,
  delivered_at: null,
  driver_name: null,
  vehicle: null,
  address1: '50, Jalan Elitis Suria, Valencia',
  address2: null,
  city: 'Sungai Buloh',
  state: 'Selangor',
  postcode: '47000',
  phone: '+60 16-663 6038',
  notes: null,
  m3_total_milli: 0,
};

const ITEMS = [
  { item_code: 'XAM-L', description: 'SOFA XAMMAR L(LHF)', qty: 1, m3_milli: 0, unit_price_sen: 0 },
  { item_code: 'XAM-R', description: 'SOFA XAMMAR 2A(RHF)', qty: 1, m3_milli: 0, unit_price_sen: 0 },
];

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

describe('letterhead: the company block never runs into the meta column', () => {
  test('a long address wraps instead of colliding with DO No / Date', async () => {
    setBrandingCache({ ...CROWDED_BRANDING }, '2990');
    const [{ jsPDF }, { drawHeader }] = await Promise.all([
      import('jspdf'),
      import('./pdf-common'),
    ]);

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const spans = captureSpans(doc);
    drawHeader(doc, {
      docTitle: 'DELIVERY ORDER',
      logo: FAKE_LOGO,
      rightMeta: [
        { label: 'DO No', value: '2990-DO-2608-006' },
        { label: 'Date', value: '06/08/2026' },
      ],
    });

    const meta = spans.filter((s) => /^(DELIVERY ORDER|DO No: |Date: )/.test(s.text));
    expect(meta).toHaveLength(3);
    const metaLeftEdge = Math.min(...meta.map((s) => s.left));

    // Everything that is NOT the meta column is the company block.
    const company = spans.filter((s) => !meta.includes(s));
    expect(company.length).toBeGreaterThan(0);
    const companyRightEdge = Math.max(...company.map((s) => s.right));

    // The load-bearing claim: no company line reaches the meta column.
    expect(companyRightEdge).toBeLessThan(metaLeftEdge);

    // And the guard actually engaged rather than the address happening to fit:
    // the address reaches drawHeader as 2 comma-split lines and has to wrap
    // further to clear the meta column.
    const addressSpans = company.filter(
      (s) => s.text !== CROWDED_BRANDING.companyName && s.text !== CROWDED_BRANDING.registrationNo,
    );
    expect(addressSpans.length).toBeGreaterThan(2);
    // The block sits BESIDE the logo, not under it — the indent is what makes
    // the measure narrow, so a regression that dropped it would hide the bug.
    expect(Math.min(...company.map((s) => s.left))).toBeGreaterThan(20);
  });

  test('a letterhead that already fits is not re-wrapped', async () => {
    setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
    const [{ jsPDF }, { drawHeader }] = await Promise.all([
      import('jspdf'),
      import('./pdf-common'),
    ]);

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const spans = captureSpans(doc);
    drawHeader(doc, {
      docTitle: 'DELIVERY ORDER',
      rightMeta: [{ label: 'DO No', value: 'DO-1' }],
    });

    // The company name is one 16pt line, not split mid-word.
    expect(spans.some((s) => s.text === DEFAULT_BRANDING.companyName)).toBe(true);
    expect(spans.some((s) => s.text === DEFAULT_BRANDING.registrationNo)).toBe(true);
  });
});

describe('the seven shared-template documents print no fills', () => {
  test('a Delivery Return draws zero filled rectangles', async () => {
    /* DR stands in for the seven documents still on the shared template: it
       shares DOC_TABLE_STYLES with all of them, so a regression that
       reintroduced a band would land in all of them at once. (The Delivery
       Order left this group on 2026-08-07 — it has its own Theme C template,
       whose pale panels ARE fills; delivery-order-template.test.ts holds the
       rule that survived the redesign.) */
    setBrandingCache({ ...CROWDED_BRANDING }, '2990');
    const [{ jsPDF }, { default: autoTable }, { renderDeliveryReturnInto }] =
      await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
        import('./delivery-return-pdf'),
      ]);

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const fills = captureFills(doc);
    await renderDeliveryReturnInto(
      doc,
      autoTable,
      {
        return_number: '2990-DR-2608-001',
        status: 'Received',
        return_date: '2026-08-06',
        debtor_code: 'C-001',
        debtor_name: 'Jackal',
        reason: 'Damaged in transit',
        refund_sen: 0,
        notes: null,
        delivery_order_id: null,
        sales_invoice_id: null,
      } as never,
      [
        {
          item_code: 'XAM-L',
          description: 'SOFA XAMMAR L(LHF)',
          qty_returned: 1,
          condition: 'Damaged',
          unit_price_sen: 0,
          refund_sen: 0,
        },
      ] as never,
    );

    expect(fills).toEqual([]);
  });

  test('the fill detector is live — a striped table still trips it', async () => {
    /* Control. Without this, "zero fills" could just mean the spy stopped
       seeing anything and both assertions above would be vacuously green. */
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const fills = captureFills(doc);
    autoTable(doc, {
      startY: 20,
      head: [['#', 'Item']],
      body: [['1', 'A'], ['2', 'B']],
      theme: 'striped',
      headStyles: { fillColor: [34, 31, 32], textColor: 250 },
    });

    expect(fills.length).toBeGreaterThan(0);
  });

  test('the shared table style declares no fill at all', async () => {
    /* All eight documents spread these, so one assertion covers the six that
       are not rendered here. */
    const { DOC_TABLE_STYLES, DOC_TABLE_HEAD_STYLES } = await import('./pdf-common');
    expect(DOC_TABLE_STYLES).not.toHaveProperty('fillColor');
    expect(DOC_TABLE_HEAD_STYLES).not.toHaveProperty('fillColor');
    expect(DOC_TABLE_HEAD_STYLES).not.toHaveProperty('textColor');
  });
});
