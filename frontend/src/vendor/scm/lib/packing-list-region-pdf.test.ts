// Packing list BY REGION (owner 2026-11-27) — measured off the drawn output.
//
// Pinned: the DO letterhead with "Region : <label>", the summary box, Part A
// only with a LORRY column (plate, distinct plates on merged rows, or "Not
// arranged"), the customer key, two signatures, the footer — and on a long
// region (long names, long descriptions) no two texts overlap, nothing leaves
// the page and no heading is left at a page foot without its first row.
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
import type { PackingItem, PackingRegionDo, PackingRegionRow } from './packing-list-queries';
import { lorriesFor, regionCategoryUnits, regionLorrySummary, regionStops } from './packing-list-model';
import { WORKED_OUT_NOTE } from './delivery-order-pdf';

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
      const opts = options as { align?: string } | undefined;
      const lineH = (doc.getFontSize() * doc.getLineHeightFactor() * 25.4) / 72;
      const lines = Array.isArray(value) ? value.map(String) : String(value).split(/\n/);
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        const w = doc.getTextWidth(line);
        const left = opts?.align === 'right' ? x - w : opts?.align === 'center' ? x - w / 2 : x;
        spans.push({ text: line, left, right: left + w, y: y + i * lineH, size: doc.getFontSize(), page: page() });
      });
    }
    return text(...args);
  }) as typeof doc.text);
  return spans;
}

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

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

const item = (code: string, group: string, qty: number, extra: Partial<PackingItem> = {}): PackingItem => ({
  line_no: 1, item_code: code, description: `${code} description`, qty,
  rack: 'Rack 3', rack_locked: true, po: 'HC-PO-2611-004', po_locked: true, worked_out: false,
  item_group: group, variants: null, description2: null, so_line_no: null, ...extra,
});

const regionDo = (n: number, plate: string | null, items: PackingItem[], extra: Partial<PackingRegionDo> = {}): PackingRegionDo => ({
  do_id: `do-${n}`, do_number: `HC-DO-2611-${100 + n}`, do_status: 'DRAFT', so_doc_no: `HC-SO-2610-${200 + n}`,
  debtor_code: `C-${n}`, customer_name: `CUSTOMER ${n}`, address: `${n}, Jalan Test`, phone: '0123', time_range: null, m3_milli: null,
  lorry_plate: plate, driver_name: null, driver_phone: null, helper_1_name: null, helper_2_name: null,
  trip_no: null, trip_stop_no: null, state: 'Selangor', country: null,
  units: items.reduce((s, i) => s + i.qty, 0), items, ...extra,
});

const region = (dos: PackingRegionDo[], extra: Partial<PackingRegionRow> = {}): PackingRegionRow => ({
  region: 'KL', label: 'KL/SEL', do_count: dos.length, customer_count: dos.length,
  units: dos.reduce((s, d) => s + d.units, 0),
  lorry_plates: [...new Set(dos.map((d) => d.lorry_plate).filter((p): p is string => !!p))].sort(),
  not_arranged: dos.filter((d) => !d.lorry_plate).length, dos, ...extra,
});

function realisticRegion(): PackingRegionRow {
  const plates = ['VJK 8821', 'VJK 8821', 'VJK 8821', 'WXY 1234', 'WXY 1234', 'WXY 1234', null, null, null];
  return region(plates.map((plate, i) => {
    const n = i + 1;
    return regionDo(n, plate, [
      item(n % 2 ? 'AKM-MAT-Q10' : 'GD-MAT-K-HYB', 'mattress', 1, { rack: `Rack ${3 + (n % 2)}` }),
      n % 3 === 0
        ? item(`XAM-1S-${n}`, 'sofa', 1, { rack: 'Rack 15', po: 'HC-PO-2611-021' })
        : item(n % 2 ? 'BF-Q-OAK' : 'BF-K-WAL', 'bedframe', 1, { rack: `Rack ${7 + n}`, po: `HC-PO-2611-01${n}`, variants: { colourLabel: 'Natural Oak', divanHeight: '12"' } }),
      item('PIL-STD', 'accessories', 2, { rack: 'Rack 12', po: 'HC-PO-2610-088' }),
    ], { customer_name: ['LIAW TECK CHAI', 'JOAN YIING', 'PHOON JIA YEONG', 'SHAIRUIMIE MOHAMAD NOOR', 'FAUZIAH BINTI BAKAR', 'MOHAMAD FAIZAL B. ABDULLAH', 'TAN AH KOW', 'LIM MEI LING', 'RAJESH KUMAR'][i] });
  }));
}

