// Delivery Order — the Theme C template (owner handoff 2026-08-07).
//
// The DO is drawn by jsPDF, so "does it match the design" is not something a
// test can assert. What IS worth pinning are the properties that make the sheet
// USABLE, each of which has already broken once in this file's history:
//
//   · the letterhead's two columns must not overlap (2990's long address ran
//     under the date on a real prod DO);
//   · nothing on the page may be a dark fill — the owner's standing rule from
//     the same day, which the redesign had to honour while introducing pale
//     panels of its own;
//   · the TOTAL label must not wrap ("TOT / AL" — caught in review, because the
//     row-number column is 5% wide and the label was dropped into it);
//   · a DO that spills onto a second page must repeat the column header, close
//     with exactly one signature block, and number its own pages — the combined
//     batch export puts several DOs in one file, so "page 1 of 1" is per
//     document, not per file.
//
// Everything is measured off the DRAWN output (doc.text / doc.rect /
// doc.roundedRect), never off the options object: a style rename would keep an
// options-level test green while the sheet changed.
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  setBrandingCache,
  type BrandingLogo,
} from '../../../lib/branding';

type JsPdf = import('jspdf').jsPDF;

/* The real 2990 letterhead — long enough that its address reaches the right
   margin, which is what made the two header columns collide. */
const BRANDING_2990 = {
  ...DEFAULT_BRANDING,
  companyName: '2990 HOME SDN. BHD.',
  registrationNo: '202501060667',
  address:
    'E-28-02 & E-28-03, Menara SUEZCAP 2, KL Gateway, No. 2, Jalan Kerinchi, '
    + 'Gerbang Kerinchi Lestari, 59200 Kuala Lumpur, Wilayah Persekutuan KL',
  postcode: '59200',
  logoR2Key: '',
};

/* A logo is not incidental to the collision — it is the cause: the letterhead
   text starts ~33mm in when one is present. 1x1 PNG; only the declared
   dimensions feed the layout. */
const LOGO: BrandingLogo = {
  key: 'test-logo',
  dataUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlE'
    + 'QVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  format: 'PNG',
  width: 3508,
  height: 1561,
};

const HEADER = {
  do_number: '2990-DO-2608-006',
  status: 'dispatched',
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
  phone: '+60166636038',
  notes: null,
  m3_total_milli: 0,
};

const itemAt = (i: number) => ({
  item_code: `XAMMAR-${i}(LHF)`,
  description: `SOFA XAMMAR ${i} module, a description long enough to wrap`,
  qty: 1,
  m3_milli: 1234,
  unit_price_centi: 0,
  source_pos: ['2990-PO-2607-003'],
  racks: i % 2 ? ['A-12'] : [],
});

type Span = { text: string; left: number; right: number; y: number; page: number };
type Fill = { rgb: [number, number, number]; y: number };

/** Text spans with the horizontal extent they occupied, plus every filled
 *  rectangle and the colour it was painted with. Widths and colours are read
 *  INSIDE the spies, while the font / fill state that produced them is still
 *  in effect — reading afterwards would report whatever was set last. */
