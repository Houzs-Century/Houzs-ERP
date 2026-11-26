
import type { Rack, RackItem, RackStatus } from './warehouse-queries';

export type SlotStatus = 'occupied' | 'reserved' | 'empty';

/* ── Zone config (owner 2026-09-11) ───────────────────────────────────────
   The KL warehouse is split into two zones by rack NUMBER, each holding both
   series (L and R). Listed LEFT→RIGHT as the plan draws them: the LOADING BAY is
   the left strip at the LOW-number end (L1 / R1), the MAIN ENTRANCE / DOCK is the
   right strip at the HIGH-number end (L21 / R17) — so ZONE A (L1–L8) is nearest
   the loading bay and comes first, ZONE B (L9–L21) is nearest the entrance and
   comes last. Racks ascend left→right within each row. Single edit point: rename
   a zone, move a boundary, reorder, or add a series/zone. Each zone stacks its
   banks (L over R) with the aisle between. */
export type ZoneAisle = { name: string; flow: string; arrows: string };
export type ZoneBankConfig = { prefix: string; from: number; to: number };
export type ZoneConfig = { label: string; banks: ZoneBankConfig[]; aisle?: ZoneAisle };

const AISLE_01: ZoneAisle = { name: 'AISLE 01', flow: 'two-way · loading bay ⇄ entrance', arrows: '⇄ ⇄ ⇄' };

export const WAREHOUSE_ZONES: ZoneConfig[] = [
  {
    label: 'ZONE A',
    banks: [{ prefix: 'L', from: 1, to: 8 }, { prefix: 'R', from: 1, to: 8 }],
    aisle: AISLE_01,
  },
  {
    label: 'ZONE B',
    banks: [{ prefix: 'L', from: 9, to: 21 }, { prefix: 'R', from: 9, to: 17 }],
    aisle: AISLE_01,
  },
];

export const ZONE_LABELS: string[] = WAREHOUSE_ZONES.map((z) => z.label);

const RACK_LABEL_RE = /([A-Za-z]*)\s*(\d+)(?:\s*[.\-/ ]\s*(\d+))?\s*$/;

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
    level: m[3] ? Number(m[3]) : null,
    parsed: true,
  };
}

export function rackKeyOf(label: string): string {
  const p = parseRackLabel(label);
  return p.parsed && !Number.isNaN(p.rackNo) ? `${p.prefix}${p.rackNo}` : label.trim();
}

export function compareRackLabels(a: string, b: string): number {
  const pa = parseRackLabel(a);
  const pb = parseRackLabel(b);
  const aBad = !pa.parsed || Number.isNaN(pa.rackNo);
  const bBad = !pb.parsed || Number.isNaN(pb.rackNo);
  if (aBad || bBad) {
    if (aBad && bBad) return a.localeCompare(b);
    return aBad ? 1 : -1;
  }
  if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix);
  if (pa.rackNo !== pb.rackNo) return pa.rackNo - pb.rackNo;
  return (pa.level ?? 0) - (pb.level ?? 0);
}

export type Slot = {
  rack: Rack;
  id: string;
  prefix: string;
  rackNo: number;
  rackKey: string;
  rackName: string;
  level: number | null;
  zone: string | null;
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

export function itemDescription(it: RackItem): string {
  const name = (it.product_name || it.item_code || '').trim();
  const size = (it.size_label || '').trim();
  return (size && !name.includes(size) ? `${name} ${size}`.trim() : name) || 'Item';
}

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
  const items = rack.items;
  const p = parseRackLabel(rack.rack);
  const status = STATUS_MAP[rack.status];
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
    zone: rack.zone,
    status,
    itemCount: items.length,
    productCode: items.length > 0 ? primary.item_code : '',
    productLabel,
    customer: customers.join(', '),
    qty,
    inDate: inDates[0] || '',
    doc: docs.join(', '),
    items,
    search: [rack.rack, ...products, ...customers, ...docs].join(' ').toLowerCase(),
  };
}

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
  used: number;
  total: number;
  utilPct: number;
  racks: RackColumn[];
};

export type Zone = {
  label: string;
  used: number;
  total: number;
  utilPct: number;
  aisle?: ZoneAisle;
  banks: Bank[];
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

function buildBank(prefix: string, group: Slot[]): Bank {
  const racks = buildRackColumns(group);
  const nums = group.map((s) => s.rackNo).filter((n) => Number.isFinite(n));
  const label = nums.length > 0 ? `${prefix}${Math.min(...nums)} – ${prefix}${Math.max(...nums)}` : prefix || 'UNZONED';
  const occupied = group.filter((s) => s.status === 'occupied').length;
  return { prefix, label, used: occupied, total: group.length, utilPct: pct(occupied, group.length), racks };
}

export function resolvedZoneLabel(slot: Slot, zones: ZoneConfig[] = WAREHOUSE_ZONES): string | null {
  const override = (slot.zone ?? '').trim();
  if (override) {
    const target = zones.find((z) => z.label === override);
    if (target && target.banks.some((bc) => bc.prefix === slot.prefix)) return override;
  }
  for (const z of zones) {
    for (const bc of z.banks) {
      if (slot.prefix === bc.prefix && Number.isFinite(slot.rackNo) && slot.rackNo >= bc.from && slot.rackNo <= bc.to) {
        return z.label;
      }
    }
  }
  return null;
}

export function buildZones(slots: Slot[], zones: ZoneConfig[] = WAREHOUSE_ZONES): Zone[] {
  const zoneOf = new Map<Slot, string | null>();
  for (const s of slots) zoneOf.set(s, resolvedZoneLabel(s, zones));
  const out: Zone[] = [];

  for (const zone of zones) {
    const banks: Bank[] = [];
    for (const bc of zone.banks) {
      const group = slots.filter((s) => zoneOf.get(s) === zone.label && s.prefix === bc.prefix);
      if (group.length === 0) continue;
      banks.push(buildBank(bc.prefix, group));
    }
    if (banks.length === 0) continue;
    const total = banks.reduce((a, b) => a + b.total, 0);
    const used = banks.reduce((a, b) => a + b.used, 0);
    out.push({ label: zone.label, used, total, utilPct: pct(used, total), aisle: zone.aisle, banks });
  }

  const leftover = slots.filter((s) => zoneOf.get(s) == null);
  if (leftover.length > 0) {
    const byPrefix = new Map<string, Slot[]>();
    for (const s of leftover) {
      const arr = byPrefix.get(s.prefix);
      if (arr) arr.push(s);
      else byPrefix.set(s.prefix, [s]);
    }
    const banks = [...byPrefix.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([prefix, group]) => buildBank(prefix, group));
    const total = leftover.length;
    const used = leftover.filter((s) => s.status === 'occupied').length;
    out.push({ label: 'UNZONED', used, total, utilPct: pct(used, total), banks });
  }
  return out;
}
