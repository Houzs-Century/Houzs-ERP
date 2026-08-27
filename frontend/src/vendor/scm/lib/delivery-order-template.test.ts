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
  // Annotated rather than inferred: the tests below build variants that DO
  // carry a driver / note / customer reference, and an inferred `null` would
  // make every one of those a type error rather than a case.
  driver_name: null as string | null,
  vehicle: null as string | null,
  address1: '50, Jalan Elitis Suria, Valencia',
  address2: null,
  city: 'Sungai Buloh',
  state: 'Selangor',
  postcode: '47000',
  phone: '+60166636038',
  notes: null as string | null,
  m3_total_milli: 0,
  po_doc_no: null as string | null,
  customer_so_no: null as string | null,
  ref: null as string | null,
};

const itemAt = (i: number) => ({
  item_code: `XAMMAR-${i}(LHF)`,
  description: `SOFA XAMMAR ${i} module, a description long enough to wrap`,
  qty: 1,
  m3_milli: 1234,
  unit_price_sen: 0,
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

async function renderDo(items: ReturnType<typeof itemAt>[], header: typeof HEADER = HEADER) {
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

  test('the debtor code never runs into the delivery-details column', async () => {
    /* The code is drawn AFTER the customer name, at name-width + 3mm. The name
       is wrapped to the left column's width, so a name whose last line ends
       near the column edge left the code nowhere to go — and jsPDF does not
       clip: it drew straight over "SO No" in the right column. Seen on a real
       Houzs sheet, 2026-08-26 (docs/bugs/0550).

       SWEPT rather than pinned to one magic name: the overflow only happens in
       the narrow band where the last line nearly fills the column, and a single
       fixture sits in that band only by luck — the first version of this test
       passed with the fix REMOVED because its name happened to wrap early.
       Growing the name one character at a time crosses the band for certain.

       Measured against the right column's OWN spans rather than a hardcoded
       81mm, so re-proportioning the panel cannot quietly retire the check. */
    const LABELS = ['SO No', 'Ref No.', 'Issued Date', 'Delivery Date', 'Status'];
    let crossedTheBand = false;

    for (let n = 18; n <= 46; n += 1) {
      const { spans } = await renderDo([itemAt(1)], {
        ...HEADER,
        debtor_name: `${'Evergreen Living Furniture Trading Sdn Bhd'.slice(0, n)}`,
        debtor_code: 'C-01427',
      });

      const code = spans.find((s) => s.text === 'C-01427');
      expect(code).toBeDefined();

      const details = spans.filter((s) => LABELS.includes(s.text.trim()));
      expect(details.length).toBeGreaterThanOrEqual(3);
      const detailsLeft = Math.min(...details.map((s) => s.left));

      const name = spans.filter((s) => s.text.startsWith('Customer :') || s.y === code!.y);
      const nameRight = Math.max(...name.filter((s) => s !== code).map((s) => s.right), 0);
      if (nameRight > detailsLeft - 14) crossedTheBand = true;

      expect(code!.right, `debtor name of ${n} chars`).toBeLessThan(detailsLeft);
    }

    // The sweep is only a proof if it actually reached the tight cases.
    expect(crossedTheBand).toBe(true);
  });

  test('a debtor code that fits still rides on the name, costing no height', async () => {
    /* The fix must not push EVERY code onto its own line — the short-name case
       is the common one, and the panel would grow a row on every sheet. */
    const { spans } = await renderDo([itemAt(1)]);
    const name = spans.find((s) => s.text.startsWith('Customer :'));
    const code = spans.find((s) => s.text === 'C-001');
    expect(name).toBeDefined();
    expect(code).toBeDefined();
    expect(code!.y).toBe(name!.y);
    expect(code!.left).toBeGreaterThan(name!.right);
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

  test('Houzs splits SO No from the customer Ref No.; 2990 keeps one SO Ref', async () => {
    /* Owner 2026-08-07. The customer reference resolves po_doc_no →
       customer_so_no → ref, the same order the DO detail page uses, so the sheet
       and the screen never name a different one. */
    const withRefs = {
      ...HEADER,
      po_doc_no: 'CUST-PO-8891',
      customer_so_no: 'CUST-SO-1',
      ref: 'REF-1',
    };

    setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
    const houzs = await renderDo([itemAt(1)], withRefs as typeof HEADER);
    expect(houzs.spans.some((s) => s.text === 'SO No')).toBe(true);
    expect(houzs.spans.some((s) => s.text === 'Ref No.')).toBe(true);
    expect(houzs.spans.some((s) => s.text === 'SO Ref')).toBe(false);
    expect(houzs.spans.some((s) => s.text === 'CUST-PO-8891')).toBe(true);

    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const two990 = await renderDo([itemAt(1)], withRefs as typeof HEADER);
    expect(two990.spans.some((s) => s.text === 'SO Ref')).toBe(true);
    expect(two990.spans.some((s) => s.text === 'Ref No.')).toBe(false);
    // 2990's sheet must not leak the customer reference into the details block.
    expect(two990.spans.some((s) => s.text === 'CUST-PO-8891')).toBe(false);
  });

  test('the customer reference falls back through the three columns in order', async () => {
    setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
    const noPo = await renderDo(
      [itemAt(1)],
      { ...HEADER, po_doc_no: null, customer_so_no: 'CUST-SO-1', ref: 'REF-1' } as typeof HEADER,
    );
    expect(noPo.spans.some((s) => s.text === 'CUST-SO-1')).toBe(true);

    const refOnly = await renderDo(
      [itemAt(1)],
      { ...HEADER, po_doc_no: null, customer_so_no: null, ref: 'REF-1' } as typeof HEADER,
    );
    expect(refOnly.spans.some((s) => s.text === 'REF-1')).toBe(true);
  });

  test('driver, vehicle, customer code and the delivery note print when the record has them', async () => {
    /* All four were dropped by the handoff's block and put back on the owner's
       call (2026-08-07): the driver's sheet is exactly where they are needed. */
    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const { spans } = await renderDo(
      [itemAt(1)],
      {
        ...HEADER,
        driver_name: 'Ah Seng',
        vehicle: 'WXY 1234',
        notes: 'Call the guardhouse on arrival, unit is behind the clubhouse.',
      } as typeof HEADER,
    );
    expect(spans.some((s) => s.text === 'Driver')).toBe(true);
    expect(spans.some((s) => s.text === 'Ah Seng')).toBe(true);
    expect(spans.some((s) => s.text === 'Vehicle')).toBe(true);
    expect(spans.some((s) => s.text === 'WXY 1234')).toBe(true);
    expect(spans.some((s) => s.text === HEADER.debtor_code)).toBe(true);
    expect(spans.some((s) => s.text === 'Note:')).toBe(true);
    expect(spans.some((s) => s.text.includes('guardhouse'))).toBe(true);
  });

  test('an unassigned run prints no dashed Driver / Vehicle rows', async () => {
    // A dash against "Driver" tells the reader nothing and costs a line on a
    // sheet whose whole job is to be scanned in a warehouse doorway.
    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const { spans } = await renderDo([itemAt(1)]);
    expect(spans.some((s) => s.text === 'Driver')).toBe(false);
    expect(spans.some((s) => s.text === 'Vehicle')).toBe(false);
    expect(spans.some((s) => s.text === 'Note:')).toBe(false);
  });

  test('a stacked logo gets the same presence as a wide one', async () => {
    /* The handoff's 28.8 x 14.6mm box was sized around 2990's WIDE mark, which
       fills it edge to edge. Houzs's lockup is stacked and near-square: in a box
       that flat it is height-bound and lands at half the width — which is what
       the owner saw on a real Houzs DO (2026-08-07). The height allowance is now
       20mm, so a square mark covers about the same AREA as the wide one, and a
       wide mark is untouched. */
    const drawn: Array<{ w: number; h: number }> = [];
    const [{ jsPDF }, { default: autoTable }, { renderDeliveryOrderInto }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
      import('./delivery-order-pdf'),
    ]);

    const measure = async (width: number, height: number) => {
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const addImage = doc.addImage.bind(doc);
      vi.spyOn(doc, 'addImage').mockImplementation(((...args: unknown[]) => {
        drawn.push({ w: Number(args[4]), h: Number(args[5]) });
        return (addImage as (...a: unknown[]) => unknown)(...args);
      }) as typeof doc.addImage);
      await renderDeliveryOrderInto(doc, autoTable, HEADER as never, [itemAt(1)] as never, {
        logo: { ...LOGO, width, height },
      });
      return drawn[drawn.length - 1]!;
    };

    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const wide = await measure(3508, 1561);   // 2990's mark
    const square = await measure(1024, 1024); // a stacked lockup

    // The wide mark still fills the box's width exactly — unchanged by the
    // taller allowance, so 2990's letterhead did not move.
    expect(wide.w).toBeCloseTo(28.8, 1);
    expect(wide.h).toBeCloseTo(28.8 / (3508 / 1561), 1);

    // The square one is no longer capped at 14.6mm...
    expect(square.h).toBeGreaterThan(14.6);
    // ...and now carries comparable weight: within 15% of the wide mark's area.
    const ratio = (square.w * square.h) / (wide.w * wide.h);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);

    // Neither is distorted.
    expect(wide.w / wide.h).toBeCloseTo(3508 / 1561, 1);
    expect(square.w / square.h).toBeCloseTo(1, 1);
  });

  test('the customer-service contact prints when the company has set one', async () => {
    /* Owner 2026-08-07. Editable per company in Settings → Branding, and kept
       apart from the headline phone/email on purpose. */
    setBrandingCache(
      { ...BRANDING_2990, csPhone: '+60 11-1110 8855', csEmail: 'operation@houzscentury.com' },
      '2990',
    );
    const { spans } = await renderDo([itemAt(1)]);
    expect(spans.some((s) => s.text === 'Customer Service')).toBe(true);
    expect(spans.some((s) => s.text.includes('11-1110 8855'))).toBe(true);
    expect(spans.some((s) => s.text.includes('operation@houzscentury.com'))).toBe(true);
  });

  test('an unset contact falls back to that same company phone and email', async () => {
    /* The dedicated fields are an override, not a requirement (owner
       2026-08-07). The fallback reads THIS company's row — which is what keeps
       a 2990 sheet from ever printing a Houzs desk. */
    setBrandingCache(
      { ...BRANDING_2990, csPhone: '', csEmail: '', phone: '+60 3-1234 5678', email: 'hello@2990shome.com' },
      '2990',
    );
    const { spans } = await renderDo([itemAt(1)]);
    expect(spans.some((s) => s.text === 'Customer Service')).toBe(true);
    expect(spans.some((s) => s.text.includes('hello@2990shome.com'))).toBe(true);
    // The load-bearing half: never the other company's.
    expect(spans.some((s) => s.text.includes('houzscentury.com'))).toBe(false);
  });

  test('a company with neither contact prints no such line', async () => {
    setBrandingCache({ ...BRANDING_2990, csPhone: '', csEmail: '', phone: '', email: '' }, '2990');
    const { spans } = await renderDo([itemAt(1)]);
    expect(spans.some((s) => s.text === 'Customer Service')).toBe(false);
  });

  test('the dedicated fields WIN over the headline ones', async () => {
    setBrandingCache(
      {
        ...BRANDING_2990,
        csPhone: '+60 11-1110 8855', csEmail: 'operation@2990shome.com',
        phone: '+60 3-0000 0000', email: 'reception@2990shome.com',
      },
      '2990',
    );
    const { spans } = await renderDo([itemAt(1)]);
    expect(spans.some((s) => s.text.includes('11-1110 8855'))).toBe(true);
    expect(spans.some((s) => s.text.includes('operation@2990shome.com'))).toBe(true);
    expect(spans.some((s) => s.text.includes('reception@'))).toBe(false);
    expect(spans.some((s) => s.text.includes('0000 0000'))).toBe(false);
  });

  test('one half of the contact is enough — the line prints what there is', async () => {
    setBrandingCache({ ...BRANDING_2990, csPhone: '', csEmail: 'ops@2990shome.com' }, '2990');
    const { spans } = await renderDo([itemAt(1)]);
    expect(spans.some((s) => s.text === 'Customer Service')).toBe(true);
    expect(spans.some((s) => s.text.includes('ops@2990shome.com'))).toBe(true);
    // No orphaned separator when only one side is set.
    expect(spans.some((s) => s.text.trim().startsWith('·') || s.text.trim().endsWith('·'))).toBe(false);
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
