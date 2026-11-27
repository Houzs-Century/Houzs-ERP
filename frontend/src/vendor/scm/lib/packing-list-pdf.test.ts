// Packing List v2 (owner 2026-11-27) — measured off the DRAWN output.
//
// What is pinned: the DO letterhead with "PACKING LIST" on ONE line, the crew
// box, Part A in category order with its own sort, Part B last stop first with
// the REAL stop number, the three signatures, the footer, the scan caption —
// and, because past sheets "爆掉" on real data, a stress lorry (14 stops, 70+
// lines, long names, long addresses, long variant descriptions) on which no two
// drawn texts may overlap, nothing may leave the page, and nothing but the
// footer may sit below the footer rule.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
import type { PackingItem, PackingListRow, PackingStop } from './packing-list-queries';

vi.mock('./authed-fetch', () => ({ authedFetch: async () => { throw new Error('offline in tests'); } }));

type JsPdf = import('jspdf').jsPDF;
type Span = { text: string; left: number; right: number; y: number; size: number; page: number };

const PAGE_W = 215.9;
const PAGE_H = 279.4;
const M = 14;

function capture(doc: JsPdf): Span[] {
  const spans: Span[] = [];
  const page = () => (doc as unknown as { internal: { getCurrentPageInfo: () => { pageNumber: number } } })
    .internal.getCurrentPageInfo().pageNumber;
  const text = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value, x, y, options] = args;
    if (typeof x === 'number' && typeof y === 'number') {
      const opts = options as { align?: string; charSpace?: number } | undefined;
      const lineH = (doc.getFontSize() * doc.getLineHeightFactor() * 25.4) / 72;
      const lines = Array.isArray(value) ? value.map(String) : String(value).split(/\n/);
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        const w = doc.getTextWidth(line) + (opts?.charSpace ?? 0) * Math.max(0, line.length - 1);
        const left = opts?.align === 'right' ? x - w : opts?.align === 'center' ? x - w / 2 : x;
        spans.push({ text: line, left, right: left + w, y: y + i * lineH, size: doc.getFontSize(), page: page() });
      });
    }
    return text(...args);
  }) as typeof doc.text);
  return spans;
}

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

const item = (code: string, group: string, qty: number, extra: Partial<PackingItem> = {}): PackingItem => ({
  line_no: 1, item_code: code, description: `${code} description`, qty,
  rack: 'Rack 3', rack_locked: true, po: 'HC-PO-2611-004', po_locked: true,
  item_group: group, variants: null, description2: null, so_line_no: null, ...extra,
});

const stop = (n: number, name: string, items: PackingItem[], extra: Partial<PackingStop> = {}): PackingStop => ({
  stop_no: n, stop_type: 'DELIVERY', customer_name: name, address: `${n}, Jalan Test, 47300 Petaling Jaya`,
  do_id: `do-${n}`, do_number: `HC-DO-2611-${String(100 + n)}`, do_status: 'LOADED', do_missing: false,
  so_doc_no: `HC-SO-2610-${String(200 + n)}`, phone: '+60127003933', time_range: '9am - 11am',
  units: items.reduce((s, i) => s + i.qty, 0), items, ...extra,
});

const list = (stops: PackingStop[], extra: Partial<PackingListRow> = {}): PackingListRow => ({
  trip_id: 'trip-1', trip_no: 'TRIP-2611-014', trip_date: '2026-11-28', trip_status: 'PLANNED',
  lorry_plate: 'VJK 8821', driver_name: 'Ah Meng', driver_phone: '+60123884410',
  helper_1_name: 'Raju', helper_2_name: 'Kumar', warehouse_name: 'Balakong HQ',
  stop_count: stops.length, do_count: stops.length,
  units: stops.reduce((s, x) => s + x.units, 0), m3_milli: 11620, stops, ...extra,
});

