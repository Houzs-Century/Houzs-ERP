
import { useProductCategories } from '../../vendor/scm/lib/product-categories-store';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { readScmHandoff, writeScmHandoff } from '../../lib/scmHandoffStorage';
import { readConvertScope, UnrecognisedScopeNotice } from '../../lib/convertScope';
import { outstandingEmptyReason } from '../../lib/outstandingEmptyReason';
import { Save, X, CheckSquare, Square, Filter } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import {
  useOutstandingPoItems,
  type OutstandingPoItem,
} from '../../vendor/scm/lib/suppliers-queries';
import { useGrnDetail, useAddGrnItem } from '../../vendor/scm/lib/grn-queries';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtDate, fmtMoneySen, fmtQty } from '@2990s/shared';
import { DateField } from "../../vendor/scm/components/DateField";
import { warehouseLabel } from "../../vendor/scm/lib/warehouse-label";

const whLabel = (
  r: { warehouseLocationCode?: string | null; warehouseLocationName?: string | null } | null | undefined,
): string | null =>
  warehouseLabel(r ? { code: r.warehouseLocationCode, name: r.warehouseLocationName } : null);

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

const STORAGE_KEY = 'grn-from-po.layout.v1';

const FILTER_INPUT: CSSProperties = {
  height: 28,
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 8px',
  fontSize: 'var(--fs-12)',
  background: 'var(--c-paper)',
  color: 'var(--c-ink)',
};


const DATE_FIELD_OPTIONS = [
  { value: 'poDate',   label: 'PO Date' },
  { value: 'expected', label: 'Expected Delivery' },
] as const;
type DateField = typeof DATE_FIELD_OPTIONS[number]['value'];

const rowDateFor = (r: OutstandingPoItem, field: DateField): string | null =>
  field === 'poDate' ? (r.poDate ?? null) : (r.expectedAt ?? null);

type Pick = { picked: boolean; qty: number };

export type GrnFromPoPick = OutstandingPoItem & { _pickQty: number };

