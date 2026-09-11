// ----------------------------------------------------------------------------
// WarehouseRacks — desktop Warehouse (Rack/REC) experience.
//
// Phase 1 of porting the owner's HOOKKA warehouse module into Houzs. Started
// life as a plain DataGrid of racks (the create surface the GRN per-line Rack
// picker was missing); this is the rich three-tab experience that mirrors the
// HOOKKA desktop Warehouse page, restyled to Houzs scm-v2 (Ink & Petrol tokens),
// and adapted for a RETAILER — there is no production-order / packing / piece-QR
// layer here (Houzs stocks in against product codes + documents).
//
//   Tab 1 · Rack Overview   — KPI tiles, warehouse selector, legend, a visual
//                             grid of colour-coded rack cards (occupied / empty
//                             / reserved), client-side search across every
//                             item's doc no / customer / product, and a rack
//                             detail popup. Keeps New rack + Seed racks.
//   Tab 2 · Stock In / Out  — stock-in form (rack + product code + qty + …) and
//                             stock-out form (occupied rack → item → reason),
//                             plus a recent-movements table.
//   Tab 3 · Movement History — type / from / to filters over the ledger.
//
// URL is state: ?warehouseId=… and ?tab=… (shareable / reload-stable).
//
// DEFERRED to a later phase (NOT built here): rack-QR / item-QR generation +
// download-all, and the public camera-scan stock-in flow.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ChevronDown, Plus, Layers,
  ArrowDownToLine, ArrowUpFromLine, History,
} from 'lucide-react';
import { Button } from '../../components/Button';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { fmtDate, fmtQty } from '@2990s/shared';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import {
  useRacks,
  useCreateRack,
  useUpdateRack,
  useStockIn,
  useStockOut,
  useMovements,
  type Rack,
  type RackMovement,
  type RackMovementType,
} from '../../vendor/scm/lib/warehouse-queries';
import { itemDescription, itemMeta } from '../../vendor/scm/lib/warehouse-floorplan';
import { WarehouseFloorPlan } from './WarehouseFloorPlan';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { buildSeedRackLabels, MAX_SEED_RACKS } from '../../vendor/shared/rack-labels';
import styles from './WarehouseRacks.module.css';
import formStyles from './Suppliers.module.css';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* Breakpoint from the design handoff: at/above it the floor plan always shows;
   below it the operator gets a Floor plan / List switch. */
const WIDE_BP = 1180;

type TabKey = 'overview' | 'stockio' | 'history';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Rack Overview' },
  { key: 'stockio', label: 'Stock In/Out' },
  { key: 'history', label: 'Movement History' },
];

/* The collapsed header stat strip — value colour per the design token table. */
const STAT_INK: Record<'ink' | 'primary' | 'warn' | 'primaryInk', string> = {
  ink: '#11140f', primary: '#16695f', warn: '#6e4d12', primaryInk: '#0c3f39',
};

/* ── Rack scope (shared across warehouses) ────────────────────────────────
   A rack can be created into just this warehouse, ALL warehouses, or a chosen
   set. The backend fans the label out to one rack row per target warehouse, so
   split warehouse records that share rack numbers (Display / KL goods / …) can
   be provisioned in one action. */
type ScopeMode = 'this' | 'all' | 'choose';

type WarehouseLite = { id: string; code: string; name: string };

/* Translate the picker state into the create-body scope keys. */
function scopeBody(
  mode: ScopeMode, currentWarehouseId: string, chosen: string[],
): { warehouseId: string } | { warehouseIds: string[] } | { allWarehouses: true } {
  if (mode === 'all') return { allWarehouses: true };
  if (mode === 'choose') {
    // Always include the current warehouse so "choose" never ships an empty set.
    const set = new Set(chosen.length > 0 ? chosen : [currentWarehouseId]);
    set.add(currentWarehouseId);
    return { warehouseIds: [...set] };
  }
  return { warehouseId: currentWarehouseId };
}