const LONG_NAME = 'MOHAMAD FAIZAL BIN ABDULLAH @ AHMAD ZULKARNAIN ENTERPRISE SDN BHD (KAJANG BRANCH)';
const LONG_DESC = 'SOFA ZANOTTI 3-SEATER WITH LEFT HAND FACING CHAISE AND STORAGE OTTOMAN, PREMIUM TECH FABRIC';

function stressRegion(): PackingRegionRow {
  const dos: PackingRegionDo[] = [];
  const groups = ['mattress', 'bedframe', 'accessories', 'sofa', 'other-thing'];
  for (let n = 1; n <= 30; n += 1) {
    const items: PackingItem[] = [];
    for (let i = 0; i < 3 + (n % 3); i += 1) {
      const g = groups[(n + i) % groups.length]!;
      items.push(item(`${g.slice(0, 3).toUpperCase()}-${n % 4}-${i}-XL-LONGCODE`, g, 1 + (i % 2), {
        description: `${LONG_DESC} ${n}.${i}`,
        variants: g === 'sofa' || g === 'bedframe' ? { colourLabel: 'Charcoal Grey Boucle Weave', legHeight: '6" black metal' } : null,
        rack: i % 4 === 0 ? null : `Rack L${n}.${i}, Rack L${n + 1}.${i}`,
        po: i % 5 === 0 ? null : `HC-PO-2611-0${n}${i}, HC-PO-2610-9${i}`,
      }));
    }
    const plate = n % 4 === 0 ? null : ['VJK 8821', 'WXY 1234', 'BNM 5520'][n % 3]!;
    dos.push(regionDo(n, plate, items, { customer_name: n % 2 ? LONG_NAME : `CUSTOMER ${n}` }));
  }
  return region(dos, { label: 'KL/SEL' });
}

