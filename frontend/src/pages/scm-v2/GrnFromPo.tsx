// ----------------------------------------------------------------------------
// GrnFromPo — multi-select PO LINE → New GRN form FEEDER.
//
// Commander 2026-05-29 redesign: this picker no longer auto-creates GRNs. Like
// Create-PO-from-SO (PurchaseOrderFromSo), it now FEEDS the New GRN form — tick
// the outstanding PO lines you're receiving, optionally adjust the Pick Qty,
// hit "Add N lines to GRN", and you land back on /grns/new with those lines
// pre-loaded (supplier locked, each line keeping its own purchase_order_item_id
// so received_qty still rolls up to every source PO).
//
// Same shared <DataGrid> primitive + toolbar (Select all / Clear all + category
// filter + date-range filter targeting PO Date / Expected Delivery + search +
// Columns config) + dense ledger columns with the variant summary under each
// Description + click-row-to-pick + editable Pick Qty. One supplier per GRN:
// once a line is ticked, other suppliers' lines grey out + disable.
//
// Routing: /grns/from-po.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/GrnFromPo.tsx. Import
// boundary only: react-router → react-router-dom; the outstanding-PO picker hook
// stays in suppliers-queries (vendor path); the GRN detail/add-item hooks →
// vendored grn-queries; components/category-badges → ../../vendor/scm/*; nav
// repointed to /scm/grns (the New GRN form + the append-to-GRN edit page).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { readScmHandoff, writeScmHandoff } from '../../lib/scmHandoffStorage';
import { Save, X, CheckSquare, Square, Filter } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import {
  useOutstandingPoItems,
  type OutstandingPoItem,
} from '../../vendor/scm/lib/suppliers-queries';
import { useGrnDetail, useAddGrnItem } from '../../vendor/scm/lib/grn-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtMoneyCenti } from '@2990s/shared';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneyCenti(centi, currency);

/* DataGrid localStorage layout key. */
const STORAGE_KEY = 'grn-from-po.layout.v1';

/* Houzs-style compact pill controls for the toolbar filters — matches the
   inputs on Create-PO-from-SO so the density is identical. */
const FILTER_INPUT: CSSProperties = {
  height: 28,
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 8px',
  fontSize: 'var(--fs-12)',
  background: 'var(--c-paper)',
  color: 'var(--c-ink)',
};

/** Category filter options — same set as Create-PO-from-SO. */
const CATEGORY_OPTIONS = [
  { value: 'all',       label: 'All categories' },
  { value: 'sofa',      label: 'Sofa' },
  { value: 'bedframe',  label: 'Bedframe' },
  { value: 'mattress',  label: 'Mattress' },
  { value: 'accessory', label: 'Accessory' },
  { value: 'service',   label: 'Service' },
] as const;

/** Which date field the range filter targets (PO has PO Date + Expected). */
const DATE_FIELD_OPTIONS = [
  { value: 'poDate',   label: 'PO Date' },
  { value: 'expected', label: 'Expected Delivery' },
] as const;
type DateField = typeof DATE_FIELD_OPTIONS[number]['value'];

const rowDateFor = (r: OutstandingPoItem, field: DateField): string | null =>
  field === 'poDate' ? (r.poDate ?? null) : (r.expectedAt ?? null);

type Pick = { picked: boolean; qty: number };

/* Shape stashed to sessionStorage for the New GRN form to consume. Mirrors the
   poFromSoPicks pattern — the full row plus the chosen pick qty. */
export type GrnFromPoPick = OutstandingPoItem & { _pickQty: number };

