// ----------------------------------------------------------------------------
// warehouse-floorplan — the ONE logic layer behind the Warehouse "Rack Overview"
// floor plan (WarehouseFloorPlan.tsx). Pure, dependency-free, unit-tested: parse
// a rack label, sort NATURALLY (the L1/L10/L2 fix), group slots into rack
// columns and physical banks, and match a slot against the toolbar filters.
//
// A backend `Rack` row IS one physical slot (its `rack` string is the slot id,
// e.g. "L1.1"); the design's "rack" (a column holding two levels) and "bank"
// (a row of racks along the aisle) are DERIVED here by parsing that label:
//
//   "L1.1"  ->  prefix "L"  ·  rackNo 1  ·  level 1
//               column key "L1"          bank "L"
//
// The prefix letter is the physical bank — the KL warehouse is an "L" row and an
// "R" row with one aisle between them — so banks come from the prefix, never
// from splitting the rack count in half.
// ----------------------------------------------------------------------------

import type { Rack, RackItem, RackStatus } from './warehouse-queries';

export type SlotStatus = 'occupied' | 'reserved' | 'empty';

/* ── Zone config — PLACEHOLDER names ──────────────────────────────────────
   `BANK A` / `BANK B` / `AISLE 01` are placeholders pending the owner's real
   zone names. Zones are keyed by rack-label PREFIX (the letters before the
   number). This constant is the single edit point: rename a `label` to rename a
   bank, add an entry to onboard a new physical prefix. The aisle strip renders
   AFTER the zone that carries it (the design shows one aisle, under BANK A). */
export type ZoneAisle = { name: string; flow: string; arrows: string };
export type ZoneConfig = { prefix: string; label: string; aisle?: ZoneAisle };

export const WAREHOUSE_ZONES: ZoneConfig[] = [
  {
    prefix: 'L',
    label: 'BANK A',
    aisle: { name: 'AISLE 01', flow: 'single aisle · two-way · dock ⇄ loading bay', arrows: '⇄ ⇄ ⇄' },
  },
  { prefix: 'R', label: 'BANK B' },
];

/* ── Rack label parsing ───────────────────────────────────────────────────
   `<letters?><number>[sep<number>]` — "L1.1", "R17.2", "12.1", also tolerant of
   "L1-2" / "L1 2" / bare "L1". A label that carries no leading number does not
   parse (rackNo NaN) and sinks to the bottom of any sort by its raw text. */
const RACK_LABEL_RE = /^\s*([A-Za-z]*)\s*(\d+)(?:\s*[.\-/ ]\s*(\d+))?\s*$/;

export type ParsedRackLabel = {
  prefix: string;
  rackNo: number;
  level: number | null;
  parsed: boolean;
};

export function parseRackLabel(label: string | null | undefined): ParsedRackLabel {
  const raw = (label ?? '').trim();
  const m = RACK_LABEL_RE.exec(raw);
  if (!m) {
    return { prefix: raw.toUpperCase(), rackNo: Number.NaN, level: null, parsed: false };
  }
  return {
    prefix: (m[1] || '').toUpperCase(),
    rackNo: Number(m[2]),
    level: m[3] != null ? Number(m[3]) : null,
    parsed: true,
  };
}

/* Column key for a rack (prefix + rackNo), e.g. "L1" — the two levels "L1.1" and
   "L1.2" share it. Unparseable labels are their own single column (raw label). */
export function rackKeyOf(label: string): string {
  const p = parseRackLabel(label);
  return p.parsed && !Number.isNaN(p.rackNo) ? `${p.prefix}${p.rackNo}` : (label ?? '').trim();
}

/* Natural comparator — prefix, then rackNo NUMERICALLY, then level. This is the
   fix for the old lexicographic order that read L1, L10, L2. Unparseable labels
   sort last, among themselves by raw text. */