export const GrnFromPo = () => {
  const navigate = useNavigate();
  const CATEGORY_OPTIONS = [
    { value: 'all', label: 'All categories' },
    ...useProductCategories().active.map((c) => ({ value: c.code.toLowerCase(), label: c.name })),
  ];

  const [searchParams] = useSearchParams();
  const scope = useMemo(
    () => readConvertScope('poToGrn', searchParams, ['appendToGrn']),
    [searchParams],
  );
  const poIdSet = scope.keys;

  /* The scope now goes to the SERVER. It used to be applied here, in the
     browser, over a list the server had already capped at 500 raw PO lines —
     so scoping could only narrow that window and never recover a PO which fell
     outside it. That is the owner's 2026-08-17 zero-row screen. */
  const itemsQ = useOutstandingPoItems(useMemo(() => [...poIdSet], [poIdSet]));

  const appendToGrn = searchParams.get('appendToGrn');
  const grnDetailQ  = useGrnDetail(appendToGrn);
  const addGrnItem  = useAddGrnItem();
  const appendGrn   = grnDetailQ.data?.grn as
    | { id: string; grn_number: string; supplier_id: string | null; warehouse_id: string | null }
    | undefined;
  const [appending, setAppending] = useState(false);

  const [picks, setPicks] = useState<Record<string, Pick>>({});

  const [category, setCategory]   = useState<string>('all');
  const [dateField, setDateField] = useState<DateField>('poDate');
  const [dateFrom, setDateFrom]   = useState<string>('');
  const [dateTo, setDateTo]       = useState<string>('');

  const [dialog, setDialog] = useState<{ title: string; body: string; goTo?: string } | null>(null);

  const items = useMemo(() => itemsQ.data?.items ?? [], [itemsQ.data]);
  const serverScope = itemsQ.data?.scope ?? null;

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

  const effRemaining = (r: OutstandingPoItem): number =>
    r.remainingQty - (draftQtyById.get(r.poItemId) ?? 0);

  const scopedRows = useMemo(() => items.filter((r) => {
    if (poIdSet.size > 0 && !poIdSet.has(r.poId)) return false;
    if (appendGrn) {
      if (appendGrn.supplier_id && r.supplierId !== appendGrn.supplier_id) return false;
      if (appendGrn.warehouse_id && r.warehouseLocationId !== appendGrn.warehouse_id) return false;
    }
    return true;
  }), [items, poIdSet, appendGrn]);

  const rows = useMemo(() => {
    return scopedRows.filter((r) => {
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
  }, [scopedRows, draftQtyById, category, dateField, dateFrom, dateTo]);

  /* Commander 2026-05-31, on the PO → Goods Received transfer —
     "应该进入 Draft 状态，不要直接 Create."
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

  const lockedWarehouse = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const row = items.find((r) => r.poItemId === id);
      if (row?.warehouseLocationId) return row.warehouseLocationId;
    }
    return null;
  }, [picks, items]);

  const lockedWarehouseLabel = useMemo(() => {
    if (!lockedWarehouse) return null;
    const row = items.find((r) => r.warehouseLocationId === lockedWarehouse);
    return whLabel(row) ?? lockedWarehouse;
  }, [lockedWarehouse, items]);

  const isRowLocked = (r: OutstandingPoItem): boolean =>
    Boolean(lockedWarehouse && r.warehouseLocationId !== lockedWarehouse
      && !picks[r.poItemId]?.picked);

  const togglePick = (id: string, remaining: number) => {
    const row = items.find((r) => r.poItemId === id);
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

  const selectAll = () =>
    setPicks((s) => {
      const next = { ...s };
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

  const columns = useMemo<GridColumn<OutstandingPoItem>[]>(() => [
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
      key: 'warehouse', label: 'Warehouse', width: 150, sortable: true, groupable: true,
      accessor: (r) => (
        <span className={styles.muted}>
          {whLabel(r) ?? '—'}
        </span>
      ),
      searchValue: (r) => `${r.warehouseLocationCode ?? ''} ${r.warehouseLocationName ?? ''}`.trim(),
      groupValue: (r) => whLabel(r) ?? '(no warehouse)',
      sortFn: (a, b) => (a.warehouseLocationCode ?? '').localeCompare(b.warehouseLocationCode ?? ''),
    },
    {
      key: 'poDate', label: 'PO Date', width: 120, sortable: true, defaultHidden: true,
      accessor: (r) => fmtDate(r.poDate),
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
      accessor: (r) => fmtQty(r.qty),
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
      accessor: (r) => fmtDate(r.expectedAt),
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
            {fmtRm(pickQty * r.unitPriceSen)}
          </span>
        );
      },
      exportValue: (r) => ((Object.hasOwn(picks, r.poItemId) && picks[r.poItemId].picked ? picks[r.poItemId].qty : effRemaining(r)) * r.unitPriceSen) / 100,
      exportFormat: 'money',
      sortFn: (a, b) => a.remainingQty * a.unitPriceSen - b.remainingQty * b.unitPriceSen,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  ], [picks]);

  const onSave = async () => {
    if (pickedCount === 0) { setDialog({ title: 'Nothing picked', body: 'Tick at least one PO line first.' }); return; }
    const out: GrnFromPoPick[] = picked
      .map(([poItemId, v]) => {
        const row = items.find((r) => r.poItemId === poItemId);
        return row ? { ...row, _pickQty: v.qty } : null;
      })
      .filter((x): x is GrnFromPoPick => x !== null);

    if (appendToGrn) {
      setAppending(true);
      const landed: string[] = [];
      try {
        for (const r of out) {
          await addGrnItem.mutateAsync({
            grnId:               appendToGrn,
            purchaseOrderItemId: r.poItemId,
            itemCode:        r.itemCode,
            supplierSku:         r.supplierSku ?? undefined,
            materialName:        r.description ?? r.itemCode,
            itemGroup:           r.itemGroup || undefined,
            variants:            (r.variants as Record<string, unknown> | null) ?? undefined,
            qty:                 r._pickQty,
            unitPriceSen:      r.unitPriceSen,
            deliveryDate:        r.deliveryDate ?? undefined,
          });
          landed.push(r.poItemId);
        }
        navigate(`/scm/grns/${appendToGrn}?edit=1`);
      } catch (e) {
        setAppending(false);
        if (landed.length > 0) {
          setPicks((prev) => {
            const next = { ...prev };
            for (const poItemId of landed) delete next[poItemId];
            return next;
          });
        }
        const why = e instanceof Error ? e.message : "Couldn't append the picked lines to this GRN.";
        setDialog({
          title: 'Add failed',
          body: landed.length > 0
            ? `${landed.length} of ${out.length} lines were added to the receipt and are no longer ticked. The rest were not: ${why} Press again to add only those.`
            : why,
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

      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        style={FILTER_INPUT}
        aria-label="Category filter"
      >
        {sortByText(CATEGORY_OPTIONS).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      <select
        value={dateField}
        onChange={(e) => setDateField(e.target.value as DateField)}
        style={FILTER_INPUT}
        aria-label="Date field"
      >
        {DATE_FIELD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <DateField value={dateFrom} onChange={(iso) => setDateFrom(iso)} style={FILTER_INPUT} aria-label="Date from"/>
      <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-11)' }}>→</span>
      <DateField value={dateTo} onChange={(iso) => setDateTo(iso)} style={FILTER_INPUT} aria-label="Date to"/>
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
      <UnrecognisedScopeNotice unknown={scope.unknown} />
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
              /* Prefer the server's `scope`, which names the PO even when it has
                 no outstanding lines. Reading the doc number off `items` alone
                 fell back to the anonymous "this PO" in exactly the case the
                 operator most needs it named — the empty one. That is the banner
                 in the owner's 2026-08-17 screenshot. */
              ? (serverScope?.pos[0]?.poDocNo
                  ?? items.find((r) => poIdSet.has(r.poId))?.poDocNo
                  ?? 'this PO')
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

      <DataGridCompat<OutstandingPoItem>
        rows={rows}
        columns={columns}
        storageKey={STORAGE_KEY}
        rowKey={(r) => r.poItemId}
        searchPlaceholder="Search PO, supplier, item…"
        onRowClick={(r) => togglePick(r.poItemId, effRemaining(r))}
        rowStyle={(r) => isRowLocked(r)
          ? { opacity: 0.45, background: 'var(--c-cream)', cursor: 'not-allowed' }
          : undefined}
        toolbar={toolbar}
        groupBanner={false}
        isLoading={itemsQ.isLoading}
        /* AN EMPTY RESULT MUST SAY WHY IT IS EMPTY. This used to be one sentence
           — "every line has been received (or there are no outstanding POs)" —
           covering five different situations and asserting the work was DONE in
           all of them. The owner hit it on a PO that had never been received.

           An empty result is only ever evidence that THE QUERY FOUND NOTHING;
           "everything is received" is a stronger claim this page has no standing
           to make, since the read is scoped to the active company and fails
           closed when that company cannot be resolved. The reasons now live in
           one shared module (which keeps #2367's wording for the unscoped case)
           so the mobile wizard cannot disagree with this screen. */
        emptyMessage={outstandingEmptyReason({
          isError: itemsQ.isError,
          isLoading: itemsQ.isLoading,
          scope: serverScope,
          serverRowCount: items.length,
          scopedRowCount: scopedRows.length,
          visibleRowCount: rows.length,
          filtersActive: category !== 'all' || Boolean(dateFrom) || Boolean(dateTo),
          poScopeActive: poIdSet.size > 0,
        }) ?? ''}
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