const SMALL = list([
  stop(1, 'LIAW TECK CHAI', [
    item('BF-Q-OAK', 'bedframe', 1, { rack: 'Rack 7', po: 'HC-PO-2611-011', so_line_no: 1, variants: { colourLabel: 'Natural Oak', divanHeight: '12"' } }),
    item('AKM-MAT-Q10', 'mattress', 1, { so_line_no: 2 }),
  ]),
  stop(2, 'JOAN YIING', [item('PIL-STD', 'accessories', 2, { rack: 'Rack 12', po: null })]),
  stop(3, 'PHOON JIA YEONG', [
    item('XAM-1S-LHF', 'sofa', 1, { rack: 'Rack 15', po: 'HC-PO-2611-021' }),
    item('XAM-ARMLESS', 'sofa', 1, { rack: 'Rack 16', po: 'HC-PO-2611-021' }),
  ]),
]);

async function render(l: PackingListRow, runUrl: string | null = null) {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  const [{ jsPDF }, { default: autoTable }, { renderPackingListInto }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'), import('./packing-list-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  const spans = capture(doc);
  await renderPackingListInto(doc, autoTable, l, { date: '2026-11-28', runUrl, logo: null });
  return { doc, spans };
}

const BRANDING_2990 = {
  ...DEFAULT_BRANDING,
  companyName: '2990 HOME SDN. BHD.',
  registrationNo: '202501060667',
  address: 'E-28-02 & E-28-03, Menara SUEZCAP 2, KL Gateway, No. 2, Jalan Kerinchi, '
    + 'Gerbang Kerinchi Lestari, 59200 Kuala Lumpur, Wilayah Persekutuan KL',
  postcode: '59200',
  logoR2Key: '',
};

function clashesOf(spans: Span[]): string[] {
  const out: string[] = [];
  const byPage = new Map<number, Span[]>();
  for (const s of spans) byPage.set(s.page, [...(byPage.get(s.page) ?? []), s]);
  for (const [p, ss] of byPage) {
    for (let i = 0; i < ss.length; i += 1) {
      for (let j = i + 1; j < ss.length; j += 1) {
        const a = ss[i]!; const b = ss[j]!;
        const lineH = (Math.min(a.size, b.size) * 25.4) / 72 * 0.85;
        const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (xOverlap > 0.3 && Math.abs(a.y - b.y) < lineH) out.push(`p${p}: "${a.text}" / "${b.text}"`);
      }
    }
  }
  return out;
}

const has = (spans: Span[], t: string) => spans.some((s) => s.text === t);
const firstIdx = (spans: Span[], t: string) => spans.findIndex((s) => s.text.includes(t));

describe('letterhead and crew box', () => {
  test('the DO letterhead, titled PACKING LIST on ONE line, then the lorry and the date', async () => {
    const { spans } = await render(SMALL);
    expect(has(spans, 'PACKING LIST')).toBe(true);
    expect(has(spans, 'PACKING')).toBe(false);
    expect(has(spans, 'Lorry : VJK 8821')).toBe(true);
    expect(has(spans, 'Delivery Date 2026/11/28 (Sat)')).toBe(true);
    expect(has(spans, DEFAULT_BRANDING.companyName)).toBe(true);
    const title = spans.find((s) => s.text === 'PACKING LIST')!;
    expect(title.right).toBeLessThanOrEqual(PAGE_W - M + 0.01);
  });

  test('the crew box: plate biggest, driver + phone, both helpers, trip, customers, units, volume', async () => {
    const { spans } = await render(SMALL);
    const plate = spans.find((s) => s.text === 'VJK 8821')!;
    expect(plate).toBeTruthy();
    const page1 = spans.filter((s) => s.page === 1 && s.text !== 'PACKING LIST');
    expect(plate.size).toBe(Math.max(...page1.map((s) => s.size)));
    for (const t of ['Ah Meng', 'Raju', 'Kumar', 'TRIP-2611-014', '3 (3 DO)', '6 units', '11.62 m³', 'Balakong HQ', 'Helper 1', 'Helper 2']) {
      expect(has(spans, t), t).toBe(true);
    }
    expect(spans.some((s) => /12-388 4410|123884410/.test(s.text.replace(/\s/g, ' ')))).toBe(true);
  });

  test('the QR is captioned SCAN WHEN FULLY LOADED, and only drawn when armed', async () => {
    const withQr = await render(SMALL, `https://erp.example.test/d/${'a'.repeat(10)}`);
    expect(has(withQr.spans, 'SCAN WHEN FULLY LOADED')).toBe(true);
    const without = await render(SMALL, null);
    expect(has(without.spans, 'SCAN WHEN FULLY LOADED')).toBe(false);
  });
});

describe('Part A — pick by category', () => {
  test('categories in the owner\'s order, sofa grouped under its sales order', async () => {
    const { spans } = await render(SMALL);
    const order = ['MATTRESS', 'BEDFRAME · one line per piece', 'ACCESSORIES', 'SOFA · one line per piece']
      .map((t) => firstIdx(spans, t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(spans.some((s) => s.text.startsWith('HC-SO-2610-203 · Customer 3 · PHOON JIA YEONG · 2 pieces · PO HC-PO-2611-021'))).toBe(true);
    expect(has(spans, 'TOTAL TO PICK')).toBe(true);
  });

  test('the bedframe variant is printed with its description, a missing PO is a dash', async () => {
    const { spans } = await render(SMALL);
    expect(spans.some((s) => s.text.includes('Natural Oak'))).toBe(true);
    const dashes = spans.filter((s) => s.text === '—');
    expect(dashes.length).toBeGreaterThan(0);
  });
});

describe('Part B — load by customer', () => {
  test('last stop first, printing the REAL stop number (3, 2, 1)', async () => {
    const { spans } = await render(SMALL);
    const partB = firstIdx(spans, 'PART B');
    const after = spans.slice(partB);
    const idx = ['PHOON JIA YEONG', 'JOAN YIING', 'LIAW TECK CHAI'].map((n) => after.findIndex((s) => s.text === n));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    const numbers = after.filter((s) => /^\d+$/.test(s.text) && s.size === 13).map((s) => s.text);
    expect(numbers).toEqual(['3', '2', '1']);
  });

  test('each block names DO, SO, units, phone and time slot; lines keep the SO order they arrive in', async () => {
    const { spans } = await render(SMALL);
    const after = spans.slice(firstIdx(spans, 'PART B'));
    expect(has(after, 'DO HC-DO-2611-101')).toBe(true);
    expect(has(after, 'SO HC-SO-2610-201  ·  2 units')).toBe(true);
    expect(after.some((s) => s.text.includes('Time 9am - 11am'))).toBe(true);
    const liaw = after.findIndex((s) => s.text === 'LIAW TECK CHAI');
    const block = after.slice(liaw);
    expect(block.findIndex((s) => s.text === 'BF-Q-OAK')).toBeLessThan(block.findIndex((s) => s.text === 'AKM-MAT-Q10'));
  });

  test('compact: Part B follows Part A on the same page when there is room (owner: 23 pages is too many)', async () => {
    const { spans } = await render(SMALL);
    const a = spans.find((x) => x.text.startsWith('PART A'));
    const b = spans.find((x) => x.text.startsWith('PART B'));
    expect(b?.page).toBe(a?.page);
  });

  test('three signatures and the footer with plate, date and page count', async () => {
    const { spans, doc } = await render(SMALL);
    for (const t of ['Picked By (Warehouse)', 'Loaded By (Helper)', 'Driver Signature']) expect(has(spans, t), t).toBe(true);
    const total = doc.getNumberOfPages();
    expect(has(spans, `VJK 8821 · 2026/11/28 · Page : ${total} of ${total}`)).toBe(true);
    expect(has(spans, `VJK 8821 · 2026/11/28 · Page : 1 of ${total}`)).toBe(true);
  });

  test('a stop whose DO the caller cannot read says so instead of printing it empty', async () => {
    const { spans } = await render(list([stop(1, 'HIDDEN', [], { do_missing: true, do_number: null })]));
    expect(spans.some((s) => /not in the companies you can see/.test(s.text))).toBe(true);
  });
});


const LONG_NAME = 'MOHAMAD FAIZAL BIN ABDULLAH @ AHMAD ZULKARNAIN ENTERPRISE SDN BHD (KAJANG BRANCH)';
const LONG_ADDR = 'Lot 17-3A, Block C, Jalan Prima Saujana 2/4, Taman Prima Saujana Seksyen 7, Off Jalan Sungai Long, 43000 Kajang, Selangor Darul Ehsan, Malaysia';
const LONG_DESC = 'SOFA ZANOTTI 3-SEATER WITH LEFT HAND FACING CHAISE AND STORAGE OTTOMAN, PREMIUM TECH FABRIC';

function stressList(): PackingListRow {
  const stops: PackingStop[] = [];
  for (let n = 1; n <= 14; n += 1) {
    const items: PackingItem[] = [];
    const groups = ['mattress', 'bedframe', 'accessories', 'sofa', 'sofa', 'other-thing'];
    for (let i = 0; i < 5 + (n % 3); i += 1) {
      const g = groups[(n + i) % groups.length]!;
      items.push(item(`${g.slice(0, 3).toUpperCase()}-${n}-${i}-XL-LONGCODE`, g, 1 + (i % 2), {
        description: `${LONG_DESC} ${n}.${i}`,
        variants: g === 'sofa' || g === 'bedframe'
          ? { colourLabel: 'Charcoal Grey Boucle Weave', legHeight: '6" black metal', divanHeight: '14"', seatHeight: '45cm' }
          : null,
        rack: i % 4 === 0 ? null : `Rack L${n}.${i}, Rack L${n + 1}.${i}`,
        po: i % 5 === 0 ? null : `HC-PO-2611-0${n}${i}, HC-PO-2610-9${i}`,
        so_line_no: i + 1,
      }));
    }
    stops.push(stop(n, n % 2 ? LONG_NAME : `CUSTOMER ${n}`, items, {
      address: n % 3 ? LONG_ADDR : 'Short address',
      time_range: n % 4 ? '2pm - 4pm (call 30 min before arrival, guard house)' : null,
    }));
  }
  return list(stops, {
    driver_name: 'MUHAMMAD HAFIZUDDIN BIN ABDUL RAHMAN',
    helper_1_name: 'SIVANESWARAN A/L KRISHNAMOORTHY',
    warehouse_name: 'Balakong HQ Warehouse 3 (Mezzanine racks L1-L40)',
    lorry_plate: 'WXY 1234',
  });
}

describe('the stress lorry — nothing overlaps, clips or runs off the page', () => {
  test('14 stops, 70+ lines, long everything: several pages, every span on the sheet', async () => {
    const l = stressList();
    expect(l.stops.reduce((n, s) => n + s.items.length, 0)).toBeGreaterThanOrEqual(70);
    const { spans, doc } = await render(l, `https://erp.example.test/d/${'b'.repeat(10)}`);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(4);

    for (const s of spans) {
      expect(s.left, `${s.text} runs off the left`).toBeGreaterThanOrEqual(M - 0.6);
      expect(s.right, `${s.text} runs off the right (page ${s.page})`).toBeLessThanOrEqual(PAGE_W - M + 0.6);
      expect(s.y, `${s.text} below the page`).toBeLessThanOrEqual(PAGE_H - 8);
      expect(s.y, `${s.text} above the page`).toBeGreaterThanOrEqual(M);
    }

    expect(clashesOf(spans)).toEqual([]);
  }, 60_000);

  test('the 2990 long letterhead beside PACKING LIST and the QR: nothing overlaps', async () => {
    setBrandingCache({ ...BRANDING_2990 }, '2990');
    const [{ jsPDF }, { default: autoTable }, { renderPackingListInto }] = await Promise.all([
      import('jspdf'), import('jspdf-autotable'), import('./packing-list-pdf'),
    ]);
    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const spans = capture(doc);
    await renderPackingListInto(doc, autoTable, SMALL, { date: '2026-11-28', runUrl: `https://erp.example.test/d/${'e'.repeat(10)}`, logo: null });
    expect(spans.some((s) => s.text === 'PACKING LIST')).toBe(true);
    expect(spans.some((s) => s.text.includes('Menara SUEZCAP'))).toBe(true);
    expect(clashesOf(spans)).toEqual([]);
    for (const s of spans) expect(s.right, s.text).toBeLessThanOrEqual(PAGE_W - M + 0.6);
  });

  test('only the footer and the signatures sit below the table bottom', async () => {
    const { spans } = await render(stressList());
    const FOOTER_RULE_Y = PAGE_H - 12 - 6;
    const below = spans.filter((s) => s.y > FOOTER_RULE_Y);
    expect(below.length).toBeGreaterThan(0);
    for (const s of below) {
      expect(/Page : \d+ of \d+$|^By signing|^HOUZS|Sdn|Bhd|BHD/i.test(s.text) || s.text === DEFAULT_BRANDING.companyName, s.text).toBe(true);
    }
  }, 60_000);

  test('a customer block never starts at the foot of a page without its first line', async () => {
    const { spans } = await render(stressList());
    const after = spans.slice(firstIdx(spans, 'PART B'));
    const numbers = after.filter((s) => /^\d+$/.test(s.text) && s.size === 13);
    expect(numbers.map((s) => s.text)).toEqual(['14', '13', '12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1']);
    for (const n of numbers) {
      const k = after.indexOf(n);
      const firstCode = after.slice(k).find((s) => /-XL-/.test(s.text));
      expect(firstCode?.page, `customer ${n.text}`).toBe(n.page);
    }
  }, 60_000);
});

describe('print helpers', () => {
  test('file name is <plate>-<yyyy-mm-dd>.pdf', async () => {
    const { packingListFileName } = await import('./packing-list-pdf');
    expect(packingListFileName({ lorry_plate: 'VJK 8821', trip_no: 'T-1' }, '2026-11-28')).toBe('VJK 8821-2026-11-28.pdf');
    expect(packingListFileName({ lorry_plate: null, trip_no: 'TRIP-1' }, '2026-11-28')).toBe('TRIP-1-2026-11-28.pdf');
  });

  test('packingRunUrl points at the PUBLIC scan page; an unarmed sheet gets none', async () => {
    const { packingRunUrl } = await import('./packing-list-pdf');
    expect(packingRunUrl('https://erp.example.test/', 'abc')).toBe('https://erp.example.test/d/abc');
    expect(packingRunUrl('https://erp.example.test', null)).toBeNull();
    expect(packingRunUrl('https://erp.example.test', '')).toBeNull();
  });

  test('the authed run URL is gone from the print path', () => {
    const src = readFileSync(resolve(__dirname, 'packing-list-pdf.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(src).not.toContain('/scm/fleet-day');
  });

  test('print-all puts every lorry in one document, each starting on a fresh page', async () => {
    setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
    const [{ jsPDF }, { default: autoTable }, { renderPackingListInto }] = await Promise.all([
      import('jspdf'), import('jspdf-autotable'), import('./packing-list-pdf'),
    ]);
    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const spans = capture(doc);
    const lists = [SMALL, { ...SMALL, trip_id: 't2', lorry_plate: 'ABC 999' }];
    for (let i = 0; i < lists.length; i += 1) {
      if (i > 0) doc.addPage();
      await renderPackingListInto(doc, autoTable, lists[i]!, { date: '2026-11-28', runUrl: null, logo: null });
    }
    const second = spans.find((s) => s.text === 'Lorry : ABC 999')!;
    const firstLorryPages = spans.filter((s) => s.text.startsWith('VJK 8821 · 2026/11/28 · Page')).map((s) => s.page);
    expect(second.page).toBe(Math.max(...firstLorryPages) + 1);
    expect(spans.some((s) => s.text === 'ABC 999 · 2026/11/28 · Page : 1 of 2')).toBe(true);
  });
});

test.skipIf(!process.env.PL_SAMPLE_OUT)('writes a sample PDF', async () => {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  const [{ jsPDF }, { default: autoTable }, { renderPackingListInto }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'), import('./packing-list-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  await renderPackingListInto(doc, autoTable, SMALL, { date: '2026-11-28', runUrl: `https://erp.example.test/d/${'c'.repeat(10)}`, logo: null });
  doc.addPage();
  await renderPackingListInto(doc, autoTable, stressList(), { date: '2026-11-28', runUrl: `https://erp.example.test/d/${'d'.repeat(10)}`, logo: null });
  writeFileSync(process.env.PL_SAMPLE_OUT as string, Buffer.from(doc.output('arraybuffer')));
}, 60_000);