export function compareRackLabels(a: string, b: string): number {
  const pa = parseRackLabel(a);
  const pb = parseRackLabel(b);
  const aBad = !pa.parsed || Number.isNaN(pa.rackNo);
  const bBad = !pb.parsed || Number.isNaN(pb.rackNo);
  if (aBad || bBad) {
    if (aBad && bBad) return (a ?? '').localeCompare(b ?? '');
    return aBad ? 1 : -1;
  }
  if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix);
  if (pa.rackNo !== pb.rackNo) return pa.rackNo - pb.rackNo;
  return (pa.level ?? 0) - (pb.level ?? 0);
}

/* ── Slot view model ──────────────────────────────────────────────────────
   Flattens a `Rack` (+ its items) into the fields the floor plan renders. A slot
   can hold several items; product / customer / doc aggregate, qty sums, in-date
   takes the earliest. `search` is the lower-cased haystack for free-text match. */
export type Slot = {
  rack: Rack;
  id: string;
  prefix: string;
  rackNo: number;
  rackKey: string;
  rackName: string;
  level: number | null;
  status: SlotStatus;
  itemCount: number;
  productCode: string;
  productLabel: string;
  customer: string;
  qty: number;
  inDate: string;
  doc: string;
  items: RackItem[];
  search: string;
};

const STATUS_MAP: Record<RackStatus, SlotStatus> = {
  OCCUPIED: 'occupied',
  RESERVED: 'reserved',
  EMPTY: 'empty',
};

/* One clear product description for an item — never empty. */
export function itemDescription(it: RackItem): string {
  const name = (it.product_name || it.item_code || '').trim();
  const size = (it.size_label || '').trim();
  return (size && !name.includes(size) ? `${name} ${size}`.trim() : name) || 'Item';
}

/* customer · doc, whichever are present. */
export function itemMeta(it: RackItem): string {
  return [it.customer_name || '', it.source_doc_no || ''].filter(Boolean).join(' · ');
}

