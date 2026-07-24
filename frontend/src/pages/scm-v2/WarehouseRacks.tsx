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
  ArrowLeft, ChevronDown, Plus, Layers, Search, X,
  ArrowDownToLine, ArrowUpFromLine, History,
} from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import { fmtDate, fmtQty } from '@2990s/shared';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import {
  useRacks,
  useCreateRack,
  useUpdateRack,
  useDeleteRack,
  useStockIn,
  useStockOut,
  useMovements,
  type Rack,
  type RackItem,
  type RackStatus,
  type RackMovement,
  type RackMovementType,
} from '../../vendor/scm/lib/warehouse-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import styles from './WarehouseRacks.module.css';
import formStyles from './Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<RackStatus, string> = {
  OCCUPIED: 'Occupied',
  RESERVED: 'Reserved',
  EMPTY: 'Empty',
};

type TabKey = 'overview' | 'stockio' | 'history';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Rack Overview' },
  { key: 'stockio', label: 'Stock In/Out' },
  { key: 'history', label: 'Movement History' },
];

/* One clear description line for a rack item — never empty. */
const itemDescription = (it: RackItem): string => {
  const name = (it.product_name || it.product_code || '').trim();
  const size = (it.size_label || '').trim();
  return (size && !name.includes(size) ? `${name} ${size}`.trim() : name) || 'Item';
};