function RackScopeField({
  warehouses, currentWarehouseId, mode, setMode, chosen, setChosen,
}: {
  warehouses: WarehouseLite[];
  currentWarehouseId: string;
  mode: ScopeMode;
  setMode: (m: ScopeMode) => void;
  chosen: string[];
  setChosen: (ids: string[]) => void;
}) {
  const toggle = (id: string) => {
    setChosen(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  };
  const others = warehouses.filter((w) => w.id !== currentWarehouseId);
  return (
    <label className={formStyles.field}>
      <span className={formStyles.fieldLabel}>Apply to</span>
      <span className={styles.selectWrap} style={{ minWidth: 0 }}>
        <select className={styles.fieldSelect} value={mode} onChange={(e) => setMode(e.target.value as ScopeMode)}>
          <option value="this">This warehouse only</option>
          <option value="all">All warehouses</option>
          <option value="choose">Choose warehouses…</option>
        </select>
        <ChevronDown className={styles.selectChevron} size={14} strokeWidth={1.75} />
      </span>
      {mode === 'choose' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, maxHeight: 200, overflowY: 'auto' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, opacity: 0.7 }}>
            <input type="checkbox" checked readOnly />
            <span>
              {warehouses.find((w) => w.id === currentWarehouseId)?.code ?? 'This'} — current (always included)
            </span>
          </label>
          {others.map((w) => (
            <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={chosen.includes(w.id)} onChange={() => toggle(w.id)} />
              <span>{w.code}</span>
            </label>
          ))}
        </div>
      )}
    </label>
  );
}