function capture(doc: JsPdf): { spans: Span[]; fills: Fill[] } {
  const spans: Span[] = [];
  const fills: Fill[] = [];
  let fill: [number, number, number] = [255, 255, 255];
  const page = () => (doc as unknown as { internal: { getCurrentPageInfo: () => { pageNumber: number } } })
    .internal.getCurrentPageInfo().pageNumber;

  const setFillColor = doc.setFillColor.bind(doc);
  vi.spyOn(doc, 'setFillColor').mockImplementation(((...args: unknown[]) => {
    if (args.length >= 3) fill = [Number(args[0]), Number(args[1]), Number(args[2])];
    else if (typeof args[0] === 'number') fill = [args[0], args[0], args[0]];
    return (setFillColor as (...a: unknown[]) => unknown)(...args);
  }) as typeof doc.setFillColor);

  const record = (style: unknown, y: unknown) => {
    // jsPDF paints on 'F' / 'FD' / 'DF'; 'S' (or nothing) only strokes, so the
    // rules and the signature lines are correctly ignored.
    if (typeof style === 'string' && /f/i.test(style) && typeof y === 'number') {
      fills.push({ rgb: [...fill] as [number, number, number], y });
    }
  };
  const rect = doc.rect.bind(doc);
  vi.spyOn(doc, 'rect').mockImplementation(((...args: unknown[]) => {
    record(args[4], args[1]);
    return (rect as (...a: unknown[]) => unknown)(...args);
  }) as typeof doc.rect);
  const roundedRect = doc.roundedRect.bind(doc);
  vi.spyOn(doc, 'roundedRect').mockImplementation(((...args: unknown[]) => {
    record(args[6], args[1]);
    return (roundedRect as (...a: unknown[]) => unknown)(...args);
  }) as typeof doc.roundedRect);

  const text = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value, x, y, options] = args;
    if (typeof x === 'number' && typeof y === 'number') {
      const opts = options as { align?: string; charSpace?: number } | undefined;
      for (const line of Array.isArray(value) ? value.map(String) : [String(value)]) {
        const w = doc.getTextWidth(line) + (opts?.charSpace ?? 0) * Math.max(0, line.length - 1);
        spans.push({
          text: line,
          left: opts?.align === 'right' ? x - w : x,
          right: opts?.align === 'right' ? x : x + w,
          y,
          page: page(),
        });
      }
    }
    return text(...args);
  }) as typeof doc.text);

  return { spans, fills };
}

