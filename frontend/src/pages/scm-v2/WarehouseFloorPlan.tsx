// ----------------------------------------------------------------------------
// WarehouseFloorPlan — the "Rack Overview" tab, re-laid out as a top-view floor
// plan (design handoff, 2026-09-10). Replaces the old flat card grid: two banks
// of rack columns (the physical "L" row and "R" row) with one aisle between
// them, dock at the north end, loading bay at the south. Filters HIGHLIGHT the
// matching slots and DIM the rest (never hide); a slot click opens the detail
// drawer, and cmd/ctrl-click multi-selects and swaps the toolbar for a batch
// bar. Below 1180px it offers a Floor plan / List switch (owned by the parent).
//
// All grouping / sorting / filtering lives in the ONE tested logic layer
// (vendor/scm/lib/warehouse-floorplan.ts) — this file is presentation only.
// Colour literals are the design-system Ink & Petrol tokens (README token
// table); Tailwind semantic classes are used wherever a token maps to one.
// ----------------------------------------------------------------------------

import { useMemo, useState, type CSSProperties } from 'react';
import {
  Search, X, Truck, ArrowLeftRight, ChevronsDown, ChevronDown,
  ArrowDownToLine, Pencil, Trash2, Download,
} from 'lucide-react';
import { Button, SearchInput } from '../../components/Button';
import { ResizableDetailDrawer } from '../../components/ResizableDetailDrawer';
import { fmtDate, fmtQty } from '@2990s/shared';
import {
  useMovements, useUpdateRack, useDeleteRack,
  type Rack, type RackMovementType,
} from '../../vendor/scm/lib/warehouse-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import {
  buildBanks, distinctCustomers, distinctProducts, isFiltering, itemDescription,
  itemMeta, matchSlot, statusCounts, toSlot,
  type FloorFilters, type Slot, type SlotStatus,
} from '../../vendor/scm/lib/warehouse-floorplan';

/* Slot-state palette — every value is an Ink & Petrol token from the README
   handoff table. Drives the cell fill / border / level pill / tick / badge for
   each status, plus the legend swatch. */
type StatePal = {
  bg: string; border: string; fg: string; levelBg: string; levelFg: string;
  tick: string; tickBd: string; label: string; badgeBg: string; badgeFg: string;
  swatch: string; swatchBd: string;
};
const PAL: Record<SlotStatus, StatePal> = {
  occupied: { bg: '#e1efed', border: '#b9d4ce', fg: '#0c3f39', levelBg: '#16695f', levelFg: '#ffffff', tick: '#16695f', tickBd: '#0c3f39', label: 'Occupied', badgeBg: '#e1efed', badgeFg: '#0c3f39', swatch: '#16695f', swatchBd: '#0c3f39' },
  reserved: { bg: '#f6efd9', border: '#d6d9d2', fg: '#6e4d12', levelBg: '#6e4d12', levelFg: '#ffffff', tick: '#b76b00', tickBd: '#6e4d12', label: 'Reserved', badgeBg: '#f6efd9', badgeFg: '#6e4d12', swatch: '#b76b00', swatchBd: '#6e4d12' },
  empty: { bg: '#ffffff', border: '#e3e6e0', fg: '#414539', levelBg: '#f4f6f3', levelFg: '#414539', tick: '#ffffff', tickBd: '#d3d8cf', label: 'Empty', badgeBg: '#f4f6f3', badgeFg: '#414539', swatch: '#ffffff', swatchBd: '#d3d8cf' },
};
const STATUS_ORDER: SlotStatus[] = ['occupied', 'empty', 'reserved'];

const detailLine = (s: Slot): string => {
  if (s.itemCount === 0) return s.status === 'reserved' ? 'on hold' : 'available';
  return [s.customer, `${s.qty} pcs`].filter(Boolean).join(' · ') || `${s.qty} pcs`;
};