export const GrnFromPo = () => {
  const navigate = useNavigate();
  const itemsQ   = useOutstandingPoItems();

  /* Commander 2026-05-31 — "Partially Convert" from the PO list lands here with
     ?poId=<id>, scoping the picker to ONE PO's outstanding lines so the operator
     isn't hunting through every supplier's PO. No param → the full picker. */
  const [searchParams] = useSearchParams();
  // ?poId=<id> (single convert) or ?poId=<id>,<id>,… (batch convert from the
  // toolbar) → scope to those POs. Empty set = the full open picker.
  const poIdFilter = searchParams.get('poId');
  const poIdSet = useMemo(
    () => new Set((poIdFilter ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    [poIdFilter],
  );

  /* Commander 2026-05-31 — APPEND mode. When a POSTED GRN's edit page sends the
     operator here with ?appendToGrn=<grnId>, this picker no longer feeds the
     New GRN form; instead it appends the picked PO lines straight into that
     existing GRN (same multi-pick UI as Create-GR's "From PO (multi)"). Scope:
     the GRN is supplier- + warehouse-locked, so only that supplier's lines for
     that warehouse are pickable. */
  const appendToGrn = searchParams.get('appendToGrn');
  const grnDetailQ  = useGrnDetail(appendToGrn);
  const addGrnItem  = useAddGrnItem();
  const appendGrn   = grnDetailQ.data?.grn as
    | { id: string; grn_number: string; supplier_id: string | null; warehouse_id: string | null }
    | undefined;
  const [appending, setAppending] = useState(false);

  // Map<poItemId, { picked, qty }>. qty defaults to remainingQty when ticked.
  const [picks, setPicks] = useState<Record<string, Pick>>({});

  // Toolbar filters — identical to Create-PO-from-SO.
  const [category, setCategory]   = useState<string>('all');
  const [dateField, setDateField] = useState<DateField>('poDate');
  const [dateFrom, setDateFrom]   = useState<string>('');
  const [dateTo, setDateTo]       = useState<string>('');

  // In-app result dialog (validation only now — the grid feeds the form).
  const [dialog, setDialog] = useState<{ title: string; body: string; goTo?: string } | null>(null);

  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);

  /* The New GRN form stashes its current draft (grnNewDraft) before sending us
     here. Build a per-poItemId drafted-qty map so the same PO line can't be
     picked twice across the unsaved draft + these new picks:
       · lines FULLY consumed by the draft are filtered out,
       · lines PARTIALLY consumed still show with a "in draft X" tag, and the
         Pick Qty is capped at (remaining − draft). Mirrors PurchaseOrderFromSo. */
  const draftQtyById = useMemo(() => {
    try {
      const d = readScmHandoff<{ lines?: Array<{ purchaseOrderItemId?: string | null; qtyReceived?: number }> }>('grnNewDraft');
      if (!d) return new Map<string, number>();
      const m = new Map<string, number>();
      for (const l of (d.lines ?? [])) {
        if (!l.purchaseOrderItemId) continue;
        m.set(l.purchaseOrderItemId, (m.get(l.purchaseOrderItemId) ?? 0) + (l.qtyReceived ?? 0));
      }
      return m;
    } catch { return new Map<string, number>(); }
  }, []);

  /* Effective remaining for a row, after subtracting what the unsaved draft
     already holds for this same PO line. <=0 → filtered out. */
  const effRemaining = (r: OutstandingPoItem): number =>
    r.remainingQty - (draftQtyById.get(r.poItemId) ?? 0);

  // ── Filtered rows fed to the grid ────────────────────────────────────
  const rows = useMemo(() => {
    return items.filter((r) => {
      if (poIdSet.size > 0 && !poIdSet.has(r.poId)) return false;
      // Append mode — only this GRN's supplier (and warehouse, if the GRN is
      // warehouse-bound) so the receipt stays one-supplier / one-warehouse.
      if (appendGrn) {
        if (appendGrn.supplier_id && r.supplierId !== appendGrn.supplier_id) return false;
        if (appendGrn.warehouse_id && r.warehouseLocationId !== appendGrn.warehouse_id) return false;
      }
      if (effRemaining(r) <= 0) return false;
      if (category !== 'all' && (r.itemGroup ?? '').toLowerCase() !== category) return false;
      if (dateFrom || dateTo) {
        const d = rowDateFor(r, dateField);
        if (!d) return false;
        if (dateFrom && d < dateFrom) return false;
        if (dateTo   && d > dateTo)   return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, draftQtyById, category, dateField, dateFrom, dateTo, poIdSet, appendGrn]);

  /* Commander 2026-05-31 — "Convert to GR 应该进入 Draft 状态，不要直接 Create."
     When the operator converts ONE PO from the list (?poId=<id>), land here with
     that PO's outstanding lines PRE-TICKED at their full remaining qty, so the
     screen is a ready-to-review draft (mirrors the DO→SI convert). They eyeball
     it and press Save — nothing is created until then. No poId param (the open
     "From PO" picker) → start untouched. Runs once after items load. */
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current) return;
    if (poIdSet.size === 0) return;
    if (itemsQ.isLoading) return;
    prefilled.current = true;
    const mine = items.filter((r) => poIdSet.has(r.poId) && effRemaining(r) > 0);
    const first = mine[0];
    if (!first) return;
    // Honour the one-warehouse-per-GRN lock: tick only lines that share the
    // first line's warehouse (a same-supplier batch can still span warehouses).
    const lockTo = first.warehouseLocationId ?? null;
    setPicks(() => {
      const next: Record<string, Pick> = {};
      for (const l of mine) {
        if (lockTo && l.warehouseLocationId !== lockTo) continue;
        next[l.poItemId] = { picked: true, qty: effRemaining(l) };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, itemsQ.isLoading, poIdSet]);

  // One WAREHOUSE per GRN (Commander 2026-05-30) — once a line is ticked, the
  // selection locks to that PO line's warehouse (purchase_location). Lines from a
  // DIFFERENT warehouse grey out / become un-tickable. Mirrors the supplier-lock
  // pattern in PurchaseOrderFromSo, but keyed on warehouseLocationId. Clearing
  // all picks unlocks.
  const lockedWarehouse = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const row = items.find((r) => r.poItemId === id);
      if (row?.warehouseLocationId) return row.warehouseLocationId;
    }
    return null;
  }, [picks, items]);

  // Human-readable label for the locked warehouse (for the header note).
  const lockedWarehouseLabel = useMemo(() => {
    if (!lockedWarehouse) return null;
    const row = items.find((r) => r.warehouseLocationId === lockedWarehouse);
    return row?.warehouseLocationCode ?? row?.warehouseLocationName ?? lockedWarehouse;
  }, [lockedWarehouse, items]);

  // A row is LOCKED when a different warehouse is already picked. Grey these out
  // + disable their checkbox / qty input.
  const isRowLocked = (r: OutstandingPoItem): boolean =>
    Boolean(lockedWarehouse && r.warehouseLocationId !== lockedWarehouse
      && !picks[r.poItemId]?.picked);

  // ── Pick helpers ─────────────────────────────────────────────────────
  const togglePick = (id: string, remaining: number) => {
    const row = items.find((r) => r.poItemId === id);
    // Block ticking a different warehouse than the one already locked.
    if (row && lockedWarehouse && row.warehouseLocationId !== lockedWarehouse
        && !picks[id]?.picked) return;
    setPicks((s) => ({
      ...s,
      [id]: s[id]?.picked
        ? { picked: false, qty: 0 }
        : { picked: true, qty: s[id]?.qty || remaining },
    }));
  };

  const setQty = (id: string, qty: number) =>
    setPicks((s) => ({ ...s, [id]: { picked: true, qty } }));

  // Select / clear all currently-VISIBLE rows (respects filters + warehouse lock).
  const selectAll = () =>
    setPicks((s) => {
      const next = { ...s };
      // Lock to the first visible warehouse so a bulk select stays one-warehouse.
      const lockTo = lockedWarehouse ?? rows[0]?.warehouseLocationId ?? null;
      for (const l of rows) {
        if (lockTo && l.warehouseLocationId !== lockTo) continue;
        next[l.poItemId] = { picked: true, qty: effRemaining(l) };
      }
      return next;
    });

  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  // ── Columns — mirror Create-PO-from-SO (PO Doc No / Supplier / Category /
  //    Item Code / Description+variants / Ordered / Received / Pick Qty /
  //    Expected / Line Value). Memoized on `picks` so the controlled inputs
  //    re-render when pick state changes (DataGrid is React.memo'd). ────────
  const columns = useMemo<DataGridColumn<OutstandingPoItem>[]>(() => [
    {
      key: 'pick', label: '', width: 40, sortable: false, groupable: false,
      accessor: (r) => {
        const on = Boolean(picks[r.poItemId]?.picked);
        const locked = isRowLocked(r);
        return (
          <input
            type="checkbox"
            checked={on}
            disabled={locked}
            onChange={() => togglePick(r.poItemId, effRemaining(r))}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Pick ${r.itemCode}`}
            style={locked ? { cursor: 'not-allowed' } : undefined}
          />
        );
      },
    },
    {
      key: 'poDocNo', label: 'PO Doc No', width: 120, sortable: true, groupable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.poDocNo}</span>,
      searchValue: (r) => r.poDocNo,
    },
    {
      // Owner 2026-07-24: supplier NAME and CODE are separate columns on every
      // procurement table, not one combined "code · name" cell.
      key: 'supplier', label: 'Supplier', width: 200, sortable: true, groupable: true,
      accessor: (r) => r.supplierName ?? '—',
      searchValue: (r) => r.supplierName ?? '',
      groupValue: (r) => r.supplierName ?? r.supplierCode ?? '(none)',
    },
    {
      key: 'supplier_code', label: 'Supplier Code', width: 110, sortable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.supplierCode ?? '—'}</span>,
      searchValue: (r) => r.supplierCode ?? '',
      filterValue: (r) => r.supplierCode ?? '—',
    },
    {
      /* Warehouse column (Deliverable 4b) — each PO line's purchase_location.
         The GRN locks to one warehouse; this column makes the lock legible. */
      key: 'warehouse', label: 'Warehouse', width: 150, sortable: true, groupable: true,
      accessor: (r) => (
        <span className={styles.muted}>
          {r.warehouseLocationCode ?? r.warehouseLocationName ?? '—'}
        </span>
      ),
      searchValue: (r) => `${r.warehouseLocationCode ?? ''} ${r.warehouseLocationName ?? ''}`.trim(),
      groupValue: (r) => r.warehouseLocationCode ?? r.warehouseLocationName ?? '(no warehouse)',
      sortFn: (a, b) => (a.warehouseLocationCode ?? '').localeCompare(b.warehouseLocationCode ?? ''),
    },
    {
      /* PO Date — available in the Columns toggle; hidden by default to keep the
         picker dense. (Deliverable 4c.) */
      key: 'poDate', label: 'PO Date', width: 120, sortable: true, defaultHidden: true,
      accessor: (r) => r.poDate ?? '',
      searchValue: (r) => r.poDate ?? '',
      sortFn: (a, b) => String(a.poDate ?? '').localeCompare(String(b.poDate ?? '')),
    },
    {
      key: 'itemGroup', label: 'Category', width: 110, sortable: true, groupable: true,
      accessor: (r) => <ItemGroupPill group={r.itemGroup} />,
      searchValue: (r) => r.itemGroup ?? '',
      groupValue: (r) => (r.itemGroup ?? '(none)').toUpperCase(),
    },
    {
      key: 'itemCode', label: 'Item Code', width: 130, sortable: true,
      accessor: (r) => <span style={{ fontWeight: 600 }}>{r.itemCode}</span>,
      searchValue: (r) => r.itemCode ?? '',
    },
    {
      key: 'description', label: 'Description', width: 240, sortable: true,
      accessor: (r) => (
        <VariantDescription
          itemCode={r.itemCode}
          itemGroup={r.itemGroup}
          variants={r.variants}
          description={r.description}
          mutedClassName={styles.muted}
        />
      ),
      searchValue: (r) => r.description ?? '',
    },
    {
      key: 'qty', label: 'Ordered', width: 80, align: 'right', sortable: true,
      accessor: (r) => String(r.qty),
      sortFn: (a, b) => a.qty - b.qty,
    },
    {
      key: 'receivedQty', label: 'Received', width: 80, align: 'right', sortable: true,
      accessor: (r) => {
        const inDraft = draftQtyById.get(r.poItemId) ?? 0;
        return (
          <span className={styles.muted}>
            {r.receivedQty}
            {inDraft > 0 && (
              <span style={{ display: 'block', fontSize: 'var(--fs-11)', color: 'var(--c-burnt)' }}>
                in draft {inDraft}
              </span>
            )}
          </span>
        );
      },
      sortFn: (a, b) => a.receivedQty - b.receivedQty,
    },
    {
      key: 'pickQty', label: 'Pick Qty', width: 90, align: 'right', sortable: false, groupable: false,
      accessor: (r) => {
        const p = picks[r.poItemId];
        const on = Boolean(p?.picked);
        const locked = isRowLocked(r);
        const eff = effRemaining(r);
        return (
          <input
            type="number"
            min={0}
            max={eff}
            value={on ? p!.qty : ''}
            placeholder={String(eff)}
            disabled={locked}
            /* Typing a qty auto-selects the row (no need to tick first). */
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              setQty(r.poItemId, Math.min(eff, Math.max(0, Number(e.target.value) || 0)))}
            style={{ ...FILTER_INPUT, width: 64, textAlign: 'right', ...(locked ? { cursor: 'not-allowed', background: 'var(--c-cream)' } : null) }}
          />
        );
      },
    },
    {
      key: 'expectedAt', label: 'Expected', width: 120, sortable: true,
      accessor: (r) => r.expectedAt ?? '',
      searchValue: (r) => r.expectedAt ?? '',
      sortFn: (a, b) => String(a.expectedAt ?? '').localeCompare(String(b.expectedAt ?? '')),
    },
    {
      key: 'lineValue', label: 'Line Value', width: 120, align: 'right', sortable: true,
      accessor: (r) => {
        const p = picks[r.poItemId];
        const pickQty = p?.picked ? p.qty : effRemaining(r);
        return (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
            {fmtRm(pickQty * r.unitPriceCenti)}
          </span>
        );
      },
      sortFn: (a, b) => a.remainingQty * a.unitPriceCenti - b.remainingQty * b.unitPriceCenti,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  ], [picks]);

  // ── Add to GRN ───────────────────────────────────────────────────────
  // Commander 2026-05-29 — this grid FEEDS the New GRN form (no longer auto-
  // creates GRNs). On confirm, stash the picked PO lines + their chosen qty,
  // then return to /grns/new, which loads them as GRN line items.
  const onSave = async () => {
    if (pickedCount === 0) { setDialog({ title: 'Nothing picked', body: 'Tick at least one PO line first.' }); return; }
    const out: GrnFromPoPick[] = picked
      .map(([poItemId, v]) => {
        const row = items.find((r) => r.poItemId === poItemId);
        return row ? { ...row, _pickQty: v.qty } : null;
      })
      .filter((x): x is GrnFromPoPick => x !== null);

    // APPEND mode — push each pick straight into the existing GRN as a new line
    // (server rolls received_qty + writes inventory-IN per line), then return to
    // the GRN's edit page where the new lines now appear.
    if (appendToGrn) {
      setAppending(true);
      try {
        for (const r of out) {
          await addGrnItem.mutateAsync({
            grnId:               appendToGrn,
            purchaseOrderItemId: r.poItemId,
            materialCode:        r.itemCode,
            materialName:        r.description ?? r.itemCode,
            itemGroup:           r.itemGroup || undefined,
            variants:            (r.variants as Record<string, unknown> | null) ?? undefined,
            qty:                 r._pickQty,
            unitPriceCenti:      r.unitPriceCenti,
            deliveryDate:        r.deliveryDate ?? undefined,
          });
        }
        navigate(`/scm/grns/${appendToGrn}?edit=1`);
      } catch (e) {
        setAppending(false);
        setDialog({
          title: 'Add failed',
          body: e instanceof Error ? e.message : "Couldn't append the picked lines to this GRN.",
        });
      }
      return;
    }

    if (!writeScmHandoff('grnFromPoPicks', out)) {
      setDialog({ title: 'Unable to continue', body: 'This browser could not safely store your picked lines. Your selection is still here; free some browser storage and try again.' });
      return;
    }
    navigate('/scm/grns/new');
  };

  // ── Toolbar (filters + select/clear) — same layout as Create-PO-from-SO.
  //    Received date is now set on the New GRN form, not here. ──────────────
  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <Button variant="ghost" size="sm" onClick={selectAll} disabled={rows.length === 0}>
        <CheckSquare {...ICON} /> Select all
      </Button>
      <Button variant="ghost" size="sm" onClick={clearAll} disabled={pickedCount === 0}>
        <Square {...ICON} /> Clear all
      </Button>

      <span style={{ width: 1, height: 20, background: 'var(--line)' }} aria-hidden />

      <Filter size={14} strokeWidth={1.75} style={{ color: 'var(--fg-muted)' }} aria-label="Filters" />

      {/* Category filter */}
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        style={FILTER_INPUT}
        aria-label="Category filter"
      >
        {sortByText(CATEGORY_OPTIONS).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      {/* Date-range filter */}
      <select
        value={dateField}
        onChange={(e) => setDateField(e.target.value as DateField)}
        style={FILTER_INPUT}
        aria-label="Date field"
      >
        {DATE_FIELD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <input
        type="date"
        value={dateFrom}
        onChange={(e) => setDateFrom(e.target.value)}
        style={FILTER_INPUT}
        aria-label="Date from"
      />
      <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-11)' }}>→</span>
      <input
        type="date"
        value={dateTo}
        onChange={(e) => setDateTo(e.target.value)}
        style={FILTER_INPUT}
        aria-label="Date to"
      />
      {(category !== 'all' || dateFrom || dateTo) && (
        <button
          type="button"
          onClick={() => { setCategory('all'); setDateFrom(''); setDateTo(''); }}
          style={{
            background: 'transparent', border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)', padding: '0 10px', height: 28,
            fontSize: 'var(--fs-11)', fontWeight: 600, color: 'var(--fg-muted)', cursor: 'pointer',
          }}
        >
          Reset
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Explicit back target (was the action-rail link): appending to an
          existing GRN returns to THAT GRN in edit mode, not the list. */}
      <PageHeader
        back={appendToGrn ? `/scm/grns/${appendToGrn}?edit=1` : '/scm/grns'}
        eyebrow="Procurement"
        title={appendToGrn
          ? `Add PO lines to ${appendGrn?.grn_number ?? 'this GRN'}`
          : 'Pick PO lines for this GRN'}
        actions={
          <div className={styles.actions}>
            <Button
              variant="ghost" size="md"
              onClick={() => navigate(appendToGrn ? `/scm/grns/${appendToGrn}?edit=1` : '/scm/grns')}
            >
              <X {...ICON} /> Cancel
            </Button>
            <Button
              variant="primary" size="md"
              onClick={onSave}
              disabled={pickedCount === 0 || appending}
              title={appendToGrn ? 'Append the picked PO lines into this GRN' : 'Add the picked PO lines into the New GRN form'}
            >
              <Save {...ICON} />
              {appending
                ? 'Adding…'
                : pickedCount === 0
                  ? 'Pick at least 1 line'
                  : `Add ${pickedCount} line${pickedCount === 1 ? '' : 's'} to GRN`}
            </Button>
          </div>
        }
      />
      {appendToGrn && (
        <p style={{
          margin: '0 0 var(--space-2)', padding: 'var(--space-1) var(--space-3)',
          width: 'fit-content', borderRadius: 'var(--radius-pill)',
          background: 'rgba(232, 107, 58, 0.10)', border: '1px solid var(--c-burnt)',
          color: 'var(--c-burnt)', fontSize: 'var(--fs-12)', fontWeight: 600,
        }}>
          Appending to <code>{appendGrn?.grn_number ?? 'this GRN'}</code> — only this
          supplier&apos;s outstanding PO lines for the same warehouse are shown. Tick lines,
          adjust qty, then Save to add them.
        </p>
      )}
      {poIdSet.size > 0 && (
        <p style={{
          margin: '0 0 var(--space-2)', padding: 'var(--space-1) var(--space-3)',
          width: 'fit-content', borderRadius: 'var(--radius-pill)',
          background: 'rgba(232, 107, 58, 0.10)', border: '1px solid var(--c-burnt)',
          color: 'var(--c-burnt)', fontSize: 'var(--fs-12)', fontWeight: 600,
        }}>
          Reviewing{' '}
          <code>
            {poIdSet.size === 1
              ? (items.find((r) => poIdSet.has(r.poId))?.poDocNo ?? 'this PO')
              : `${poIdSet.size} POs`}
          </code>
          {' '}— outstanding lines are pre-filled. Adjust qty, then Save to create the GRN.{' '}
          <Link to="/scm/grns/from-po" style={{ color: 'var(--c-burnt)', textDecoration: 'underline' }}>Show all POs</Link>
        </p>
      )}
      {lockedWarehouse && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          One warehouse per GRN — locked to{' '}
          <code>{lockedWarehouseLabel}</code>. PO lines from a different warehouse
          are greyed out; clear picks to switch.
        </p>
      )}

      <DataGrid<OutstandingPoItem>
        rows={rows}
        columns={columns}
        storageKey={STORAGE_KEY}
        rowKey={(r) => r.poItemId}
        searchPlaceholder="Search PO, supplier, item…"
        onRowClick={(r) => togglePick(r.poItemId, effRemaining(r))}
        /* Grey out rows whose supplier conflicts with the locked one. */
        rowStyle={(r) => isRowLocked(r)
          ? { opacity: 0.45, background: 'var(--c-cream)', cursor: 'not-allowed' }
          : undefined}
        toolbar={toolbar}
        groupBanner={false}
        isLoading={itemsQ.isLoading}
        /* A failed read must NEVER render as the sentence below. "We couldn't
           load the lines" and "there are no lines left to do" are opposite
           facts, and the operator acts on the second one by walking away from
           work that is still outstanding. */
        emptyMessage={itemsQ.isError
          ? "We couldn't load the outstanding lines, so this list is incomplete. That is not the same as there being none left — please refresh and try again."
          : "No outstanding PO lines — every line has been received (or there are no outstanding POs)."}
      />

      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          primaryLabel={dialog.goTo ? 'Open Goods Receipts' : undefined}
          onPrimary={dialog.goTo ? () => { const g = dialog.goTo!; setDialog(null); navigate(g); } : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
