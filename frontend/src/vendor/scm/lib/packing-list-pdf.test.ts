import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/* The packing list sheet — what it DRAWS, and in what order.
 *
 * A PDF generator that compiles is not a sheet that says the right thing, and
 * nothing else in this repo can look at one. So the assertions are on the text
 * draws, captured through `doc.text` (which jspdf-autotable also paints its
 * cells through). Same technique as `stock-movement-pdf.test.ts`.
 *
 * Four things are worth a test here and the rest is layout:
 *
 *   1. THE SHEET RUNS N..1. This is the feature. The sections must come out in
 *      LOADING order — last delivery first — and the assertion below fails if
 *      anyone "fixes" the sheet to ascending.
 *   2. IT IS NUMBERED BY LOADING ORDER ONLY. The owner rejected printing the
 *      stop number beside it. So section 1 must NOT read "STOP 3".
 *   3. IT NEVER WRITES COMPANY DETAILS. The letterhead is `drawHeader`, which
 *      reads the branding the switcher sets; a hand-typed company name would
 *      put Houzs's address on a 2990 run.
 *   4. IT DOES NOT PRINT A VOLUME NOBODY STORED. `m3_milli: null` must produce
 *      no m³ figure at all, not "0.00 m³".
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  setBrandingCache,
} from '../../../lib/branding';
import type { PackingListRow } from './packing-list-queries';

type JsPdf = import('jspdf').jsPDF;
type TextDraw = { text: string; y: number };

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

/* Ordinary ASCII in the fixture: no CJK font fetch, no logo fetch, no network. */
const setUpBranding = () => setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const item = (line_no: number, item_code: string, qty: number, rack: string | null) =>
  ({ line_no, item_code, description: null, qty, rack });

const stop = (stop_no: number, customer: string, do_number: string, code: string) => ({
  stop_no,
  stop_type: 'DELIVERY',
  customer_name: customer,
  address: `${stop_no} Jalan Test`,
  do_id: `do-${stop_no}`,
  do_number,
  do_status: 'LOADED',
  do_missing: false,
  units: 2,
  items: [item(1, code, 2, 'Rack 3')],
});

const LIST: PackingListRow = {
  trip_id: 'trip-1',
  trip_no: 'TRIP-2608-001',
  trip_date: '2026-08-26',
  trip_status: 'PLANNED',
  lorry_plate: 'WXY 1234',
  driver_name: 'Ah Meng',
  warehouse_name: 'Main Depot',
  stop_count: 3,
  do_count: 3,
  units: 6,
  m3_milli: 3400,
  stops: [
    stop(1, 'Alpha Sdn Bhd', 'HC-DO-2608-001', 'SKUONE'),
    stop(2, 'Bravo Sdn Bhd', 'HC-DO-2608-002', 'SKUTWO'),
    stop(3, 'Charlie Sdn Bhd', 'HC-DO-2608-003', 'SKUTRE'),
  ],
};