export const WarehouseRacks = () => {
  const [params, setParams] = useSearchParams();
  const warehouses = useWarehouses();
  const warehouseId = params.get('warehouseId') ?? '';
  const tab = (params.get('tab') as TabKey) || 'overview';

  // Default to the first warehouse once the list loads (keeps the URL as state).
  useEffect(() => {
    if (!warehouseId && (warehouses.data?.length ?? 0) > 0) {
      const first = warehouses.data![0];
      const p = new URLSearchParams(params);
      p.set('warehouseId', first.id);
      setParams(p, { replace: true });
    }
  }, [warehouseId, warehouses.data, params, setParams]);

  const selectWarehouse = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('warehouseId', id);
    setParams(p, { replace: true });
  };
  const selectTab = (key: TabKey) => {
    const p = new URLSearchParams(params);
    p.set('tab', key);
    setParams(p, { replace: true });
  };

  // Narrow-screen view is URL state ('plan' is the default, so it stays out of
  // the URL); the switch only appears below the design breakpoint.
  const view: 'plan' | 'list' = params.get('view') === 'list' ? 'list' : 'plan';
  const selectView = (v: 'plan' | 'list') => {
    const p = new URLSearchParams(params);
    if (v === 'plan') p.delete('view'); else p.set('view', v);
    setParams(p, { replace: true });
  };
  const [wide, setWide] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= WIDE_BP : true));
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= WIDE_BP);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const racks = useRacks(warehouseId ? { warehouseId } : undefined);
  const rackList = useMemo(() => racks.data?.racks ?? [], [racks.data]);
  const summary = racks.data?.summary ?? { total: 0, occupied: 0, empty: 0, reserved: 0, occupancyRate: 0 };

  const [editing, setEditing] = useState<Rack | null>(null);
  // Which create surface is open: the single-rack drawer, the seed modal, or none.
  const [creatingMode, setCreatingMode] = useState<'single' | 'seed' | null>(null);
  // Preselect a rack when jumping from the detail popup into the stock-in form.
  const [stockInRackId, setStockInRackId] = useState<string>('');

  return (
    <div>
      <PageHeader back
        eyebrow="Inventory"
        title="Warehouse"
        description="Rack overview, stock in / out and the full movement ledger for the selected warehouse."
        actions={
          /* Right column of the header: action row on top, the collapsed stat
             strip below (was a five-tile grid that pushed the plan down). All
             three actions stay inline Buttons/Link rather than
             `secondaryActions`: MenuItem has no `disabled`, and Seed racks / New
             rack must keep their `disabled={!warehouseId}` guard. */
          <div className="flex flex-col items-end gap-3">
            <div className="flex items-stretch gap-2">
              <Link
                to="/scm/warehouses"
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary"
              >
                <ArrowLeft size={14} /> Warehouses
              </Link>
              <Button
                variant="secondary"
                icon={<Layers size={14} />}
                onClick={() => { setEditing(null); setCreatingMode('seed'); }}
                disabled={!warehouseId}
              >
                Seed racks
              </Button>
              <Button
                variant="primary"
                icon={<Plus size={14} />}
                onClick={() => { setEditing(null); setCreatingMode('single'); }}
                disabled={!warehouseId}
              >
                New rack
              </Button>
            </div>
            <HeaderStatStrip summary={summary} />
          </div>
        }
      />

      <div className="space-y-4">
        {/* Warehouse selector — Houzs racks are per-warehouse, so it's required.
            Styled as the design's picker pill; stays a native select. */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface py-1.5 pl-3 pr-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">WH</span>
            <span className="relative inline-flex items-center">
              <select
                className="appearance-none border-none bg-transparent pr-5 text-[13px] font-semibold text-ink outline-none"
                value={warehouseId}
                onChange={(e) => selectWarehouse(e.target.value)}
                aria-label="Warehouse"
              >
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-0 text-ink-muted" size={12} strokeWidth={2} />
            </span>
          </span>
        </div>

        {/* Tabs + narrow-screen Floor plan / List switch */}
        <div className="flex flex-wrap items-center gap-3">
          <nav
            className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-surface p-1 shadow-stone"
            aria-label="Warehouse views"
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                data-active={tab === t.key}
                onClick={() => selectTab(t.key)}
                className={
                  tab === t.key
                    ? 'whitespace-nowrap rounded bg-primary px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white transition-all duration-150'
                    : 'whitespace-nowrap rounded px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-all duration-150 hover:bg-primary-soft hover:text-primary'
                }
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex-1" />
          {tab === 'overview' && !wide && (
            <div className="flex items-center rounded-md border border-border-subtle bg-surface p-[3px]">
              {(['plan', 'list'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => selectView(v)}
                  className="rounded-[6px] px-3 py-[5px] text-[11.5px] font-semibold transition-colors"
                  style={view === v ? { background: '#16695f', color: '#ffffff' } : { color: '#767b6e' }}
                >
                  {v === 'plan' ? 'Floor plan' : 'List'}
                </button>
              ))}
            </div>
          )}
        </div>

        {tab === 'overview' && (
          <WarehouseFloorPlan
            racks={rackList}
            warehouseId={warehouseId}
            isLoading={racks.isLoading}
            wide={wide}
            view={view}
            onEditRack={(r) => { setEditing(r); setCreatingMode(null); }}
            onStockInHere={(rackId) => { setStockInRackId(rackId); selectTab('stockio'); }}
          />
        )}

        {tab === 'stockio' && (
          <StockIoTab
            racks={rackList}
            warehouseId={warehouseId}
            initialRackId={stockInRackId}
            onConsumeInitialRack={() => setStockInRackId('')}
          />
        )}

        {tab === 'history' && (
          <HistoryTab warehouseId={warehouseId} />
        )}
      </div>

      {(creatingMode === 'single' || editing) && warehouseId && (
        <RackFormDrawer
          warehouseId={warehouseId}
          warehouses={warehouses.data ?? []}
          editing={editing}
          onClose={() => { setCreatingMode(null); setEditing(null); }}
        />
      )}

      {creatingMode === 'seed' && warehouseId && (
        <SeedRacksModal
          warehouseId={warehouseId}
          warehouses={warehouses.data ?? []}
          onClose={() => setCreatingMode(null)}
        />
      )}
    </div>
  );
};

/* Collapsed header stat strip — five compact cells replacing the old five-tile
   grid, so the floor plan starts higher. Value colours per the design table:
   occupied petrol, reserved brass-ink, occupancy dark petrol. */
