/* ----------------------------------------------------------------------------
   packing-list-model — the two rules a packing list is FOR, in one place so the
   screen and the printed sheet can never disagree about them.

   1. THE SHEET IS THE REVERSE OF THE ROUTE. Stops are numbered 1..N in DELIVERY
      order (`trip_stops.stop_no`, as the dispatcher sequenced them). Loading
      runs the other way — owner, 2026-08-25: 「我们进货 Loading 的时候，都是把最
      后一张单放在最里面，所以顺序应该反过来」. The LAST delivery goes in FIRST,
      deepest into the lorry, so the first drop is the one standing at the tail
      door. `loadingOrder` is the only place that reversal happens.

      THE SHEET PRINTS THE REAL STOP NUMBER, reversed: 6, 5, 4, 3, 2, 1 (owner
      2026-11-27). Still one number per customer — the two-number form ("LOAD
      FIRST 1 STOP 3") stays rejected.

   2. THE STATUS CHIP ROLLS UP THE MEMBER DELIVERY ORDERS. The words are the
      owner's ladder — Confirmed / Loaded / In Transit / Delivered — over the
      four rungs `scm.do_status` actually has. `rollupDeliveryStatus` names the
      furthest rung ANY member DO has reached and counts how many have reached
      it: "Loaded 2/3".

      AND IT REFUSES TO ANSWER OVER NOTHING. A trip with no readable delivery
      order returns null, and the caller renders a dash. Every enum literal it
      compares is a member of `scm.do_status` — a string that is not is a
      `22P02` in Postgres and took the whole Delivery Orders page down twice
      (docs/bugs/0530), and here it would silently bucket a row nowhere.
   ---------------------------------------------------------------------------- */

import type { PackingRegionDo, PackingRegionRow, PackingStop } from './packing-list-queries';
import { shortRackLabel } from './rack-label';


export type LoadingSection<S> = {
  load_no: number;
  stop: S;
};

/**
 * Delivery order in, LOADING order out. Pure, total, and non-mutating: the
 * caller's array is left alone, because the screen renders the delivery order
 * from the same rows the sheet reverses.
 */
export function loadingOrder<S extends { stop_no: number }>(stops: readonly S[]): LoadingSection<S>[] {
  const byDelivery = [...stops].sort((a, b) => a.stop_no - b.stop_no);
  const out: LoadingSection<S>[] = [];
  for (let i = byDelivery.length - 1; i >= 0; i -= 1) {
    out.push({ load_no: out.length + 1, stop: byDelivery[i] });
  }
  return out;
}


/** The owner's four rungs, in his words, over the statuses scm.do_status has.
 *  DRAFT is deliberately rung 0 — it is before the ladder starts, not on it. */
export const DO_RUNG: ReadonlyMap<string, { rung: number; label: string }> = new Map([
  ['DRAFT', { rung: 0, label: 'Draft' }],
  ['LOADED', { rung: 1, label: 'Confirmed' }],
  ['DISPATCHED', { rung: 2, label: 'Loaded' }],
  ['IN_TRANSIT', { rung: 3, label: 'In Transit' }],
  ['SIGNED', { rung: 4, label: 'Delivered' }],
  ['DELIVERED', { rung: 4, label: 'Delivered' }],
  ['INVOICED', { rung: 4, label: 'Delivered' }],
]);

export type StatusRollup = {
  label: string;
  reached: number;
  total: number;
  cancelled: number;
};

/**
 * Null when there is nothing to roll up — no readable delivery order at all, or
 * every one of them cancelled. The caller renders a dash: an empty bucket must
 * never print a confident zero, because a company predicate that matched
 * nothing and a lorry that is genuinely empty are the same shape here.
 */