function uniq(values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const t = (v || '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function toSlot(rack: Rack): Slot {
  const items = rack.items || [];
  const p = parseRackLabel(rack.rack);
  const status = STATUS_MAP[rack.status] ?? 'empty';
  const products = uniq(items.map((it) => it.product_name || it.item_code));
  const customers = uniq(items.map((it) => it.customer_name));
  const docs = uniq(items.map((it) => it.source_doc_no));
  const qty = items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
  const inDates = items.map((it) => it.stocked_in_date).filter(Boolean).sort();
  const primary = items[0];
  const productLabel =
    items.length === 0 ? '' : items.length === 1 ? itemDescription(primary) : `${items.length} items`;
  return {
    rack,
    id: rack.rack,
    prefix: p.prefix,
    rackNo: p.rackNo,
    rackKey: rackKeyOf(rack.rack),
    rackName: p.parsed && !Number.isNaN(p.rackNo) ? `${p.prefix}${p.rackNo}` : rack.rack,
    level: p.level,
    status,
    itemCount: items.length,
    productCode: primary?.item_code || '',
    productLabel,
    customer: customers.join(', '),
    qty,
    inDate: inDates[0] || '',
    doc: docs.join(', '),
    items,
    search: [rack.rack, ...products, ...customers, ...docs].join(' ').toLowerCase(),
  };
}

/* ── Filters ──────────────────────────────────────────────────────────────
   `matchSlot` is the highlight-and-dim predicate: a passing slot is a "hit"
   (ring + full opacity), a failing one is dimmed (never hidden). Product /
   customer match ANY item on the slot; the date range tests the earliest
   in-date; `q` is a substring across id / product / customer / doc. */
export type FloorFilters = {
  q: string;
  product: string;
  customer: string;
  from: string;
  to: string;
  status: SlotStatus | '';
};

export const EMPTY_FILTERS: FloorFilters = {
  q: '', product: '', customer: '', from: '', to: '', status: '',
};

export function isFiltering(f: FloorFilters): boolean {
  return !!(f.q || f.product || f.customer || f.from || f.to || f.status);
}

export function matchSlot(s: Slot, f: FloorFilters): boolean {
  if (f.status && s.status !== f.status) return false;
  if (f.product && !s.items.some((it) => (it.product_name || it.item_code) === f.product)) return false;
  if (f.customer && !s.items.some((it) => (it.customer_name || '') === f.customer)) return false;
  if (f.from && (!s.inDate || s.inDate < f.from)) return false;
  if (f.to && (!s.inDate || s.inDate > f.to)) return false;
  if (f.q && !s.search.includes(f.q.trim().toLowerCase())) return false;
  return true;
}

export function distinctProducts(slots: Slot[]): string[] {
  return uniq(slots.flatMap((s) => s.items.map((it) => it.product_name || it.item_code))).sort((a, b) =>
    a.localeCompare(b),
  );
}

export function distinctCustomers(slots: Slot[]): string[] {
  return uniq(slots.flatMap((s) => s.items.map((it) => it.customer_name))).sort((a, b) => a.localeCompare(b));
}

export function statusCounts(slots: Slot[]): Record<SlotStatus, number> {
  const out: Record<SlotStatus, number> = { occupied: 0, reserved: 0, empty: 0 };
  for (const s of slots) out[s.status] += 1;
  return out;
}

/* ── Banks + rack columns ─────────────────────────────────────────────────
   Group the flat slot list into rack columns (two levels each) and physical
   banks (by prefix), each with utilisation. Bank order follows WAREHOUSE_ZONES;
   any prefix not in the config is appended (label = prefix), so unexpected data
   still renders. */
export type RackColumn = {
  key: string;
  name: string;
  slots: Slot[];
  occupied: number;
  total: number;
  utilPct: number;
};

export type Bank = {
  prefix: string;
  label: string;
  range: string;
  used: number;
  total: number;
  utilPct: number;
  aisle?: ZoneAisle;
  racks: RackColumn[];
};

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

function buildRackColumns(slots: Slot[]): RackColumn[] {
  const byKey = new Map<string, Slot[]>();
  for (const s of slots) {
    const arr = byKey.get(s.rackKey);
    if (arr) arr.push(s);
    else byKey.set(s.rackKey, [s]);
  }
  return [...byKey.entries()]
    .sort(([, a], [, b]) => compareRackLabels(a[0].id, b[0].id))
    .map(([key, group]) => {
      const ordered = [...group].sort((a, b) => compareRackLabels(a.id, b.id));
      const occupied = ordered.filter((s) => s.status === 'occupied').length;
      return {
        key,
        name: ordered[0]?.rackName ?? key,
        slots: ordered,
        occupied,
        total: ordered.length,
        utilPct: pct(occupied, ordered.length),
      };
    });
}

export function buildBanks(slots: Slot[], zones: ZoneConfig[] = WAREHOUSE_ZONES): Bank[] {
  const byPrefix = new Map<string, Slot[]>();
  for (const s of slots) {
    const arr = byPrefix.get(s.prefix);
    if (arr) arr.push(s);
    else byPrefix.set(s.prefix, [s]);
  }

  const configured = zones.map((z) => z.prefix);
  const extras = [...byPrefix.keys()].filter((p) => !configured.includes(p)).sort((a, b) => a.localeCompare(b));
  const ordered: ZoneConfig[] = [
    ...zones,
    ...extras.map((prefix) => ({ prefix, label: prefix || 'UNZONED' })),
  ];

  const banks: Bank[] = [];
  for (const zone of ordered) {
    const group = byPrefix.get(zone.prefix);
    if (!group || group.length === 0) continue;
    const racks = buildRackColumns(group);
    const total = group.length;
    const used = group.filter((s) => s.status === 'occupied').length;
    const nums = racks.map((r) => r.slots[0]?.rackNo).filter((n) => Number.isFinite(n)) as number[];
    const range =
      nums.length > 0
        ? `${zone.prefix}${Math.min(...nums)} – ${zone.prefix}${Math.max(...nums)}`
        : `${racks.length} rack${racks.length === 1 ? '' : 's'}`;
    banks.push({
      prefix: zone.prefix,
      label: zone.label,
      range,
      used,
      total,
      utilPct: pct(used, total),
      aisle: zone.aisle,
      racks,
    });
  }
  return banks;
}