async function render(list: PackingListRow, runUrl: string | null = null): Promise<TextDraw[]> {
  setUpBranding();
  const [{ jsPDF }, { default: autoTable }, { renderPackingListInto }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./packing-list-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const draws = captureTextDraws(doc);
  await renderPackingListInto(doc, autoTable, list, { date: '2026-08-26', runUrl });
  return draws;
}

const indexOfText = (draws: TextDraw[], needle: string): number =>
  draws.findIndex((d) => d.text.includes(needle));

describe('the packing list sheet', () => {
  test('runs the sections in LOADING order — the last delivery is drawn first', async () => {
    const draws = await render(LIST);
    const alpha = indexOfText(draws, 'Alpha Sdn Bhd');
    const bravo = indexOfText(draws, 'Bravo Sdn Bhd');
    const charlie = indexOfText(draws, 'Charlie Sdn Bhd');
    expect(charlie).toBeGreaterThanOrEqual(0);
    // Stop 3 (Charlie) is loaded first, so it is drawn first. Reverse the
    // ordering back to ascending and this is the line that fails.
    expect(charlie).toBeLessThan(bravo);
    expect(bravo).toBeLessThan(alpha);
  });

  test('numbers the sections by LOADING order, and never prints the stop number beside it', async () => {
    const draws = await render(LIST);
    // The FIRST section on the sheet is Charlie, and it is numbered 1.
    expect(draws.some((d) => d.text === '1 · Charlie Sdn Bhd')).toBe(true);
    expect(draws.some((d) => d.text === '2 · Bravo Sdn Bhd')).toBe(true);
    expect(draws.some((d) => d.text === '3 · Alpha Sdn Bhd')).toBe(true);
    // The rejected two-number form: nothing on the sheet says STOP n.
    expect(draws.some((d) => /\bSTOP\s*\d/i.test(d.text))).toBe(false);
    expect(draws.some((d) => /LOAD FIRST/i.test(d.text))).toBe(false);
  });

  test('carries the one loading instruction, in English', async () => {
    const draws = await render(LIST);
    expect(draws.some((d) => d.text
      === 'Load in this order — top of the sheet goes in first, deepest into the lorry.')).toBe(true);
  });

  test('states the four header fields, one thing each', async () => {
    const draws = await render(LIST);
    for (const label of ['LORRY', 'DRIVER', 'STOPS', 'TOTAL']) {
      expect(draws.some((d) => d.text === label), label).toBe(true);
    }
    expect(draws.some((d) => d.text === 'WXY 1234')).toBe(true);
    expect(draws.some((d) => d.text === 'Ah Meng')).toBe(true);
    expect(draws.some((d) => d.text === '6 units · 3.40 m³')).toBe(true);
    // The combined "Stops / DOs" field the owner rejected.
    expect(draws.some((d) => /stops\s*\/\s*dos/i.test(d.text))).toBe(false);
  });

  test('prints no volume at all when no delivery order carried one', async () => {
    const draws = await render({ ...LIST, m3_milli: null });
    expect(draws.some((d) => d.text === '6 units')).toBe(true);
    expect(draws.some((d) => /m³/.test(d.text))).toBe(false);
    expect(draws.some((d) => /0\.00/.test(d.text))).toBe(false);
  });

  test('signs off as Loaded By and Driver Signature', async () => {
    const draws = await render(LIST);
    expect(draws.some((d) => d.text === 'Loaded By')).toBe(true);
    expect(draws.some((d) => d.text === 'Driver Signature')).toBe(true);
  });

  test('heads the goods table with the six columns the loader reads', async () => {
    const draws = await render(LIST);
    for (const head of ['#', 'DO No.', 'Item', 'Qty', 'Rack', 'Tick']) {
      expect(draws.some((d) => d.text === head), head).toBe(true);
    }
    expect(draws.some((d) => d.text === 'HC-DO-2608-003')).toBe(true);
    expect(draws.some((d) => d.text === 'Rack 3')).toBe(true);
  });

  test('says so when a stop names a delivery order this caller cannot read, instead of showing it empty', async () => {
    const hidden = {
      ...LIST,
      stops: [{ ...LIST.stops[0], do_number: null, do_status: null, do_missing: true, units: 0, items: [] }],
      stop_count: 1, do_count: 0, units: 0,
    };
    const draws = await render(hidden);
    expect(draws.some((d) => /not in the companies you can see/i.test(d.text))).toBe(true);
    expect(draws.some((d) => d.text === '0 units')).toBe(false);
  });

  test('takes the letterhead from branding and writes no company details of its own', async () => {
    const draws = await render(LIST);
    expect(draws.some((d) => d.text === 'PACKING LIST')).toBe(true);
    expect(draws.some((d) => d.text === DEFAULT_BRANDING.companyName)).toBe(true);
    // A hand-typed company name would survive a branding change; this one does not.
    setBrandingCache({ ...DEFAULT_BRANDING, companyName: 'Renamed Test Co', logoR2Key: '' }, 'HOUZS');
    const renamed = await (async () => {
      const [{ jsPDF }, { default: autoTable }, { renderPackingListInto }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'), import('./packing-list-pdf'),
      ]);
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const d = captureTextDraws(doc);
      await renderPackingListInto(doc, autoTable, LIST, { date: '2026-08-26', runUrl: null });
      return d;
    })();
    expect(renamed.some((d) => d.text === 'Renamed Test Co')).toBe(true);
    expect(renamed.some((d) => d.text === DEFAULT_BRANDING.companyName)).toBe(false);
  });

  /* THE CAPTION MOVED WITH THE LINK (2026-08-26). It read "SCAN · OPEN THIS
     RUN" while the code opened an authed page nobody holding the sheet could
     reach. The code is public now and it RECORDS a step rather than opening a
     view, so the caption says what the DO print's does — the same words on both
     papers, because it is the same act. */
  test('draws the run QR and captions it, only when a URL was supplied', async () => {
    const url = `https://erp.example.test/d/${'a'.repeat(64)}`;
    const withQr = await render(LIST, url);
    expect(withQr.some((d) => d.text === 'SCAN AT EACH STEP')).toBe(true);
    const withoutQr = await render(LIST, null);
    expect(withoutQr.some((d) => d.text === 'SCAN AT EACH STEP')).toBe(false);
    expect(withoutQr.some((d) => d.text === 'SCAN · OPEN THIS RUN')).toBe(false);
  });
});

describe('packingRunUrl', () => {
  /* IT POINTED AT THE AUTHED PAGE UNTIL 2026-08-26. The sheet is carried by a
     driver with no account, so the link has to open without one; the token is
     the credential (mig 0329). The old assertions are rewritten rather than
     deleted, because the property underneath them survives: the sheet's QR
     addresses THIS run and nothing else. */
  test('points at the PUBLIC scan page for this run', async () => {
    const { packingRunUrl } = await import('./packing-list-pdf');
    const token = 'b'.repeat(64);
    expect(packingRunUrl('https://erp.example.test', token))
      .toBe(`https://erp.example.test/d/${token}`);
  });

  test('a trailing slash on the origin does not double up', async () => {
    const { packingRunUrl } = await import('./packing-list-pdf');
    const token = 'c'.repeat(64);
    expect(packingRunUrl('https://erp.example.test/', token))
      .toBe(`https://erp.example.test/d/${token}`);
  });

  /* NO TOKEN DRAWS NO QR — never a fallback to the authed link. A sheet
     carrying a link only office staff can open is worse than one carrying
     none, because the driver finds out at the lorry. */
  test('an unarmed sheet gets no URL at all', async () => {
    const { packingRunUrl } = await import('./packing-list-pdf');
    expect(packingRunUrl('https://erp.example.test', null)).toBeNull();
    expect(packingRunUrl('https://erp.example.test', '')).toBeNull();
  });

  test('the authed run URL is gone from the print path', async () => {
    const src = readFileSync(resolve(__dirname, 'packing-list-pdf.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src).not.toContain('/scm/fleet-day');
  });
});