async function renderDo(items: ReturnType<typeof itemAt>[], header = HEADER) {
  const [{ jsPDF }, { default: autoTable }, { renderDeliveryOrderInto }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./delivery-order-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const captured = capture(doc);
  await renderDeliveryOrderInto(doc, autoTable, header as never, items as never, { logo: LOGO });
  return { doc, ...captured };
}

/** Perceived lightness, 0 (black) → 1 (white). */
const luminance = ([r, g, b]: [number, number, number]): number =>
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

describe('Delivery Order — Theme C template', () => {
  test('the letterhead columns never overlap, however long the address', async () => {
    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const { spans } = await renderDo([itemAt(1)]);

    // The right column: the two title words, the doc-number chip, "Issued" and
    // the date — everything drawn above the petrol rule at the right edge.
    const meta = spans.filter(
      (s) => ['DELIVERY', 'ORDER', HEADER.do_number, 'Issued', '06/08/2026'].includes(s.text) && s.y < 50,
    );
    expect(meta.length).toBeGreaterThanOrEqual(5);
    const metaLeft = Math.min(...meta.map((s) => s.left));

    const company = spans.filter(
      (s) => s.y < 50 && !meta.includes(s) && s.text.trim() !== '',
    );
    expect(company.length).toBeGreaterThan(0);
    expect(Math.max(...company.map((s) => s.right))).toBeLessThan(metaLeft);

    // The company block sits BESIDE the logo — that indent is what narrows the
    // measure, so losing it would hide the bug rather than fix it.
    expect(Math.min(...company.map((s) => s.left))).toBeGreaterThan(20);
  });

  test('nothing on the page is a dark fill', async () => {
    /* The owner's rule from the morning of the same day: no black band, no grey
       striping. Theme C brings fills back — a paper panel, a brass doc-number
       chip, a teal status chip — so the rule survives as a LIGHTNESS bound
       rather than a count. The old near-black band (#221f20, luminance 0.12)
       fails this; every Theme C fill is above 0.85. */
    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const { fills } = await renderDo([itemAt(1), itemAt(2), itemAt(3)]);

    expect(fills.length).toBeGreaterThan(0); // the spy is live
    const darkest = fills.reduce((a, b) => (luminance(a.rgb) <= luminance(b.rgb) ? a : b));
    expect({ rgb: darkest.rgb, luminance: Number(luminance(darkest.rgb).toFixed(3)) })
      .toMatchObject({ luminance: expect.any(Number) });
    expect(luminance(darkest.rgb)).toBeGreaterThan(0.8);
  });

  test('the TOTAL label prints as one word, not wrapped into the number rail', async () => {
    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const { spans } = await renderDo([itemAt(1), itemAt(2)]);
    expect(spans.some((s) => s.text === 'TOTAL')).toBe(true);
    // The wrap this replaced.
    expect(spans.some((s) => s.text === 'TOT' || s.text === 'AL')).toBe(false);
  });

  test('row numbers are zero-padded so the rail keeps its width', async () => {
    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const { spans } = await renderDo(Array.from({ length: 11 }, (_, i) => itemAt(i + 1)));
    expect(spans.some((s) => s.text === '01')).toBe(true);
    expect(spans.some((s) => s.text === '09')).toBe(true);
    expect(spans.some((s) => s.text === '11')).toBe(true);
    // The unpadded forms never appear in the rail. (They DO appear as Qty
    // values, so this checks the rail's own column, not the whole page.)
    const railX = spans.find((s) => s.text === '01')!.left;
    expect(spans.some((s) => Math.abs(s.left - railX) < 0.5 && /^\d$/.test(s.text))).toBe(false);
  });

  test('a spilled DO repeats its column header, signs once, and numbers its own pages', async () => {
    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const { doc, spans } = await renderDo(Array.from({ length: 30 }, (_, i) => itemAt(i + 1)));
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);

    // The header band is redrawn on every page the table reaches — a second
    // sheet of unlabelled numbers is not a delivery note. (The closing block
    // can take a page of its own when the rows run to the bottom of the last
    // sheet; that page carries no rows, so it needs no header.)
    const headerPages = new Set(spans.filter((s) => s.text === 'ITEM CODE').map((s) => s.page));
    const rowPages = new Set(spans.filter((s) => s.text.startsWith('XAMMAR-')).map((s) => s.page));
    expect(rowPages.size).toBeGreaterThan(1);
    for (const page of rowPages) expect(headerPages.has(page)).toBe(true);

    // Exactly one signature block, on the last page.
    const signatures = spans.filter((s) => s.text === 'Customer Acknowledged Receipt');
    expect(signatures).toHaveLength(1);
    expect(signatures[0]!.page).toBe(doc.getNumberOfPages());

    const total = doc.getNumberOfPages();
    for (let p = 1; p <= total; p += 1) {
      expect(spans.some((s) => s.page === p && s.text === `${HEADER.do_number} · Page ${p} of ${total}`))
        .toBe(true);
    }
  });

  test('a combined export numbers each DO from 1, not from the file', async () => {
    /* The batch "Export PDF" puts several DOs in one file. The page counter is
       scoped to the DO, so the customer reading sheet 2 of a 2-page DO is not
       told it is "page 4 of 6" of someone else's bundle. */
    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const [{ jsPDF }, { default: autoTable }, { renderDeliveryOrderInto }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
      import('./delivery-order-pdf'),
    ]);
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const { spans } = capture(doc);

    await renderDeliveryOrderInto(doc, autoTable, HEADER as never, [itemAt(1)] as never, { logo: LOGO });
    doc.addPage();
    await renderDeliveryOrderInto(
      doc,
      autoTable,
      { ...HEADER, do_number: '2990-DO-2608-007' } as never,
      [itemAt(1)] as never,
      { logo: LOGO },
    );

    expect(spans.some((s) => s.text === '2990-DO-2608-006 · Page 1 of 1')).toBe(true);
    expect(spans.some((s) => s.text === '2990-DO-2608-007 · Page 1 of 1')).toBe(true);
  });

  test('the Consignment Note reuse drops the picking columns and keeps its own title', async () => {
    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const [{ jsPDF }, { default: autoTable }, { renderDeliveryOrderInto }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
      import('./delivery-order-pdf'),
    ]);
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const { spans } = capture(doc);
    await renderDeliveryOrderInto(doc, autoTable, HEADER as never, [itemAt(1)] as never, {
      docTitle: 'CONSIGNMENT NOTE',
      docNoLabel: 'CN No',
      showPicking: false,
      logo: LOGO,
    });

    // The title splits one word per line, so both halves are drawn.
    expect(spans.some((s) => s.text === 'CONSIGNMENT')).toBe(true);
    expect(spans.some((s) => s.text === 'NOTE')).toBe(true);
    expect(spans.some((s) => s.text === 'SOURCE PO')).toBe(false);
    expect(spans.some((s) => s.text === 'RACK')).toBe(false);
    expect(spans.some((s) => s.text === 'QTY')).toBe(true);
  });
});