async function render(r: PackingRegionRow, runUrl: string | null = null) {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  const [{ jsPDF }, { default: autoTable }, { renderPackingRegionInto }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'), import('./packing-list-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  const spans = capture(doc);
  await renderPackingRegionInto(doc, autoTable, r, { date: '2026-11-28', runUrl, logo: null });
  return { doc, spans };
}

const has = (spans: Span[], t: string) => spans.some((s) => s.text === t);

describe('region model helpers', () => {
  const r = realisticRegion();

  test('DOs are numbered 1..N in the order the backend sends them', () => {
    expect(regionStops(r).map((s) => [s.stop_no, s.customer_name])).toEqual(r.dos.map((d, i) => [i + 1, d.customer_name]));
  });

  test('a merged row lists its distinct lorries, plates before Not arranged', () => {
    expect(lorriesFor([9, 1, 2, 4], r)).toEqual(['VJK 8821', 'WXY 1234', 'Not arranged']);
    expect(lorriesFor([7], r)).toEqual(['Not arranged']);
  });

  test('table summaries', () => {
    expect(regionLorrySummary(r)).toBe('VJK 8821, WXY 1234, 3 not arranged');
    expect(regionLorrySummary({ lorry_plates: [], not_arranged: 0 })).toBe('—');
    expect(regionCategoryUnits(r)).toEqual({ MATTRESS: 9, BEDFRAME: 6, ACCESSORIES: 18, SOFA: 3, OTHER: 0 });
  });
});

describe('the region sheet', () => {
  test('an armed region sheet prints the QR with the two-scan caption (owner 2026-11-28)', async () => {
    const { spans } = await render(realisticRegion(), `https://erp.example.test/d/${'k'.repeat(10)}`);
    expect(has(spans, 'SCAN: PREPARED, THEN LOADED')).toBe(true);
    expect(has(spans, 'Region : KL/SEL')).toBe(true);
  });

  test('letterhead: PACKING LIST, Region : KL/SEL, the delivery date; no QR when not armed', async () => {
    const { spans } = await render(realisticRegion());
    expect(has(spans, 'PACKING LIST')).toBe(true);
    expect(has(spans, 'Region : KL/SEL')).toBe(true);
    expect(has(spans, 'Delivery Date 2026/11/28 (Sat)')).toBe(true);
    expect(spans.some((s) => s.text.includes('SCAN'))).toBe(false);
  });

  test('summary box: region, DOs, customers, units, plates and how many are not arranged', async () => {
    const { spans } = await render(realisticRegion());
    const box = spans.filter((s) => s.page === 1).map((s) => s.text).join(' ');
    for (const t of ['Region : KL/SEL', '9 DO · ', '36 units', '3 of 9 DO']) expect(box.includes(t), t).toBe(true);
    expect(box).toMatch(/VJK 8821, ?\s*WXY 1234/);
  });

  test('Part A only: categories in order, a LORRY column, no loading order', async () => {
    const { spans } = await render(realisticRegion());
    const order = ['MATTRESS', 'BEDFRAME', 'ACCESSORIES', 'SOFA'].map((t) => spans.findIndex((s) => s.text === t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(has(spans, 'LORRY')).toBe(true);
    expect(has(spans, 'Not arranged')).toBe(true);
    expect(spans.some((s) => s.text.includes('PART B') || s.text.includes('LOAD BY CUSTOMER'))).toBe(false);
    const so = spans.findIndex((s) => s.text.includes('Customer 3 · PHOON JIA YEONG'));
    expect(so).toBeGreaterThanOrEqual(0);
    expect(spans.slice(so, so + 4).some((s) => s.text.includes('Lorry VJK 8821'))).toBe(true);
  });

  test('the customer key names every DO with its lorry', async () => {
    const { spans } = await render(realisticRegion());
    expect(has(spans, 'CUSTOMERS IN THIS REGION')).toBe(true);
    for (const t of ['HC-DO-2611-101', 'HC-DO-2611-109', 'RAJESH KUMAR']) expect(has(spans, t), t).toBe(true);
  });

  test('two signatures and the footer with region, date and page count', async () => {
    const { spans, doc } = await render(realisticRegion());
    expect(has(spans, 'Picked By (Warehouse)')).toBe(true);
    expect(has(spans, 'Checked By')).toBe(true);
    expect(has(spans, 'Loaded By (Helper)')).toBe(false);
    const n = doc.getNumberOfPages();
    expect(has(spans, `KL/SEL · 2026/11/28 · Page : ${n} of ${n}`)).toBe(true);
  });

  test('compact: a realistic region (9 DOs, 3 lines each) fits on two pages at most', async () => {
    const { doc, spans } = await render(realisticRegion());
    expect(doc.getNumberOfPages()).toBeLessThanOrEqual(2);
    expect(clashesOf(spans)).toEqual([]);
  });
});

describe('the long region — nothing overlaps, clips or runs off the page', () => {
  test('30 DOs, long names and descriptions: every span on the sheet, no clashes', async () => {
    const { spans, doc } = await render(stressRegion());
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(3);
    for (const s of spans) {
      expect(s.left, `${s.text} runs off the left`).toBeGreaterThanOrEqual(M - 0.6);
      expect(s.right, `${s.text} runs off the right (page ${s.page})`).toBeLessThanOrEqual(PAGE_W - M + 0.6);
      expect(s.y, `${s.text} below the page`).toBeLessThanOrEqual(PAGE_H - 8);
      expect(s.y, `${s.text} above the page`).toBeGreaterThanOrEqual(M);
    }
    expect(clashesOf(spans)).toEqual([]);
  }, 60_000);

  test('only the footer and the signatures sit below the table bottom', async () => {
    const { spans } = await render(stressRegion());
    const FOOTER_RULE_Y = PAGE_H - 12 - 6;
    for (const s of spans.filter((x) => x.y > FOOTER_RULE_Y)) {
      expect(/Page : \d+ of \d+$|^By signing|^HOUZS|Sdn|Bhd|BHD/i.test(s.text) || s.text === DEFAULT_BRANDING.companyName, s.text).toBe(true);
    }
  }, 60_000);

  test('no heading is orphaned: every section, sofa group and the key starts on the page of its first row', async () => {
    const { spans } = await render(stressRegion());
    const heads = spans.filter((s) =>
      /^(MATTRESS|BEDFRAME|ACCESSORIES|SOFA|OTHER)( · one line per piece)?$/.test(s.text) || /^HC-SO-\S+ · Customer /.test(s.text) || s.text === 'CUSTOMERS IN THIS REGION');
    expect(heads.length).toBeGreaterThan(5);
    for (const h of heads) {
      const k = spans.indexOf(h);
      const firstRow = spans.slice(k + 1).find((s) => /-XL-|^HC-DO-2611-1\d\d$/.test(s.text));
      expect(firstRow?.page, h.text).toBe(h.page);
    }
  }, 60_000);
});

describe('print helpers', () => {
  test('file name is <region>-<yyyy-mm-dd>.pdf', async () => {
    const { packingRegionFileName } = await import('./packing-list-pdf');
    expect(packingRegionFileName({ label: 'East Coast', region: 'EAST_COAST' }, '2026-11-28')).toBe('East Coast-2026-11-28.pdf');
  });

  test('print all regions: each region starts on a fresh page', async () => {
    setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
    const [{ jsPDF }, { default: autoTable }, { renderPackingRegionInto }] = await Promise.all([
      import('jspdf'), import('jspdf-autotable'), import('./packing-list-pdf'),
    ]);
    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const spans = capture(doc);
    const rows = [realisticRegion(), { ...realisticRegion(), region: 'SOUTHERN', label: 'Southern' }];
    for (let i = 0; i < rows.length; i += 1) {
      if (i > 0) doc.addPage();
      await renderPackingRegionInto(doc, autoTable, rows[i]!, { date: '2026-11-28', runUrl: null, logo: null });
    }
    const second = spans.find((s) => s.text === 'Region : Southern')!;
    const firstPages = spans.filter((s) => s.text.startsWith('KL/SEL · 2026/11/28 · Page')).map((s) => s.page);
    expect(second.page).toBe(Math.max(...firstPages) + 1);
  });
});

test.skipIf(!process.env.PL_REGION_SAMPLE_OUT)('writes a sample region PDF', async () => {
  const { doc } = await render(realisticRegion(), 'https://erp.example.test/d/k7m2n9p4q8');
  // eslint-disable-next-line no-console -- the page count is the point of this opt-in sample run
  console.log(`region sample pages: ${doc.getNumberOfPages()}`);
  const [{ default: autoTable }, { renderPackingRegionInto }] = await Promise.all([import('jspdf-autotable'), import('./packing-list-pdf')]);
  doc.addPage();
  await renderPackingRegionInto(doc, autoTable, stressRegion(), { date: '2026-11-28', runUrl: null, logo: null });
  writeFileSync(process.env.PL_REGION_SAMPLE_OUT as string, Buffer.from(doc.output('arraybuffer')));
}, 60_000);

describe('worked-out PO / Rack on a region sheet', () => {
  test('a worked-out value is starred and the DO PDF footnote is printed once', async () => {
    const r = region([
      regionDo(1, 'VPC9058', [item('AKM-MAT-Q10', 'mattress', 1, { rack: 'L3.2', po: 'HC-PO-2610-050', rack_locked: false, po_locked: false, worked_out: true })]),
      regionDo(2, null, [item('XAM-1S-LHF', 'sofa', 1, { rack: 'L16.1', po: 'HC-PO-2609-229' })]),
    ]);
    const { spans } = await render(r);
    expect(spans.some((s) => s.text === 'HC-PO-2610-050 *')).toBe(true);
    expect(spans.some((s) => s.text === 'L3.2 *')).toBe(true);
    expect(spans.some((s) => s.text.includes('HC-PO-2609-229 *'))).toBe(false);
    expect(spans.filter((s) => s.text === WORKED_OUT_NOTE)).toHaveLength(1);
    const plain = await render(region([regionDo(2, null, [item('XAM-1S-LHF', 'sofa', 1)])]));
    expect(plain.spans.some((s) => s.text === WORKED_OUT_NOTE)).toBe(false);
  });
});