function HeaderStatStrip({
  summary,
}: {
  summary: { total: number; occupied: number; empty: number; reserved: number; occupancyRate: number };
}) {
  const cells: { label: string; value: string; color: string }[] = [
    { label: 'Total slots', value: String(summary.total), color: STAT_INK.ink },
    { label: 'Occupied', value: String(summary.occupied), color: STAT_INK.primary },
    { label: 'Empty', value: String(summary.empty), color: STAT_INK.ink },
    { label: 'Reserved', value: String(summary.reserved), color: STAT_INK.warn },
    { label: 'Occupancy', value: `${summary.occupancyRate}%`, color: STAT_INK.primaryInk },
  ];
  return (
    <div className="flex flex-wrap items-stretch overflow-hidden rounded-[10px] border border-border-subtle bg-surface">
      {cells.map((c, i) => (
        <div key={c.label} className={`flex min-w-[84px] flex-col gap-0.5 px-[18px] py-2 ${i > 0 ? 'border-l border-[#eceeea]' : ''}`}>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{c.label}</span>
          <span className="text-[19px] font-bold leading-tight tabular-nums" style={{ color: c.color }}>{c.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Tab 2 — Stock In / Out.
   ════════════════════════════════════════════════════════════════════════ */
function StockIoTab({
  racks, warehouseId, initialRackId, onConsumeInitialRack,
}: {
  racks: Rack[];
  warehouseId: string;
  initialRackId: string;
  onConsumeInitialRack: () => void;
}) {
  const notify = useNotify();
  const stockIn = useStockIn();
  const stockOut = useStockOut();
  const recent = useMovements(warehouseId ? { warehouseId } : undefined);

  // Stock-in form.
  const [siRack, setSiRack] = useState('');
  const [siCode, setSiCode] = useState('');
  const [siName, setSiName] = useState('');
  const [siCustomer, setSiCustomer] = useState('');
  const [siDoc, setSiDoc] = useState('');
  const [siQty, setSiQty] = useState(1);
  const [siNotes, setSiNotes] = useState('');

  // Preselect the rack when the operator jumped here from the detail popup.
  useEffect(() => {
    if (initialRackId) {
      setSiRack(initialRackId);
      onConsumeInitialRack();
    }
  }, [initialRackId, onConsumeInitialRack]);

  // Stock-out form.
  const [soRack, setSoRack] = useState('');
  const [soItem, setSoItem] = useState('');
  const [soReason, setSoReason] = useState('');

  const occupiedRacks = useMemo(() => racks.filter((r) => (r.items?.length ?? 0) > 0), [racks]);
  const soRackObj = occupiedRacks.find((r) => r.id === soRack) ?? null;
  const soItemObj = soRackObj?.items.find((it) => it.id === soItem) ?? null;

  const submitStockIn = () => {
    if (!siRack) { notify({ title: 'Pick a rack to stock into.', tone: 'error' }); return; }
    if (!siCode.trim()) { notify({ title: 'A product code is required.', tone: 'error' }); return; }
    stockIn.mutate(
      {
        rackId: siRack,
        itemCode: siCode.trim(),
        productName: siName.trim() || undefined,
        customerName: siCustomer.trim() || undefined,
        sourceDocNo: siDoc.trim() || undefined,
        qty: Math.max(1, Math.floor(Number(siQty) || 1)),
        notes: siNotes.trim() || undefined,
      },
      {
        onSuccess: () => {
          notify({ title: 'Stocked in.' });
          setSiCode(''); setSiName(''); setSiCustomer(''); setSiDoc(''); setSiQty(1); setSiNotes('');
        },
        onError: (e) => notify({ title: 'Stock in failed', body: (e as Error).message, tone: 'error' }),
      },
    );
  };

  const submitStockOut = () => {
    if (!soItem) { notify({ title: 'Pick the item to remove.', tone: 'error' }); return; }
    if (!soReason.trim()) { notify({ title: 'A reason is required.', tone: 'error' }); return; }
    stockOut.mutate(
      { itemId: soItem, reason: soReason.trim() },
      {
        onSuccess: () => {
          notify({ title: 'Stocked out.' });
          setSoRack(''); setSoItem(''); setSoReason('');
        },
        onError: (e) => notify({ title: 'Stock out failed', body: (e as Error).message, tone: 'error' }),
      },
    );
  };

  if (!warehouseId) {
    return <div className={styles.emptyRow}>Select a warehouse first.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className={styles.stockGrid}>
        {/* Stock In */}
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}><ArrowDownToLine {...ICON} /> Stock In</h3>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Rack *</span>
            <span className={styles.selectWrap} style={{ minWidth: 0 }}>
              <select className={styles.fieldSelect} value={siRack} onChange={(e) => setSiRack(e.target.value)}>
                <option value="">Select rack…</option>
                {racks.filter((r) => r.status !== 'RESERVED').map((r) => (
                  <option key={r.id} value={r.id}>{r.rack} ({r.items?.length ?? 0} item{(r.items?.length ?? 0) === 1 ? '' : 's'})</option>
                ))}
              </select>
              <ChevronDown className={styles.selectChevron} size={14} strokeWidth={1.75} />
            </span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Product code *</span>
            <input className={styles.fieldInput} value={siCode} placeholder="e.g. BF-1013-KING"
              onChange={(e) => setSiCode(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Product name</span>
            <input className={styles.fieldInput} value={siName} placeholder="Optional description"
              onChange={(e) => setSiName(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Customer</span>
            <input className={styles.fieldInput} value={siCustomer} placeholder="Optional"
              onChange={(e) => setSiCustomer(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Document no (SO / DO)</span>
            <input className={styles.fieldInput} value={siDoc} placeholder="Optional e.g. SO-2607-062"
              onChange={(e) => setSiDoc(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Quantity</span>
            <input className={styles.fieldInput} type="number" min={1} value={siQty}
              onChange={(e) => setSiQty(Number(e.target.value))} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Notes</span>
            <textarea className={styles.fieldTextarea} value={siNotes}
              onChange={(e) => setSiNotes(e.target.value)} />
          </label>
          <Button variant="primary" className="w-full" disabled={stockIn.isPending} onClick={submitStockIn}>
            <ArrowDownToLine {...ICON} /><span>{stockIn.isPending ? 'Saving…' : 'Confirm Stock In'}</span>
          </Button>
        </div>

        {/* Stock Out */}
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}><ArrowUpFromLine {...ICON} /> Stock Out</h3>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Occupied rack *</span>
            <span className={styles.selectWrap} style={{ minWidth: 0 }}>
              <select className={styles.fieldSelect} value={soRack}
                onChange={(e) => { setSoRack(e.target.value); setSoItem(''); }}>
                <option value="">Select an occupied rack…</option>
                {occupiedRacks.map((r) => (
                  <option key={r.id} value={r.id}>{r.rack} ({r.items.length} item{r.items.length === 1 ? '' : 's'})</option>
                ))}
              </select>
              <ChevronDown className={styles.selectChevron} size={14} strokeWidth={1.75} />
            </span>
          </label>
          {soRackObj && soRackObj.items.length > 0 && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Item to remove *</span>
              <span className={styles.selectWrap} style={{ minWidth: 0 }}>
                <select className={styles.fieldSelect} value={soItem} onChange={(e) => setSoItem(e.target.value)}>
                  <option value="">Select item…</option>
                  {soRackObj.items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {itemDescription(it)}{itemMeta(it) ? ` (${itemMeta(it)})` : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown className={styles.selectChevron} size={14} strokeWidth={1.75} />
              </span>
            </label>
          )}
          {soItemObj && (
            <div className={styles.previewBox}>
              <strong>Item to be released</strong>
              <span>Rack: {soRackObj?.rack}</span>
              <span>Product: {itemDescription(soItemObj)}</span>
              {soItemObj.customer_name && <span>Customer: {soItemObj.customer_name}</span>}
              {soItemObj.source_doc_no && <span>Document: {soItemObj.source_doc_no}</span>}
            </div>
          )}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Reason *</span>
            <input className={styles.fieldInput} value={soReason}
              placeholder="e.g. Delivered to customer, Transferred, Damaged…"
              onChange={(e) => setSoReason(e.target.value)} />
          </label>
          <Button variant="secondary" className="w-full" disabled={stockOut.isPending} onClick={submitStockOut}>
            <ArrowUpFromLine {...ICON} /><span>{stockOut.isPending ? 'Saving…' : 'Confirm Stock Out'}</span>
          </Button>
        </div>
      </div>

      {/* Recent movements */}
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}><History {...ICON} /> Recent Movements</h3>
        <MovementTable movements={(recent.data ?? []).slice(0, 20)} isLoading={recent.isLoading} />
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Tab 3 — Movement History with type / from / to filters.
   ════════════════════════════════════════════════════════════════════════ */
function HistoryTab({ warehouseId }: { warehouseId: string }) {
  const [type, setType] = useState<RackMovementType | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const movements = useMovements(
    warehouseId ? { warehouseId, type: type || undefined, from: from || undefined, to: to || undefined } : undefined,
  );

  if (!warehouseId) {
    return <div className={styles.emptyRow}>Select a warehouse first.</div>;
  }

  return (
    <div className={styles.panel}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <h3 className={styles.panelTitle}><History {...ICON} /> Full Movement History</h3>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={styles.selectWrap} style={{ minWidth: 150 }}>
            <select className={styles.fieldSelect} value={type} onChange={(e) => setType(e.target.value as RackMovementType | '')}>
              <option value="">All types</option>
              <option value="STOCK_IN">Stock In</option>
              <option value="STOCK_OUT">Stock Out</option>
              <option value="TRANSFER">Transfer</option>
            </select>
            <ChevronDown className={styles.selectChevron} size={14} strokeWidth={1.75} />
          </span>
          <DateField fullWidth className={styles.fieldInput} style={{ width: 150 }} value={from} onChange={(iso) => setFrom(iso)}/>
          <DateField fullWidth className={styles.fieldInput} style={{ width: 150 }} value={to} onChange={(iso) => setTo(iso)}/>
          {(type || from || to) && (
            <Button variant="ghost" onClick={() => { setType(''); setFrom(''); setTo(''); }}>Clear</Button>
          )}
        </div>
      </div>
      <MovementTable movements={movements.data ?? []} isLoading={movements.isLoading} />
    </div>
  );
}

/* ── Shared movement table + pill ──────────────────────────────────────── */
function MovementPill({ type }: { type: RackMovementType }) {
  const cls = type === 'STOCK_IN' ? styles.movementIn : type === 'STOCK_OUT' ? styles.movementOut : styles.movementTransfer;
  const label = type === 'STOCK_IN' ? 'IN' : type === 'STOCK_OUT' ? 'OUT' : 'TRANSFER';
  return <span className={`${styles.movementPill} ${cls}`}>{label}</span>;
}

/* Batch 4: the shared movement ledger renders through DataTable — one
   conversion covers both consumers (Stock In/Out's recent list + the full
   Movement History tab). Server order (newest first) is the default; the
   date column's getValue keeps re-sorts honest. */
function MovementTable({ movements, isLoading }: { movements: RackMovement[]; isLoading: boolean }) {
  return (
    <DataTable<RackMovement>
      tableId="warehouse-racks-movements"
      layoutFamily="warehouse-racks-movements"
      exportName="rack-movements"
      rows={isLoading ? null : movements}
      loading={isLoading}
      emptyLabel="No movements found."
      getRowKey={(m) => m.id}
      columns={[
        { key: 'date', label: 'Date', width: '120px', getValue: (m) => m.created_at ?? '', render: (m) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDate(m.created_at)}</span> },
        { key: 'type', label: 'Type', width: '110px', getValue: (m) => m.movement_type, render: (m) => <MovementPill type={m.movement_type} /> },
        {
          key: 'rack', label: 'Rack', width: '140px',
          getValue: (m) => `${m.rack_label ?? ''}${m.to_rack_label ?? ''}`,
          render: (m) => (
            <span style={{ whiteSpace: 'nowrap' }}>
              {m.rack_label ?? '—'}
              {m.movement_type === 'TRANSFER' && m.to_rack_label ? ` → ${m.to_rack_label}` : ''}
            </span>
          ),
        },
        { key: 'doc', label: 'Document', width: '140px', getValue: (m) => m.source_doc_no ?? '', render: (m) => m.source_doc_no ? <span className={styles.codeChip}>{m.source_doc_no}</span> : '—' },
        { key: 'product', label: 'Product', getValue: (m) => m.product_name || m.item_code || '', render: (m) => m.product_name || m.item_code || '—' },
        { key: 'qty', label: 'Qty', align: 'right', width: '90px', getValue: (m) => m.quantity, render: (m) => fmtQty(m.quantity) },
        { key: 'reason', label: 'Reason', getValue: (m) => m.reason ?? '', render: (m) => m.reason ?? '—' },
      ] satisfies Column<RackMovement>[]}
    />
  );
}

/* ── Single-rack create / edit drawer — mirrors the mobile "Rack" form ──── */
function RackFormDrawer({
  warehouseId, warehouses, editing, onClose,
}: {
  warehouseId: string;
  warehouses: WarehouseLite[];
  editing: Rack | null;
  onClose: () => void;
}) {
  const create = useCreateRack();
  const update = useUpdateRack();
  const notify = useNotify();
  const [form, setForm] = useState({
    rack: editing?.rack ?? '',
    position: editing?.position ?? '',
    notes: editing?.notes ?? '',
    reserved: editing?.reserved ?? false,
  });
  // Scope — create only. Editing touches a single warehouse's rack row.
  const [scopeMode, setScopeMode] = useState<ScopeMode>('this');
  const [scopeChosen, setScopeChosen] = useState<string[]>([]);

  const submit = () => {
    if (!form.rack.trim()) {
      notify({ title: 'A rack label is required.', tone: 'error' });
      return;
    }
    const onError = (e: unknown) => notify({ title: 'Could not save rack', body: (e as Error).message, tone: 'error' });
    if (editing) {
      update.mutate(
        { id: editing.id, rack: form.rack.trim(), position: form.position, notes: form.notes, reserved: form.reserved },
        { onSuccess: onClose, onError },
      );
    } else {
      create.mutate(
        {
          ...scopeBody(scopeMode, warehouseId, scopeChosen),
          rack: form.rack.trim(),
          position: form.position || undefined,
          notes: form.notes || undefined,
          reserved: form.reserved,
        },
        {
          onSuccess: () => {
            if (scopeMode !== 'this') {
              notify({ title: scopeMode === 'all' ? 'Rack created in all warehouses.' : 'Rack created in the chosen warehouses.' });
            }
            onClose();
          },
          onError,
        },
      );
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <div className={formStyles.backdrop} onClick={onClose}>
      <div className={formStyles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={formStyles.drawerHeader}>
          <h2 className={formStyles.drawerTitle}>{editing ? 'Edit Rack' : 'New Rack'}</h2>
          <button type="button" onClick={onClose} className={formStyles.codeChip}>Close</button>
        </div>
        <div className={formStyles.drawerBody}>
          <label className={formStyles.field}>
            <span className={formStyles.fieldLabel}>Rack Label *</span>
            <input className={formStyles.fieldInput} value={form.rack} placeholder="e.g. Rack A1"
              onChange={(e) => setForm((s) => ({ ...s, rack: e.target.value }))} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.fieldLabel}>Position</span>
            <input className={formStyles.fieldInput} value={form.position ?? ''} placeholder="Aisle / bay / level"
              onChange={(e) => setForm((s) => ({ ...s, position: e.target.value }))} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.fieldLabel}>Notes</span>
            <textarea className={formStyles.fieldTextarea} value={form.notes ?? ''}
              onChange={(e) => setForm((s) => ({ ...s, notes: e.target.value }))} />
          </label>
          <label className={formStyles.fieldRow}>
            <input type="checkbox" checked={form.reserved}
              onChange={(e) => setForm((s) => ({ ...s, reserved: e.target.checked }))} />
            <span className={formStyles.fieldLabel} style={{ textTransform: 'none' }}>Reserve this rack (hold empty)</span>
          </label>
          {!editing && (
            <RackScopeField
              warehouses={warehouses}
              currentWarehouseId={warehouseId}
              mode={scopeMode}
              setMode={setScopeMode}
              chosen={scopeChosen}
              setChosen={setScopeChosen}
            />
          )}
        </div>
        <div className={formStyles.drawerFooter}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Seed N racks quick-add (desktop-only) — POST { warehouseId, count, prefix } */
function SeedRacksModal({
  warehouseId, warehouses, onClose,
}: {
  warehouseId: string;
  warehouses: WarehouseLite[];
  onClose: () => void;
}) {
  const create = useCreateRack();
  const notify = useNotify();
  const [prefix, setPrefix] = useState('Rack');
  const [series, setSeries] = useState('');
  const [count, setCount] = useState(10);
  const [levels, setLevels] = useState(1);
  const [scopeMode, setScopeMode] = useState<ScopeMode>('this');
  const [scopeChosen, setScopeChosen] = useState<string[]>([]);

  /* The labels the server WILL write, from the shared generator — the preview
     must not be a second guess at the rule (shared/rack-labels.ts). */
  const preview = buildSeedRackLabels({
    prefix: prefix.trim() || 'Rack', series, count: Number(count), levels: Number(levels),
  });

  const submit = () => {
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n < 1) {
      notify({ title: `Enter how many racks to create (1–${MAX_SEED_RACKS}).`, tone: 'error' });
      return;
    }
    create.mutate(
      {
        ...scopeBody(scopeMode, warehouseId, scopeChosen),
        count: n,
        prefix: prefix.trim() || 'Rack',
        series: series.trim(),
        levels: Math.max(1, Math.floor(Number(levels)) || 1),
      },
      {
        onSuccess: (res) => {
          const made = res.created ?? res.racks?.length ?? 0;
          notify({ title: made > 0 ? `Created ${made} rack${made === 1 ? '' : 's'}.` : 'No new racks — those labels already exist.' });
          onClose();
        },
        onError: (e) => notify({ title: 'Could not seed racks', body: (e as Error).message, tone: 'error' }),
      },
    );
  };

  return (
    <div className={formStyles.backdrop} onClick={onClose}>
      <div className={formStyles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={formStyles.drawerHeader}>
          <h2 className={formStyles.drawerTitle}>Seed Racks</h2>
          <button type="button" onClick={onClose} className={formStyles.codeChip}>Close</button>
        </div>
        <div className={formStyles.modalBody}>
          <p className={formStyles.subtitle} style={{ margin: 0 }}>
            {preview.length > 0
              ? <>Creates {preview.length} rack{preview.length === 1 ? '' : 's'}: <strong>{preview[0]}</strong>
                  {preview.length > 1 && <> … <strong>{preview[preview.length - 1]}</strong></>}.</>
              : <>Enter how many racks to create.</>}
            {' '}Labels that already exist are skipped. Max {MAX_SEED_RACKS} at a time.
          </p>
          <label className={formStyles.field}>
            <span className={formStyles.fieldLabel}>Prefix</span>
            <input className={formStyles.fieldInput} value={prefix} placeholder="Rack"
              onChange={(e) => setPrefix(e.target.value)} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.fieldLabel}>Series (optional)</span>
            <input className={formStyles.fieldInput} value={series} placeholder="e.g. L or R — leave blank for plain numbers"
              onChange={(e) => setSeries(e.target.value)} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.fieldLabel}>How many {Number(levels) > 1 ? 'aisles' : 'racks'}</span>
            <input className={formStyles.fieldInput} type="number" min={1} max={MAX_SEED_RACKS} value={count}
              onChange={(e) => setCount(Number(e.target.value))} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.fieldLabel}>Levels per aisle</span>
            <input className={formStyles.fieldInput} type="number" min={1} max={20} value={levels}
              onChange={(e) => setLevels(Number(e.target.value))} />
          </label>
          <RackScopeField
            warehouses={warehouses}
            currentWarehouseId={warehouseId}
            mode={scopeMode}
            setMode={setScopeMode}
            chosen={scopeChosen}
            setChosen={setScopeChosen}
          />
        </div>
        <div className={formStyles.drawerFooter}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create racks'}
          </Button>
        </div>
      </div>
    </div>
  );
}
