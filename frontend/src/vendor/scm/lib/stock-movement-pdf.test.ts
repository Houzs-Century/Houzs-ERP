/* The two documents that could not be printed at all until 2026-08-22 — the
   Stock Transfer and the Stock Take.
 *
 * WHAT THESE TESTS ARE FOR. A PDF generator that compiles is not a PDF that
 * says the right thing, and nothing else in this repo can look at one. So the
 * assertions are on WHAT WAS DRAWN and WHERE, captured through doc.text (which
 * jspdf-autotable also paints its cells through, so table rows and the totals
 * rail are directly comparable). Same technique as `pdf-money-layout.test.ts`,
 * for the same reason.
 *
 * Three things are worth a test here and the rest is layout:
 *
 *   1. NEITHER DOCUMENT MAY STATE A VALUE. Both routes carry no money at all,
 *      and a stock movement sheet that prints an RM figure is inventing one.
 *      Asserted as an absence over every drawn string, so a later edit that
 *      reaches for `fmtRm` fails here rather than in front of a storekeeper.
 *   2. THE VARIANCE IS BELOW THE LINES. It is the number a person prints a
 *      stock take to look at, and it is positioned by the same
 *      `lastAutoTable.finalY ?? y` expression that once put a GRAND TOTAL on
 *      top of the goods.
 *   3. A BLIND TAKE PRINTS NO SYSTEM QUANTITY. The server strips those fields
 *      while the take is OPEN for anyone without `scm.stock_take.supervise`;
 *      the sheet must drop the columns rather than print a rail of dashes that
 *      reads as "no variance".
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  setBrandingCache,
} from '../../../lib/branding';

type JsPdf = import('jspdf').jsPDF;
type TextDraw = { text: string; y: number };

/* Every text draw in order, with the y it landed on. */
function captureTextDraws(doc: JsPdf): TextDraw[] {
  const draws: TextDraw[] = [];
  const original = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value, , y] = args;
    if (typeof y === 'number') {
      const lines = Array.isArray(value) ? value.map(String) : [String(value)];
      for (const line of lines) draws.push({ text: line.trim(), y });
    }
    return original(...args);
  }) as typeof doc.text);
  return draws;
}

/* Fails with the labels that WERE drawn — a renamed label must read as a broken
   test, not as a comparison against undefined. */
function yOf(draws: TextDraw[], label: string): number {
  const hit = draws.find((d) => d.text === label);
  if (!hit) {
    throw new Error(
      `"${label}" was never drawn. Drawn: ${draws.map((d) => d.text).join(' | ')}`,
    );
  }
  return hit.y;
}

/* Item codes are matched whole-cell, so they must be short enough not to wrap
   inside their column — autoTable hands a wrapped cell to doc.text as
   ['SKU-ROW-', 'ONE'] and no fragment would equal the code. */
function rowYsFor(draws: TextDraw[], codes: string[]): number[] {
  return codes.map((code) => {
    const hit = draws.find((d) => d.text === code);
    if (!hit) {
      throw new Error(
        `Line code "${code}" was never drawn as a whole cell (did it wrap?). `
        + `Drawn: ${draws.map((d) => d.text).join(' | ')}`,
      );
    }
    return hit.y;
  });
}