/* customer · doc, whichever are present. */
const itemMeta = (it: RackItem): string =>
  [it.customer_name || '', it.source_doc_no || ''].filter(Boolean).join(' · ');

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
        primaryAction={
          /* All three stay inline Buttons/Link rather than `secondaryActions`:
             MenuItem has no `disabled`, and Seed racks / New rack must keep
             their `disabled={!warehouseId}` guard. */
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
        }
      />

      <div className="space-y-4">
        {/* Warehouse selector — Houzs racks are per-warehouse, so it's required. */}
        <div className="flex flex-wrap items-center gap-3">
          <span className={styles.eyebrow}>Warehouse</span>
          <span className={styles.selectWrap}>
            <select
              className={styles.fieldSelect}
              value={warehouseId}
              onChange={(e) => selectWarehouse(e.target.value)}
            >
              {(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.code}</option>
              ))}
            </select>
            <ChevronDown className={styles.selectChevron} size={14} strokeWidth={1.75} />
          </span>
        </div>

        {/* KPI tiles */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Total Slots" value={String(summary.total)} />
          <StatCard label="Occupied" value={String(summary.occupied)} />
          <StatCard label="Empty" value={String(summary.empty)} />
          <StatCard label="Reserved" value={String(summary.reserved)} />
          <StatCard label="Occupancy" value={`${summary.occupancyRate}%`} />
        </div>

        {/* Tabs */}
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

        {tab === 'overview' && (
          <OverviewTab
            racks={rackList}
            warehouseId={warehouseId}
            isLoading={racks.isLoading}
            summary={summary}
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

/* ════════════════════════════════════════════════════════════════════════
   Tab 1 — Rack Overview: legend + search + visual rack grid + detail popup.
   ════════════════════════════════════════════════════════════════════════ */
function OverviewTab({
  racks, warehouseId, isLoading, summary, onEditRack, onStockInHere,
}: {
  racks: Rack[];
  warehouseId: string;
  isLoading: boolean;
  summary: { total: number; occupied: number; empty: number; reserved: number; occupancyRate: number };
  onEditRack: (r: Rack) => void;
  onStockInHere: (rackId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Rack | null>(null);

  const q = search.trim().toLowerCase();
  const matches = (r: Rack): boolean => {
    if (!q) return true;
    if (r.rack.toLowerCase().includes(q)) return true;
    return (r.items || []).some((it) =>
      [it.source_doc_no || '', it.customer_name || '', it.product_name || '', it.product_code || '']
        .join(' ').toLowerCase().includes(q));
  };
  const shown = useMemo(() => racks.filter(matches), [racks, q]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!warehouseId) {
    return <div className={styles.emptyRow}>Select a warehouse to view its racks.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {/* Legend */}
      <div className={styles.legendRow}>
        <span className={styles.legendItem}>
          <span className={`${styles.legendSwatch} ${styles.swatchOccupied}`} /> Occupied ({summary.occupied})
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.legendSwatch} ${styles.swatchEmpty}`} /> Empty ({summary.empty})
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.legendSwatch} ${styles.swatchReserved}`} /> Reserved ({summary.reserved})
        </span>
      </div>

      {/* Search — which rack is a piece in? Substring across every item's doc /
          customer / product; client-side over the loaded racks. */}
      <div className={styles.filterRow}>
        <div className={styles.searchBox}>
          <Search {...ICON} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search by document no, customer, or product…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {q && (
          <p className={styles.hint}>
            Showing {shown.length} of {racks.length} racks{shown.length === 0 ? ' — no item matches' : ''}
          </p>
        )}
      </div>

      {isLoading ? (
        <div className={styles.emptyRow}>Loading racks…</div>
      ) : racks.length === 0 ? (
        <div className={styles.emptyRow}>No racks in this warehouse yet. Add one with New rack.</div>
      ) : (
        <div className={styles.rackGrid}>
          {shown.map((r) => (
            <RackCard key={r.id} rack={r} onClick={() => setSelected(r)} />
          ))}
        </div>
      )}

      {selected && (
        <RackDetailModal
          rack={selected}
          warehouseId={warehouseId}
          onClose={() => setSelected(null)}
          onEdit={() => { onEditRack(selected); setSelected(null); }}
          onStockInHere={() => { onStockInHere(selected.id); setSelected(null); }}
        />
      )}
    </div>
  );
}

/* A single colour-coded rack card. Occupied shows up to 3 items + "+N more". */
function RackCard({ rack, onClick }: { rack: Rack; onClick: () => void }) {
  const cls =
    rack.status === 'OCCUPIED' ? styles.rackOccupied
      : rack.status === 'RESERVED' ? styles.rackReserved
        : styles.rackEmpty;
  const items = rack.items || [];
  const visible = items.slice(0, 3);
  const extra = Math.max(0, items.length - 3);

  return (
    <div className={`${styles.rackCard} ${cls}`} onClick={onClick}>
      <div className={styles.rackCardTop}>
        <span className={styles.rackName}>{rack.rack}</span>
        {rack.status === 'OCCUPIED' && (
          <span className={styles.rackCount}>{items.length} item{items.length === 1 ? '' : 's'}</span>
        )}
      </div>
      {rack.status === 'OCCUPIED' ? (
        <div className={styles.rackItems}>
          {visible.map((it) => {
            const meta = itemMeta(it);
            return (
              <div key={it.id} className={styles.rackItemLine}>
                <div className={styles.rackItemName}>{itemDescription(it)}</div>
                {meta && <div className={styles.rackItemMeta}>{meta}</div>}
              </div>
            );
          })}
          {extra > 0 && <div className={styles.rackMore}>+ {extra} more</div>}
        </div>
      ) : (
        <div className={styles.rackStateLabel}>{STATUS_LABEL[rack.status]}</div>
      )}
    </div>
  );
}

/* Rack detail popup — contents + move history for THIS rack, plus Edit / Delete
   (empty only) / Stock in here. Movements are filtered client-side out of the
   warehouse ledger so no extra endpoint is needed. */
function RackDetailModal({
  rack, warehouseId, onClose, onEdit, onStockInHere,
}: {
  rack: Rack;
  warehouseId: string;
  onClose: () => void;
  onEdit: () => void;
  onStockInHere: () => void;
}) {
  const del = useDeleteRack();
  const notify = useNotify();
  const confirm = useConfirm();
  const movements = useMovements(warehouseId ? { warehouseId } : undefined);
  const rackMoves = useMemo(
    () => (movements.data ?? []).filter((m) => m.rack_id === rack.id || m.to_rack_id === rack.id),
    [movements.data, rack.id],
  );
  const items = rack.items || [];

  const removeRack = async () => {
    if (items.length > 0) {
      notify({ title: 'This rack still has stock on it.', body: 'Move or stock out its items before deleting.', tone: 'error' });
      return;
    }
    const ok = await confirm({
      title: `Delete ${rack.rack}?`,
      body: 'This removes the empty rack. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    del.mutate(rack.id, {
      onSuccess: onClose,
      onError: (e) => notify({ title: 'Could not delete rack', body: (e as Error).message, tone: 'error' }),
    });
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>{rack.rack}</h3>
          <button type="button" className={styles.closeBtn} onClick={onClose}><X {...ICON} /></button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
          <span className={styles.eyebrow}>Status</span>
          <span className={`${styles.movementPill} ${
            rack.status === 'OCCUPIED' ? styles.movementIn
              : rack.status === 'RESERVED' ? styles.movementTransfer
                : styles.movementOut}`}>{STATUS_LABEL[rack.status]}</span>
        </div>
        {rack.position && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
            <span className={styles.eyebrow}>Position</span>
            <span className={styles.detailItemMeta}>{rack.position}</span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <span className={styles.eyebrow}>Contents ({items.length})</span>
          {items.length === 0 ? (
            <p className={styles.detailItemMeta}>No items in this rack.</p>
          ) : (
            items.map((it) => (
              <div key={it.id} className={styles.detailItem}>
                <span className={styles.detailItemName}>{itemDescription(it)}</span>
                {it.customer_name && <span className={styles.detailItemMeta}>Customer: {it.customer_name}</span>}
                {it.source_doc_no && <span className={styles.detailItemMeta}>Document: {it.source_doc_no}</span>}
                {(it.qty ?? 1) > 1 && <span className={styles.detailItemMeta}>Qty: {fmtQty(it.qty)}</span>}
                {it.stocked_in_date && <span className={styles.detailItemMeta}>Stocked in: {fmtDate(it.stocked_in_date)}</span>}
                {it.notes && <span className={styles.detailItemMeta}>Notes: {it.notes}</span>}
              </div>
            ))
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <span className={styles.eyebrow}>Move history ({rackMoves.length})</span>
          {movements.isLoading ? (
            <p className={styles.detailItemMeta}>Loading history…</p>
          ) : rackMoves.length === 0 ? (
            <p className={styles.detailItemMeta}>No movements recorded for this rack.</p>
          ) : (
            rackMoves.slice(0, 12).map((m) => (
              <div key={m.id} className={styles.detailItem}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <MovementPill type={m.movement_type} />
                  <span className={styles.detailItemMeta}>Qty {fmtQty(m.quantity)} · {fmtDate(m.created_at)}</span>
                </span>
                {m.product_name && <span className={styles.detailItemMeta}>{m.product_name}</span>}
                {m.source_doc_no && <span className={styles.detailItemMeta}>{m.source_doc_no}</span>}
                {m.reason && <span className={styles.detailItemMeta}>{m.reason}</span>}
              </div>
            ))
          )}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="ghost" onClick={onEdit}>Edit</Button>
            <Button variant="ghost" onClick={removeRack} disabled={items.length > 0 || del.isPending}>Delete</Button>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="secondary" onClick={onStockInHere}>
              <ArrowDownToLine {...ICON} /><span>Stock in here</span>
            </Button>
            <Button variant="primary" onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>
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
        productCode: siCode.trim(),
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
          <input className={styles.fieldInput} style={{ width: 150 }} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input className={styles.fieldInput} style={{ width: 150 }} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
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

function MovementTable({ movements, isLoading }: { movements: RackMovement[]; isLoading: boolean }) {
  if (isLoading) return <div className={styles.emptyRow}>Loading movements…</div>;
  if (movements.length === 0) return <div className={styles.emptyRow}>No movements found.</div>;
  return (
    <div className={styles.tableCard}>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Rack</th>
              <th>Document</th>
              <th>Product</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(m.created_at)}</td>
                <td><MovementPill type={m.movement_type} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {m.rack_label ?? '—'}
                  {m.movement_type === 'TRANSFER' && m.to_rack_label ? ` → ${m.to_rack_label}` : ''}
                </td>
                <td>{m.source_doc_no ? <span className={styles.codeChip}>{m.source_doc_no}</span> : '—'}</td>
                <td>{m.product_name || m.product_code || '—'}</td>
                <td style={{ textAlign: 'right' }}>{fmtQty(m.quantity)}</td>
                <td>{m.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
  const [count, setCount] = useState(10);
  const [scopeMode, setScopeMode] = useState<ScopeMode>('this');
  const [scopeChosen, setScopeChosen] = useState<string[]>([]);

  const submit = () => {
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n < 1) {
      notify({ title: 'Enter how many racks to create (1–200).', tone: 'error' });
      return;
    }
    create.mutate(
      { ...scopeBody(scopeMode, warehouseId, scopeChosen), count: n, prefix: prefix.trim() || 'Rack' },
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
            Quickly create numbered racks (e.g. Rack 1 … Rack {Math.max(1, Math.floor(Number(count) || 0))}). Labels that already exist are skipped. Max 200 at a time.
          </p>
          <label className={formStyles.field}>
            <span className={formStyles.fieldLabel}>Prefix</span>
            <input className={formStyles.fieldInput} value={prefix} placeholder="Rack"
              onChange={(e) => setPrefix(e.target.value)} />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.fieldLabel}>How many</span>
            <input className={formStyles.fieldInput} type="number" min={1} max={200} value={count}
              onChange={(e) => setCount(Number(e.target.value))} />
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