export function rollupDeliveryStatus(
  stops: readonly Pick<PackingStop, 'do_id' | 'do_status'>[],
): StatusRollup | null {
  const byDo = new Map<string, string>();
  for (const s of stops) {
    if (!s.do_id || !s.do_status) continue;
    byDo.set(s.do_id, String(s.do_status).toUpperCase());
  }
  let cancelled = 0;
  const rungs: number[] = [];
  for (const status of byDo.values()) {
    if (status === 'CANCELLED') { cancelled += 1; continue; }
    const hit = DO_RUNG.get(status);
    if (hit) rungs.push(hit.rung);
  }
  if (rungs.length === 0) return null;

  const top = Math.max(...rungs);
  const label = [...DO_RUNG.values()].find((r) => r.rung === top)?.label ?? 'Draft';
  return {
    label,
    reached: rungs.filter((r) => r >= top).length,
    total: rungs.length,
    cancelled,
  };
}

/** "Loaded 2/3", or null — same refusal as above, passed straight through. */
export function rollupLabel(rollup: StatusRollup | null): string | null {
  return rollup ? `${rollup.label} ${rollup.reached}/${rollup.total}` : null;
}


const rackNum = (s: string): number => {
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
};

export function compareRackLabels(a: string, b: string): number {
  return rackNum(a) - rackNum(b) || a.localeCompare(b);
}

/**
 * "3, 4" — dedupe, numeric sort, the label without the word "Rack" (the column
 * header says it; owner 2026-11-10). Empty string when nothing resolved, so the
 * caller prints a dash.
 *
 * ONE RACK PER DELIVERY-ORDER LINE is all Houzs stores (`rack_id`, mig 0118).
 * Hookka can print per PIECE ("HB: Rack 19 / Divan: Rack 19, 20") because its
 * packing job cards carry a rack each; this system has no piece layer, and
 * inventing one would be a sheet that says more than the data does.
 */
export function formatRacksCompact(labels: readonly (string | null | undefined)[]): string {
  const seen = new Set<string>();
  for (const raw of labels) {
    const v = (raw ?? '').trim();
    if (v) seen.add(v);
  }
  if (seen.size === 0) return '';
  const sorted = [...seen].sort(compareRackLabels);
  return sorted.map(shortRackLabel).join(', ');
}


/**
 * m³ from the stored milli-m³, or null when NOT ONE member delivery order
 * carried a figure. `delivery_orders.m3_total_milli` is a column that exists
 * and is not guaranteed to be filled — a printed "0.00 m³" would be a claim
 * about the load, where a dash is a report about our data.
 */
export function fmtM3(m3Milli: number | null | undefined): string | null {
  if (m3Milli == null) return null;
  return `${(m3Milli / 1000).toFixed(2)} m³`;
}



/* ── PART A: PICK BY CATEGORY (owner 2026-11-27) ──────────────────────────────
   One pick sheet for the whole lorry, by product category, in this order:
   MATTRESS, BEDFRAME, ACCESSORIES, SOFA, then anything else as OTHER.

   · MATTRESS / ACCESSORIES (and OTHER): identical item code + variant collapse
     into one row with the total qty, every rack, every PO, and the customers
     (stop numbers) listed highest first.
   · BEDFRAME / SOFA: one row per DO line, each with its own PO and rack, never
     merged — two bedframes of one code can come off two racks from two POs.
   · SOFA rows are grouped by sales order so two customers' sets never mix;
     groups run highest stop first.

   EVERY list of rows is sorted the same way — item code, then variant text,
   then customer (highest first), then rack — so the sheet reads identically
   every time it is printed (owner: 「确保sorting功能有要不然每次很乱」). */

export type PackCategory = 'MATTRESS' | 'BEDFRAME' | 'ACCESSORIES' | 'SOFA' | 'OTHER';
export const PACK_CATEGORY_ORDER: readonly PackCategory[] = ['MATTRESS', 'BEDFRAME', 'ACCESSORIES', 'SOFA', 'OTHER'];
const PIECE_CATEGORIES: ReadonlySet<PackCategory> = new Set<PackCategory>(['BEDFRAME', 'SOFA']);