const readFinalY = (doc: JsPdf): number | undefined =>
  (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY;

/* A money figure, in any of the shapes this app renders one: "RM 1,200.00",
   "1,200.00", "MYR 12.00". Deliberately broad — the point is that NOTHING on
   these two sheets looks like a value. */
const MONEY = /(RM|MYR)\s*[\d,]+(\.\d{2})?|\b\d{1,3}(,\d{3})*\.\d{2}\b/;

/* THE MATCHER SELF-TESTS, because the two assertions that use it are
   ASSERTIONS OF ABSENCE — a regex that had stopped matching anything would
   report both documents clean forever and nobody would know. CLAUDE.md: "a
   verdict computed over nothing must never read as a pass." The positives are
   what `fmtMoneySen` actually emits; the negatives are what these two sheets
   legitimately draw and must not be mistaken for a value. */
describe('the money matcher these tests depend on', () => {
  test('it matches what a money document draws', () => {
    for (const v of ['RM 1,200.00', 'RM1,200.00', 'MYR 12.00', '1,200.00', '0.00', '12.50']) {
      expect(MONEY.test(v), v).toBe(true);
    }
  });

  test('it does not match what a stock document legitimately draws', () => {
    for (const v of ['20/08/2026', 'TOTAL QTY', '10', '-1', '+2', '2 of 3',
      'HC-ST-2608-001', 'WH-BLK', 'Page 1 of 1', 'fabriccode bf-16 · gap 16']) {
      expect(MONEY.test(v), v).toBe(false);
    }
  });
});

/* Ordinary ASCII everywhere: no CJK font fetch, no logo fetch, so these tests
   are about geometry and wording only and touch no network. */
const setUpBranding = () => setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* Widened on purpose: `typeof CONST` narrows `null` to `null` and a string to
   its literal, so a variant fixture below could not flip either. */
type TransferHeaderFixture = {
  transfer_no: string; status: string; transfer_date: string; notes: string | null;
  posted_at: string | null; cancelled_at: string | null;
  from_warehouse_id: string | null; to_warehouse_id: string | null;
  from_warehouse: { code: string; name: string } | null;
  to_warehouse: { code: string; name: string } | null;
};
type TransferLineFixture = {
  item_code: string; product_name: string | null; qty: number;
  notes: string | null; variant_key: string;
};

const TRANSFER_HEADER: TransferHeaderFixture = {
  transfer_no: 'HC-ST-2608-001',
  status: 'POSTED',
  transfer_date: '2026-08-20',
  notes: 'Rebalancing the showroom',
  posted_at: '2026-08-20T02:00:00.000Z',
  cancelled_at: null,
  from_warehouse_id: 'aaaaaaaa-0000-0000-0000-000000000001',
  to_warehouse_id: 'bbbbbbbb-0000-0000-0000-000000000002',
  from_warehouse: { code: 'WH-BLK', name: 'Balakong Warehouse' },
  to_warehouse: { code: 'WH-KL', name: 'KL Showroom' },
};

const TRANSFER_LINES: TransferLineFixture[] = [
  { item_code: 'ST-A', product_name: 'Sofa module', qty: 3, notes: null, variant_key: 'fabriccode=bf-16|gap=16' },
  { item_code: 'ST-B', product_name: 'Bedframe', qty: 7, notes: 'Top shelf', variant_key: '' },
];

async function renderTransfer(
  header: TransferHeaderFixture,
  lines: TransferLineFixture[],
): Promise<{ doc: JsPdf; draws: TextDraw[] }> {
  setUpBranding();
  const [{ jsPDF }, { default: autoTable }, { renderStockTransferInto }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./stock-transfer-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const draws = captureTextDraws(doc);
  await renderStockTransferInto(doc, autoTable, header, lines);
  return { doc, draws };
}

describe('Stock Transfer PDF', () => {
  test('the warehouse pair is on the sheet, both codes and both names', async () => {
    const { doc, draws } = await renderTransfer(TRANSFER_HEADER, TRANSFER_LINES);
    expect(doc.getNumberOfPages()).toBe(1);

    const text = draws.map((d) => d.text);
    expect(text).toContain('FROM WAREHOUSE');
    expect(text).toContain('TO WAREHOUSE');
    // Code first (warehouse-label.ts, the one rule), the full name beneath it.
    expect(text).toContain('WH-BLK');
    expect(text).toContain('WH-KL');
    expect(text).toContain('Balakong Warehouse');
    expect(text).toContain('KL Showroom');

    // The pair leads: the band sits above the line items, not below them.
    const lastLineY = Math.max(...rowYsFor(draws, ['ST-A', 'ST-B']));
    expect(yOf(draws, 'WH-BLK')).toBeLessThan(lastLineY);
  });

  test('the document number, date and status all print', async () => {
    const { draws } = await renderTransfer(TRANSFER_HEADER, TRANSFER_LINES);
    const text = draws.map((d) => d.text);
    expect(text).toContain('ST No: HC-ST-2608-001');
    expect(text).toContain('Date: 20/08/2026');
    /* Right-hand detail rail: drawInfoColumns paints the value as ": <value>".
       The word is CONFIRMED, not the stored `POSTED`: since 2026-08-26 the
       status comes from statusLabel('stockTransfer', …), the same map the
       screen reads, so the sheet and the list cannot say different words for
       the same row. It said ": Posted" until then — the whole vocabulary is
       pinned in pdf-status-label.test.ts. */
    expect(text).toContain(': Confirmed');
    /* And the footer carries the doc no on every page of THIS document's span
       — the bare number, at the footer baseline the nine other generators use. */
    const footers = draws.filter((d) => d.text === 'HC-ST-2608-001' && d.y === 290);
    expect(footers.length).toBe(1);
  });

  test('the only total is quantity, and it is drawn below the last line', async () => {
    const { doc, draws } = await renderTransfer(TRANSFER_HEADER, TRANSFER_LINES);

    const lastLineY = Math.max(...rowYsFor(draws, ['ST-A', 'ST-B']));
    const finalY = readFinalY(doc);
    expect(Number.isFinite(finalY)).toBe(true);

    const totalY = yOf(draws, 'TOTAL QTY');
    expect(totalY).toBeGreaterThan(lastLineY);
    expect(totalY).toBeGreaterThan(finalY!);

    // 3 + 7, summed from the lines rather than from a header column that does
    // not exist on this document.
    expect(draws.some((d) => d.text === '10' && d.y === totalY)).toBe(true);
    // The label says QTY, so no reader can take it for a value.
    expect(draws.map((d) => d.text)).not.toContain('TOTAL');
  });

  test('NOTHING on the sheet looks like money — the route carries none', async () => {
    const { draws } = await renderTransfer(TRANSFER_HEADER, TRANSFER_LINES);
    const offenders = draws.map((d) => d.text).filter((t) => MONEY.test(t));
    expect(offenders, `these read as a value: ${offenders.join(' | ')}`).toEqual([]);
  });

  test('the variant bucket that moved is printed, and a plain SKU adds no noise', async () => {
    const { draws } = await renderTransfer(TRANSFER_HEADER, TRANSFER_LINES);
    const text = draws.map((d) => d.text);
    // Humanised through the shared variant-key rule, not printed raw.
    expect(text).toContain('fabriccode bf-16 · gap 16');
    expect(text).not.toContain('fabriccode=bf-16|gap=16');
    // The '' bucket is the unclassified one and prints nothing extra.
    expect(text).toContain('Bedframe');
  });

  test('an unresolved warehouse embed still identifies itself instead of printing nothing', async () => {
    const { draws } = await renderTransfer(
      { ...TRANSFER_HEADER, from_warehouse: null, to_warehouse: null },
      TRANSFER_LINES,
    );
    const text = draws.map((d) => d.text);
    expect(text).toContain('aaaaaaaa-0000-0000-0000-000000000001');
    expect(text).toContain('bbbbbbbb-0000-0000-0000-000000000002');
  });

  /* The two boxes sit half a page apart and drawSignatureBoxes does not wrap,
     so a long warehouse label has to be DROPPED rather than allowed to run into
     its neighbour. The bare role is still true; a collision is not readable. */
  test('the signature boxes name the two warehouses, and give that up rather than collide', async () => {
    const { draws } = await renderTransfer(TRANSFER_HEADER, TRANSFER_LINES);
    const text = draws.map((d) => d.text);
    expect(text).toContain('Released By — WH-BLK');
    expect(text).toContain('Received By — WH-KL');

    const long = await renderTransfer(
      {
        ...TRANSFER_HEADER,
        from_warehouse: { code: '', name: 'Balakong Main Warehouse and Overflow Showroom Annexe' },
        to_warehouse: { code: '', name: 'Kuala Lumpur Flagship Showroom and Consignment Store' },
      },
      TRANSFER_LINES,
    );
    const longText = long.draws.map((d) => d.text);
    expect(longText).toContain('Released By');
    expect(longText).toContain('Received By');
    expect(longText.some((t) => t.startsWith('Released By —'))).toBe(false);
  });

  /* A warehouse with no CODE falls back to its NAME (warehouse-label.ts), which
     can be long enough to take two lines in the band. The band's height has to
     follow the wrap: a fixed step would put the label's second line straight
     through the warehouse-name row under it, and nothing would report it. */
  test('a long warehouse label wraps without landing on the row beneath it', async () => {
    const longName = 'Balakong Main Warehouse and Overflow Showroom Annexe Block C';
    const { draws } = await renderTransfer(
      {
        ...TRANSFER_HEADER,
        from_warehouse: { code: 'WH-BLK', name: longName },
        to_warehouse: { code: 'WH-KL', name: 'KL Showroom' },
      },
      TRANSFER_LINES,
    );

    // The name really did wrap — otherwise this test proves nothing.
    const nameFragments = draws.filter((d) => longName.startsWith(d.text) || longName.endsWith(d.text));
    const wrapped = draws.filter((d) => d.text !== '' && longName.includes(d.text) && d.text !== longName);
    expect(wrapped.length, 'the fixture name must be long enough to wrap').toBeGreaterThan(1);
    expect(nameFragments.length).toBeGreaterThan(0);

    // Every fragment sits on its own baseline — none shares a y with another.
    const ys = wrapped.map((d) => d.y);
    expect(new Set(ys).size).toBe(ys.length);

    // And the band still finishes above the line items.
    const firstLineY = Math.min(...rowYsFor(draws, ['ST-A', 'ST-B']));
    expect(Math.max(...ys)).toBeLessThan(firstLineY);
  });

  /* A table that runs to the bottom of the last page would otherwise put the
     total past the paper, or on top of the footer at y=290.

     SWEPT, not pinned to one line count. Measured with the guard removed, the
     total only lands in the danger zone for a NARROW band of line counts —
     282.8 at 93 lines and 290.3 at 94, and from 95 up autoTable breaks the page
     itself and the total lands near the top. A single fixture is therefore
     almost certain to miss the bug, and would read as a passing test forever.
     The invariant is what is asserted, over every count in the band. */
  test('however many lines it has, TOTAL QTY never lands on the footer', async () => {
    for (let n = 88; n <= 100; n += 1) {
      const { doc, draws } = await renderTransfer(
        TRANSFER_HEADER,
        Array.from({ length: n }, (_, i) => ({
          item_code: `T${i}`, product_name: `Item ${i}`, qty: 1,
          notes: null, variant_key: '',
        })),
      );
      const totalY = yOf(draws, 'TOTAL QTY');
      // A4 is 297mm and the footer sits at 290.
      expect(totalY, `${n} lines`).toBeLessThan(288);
      expect(doc.getNumberOfPages(), `${n} lines`).toBeGreaterThan(1);
      expect(
        draws.some((d) => d.text === String(n) && d.y === totalY),
        `${n} lines`,
      ).toBe(true);
      vi.restoreAllMocks();
    }
  });

  test('a transfer with no lines still renders one page and a zero total', async () => {
    const { doc, draws } = await renderTransfer(TRANSFER_HEADER, []);
    expect(doc.getNumberOfPages()).toBe(1);
    const totalY = yOf(draws, 'TOTAL QTY');
    expect(draws.some((d) => d.text === '0' && d.y === totalY)).toBe(true);
  });
});

/* ── Stock Take ───────────────────────────────────────────────────────────── */

type TakeHeaderFixture = {
  take_no: string; status: string; take_date: string;
  scope_type: string; scope_value: string | null; notes: string | null;
  posted_at: string | null; cancelled_at: string | null; blind: boolean;
  warehouse_id: string | null; warehouse: { code: string; name: string } | null;
  assignee_name: string | null;
};
type TakeLineFixture = {
  item_code: string; product_name: string | null;
  variant_key: string; variant_label: string | null;
  system_qty: number | null; counted_qty: number | null; variance: number | null;
  notes: string | null;
};

const TAKE_HEADER: TakeHeaderFixture = {
  take_no: 'HC-STK-2608-004',
  status: 'POSTED',
  take_date: '2026-08-21',
  scope_type: 'ALL',
  scope_value: null,
  notes: 'Month end',
  posted_at: '2026-08-21T09:00:00.000Z',
  cancelled_at: null,
  blind: false,
  warehouse_id: 'cccccccc-0000-0000-0000-000000000003',
  warehouse: { code: 'WH-BLK', name: 'Balakong Warehouse' },
  assignee_name: 'Lim Wei Sheng',
};

const TAKE_LINES: TakeLineFixture[] = [
  { item_code: 'TK-A', product_name: 'Sofa module', variant_key: '', variant_label: 'Fabric BF-16', system_qty: 10, counted_qty: 12, variance: 2, notes: null },
  { item_code: 'TK-B', product_name: 'Bedframe', variant_key: '', variant_label: null, system_qty: 8, counted_qty: 5, variance: -3, notes: 'Two damaged' },
  // Uncounted: the sheet must not report this one as agreeing.
  { item_code: 'TK-C', product_name: 'Mattress', variant_key: '', variant_label: null, system_qty: 4, counted_qty: null, variance: null, notes: null },
];

async function renderTake(
  header: TakeHeaderFixture,
  lines: TakeLineFixture[],
): Promise<{ doc: JsPdf; draws: TextDraw[] }> {
  setUpBranding();
  const [{ jsPDF }, { default: autoTable }, { renderStockTakeInto }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./stock-take-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const draws = captureTextDraws(doc);
  await renderStockTakeInto(doc, autoTable, header, lines);
  return { doc, draws };
}

describe('Stock Take PDF', () => {
  test('the count identifies itself — number, date, warehouse, scope, assignee', async () => {
    const { draws } = await renderTake(TAKE_HEADER, TAKE_LINES);
    const text = draws.map((d) => d.text);
    expect(text).toContain('STK No: HC-STK-2608-004');
    expect(text).toContain('Date: 21/08/2026');
    expect(text).toContain('WH-BLK · Balakong Warehouse');
    expect(text).toContain('All SKUs');
    // Resolved by the page, never a uuid.
    expect(text).toContain('Lim Wei Sheng');
    expect(text).not.toContain('cccccccc-0000-0000-0000-000000000003');
  });

  test('the NET VARIANCE is drawn below the last line, signed', async () => {
    const { doc, draws } = await renderTake(TAKE_HEADER, TAKE_LINES);
    expect(doc.getNumberOfPages()).toBe(1);

    const lastLineY = Math.max(...rowYsFor(draws, ['TK-A', 'TK-B', 'TK-C']));
    const finalY = readFinalY(doc);
    const netY = yOf(draws, 'NET VARIANCE');

    // THE assertion: under the `?? y` failure this mirrors from the money
    // documents, the rail would be drawn back on top of the count.
    expect(netY).toBeGreaterThan(lastLineY);
    expect(netY).toBeGreaterThan(finalY!);

    // +2 and -3 → -1, and it carries its sign.
    expect(draws.some((d) => d.text === '-1' && d.y === netY)).toBe(true);
    expect(draws.map((d) => d.text)).toContain('+2');
  });

  test('an uncounted line is reported as uncounted, not as agreeing', async () => {
    const { draws } = await renderTake(TAKE_HEADER, TAKE_LINES);
    const text = draws.map((d) => d.text);
    expect(text).toContain('2 of 3');   // counted
    expect(text).toContain('Not counted');
    const notCountedY = yOf(draws, 'Not counted');
    expect(draws.some((d) => d.text === '1' && d.y === notCountedY)).toBe(true);
  });

  test('NOTHING on the sheet looks like money — the route carries none', async () => {
    const { draws } = await renderTake(TAKE_HEADER, TAKE_LINES);
    const offenders = draws.map((d) => d.text).filter((t) => MONEY.test(t));
    expect(offenders, `these read as a value: ${offenders.join(' | ')}`).toEqual([]);
  });

  test('a BLIND take prints a count sheet — no system column, no variance rail', async () => {
    /* Exactly the payload the server hands a non-supervising viewer of an OPEN
       blind take: system_qty and variance stripped, counted_qty kept. */
    const { draws } = await renderTake(
      { ...TAKE_HEADER, status: 'OPEN', blind: true, posted_at: null },
      TAKE_LINES.map((l) => ({ ...l, system_qty: null, variance: null })),
    );
    const text = draws.map((d) => d.text);

    expect(text).toContain('Blind count — system quantities and variances are not shown on this sheet.');
    expect(text).not.toContain('System');
    expect(text).not.toContain('Variance');
    expect(text).not.toContain('NET VARIANCE');
    // What a counter still needs is all there.
    expect(text).toContain('Counted');
    expect(text).toContain('TK-A');
  });

  test('a non-blind take keeps both columns and the variance header', async () => {
    const { draws } = await renderTake(TAKE_HEADER, TAKE_LINES);
    const text = draws.map((d) => d.text);
    expect(text).toContain('System');
    expect(text).toContain('Variance');
    expect(text).not.toContain('Blind count — system quantities and variances are not shown on this sheet.');
  });

  /* THE case for this document: a full-warehouse count is one line per SKU, so
     its table routinely fills the last page — and the rail under it is the
     reason anyone printed the sheet. */
  test('a long count keeps its NET VARIANCE on the paper, above the footer', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      item_code: `K${i}`, product_name: `Item ${i}`,
      variant_key: '', variant_label: null,
      system_qty: 5, counted_qty: 5, variance: 0, notes: null,
    }));
    const { doc, draws } = await renderTake(TAKE_HEADER, many);
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);

    const netY = yOf(draws, 'NET VARIANCE');
    expect(netY).toBeLessThan(290);
    // Every page of this take's span still gets its footer.
    const footers = draws.filter((d) => d.text === 'HC-STK-2608-004' && d.y === 290);
    expect(footers.length).toBe(doc.getNumberOfPages());
  });

  test('a scope with a value spells the value out', async () => {
    const { draws } = await renderTake(
      { ...TAKE_HEADER, scope_type: 'CODE_PREFIX', scope_value: 'CODY' },
      TAKE_LINES,
    );
    expect(draws.map((d) => d.text)).toContain('Prefix · CODY');
  });
});