export function WarehouseFloorPlan({
  racks, warehouseId, isLoading, wide, view, onEditRack, onStockInHere,
}: {
  racks: Rack[];
  warehouseId: string;
  isLoading: boolean;
  wide: boolean;
  view: 'plan' | 'list';
  onEditRack: (r: Rack) => void;
  onStockInHere: (rackId: string) => void;
}) {
  const [filters, setFilters] = useState<FloorFilters>({ q: '', product: '', customer: '', from: '', to: '', status: '' });
  const [picked, setPicked] = useState<string[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ slot: Slot; x: number; y: number } | null>(null);

  const notify = useNotify();
  const confirm = useConfirm();
  const updateRack = useUpdateRack();
  const deleteRack = useDeleteRack();

  const slots = useMemo(() => racks.map(toSlot), [racks]);
  const filtering = isFiltering(filters);
  const hits = useMemo(() => new Set(slots.filter((s) => matchSlot(s, filters)).map((s) => s.id)), [slots, filters]);
  const banks = useMemo(() => buildBanks(slots), [slots]);
  const counts = useMemo(() => statusCounts(slots), [slots]);
  const products = useMemo(() => distinctProducts(slots), [slots]);
  const customers = useMemo(() => distinctCustomers(slots), [slots]);
  const pickedSet = useMemo(() => new Set(picked), [picked]);

  const sel = useMemo(() => slots.find((s) => s.id === selId) ?? null, [slots, selId]);
  const setFilter = (patch: Partial<FloorFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const resetFilters = () => setFilters({ q: '', product: '', customer: '', from: '', to: '', status: '' });

  const clickSlot = (s: Slot, e: React.MouseEvent) => {
    const multi = e.metaKey || e.ctrlKey || e.shiftKey;
    setHover(null);
    if (multi || picked.length > 0) {
      setPicked((p) => (p.includes(s.rack.id) ? p.filter((x) => x !== s.rack.id) : [...p, s.rack.id]));
    } else {
      setSelId(s.id);
    }
  };

  const pickedSlots = useMemo(() => slots.filter((s) => pickedSet.has(s.rack.id)), [slots, pickedSet]);

  const setReserved = async (reserved: boolean) => {
    try {
      for (const s of pickedSlots) await updateRack.mutateAsync({ id: s.rack.id, reserved });
      notify({ title: reserved ? 'Marked reserved.' : 'Reservation released.' });
      setPicked([]);
    } catch (e) {
      notify({ title: 'Could not update the selected slots', body: (e as Error).message, tone: 'error' });
    }
  };

  const exportSelection = () => {
    const head = ['Slot', 'Status', 'Product', 'Customer', 'Qty', 'In date', 'Document'];
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const body = pickedSlots.map((s) =>
      [s.id, s.status, s.productLabel, s.customer, s.itemCount ? String(s.qty) : '', s.inDate, s.doc].map((v) => esc(String(v))).join(','));
    const csv = [head.join(','), ...body].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `warehouse-slots-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!warehouseId) return <PlaceholderPanel>Select a warehouse to view its floor plan.</PlaceholderPanel>;
  if (isLoading) return <PlaceholderPanel>Loading floor plan…</PlaceholderPanel>;
  if (racks.length === 0) return <PlaceholderPanel>No racks in this warehouse yet. Add one with New rack.</PlaceholderPanel>;

  const showList = !wide && view === 'list';

  return (
    <div className="flex flex-col gap-4">
      {picked.length === 0 ? (
        <Toolbar
          filters={filters}
          setFilter={setFilter}
          onReset={resetFilters}
          products={products}
          customers={customers}
          counts={counts}
          total={slots.length}
          hitCount={hits.size}
          filtering={filtering}
        />
      ) : (
        <BatchBar
          count={picked.length}
          onReserve={() => setReserved(true)}
          onRelease={() => setReserved(false)}
          onExport={exportSelection}
          busy={updateRack.isPending}
          onClear={() => setPicked([])}
        />
      )}

      {showList ? (
        <ListView banks={banks} filtering={filtering} hits={hits} pickedSet={pickedSet} onClickSlot={clickSlot} />
      ) : (
        <FloorPlan
          banks={banks}
          wide={wide}
          filtering={filtering}
          hits={hits}
          pickedSet={pickedSet}
          onClickSlot={clickSlot}
          onHover={(slot, e) => setHover({ slot, x: e.clientX + 14, y: e.clientY + 14 })}
          onHoverEnd={() => setHover(null)}
        />
      )}

      {hover && <HoverCard hover={hover} />}

      <ResizableDetailDrawer open={!!sel} onClose={() => setSelId(null)} ariaLabel="Slot detail">
        {sel && (
          <SlotDrawerBody
            slot={sel}
            warehouseId={warehouseId}
            onClose={() => setSelId(null)}
            onEdit={() => { onEditRack(sel.rack); setSelId(null); }}
            onStockInHere={() => { onStockInHere(sel.rack.id); setSelId(null); }}
            onDelete={async () => {
              if (sel.itemCount > 0) {
                notify({ title: 'This slot still has stock on it.', body: 'Stock out its items before deleting.', tone: 'error' });
                return;
              }
              const ok = await confirm({ title: `Delete ${sel.id}?`, body: 'This removes the empty rack. This cannot be undone.', confirmLabel: 'Delete', danger: true });
              if (!ok) return;
              deleteRack.mutate(sel.rack.id, {
                onSuccess: () => setSelId(null),
                onError: (e) => notify({ title: 'Could not delete rack', body: (e as Error).message, tone: 'error' }),
              });
            }}
            deleting={deleteRack.isPending}
          />
        )}
      </ResizableDetailDrawer>
    </div>
  );
}

/* ── Toolbar (no selection) ─────────────────────────────────────────────── */
function Toolbar({
  filters, setFilter, onReset, products, customers, counts, total, hitCount, filtering,
}: {
  filters: FloorFilters;
  setFilter: (p: Partial<FloorFilters>) => void;
  onReset: () => void;
  products: string[];
  customers: string[];
  counts: Record<SlotStatus, number>;
  total: number;
  hitCount: number;
  filtering: boolean;
}) {
  const selectCls = 'h-9 rounded-md border border-border-subtle bg-surface px-2.5 text-[12.5px] text-ink-secondary outline-none focus:border-primary';
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <SearchInput
          value={filters.q}
          onChange={(v) => setFilter({ q: v })}
          placeholder="Search slot, product, customer or doc no…"
          aria-label="Search slots"
          className="min-w-[220px] flex-1"
          leadingIcon={<Search size={14} strokeWidth={1.75} />}
          inputClassName="!w-full !bg-surface-2 !pl-8"
        />
        <select className={selectCls} value={filters.product} onChange={(e) => setFilter({ product: e.target.value })} aria-label="Filter by product">
          <option value="">All products</option>
          {products.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className={selectCls} value={filters.customer} onChange={(e) => setFilter({ customer: e.target.value })} aria-label="Filter by customer">
          <option value="">All customers</option>
          {customers.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="flex h-9 items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2.5">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-muted">In date</span>
          <input type="date" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} aria-label="In date from" className="border-none bg-transparent text-[12px] text-ink-secondary outline-none" />
          <span className="text-[11px] text-ink-secondary">→</span>
          <input type="date" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} aria-label="In date to" className="border-none bg-transparent text-[12px] text-ink-secondary outline-none" />
        </div>
        <button type="button" onClick={onReset} className="h-9 rounded-md px-3 text-[12px] font-semibold text-ink-muted hover:text-ink">Reset</button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-[#f0f2ee] pt-2.5">
        {STATUS_ORDER.map((k) => {
          const p = PAL[k];
          const on = filters.status === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setFilter({ status: on ? '' : k })}
              className="flex items-center gap-[7px] rounded-full border py-1 pl-2 pr-2.5"
              style={{ background: on ? p.badgeBg : 'transparent', borderColor: on ? p.swatchBd : '#e3e6e0', color: on ? p.badgeFg : '#414539' }}
            >
              <span className="h-2.5 w-2.5 rounded-[3px] border" style={{ background: p.swatch, borderColor: p.swatchBd }} />
              <span className="text-[12px] font-semibold">{p.label}</span>
              <span className="text-[12px] tabular-nums text-ink-muted">{counts[k]}</span>
            </button>
          );
        })}
        <div className="flex-1" />
        <span className="text-[12px] text-ink-muted">
          {filtering ? `${hitCount} of ${total} slots match — others dimmed` : `${total} slots`}
        </span>
      </div>
    </div>
  );
}

/* ── Batch bar (≥1 selected) ────────────────────────────────────────────── */
function BatchBar({
  count, onReserve, onRelease, onExport, busy, onClear,
}: {
  count: number;
  onReserve: () => void;
  onRelease: () => void;
  onExport: () => void;
  busy: boolean;
  onClear: () => void;
}) {
  const primary = 'h-8 rounded-md px-3.5 text-[12.5px] font-semibold bg-white text-[#0c3f39] disabled:opacity-60';
  const ghost = 'h-8 rounded-md px-3.5 text-[12.5px] font-semibold text-white border border-white/25 bg-white/10 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-45';
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-xl bg-primary-ink p-3">
      <div className="flex items-center gap-2.5 border-r border-white/20 pr-3.5">
        <span className="text-[15px] font-bold tabular-nums text-white">{count}</span>
        <span className="text-[12.5px] text-[#cfe0dc]">slots selected</span>
      </div>
      <button type="button" className={ghost} disabled title="Not available yet — moving stock between slots is coming in a later phase">Move to slot…</button>
      <button type="button" className={primary} onClick={onReserve} disabled={busy}>Mark reserved</button>
      <button type="button" className={ghost} onClick={onRelease} disabled={busy}>Release reserve</button>
      <button type="button" className={ghost} disabled title="Not available yet — bulk stock-out is coming in a later phase">Empty slots</button>
      <button type="button" className={ghost} onClick={onExport}><Download size={13} className="mr-1 inline" strokeWidth={2} />Export</button>
      <div className="flex-1" />
      <button type="button" onClick={onClear} className="h-8 rounded-md px-3 text-[12.5px] font-semibold text-[#cfe0dc] hover:text-white">Clear</button>
    </div>
  );
}

/* ── Floor plan ─────────────────────────────────────────────────────────── */
const HATCH = 'repeating-linear-gradient(135deg,#f7f8f6,#f7f8f6 8px,#eceeea 8px,#eceeea 16px)';

function FloorPlan({
  banks, wide, filtering, hits, pickedSet, onClickSlot, onHover, onHoverEnd,
}: {
  banks: ReturnType<typeof buildBanks>;
  wide: boolean;
  filtering: boolean;
  hits: Set<string>;
  pickedSet: Set<string>;
  onClickSlot: (s: Slot, e: React.MouseEvent) => void;
  onHover: (s: Slot, e: React.MouseEvent) => void;
  onHoverEnd: () => void;
}) {
  return (
    <div className="flex flex-col overflow-x-auto rounded-xl border border-border-subtle bg-surface px-5 pb-5 pt-[18px]">
      <div className="mb-3.5 flex min-w-max items-center gap-2.5 border-b border-dashed border-border-subtle pb-3">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-accent">Floor plan · top view</span>
        <span className="h-px w-20 bg-[#f0f2ee]" />
        <span className="text-[11.5px] text-ink-secondary">click a slot for details · cmd/ctrl-click to multi-select</span>
      </div>

      {/* Dock — north end */}
      <div className="mb-3.5 flex h-9 min-w-max items-center gap-3 rounded-md bg-primary-ink px-3.5">
        <Truck size={13} className="text-white" strokeWidth={2} />
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-white">Main entrance / dock</span>
        <span className="text-[11px] text-[#a9c6c0]">goods in · north end</span>
        <span className="min-w-[40px] flex-1" />
        <ChevronsDown size={14} className="text-[#a9c6c0]" strokeWidth={2} />
      </div>

      {banks.map((bank) => (
        <div key={bank.prefix} className="mb-3.5 flex min-w-max flex-col gap-2">
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-ink-secondary">{bank.label}</span>
            <span className="text-[11.5px] text-ink-muted">{bank.range}</span>
            <span className="text-[11px] tabular-nums text-ink-muted">{bank.used}/{bank.total} used · {bank.utilPct}%</span>
          </div>
          <div className="flex gap-1.5">
            {bank.racks.map((rack) => (
              <div
                key={rack.key}
                className="flex flex-none flex-col gap-0.5 rounded-[7px] border border-border-subtle bg-surface-2 p-1"
                style={{ width: wide ? 164 : 104 }}
              >
                {rack.slots.map((s) => (
                  <SlotCell
                    key={s.id}
                    slot={s}
                    wide={wide}
                    filtering={filtering}
                    hit={hits.has(s.id)}
                    picked={pickedSet.has(s.rack.id)}
                    onClick={onClickSlot}
                    onHover={onHover}
                    onHoverEnd={onHoverEnd}
                  />
                ))}
                <div className="mt-0.5 h-[3px] overflow-hidden rounded-[2px] bg-border-subtle">
                  <div className="h-[3px]" style={{ width: `${rack.utilPct}%`, background: rack.utilPct >= 100 ? '#0c3f39' : '#16695f' }} />
                </div>
                <div className="flex items-center justify-between gap-0.5 px-0.5 pt-px">
                  <span className="text-[11.5px] font-bold text-ink">{rack.name}</span>
                  <span className="font-mono text-[10px] text-ink-secondary">{rack.occupied}/{rack.total}</span>
                </div>
              </div>
            ))}
          </div>
          {bank.aisle && (
            <div className="mt-1 flex h-[34px] items-center gap-3 rounded border-y border-dashed border-[#d3d8cf] px-3.5" style={{ background: HATCH }}>
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-ink-secondary">{bank.aisle.name}</span>
              <span className="text-[11px] text-ink-muted">{bank.aisle.flow}</span>
              <span className="flex-1" />
              <ArrowLeftRight size={13} className="text-[#9aa093]" strokeWidth={2} />
            </div>
          )}
        </div>
      ))}

      {/* Loading bay — south end */}
      <div className="mt-0.5 flex h-9 min-w-max items-center gap-3 rounded-md border border-border bg-accent-soft px-3.5">
        <ChevronsDown size={14} className="text-accent" strokeWidth={2} />
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-accent">Loading bay</span>
        <span className="text-[11px] text-accent-ink">goods out · south end</span>
      </div>
    </div>
  );
}

function SlotCell({
  slot, wide, filtering, hit, picked, onClick, onHover, onHoverEnd,
}: {
  slot: Slot;
  wide: boolean;
  filtering: boolean;
  hit: boolean;
  picked: boolean;
  onClick: (s: Slot, e: React.MouseEvent) => void;
  onHover: (s: Slot, e: React.MouseEvent) => void;
  onHoverEnd: () => void;
}) {
  const p = PAL[slot.status];
  const style: CSSProperties = {
    minHeight: wide ? 44 : 40,
    background: p.bg,
    borderColor: picked ? '#0c3f39' : p.border,
    boxShadow: picked ? '0 0 0 2px #0c3f39' : filtering && hit ? '0 0 0 2px #16695f' : 'none',
    opacity: filtering && !hit ? 0.26 : 1,
    color: p.fg,
  };
  const codeText = slot.status === 'empty' ? 'EMPTY'
    : slot.itemCount === 0 ? 'RESERVED'
      : slot.productLabel || slot.productCode || '—';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => onClick(slot, e)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(slot, e as unknown as React.MouseEvent); } }}
      onMouseEnter={(e) => onHover(slot, e)}
      onMouseMove={(e) => onHover(slot, e)}
      onMouseLeave={onHoverEnd}
      className="flex cursor-pointer flex-col justify-center gap-0.5 overflow-hidden rounded border px-1.5 py-1"
      style={style}
      title={`${slot.id} · ${p.label}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex-none rounded-[3px] px-1 font-mono text-[10px] font-bold" style={{ background: p.levelBg, color: p.levelFg }}>
          {slot.level != null ? `.${slot.level}` : '·'}
        </span>
        <span className="truncate text-[11px] font-bold tracking-[0.02em]">{codeText}</span>
        <span className="flex-1" />
        <span className="h-[9px] w-[9px] flex-none rounded-[3px] border" style={{ background: p.tick, borderColor: p.tickBd }} />
      </div>
      <div className="truncate text-[10.5px] text-ink-secondary">{detailLine(slot)}</div>
    </div>
  );
}

/* ── List view (< 1180px) ───────────────────────────────────────────────── */
function ListView({
  banks, filtering, hits, pickedSet, onClickSlot,
}: {
  banks: ReturnType<typeof buildBanks>;
  filtering: boolean;
  hits: Set<string>;
  pickedSet: Set<string>;
  onClickSlot: (s: Slot, e: React.MouseEvent) => void;
}) {
  const racks = banks.flatMap((b) => b.racks);
  return (
    <div className="flex flex-col gap-2">
      {racks.map((rack) => (
        <div key={rack.key} className="overflow-hidden rounded-[10px] border border-border-subtle bg-surface">
          <div className="flex items-center gap-2.5 border-b border-border-subtle bg-surface-2 px-3 py-2">
            <span className="text-[13px] font-bold text-ink">{rack.name}</span>
            <span className="font-mono text-[10.5px] text-ink-secondary">{rack.occupied}/{rack.total}</span>
            <span className="flex-1" />
            <span className="h-[3px] w-16 overflow-hidden rounded-[2px] bg-border-subtle">
              <span className="block h-[3px]" style={{ width: `${rack.utilPct}%`, background: rack.utilPct >= 100 ? '#0c3f39' : '#16695f' }} />
            </span>
          </div>
          {rack.slots.map((s) => {
            const p = PAL[s.status];
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={(e) => onClickSlot(s, e)}
                onKeyDown={(e) => { if (e.key === 'Enter') onClickSlot(s, e as unknown as React.MouseEvent); }}
                className="flex cursor-pointer items-center gap-2.5 border-t border-[#f0f2ee] px-3 py-2.5"
                style={{ background: p.bg, opacity: filtering && !hits.has(s.id) ? 0.26 : 1, boxShadow: pickedSet.has(s.rack.id) ? 'inset 0 0 0 2px #0c3f39' : undefined }}
              >
                <span className="rounded px-1.5 py-px font-mono text-[10px] font-bold" style={{ background: p.levelBg, color: p.levelFg }}>
                  {s.level != null ? `.${s.level}` : '·'}
                </span>
                <span className="text-[12.5px] font-semibold" style={{ color: p.fg }}>{s.status === 'empty' ? 'Empty' : s.itemCount === 0 ? 'Reserved' : s.productLabel}</span>
                <span className="flex-1" />
                <span className="truncate text-[11.5px] text-ink-muted">{detailLine(s)}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ── Hover preview ──────────────────────────────────────────────────────── */
function HoverCard({ hover }: { hover: { slot: Slot; x: number; y: number } }) {
  const s = hover.slot;
  const p = PAL[s.status];
  const rows: [string, string][] = s.itemCount === 0
    ? [['Status', s.status === 'reserved' ? 'On hold' : 'Available'], ['Rack', `${s.rackName} · level ${s.level ?? '—'}`]]
    : [['Product', s.productLabel], ['Qty', `${s.qty} pcs`], ['Customer', s.customer || '—'], ['In date', s.inDate || '—']];
  return (
    <div
      className="pointer-events-none fixed z-[60] flex min-w-[170px] flex-col gap-1.5 rounded-[9px] bg-ink px-3 py-2.5 text-white"
      style={{ left: hover.x, top: hover.y, boxShadow: '0 12px 28px rgba(17,20,15,0.24)' }}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-bold tracking-[0.06em]">{s.id}</span>
        <span className="rounded-full px-[7px] py-px text-[10px] font-bold" style={{ background: p.badgeBg, color: p.badgeFg }}>{p.label}</span>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-4">
          <span className="text-[10.5px] text-[#9aa093]">{k}</span>
          <span className="truncate text-[11.5px] font-semibold tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Detail drawer body ─────────────────────────────────────────────────── */
const MOVE_TAG: Record<RackMovementType, { label: string; bg: string; fg: string }> = {
  STOCK_IN: { label: 'IN', bg: '#e1efed', fg: '#0c3f39' },
  STOCK_OUT: { label: 'OUT', bg: '#f6efd9', fg: '#6e4d12' },
  TRANSFER: { label: 'MOVE', bg: '#f4f6f3', fg: '#414539' },
};

function SlotDrawerBody({
  slot, warehouseId, onClose, onEdit, onStockInHere, onDelete, deleting,
}: {
  slot: Slot;
  warehouseId: string;
  onClose: () => void;
  onEdit: () => void;
  onStockInHere: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const p = PAL[slot.status];
  const movements = useMovements(warehouseId ? { warehouseId } : undefined);
  const rackMoves = useMemo(
    () => (movements.data ?? []).filter((m) => m.rack_id === slot.rack.id || m.to_rack_id === slot.rack.id).slice(0, 12),
    [movements.data, slot.rack.id],
  );

  const fields: [string, string][] = slot.itemCount === 0
    ? [['Rack / level', `${slot.rackName} · level ${slot.level ?? '—'}`], ['Status', slot.status === 'reserved' ? 'Reserved (on hold)' : 'Available'], ['Capacity', '1 pallet']]
    : slot.itemCount === 1
      ? [['Product', slot.productLabel], ['Customer', slot.customer || '—'], ['Quantity', `${slot.qty} pcs`], ['In date', slot.inDate ? fmtDate(slot.inDate) : '—'], ['Document no', slot.doc || '—'], ['Rack / level', `${slot.rackName} · level ${slot.level ?? '—'}`]]
      : [['Rack / level', `${slot.rackName} · level ${slot.level ?? '—'}`], ['Status', p.label], ['Total qty', `${slot.qty} pcs`]];

  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent">Slot</span>
          <span className="text-[22px] font-bold leading-none tracking-tight text-ink">{slot.id}</span>
          <span className="inline-flex w-fit items-center rounded-full px-2.5 py-[3px] text-[11px] font-bold" style={{ background: p.badgeBg, color: p.badgeFg }}>{p.label}</span>
        </div>
        <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md border border-border-subtle text-ink-muted hover:bg-surface-2"><X size={14} /></button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-3.5">
          {fields.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-muted">{label}</span>
              <span className="text-[14px] font-semibold tabular-nums text-ink">{value}</span>
            </div>
          ))}
        </div>

        {slot.itemCount > 1 && (
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-muted">Contents ({slot.itemCount})</span>
            {slot.items.map((it) => (
              <div key={it.id} className="flex flex-col gap-0.5 rounded-md border border-border-subtle bg-surface-2 p-2.5">
                <span className="text-[12.5px] font-semibold text-ink">{itemDescription(it)}</span>
                {itemMeta(it) && <span className="text-[11.5px] text-ink-muted">{itemMeta(it)}</span>}
                {(it.qty ?? 1) > 1 && <span className="text-[11.5px] text-ink-muted">Qty: {fmtQty(it.qty)}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="h-px bg-border-subtle" />
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-muted">Recent movements</span>
          {movements.isLoading ? (
            <span className="text-[12px] text-ink-muted">Loading history…</span>
          ) : rackMoves.length === 0 ? (
            <span className="text-[12px] text-ink-muted">No movements recorded for this slot.</span>
          ) : (
            rackMoves.map((m) => {
              const tag = MOVE_TAG[m.movement_type];
              return (
                <div key={m.id} className="flex items-center gap-2.5 rounded-md bg-surface-2 px-2.5 py-2">
                  <span className="rounded-full px-[7px] py-0.5 font-mono text-[10px] font-bold" style={{ background: tag.bg, color: tag.fg }}>{tag.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{[m.product_name || m.item_code, m.source_doc_no].filter(Boolean).join(' · ') || `Qty ${fmtQty(m.quantity)}`}</span>
                  <span className="text-[11.5px] tabular-nums text-ink-muted">{fmtDate(m.created_at)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-5 py-3.5">
        <Button variant="primary" className="flex-1" onClick={onStockInHere}>
          <ArrowDownToLine size={14} strokeWidth={1.75} />
          <span>{slot.status === 'empty' ? 'Put away here' : 'Pick from slot'}</span>
        </Button>
        <Button variant="secondary" icon={<Pencil size={14} />} onClick={onEdit}>Edit</Button>
        {slot.itemCount === 0 && (
          <Button variant="ghost" icon={<Trash2 size={14} />} onClick={onDelete} disabled={deleting}>Delete</Button>
        )}
      </div>
    </>
  );
}

function PlaceholderPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-8 text-center text-[13px] text-ink-muted">
      {children}
    </div>
  );
}