/** `item_group` -> pick category, case-insensitive. Unknown or empty = OTHER. */
export function packCategory(itemGroup: string | null | undefined): PackCategory {
  const g = (itemGroup ?? '').trim().toLowerCase();
  if (g === 'mattress' || g === 'mattresses') return 'MATTRESS';
  if (g === 'bedframe' || g === 'bedframes' || g === 'bed frame') return 'BEDFRAME';
  if (g === 'accessory' || g === 'accessories') return 'ACCESSORIES';
  if (g === 'sofa' || g === 'sofas') return 'SOFA';
  return 'OTHER';
}

export type PickRow = {
  item_code: string;
  description: string | null;
  variant: string;
  pos: string[];
  racks: string[];
  qty: number;
  customers: number[];
};

export type SofaGroup = {
  so_doc_no: string | null;
  stop_no: number;
  customer_name: string | null;
  pieces: number;
  pos: string[];
  rows: PickRow[];
};

export type PickSection = {
  category: PackCategory;
  units: number;
  rows: PickRow[];
  groups: SofaGroup[];
};

const uniq = (xs: readonly string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
const splitList = (v: string | null | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const byCode = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/** The one sort every pick list uses. Pure, total: ties fall through to rack. */
export function comparePickRows(a: PickRow, b: PickRow): number {
  return byCode(a.item_code, b.item_code)
    || byCode(a.variant, b.variant)
    || (b.customers[0] ?? 0) - (a.customers[0] ?? 0)
    || byCode(formatRacksCompact(a.racks), formatRacksCompact(b.racks));
}

/** Sorted copy; never mutates the caller's rows. */
export function sortPickRows(rows: readonly PickRow[]): PickRow[] {
  return [...rows].sort(comparePickRows);
}

type FlatLine = { stop: PackingStop; item: PackingStop['items'][number]; variant: string };

/**
 * One trip's lines -> the Part A sections, in category order, empty categories
 * dropped. `variantOf` composes the printed variant text (the PDF passes the
 * DO's own composition, so the two documents describe a line the same way).
 */
export function buildPickSections(
  stops: readonly PackingStop[],
  variantOf: (item: PackingStop['items'][number]) => string,
): PickSection[] {
  const seenDo = new Set<string>();
  const flat: FlatLine[] = [];
  for (const stop of stops) {
    if (stop.do_missing) continue;
    if (stop.do_id) { if (seenDo.has(stop.do_id)) continue; seenDo.add(stop.do_id); }
    for (const item of stop.items) flat.push({ stop, item, variant: variantOf(item).trim() });
  }

  const pieceRow = (l: FlatLine): PickRow => ({
    item_code: l.item.item_code,
    description: l.item.description,
    variant: l.variant,
    pos: splitList(l.item.po),
    racks: splitList(l.item.rack),
    qty: l.item.qty,
    customers: [l.stop.stop_no],
  });

  const out: PickSection[] = [];
  for (const category of PACK_CATEGORY_ORDER) {
    const lines = flat.filter((l) => packCategory(l.item.item_group) === category);
    if (lines.length === 0) continue;
    const units = lines.reduce((n, l) => n + l.item.qty, 0);

    if (category === 'SOFA') {
      const byGroup = new Map<string, FlatLine[]>();
      for (const l of lines) {
        const key = `${l.stop.so_doc_no ?? ''}\u0000${l.stop.stop_no}`;
        const arr = byGroup.get(key) ?? [];
        arr.push(l);
        byGroup.set(key, arr);
      }
      const groups: SofaGroup[] = [...byGroup.values()].map((ls) => {
        const rows = sortPickRows(ls.map(pieceRow));
        return {
          so_doc_no: ls[0].stop.so_doc_no,
          stop_no: ls[0].stop.stop_no,
          customer_name: ls[0].stop.customer_name,
          pieces: ls.reduce((n, l) => n + l.item.qty, 0),
          pos: uniq(rows.flatMap((r) => r.pos)).sort(byCode),
          rows,
        };
      });
      groups.sort((a, b) => b.stop_no - a.stop_no || byCode(a.so_doc_no ?? '', b.so_doc_no ?? ''));
      out.push({ category, units, rows: [], groups });
      continue;
    }

    if (PIECE_CATEGORIES.has(category)) {
      out.push({ category, units, rows: sortPickRows(lines.map(pieceRow)), groups: [] });
      continue;
    }

    const agg = new Map<string, PickRow>();
    for (const l of lines) {
      const key = `${l.item.item_code}\u0000${l.variant}`;
      const row = agg.get(key) ?? { ...pieceRow(l), qty: 0, pos: [], racks: [], customers: [] };
      row.qty += l.item.qty;
      row.pos = uniq([...row.pos, ...splitList(l.item.po)]).sort(byCode);
      row.racks = uniq([...row.racks, ...splitList(l.item.rack)]).sort(compareRackLabels);
      row.customers = [...new Set([...row.customers, l.stop.stop_no])].sort((a, b) => b - a);
      if (l.item.description && (!row.description || byCode(l.item.description, row.description) < 0)) {
        row.description = l.item.description;
      }
      agg.set(key, row);
    }
    out.push({ category, units, rows: sortPickRows([...agg.values()]), groups: [] });
  }
  return out;
}

/** yyyy-mm-dd shifted by whole days, in calendar terms (no timezone drift). */
export function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}


/* ── BY REGION (owner 2026-11-27) ─────────────────────────────────────────────
   A region sheet is Part A only, over every DO delivering in the region that
   day. It reuses buildPickSections by numbering the region's DOs 1..N in the
   order the backend sorts them (by lorry, then customer); the number is the
   customer key printed on the sheet, and each number carries a lorry label. */

export const NOT_ARRANGED = 'Not arranged';

export function regionLorryLabel(d: Pick<PackingRegionDo, 'lorry_plate'>): string {
  return d.lorry_plate ?? NOT_ARRANGED;
}

export function regionStops(region: Pick<PackingRegionRow, 'dos'>): PackingStop[] {
  return region.dos.map((d, i) => ({
    stop_no: i + 1,
    stop_type: null,
    customer_name: d.customer_name,
    address: d.address,
    do_id: d.do_id,
    do_number: d.do_number,
    do_status: d.do_status,
    do_missing: false,
    so_doc_no: d.so_doc_no,
    phone: d.phone,
    time_range: d.time_range,
    units: d.units,
    items: d.items,
  }));
}

/** Customer numbers -> the distinct lorry labels, arranged plates first. */
export function lorriesFor(customers: readonly number[], region: Pick<PackingRegionRow, 'dos'>): string[] {
  const labels = new Set<string>();
  for (const n of customers) {
    const d = region.dos[n - 1] as PackingRegionDo | undefined;
    if (d) labels.add(regionLorryLabel(d));
  }
  return [...labels].sort((a, b) => Number(a === NOT_ARRANGED) - Number(b === NOT_ARRANGED) || byCode(a, b));
}

/** "VJK 8821, WXY 1234, 3 not arranged" for the region table. */
export function regionLorrySummary(region: Pick<PackingRegionRow, 'lorry_plates' | 'not_arranged'>): string {
  const parts = [...region.lorry_plates];
  if (region.not_arranged > 0) parts.push(`${region.not_arranged} not arranged`);
  return parts.join(', ') || '—';
}

/** Units per pick category for one region, every category present (0 when none). */
export function regionCategoryUnits(region: Pick<PackingRegionRow, 'dos'>): Record<PackCategory, number> {
  const out = Object.fromEntries(PACK_CATEGORY_ORDER.map((c) => [c, 0])) as Record<PackCategory, number>;
  for (const d of region.dos) for (const it of d.items) out[packCategory(it.item_group)] += it.qty;
  return out;
}
