// ----------------------------------------------------------------------------
// PurchaseOrderFromSo — multi-select SO → PO picker.
//
// Commander 2026-05-28 redesign:
//   - REMOVED the "PO Defaults" card (Expected Delivery + Purchase Location).
//     Those are NOT asked anymore — the server derives each PO line's
//     warehouse from the source SO's Sales Location, and each line's delivery
//     date from the SO line's own delivery date (header expected_at / purchase
//     location are rolled up from the lines server-side).
//   - SWAPPED the bespoke card list for the shared <DataGrid> primitive
//     (same dense ledger look as MfgSalesOrdersList / SalesOrderDetailListing).
//   - ADDED toolbar filters: a date-range filter that targets SO Date /
//     Processing Date / Delivery Date, plus a Category filter.
//
// Original multi-select + partial-qty behaviour (Commander 2026-05-26) is
// preserved: tick lines, optionally edit the pick qty, hit "Create POs".
// Server groups by main supplier and emits one PO per supplier.
//
// Routing: /scm/purchase-orders/from-so.
// ----------------------------------------------------------------------------

import { useMemo, useState, type CSSProperties } from 'react';
// HOUZS VENDOR — Link + useSearchParams live on 'react-router-dom' in
// react-router v6 (the version Houzs ships). Only the import specifier changed.
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Save, X, CheckSquare, Square, Filter } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { fmtDateOrDash, fmtMoneySen } from '@2990s/shared';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import {
  useOutstandingSoItems,
  useCreatePosFromSoItems,
  usePurchaseOrderDetail,
  type OutstandingSoItem,
} from '../../vendor/scm/lib/suppliers-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, writeScmHandoff } from '../../lib/scmHandoffStorage';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

/* DataGrid localStorage layout key (commander 2026-05-28). */
const STORAGE_KEY = 'po-from-so.layout.v1';

/* Houzs-style compact pill controls for the toolbar filters — mirrors the
   inputs used on the SO list page so the density matches. */
const FILTER_INPUT: CSSProperties = {
  height: 28,
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 8px',
  fontSize: 'var(--fs-12)',
  background: 'var(--c-paper)',
  color: 'var(--c-ink)',
};

/** Category filter options. 'all' shows everything; the rest match item_group. */
const CATEGORY_OPTIONS = [
  { value: 'all',       label: 'All categories' },
  { value: 'sofa',      label: 'Sofa' },
  { value: 'bedframe',  label: 'Bedframe' },
  { value: 'mattress',  label: 'Mattress' },
  { value: 'accessory', label: 'Accessory' },
  { value: 'service',   label: 'Service' },
] as const;

/** Which date field the range filter targets. */
const DATE_FIELD_OPTIONS = [
  { value: 'soDate',       label: 'SO Date' },
  { value: 'processing',   label: 'Processing Date' },
  { value: 'delivery',     label: 'Delivery Date' },
] as const;
type DateField = typeof DATE_FIELD_OPTIONS[number]['value'];

/** Resolve the date string for a row given the active date-field selector. */
const rowDateFor = (r: OutstandingSoItem, field: DateField): string | null => {
  if (field === 'soDate')     return r.soDate ?? null;
  if (field === 'processing') return r.processingDate ?? null;
  // delivery — prefer the SO line's own date, fall back to the SO header date.
  return r.lineDeliveryDate ?? r.deliveryDate ?? null;
};

type Pick = { picked: boolean; qty: number };

export const PurchaseOrderFromSo = () => {
  const navigate = useNavigate();
  const itemsQ   = useOutstandingSoItems();

  /* Commander 2026-05-29 — when opened from a PO ("Transfer from Sales Order" / "Add Line
     Item"), ?poId scopes this picker to that PO: it locks to the PO's supplier
     and, on save, APPENDS the picked SO lines to that PO (instead of creating
     new POs), then returns to the PO. */
  const [searchParams] = useSearchParams();
  const targetPoId = searchParams.get('poId');
  const targetPoQ = usePurchaseOrderDetail(targetPoId);
  const targetPoSupplierCode = targetPoQ.data?.purchaseOrder?.supplier?.code ?? null;
  const targetPoNumber = targetPoQ.data?.purchaseOrder?.po_number ?? null;
  const createPos = useCreatePosFromSoItems();
  /* One append per mount: only the ?poId branch posts, and it navigates to the
     PO on success — so this mount IS one intent and a per-mount key is the same
     shape as every other create form (lib/idempotency.ts). Load-bearing here
     because onError leaves the operator ON this page with the picks intact and
     an "Add failed" dialog: if the post actually committed and only the response
     was lost, the invited re-press must REPLAY, not append the same lines twice.
     Nothing caps it otherwise — this branch does not send fromMrp, so the server
     only rejects a re-append once remaining runs out. */
  const idemKey = useIdempotencyKey();

  // Map<soItemId, { picked, qty }>. Defaults: picked = false; when ticked,
  // qty defaults to remainingQty.
  const [picks, setPicks] = useState<Record<string, Pick>>({});

  // Toolbar filters (commander 2026-05-28).
  const [category, setCategory]   = useState<string>('all');
  const [dateField, setDateField] = useState<DateField>('soDate');
  const [dateFrom, setDateFrom]   = useState<string>('');
  const [dateTo, setDateTo]       = useState<string>('');

  // In-app result dialog (validation only now — the grid feeds the form).
  const [dialog, setDialog] = useState<{ title: string; body: string; goTo?: string } | null>(null);

  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);

  /* Commander 2026-05-30 — the New PO form stashes its current draft
     (poNewDraft) before sending us here. Build a per-soItemId draft qty map so:
       · lines FULLY consumed by the draft are filtered out (clean),
       · lines PARTIALLY consumed still show with a "draft already X" tag, and
         the Pick Qty input is capped at (remaining − draft) so the same SO
         qty can't be over-picked across draft + new picks. */
  const draftQtyById = useMemo(() => {
    try {
      const d = readScmHandoff<{ lines?: Array<{ soItemId?: string | null; qty?: number }> }>('poNewDraft');
      if (!d) return new Map<string, number>();
      const m = new Map<string, number>();
      for (const l of (d.lines ?? [])) {
        if (!l.soItemId) continue;
        m.set(l.soItemId, (m.get(l.soItemId) ?? 0) + (l.qty ?? 0));
      }
      return m;
    } catch { return new Map<string, number>(); }
  }, []);
  const cameFromNewPage = draftQtyById.size > 0;

  /* Effective remaining for a row, after subtracting what the draft already
     holds for this same SO line. <=0 → filter out. >0 with draftQty>0 →
     partially consumed, show with the "draft already X" tag. */
  const effectiveRemaining = (r: OutstandingSoItem): number =>
    r.remainingQty - (draftQtyById.get(r.soItemId) ?? 0);

  // ── Filtered rows fed to the grid ────────────────────────────────────
  const rows = useMemo(() => {
    return items.filter((r) => {
      if (effectiveRemaining(r) <= 0) return false;
      if (category !== 'all' && (r.itemGroup ?? '').toLowerCase() !== category) return false;
      if (dateFrom || dateTo) {
        const d = rowDateFor(r, dateField);
        if (!d) return false;
        if (dateFrom && d < dateFrom) return false;
        if (dateTo   && d > dateTo)   return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  }, [items, draftQtyById, category, dateField, dateFrom, dateTo]);

  // One supplier per PO (Commander 2026-05-29) — once a bound line is ticked,
  // lines from other suppliers lock. Unbound ("— none —") lines don't lock.
  const lockedSupplier = useMemo(() => {
    // In PO-scoped mode the supplier is fixed to the PO's supplier from the
    // start — every other supplier's lines grey out immediately.
    if (targetPoSupplierCode) return targetPoSupplierCode;
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const row = items.find((r) => r.soItemId === id);
      if (row?.mainSupplierCode) return row.mainSupplierCode;
    }
    return null;
  }, [picks, items, targetPoSupplierCode]);

  // A row is LOCKED when a different bound supplier is already picked.
  // Commander 2026-05-29: "不让勾选了，那为什么不把选项置灰呢" — grey these out
  // and disable their checkbox / qty input so the lock is obvious, not vague.
  // Nothing is locked while no supplier is chosen ("不要限制得太死"), and
  // unbound "— none —" rows never lock (they have no supplier to conflict).
  const isRowLocked = (r: OutstandingSoItem): boolean =>
    Boolean(r.mainSupplierCode && lockedSupplier && r.mainSupplierCode !== lockedSupplier
      && !picks[r.soItemId]?.picked);

  // ── Pick helpers ─────────────────────────────────────────────────────
  const togglePick = (id: string, remaining: number) => {
    const row = items.find((r) => r.soItemId === id);
    if (!row) return;
    // Block ticking a different bound supplier than the one already locked.
    if (row.mainSupplierCode && lockedSupplier && row.mainSupplierCode !== lockedSupplier
        && !picks[id]?.picked) return;
    const turningOn = !picks[id]?.picked;

    /* Sofa SET (Commander 2026-05-29) — a sofa SO converts as a UNIT: every sofa
       compartment AND every accessory (pillows: LONG/SQUARE PILLOW, etc.) of that
       SAME SO travel together on the sofa's PO ("pillow 开在 sofa 里面就要跟 sofa
       的 PO 一起"). Ticking ANY set member ticks the whole set. An accessory only
       joins a set when its SO actually contains a sofa — accessories on a
       sofa-less SO behave as normal standalone lines. */
    const grp = (row.itemGroup ?? '').toLowerCase();
    const docHasSofa = items.some(
      (r) => r.soDocNo === row.soDocNo && (r.itemGroup ?? '').toLowerCase() === 'sofa',
    );
    const isSetMember = grp === 'sofa' || (grp === 'accessory' && docHasSofa);
    if (isSetMember) {
      const members = items.filter((r) => {
        if (r.soDocNo !== row.soDocNo) return false;
        const g = (r.itemGroup ?? '').toLowerCase();
        return g === 'sofa' || g === 'accessory';
      });
      /* The supplier this set rides on = the sofa's bound supplier (first sofa
         line that has one), else whatever's already locked. */
      const sofaSupplier = members
        .find((r) => (r.itemGroup ?? '').toLowerCase() === 'sofa' && r.mainSupplierCode)?.mainSupplierCode
        ?? row.mainSupplierCode ?? lockedSupplier ?? null;
      /* One PO = one supplier. Members on the sofa's supplier (or unbound) ride
         this PO; members bound to a DIFFERENT supplier (e.g. pillows from another
         vendor) can't sit on it — they split to their own PO ("不同就分开 + 提示"). */
      const rideOn   = members.filter((r) => !r.mainSupplierCode || !sofaSupplier || r.mainSupplierCode === sofaSupplier);
      const splitOff = members.filter((r) => r.mainSupplierCode && sofaSupplier && r.mainSupplierCode !== sofaSupplier);
      setPicks((s) => {
        const next = { ...s };
        for (const m of rideOn) {
          /* Commander 2026-05-30 — when a draft already holds some of this SO
             line's qty, the bulk-set tick defaults to the EFFECTIVE remaining
             (remaining − draft) so it can't over-pick across draft + new. */
          const cap = effectiveRemaining(m);
          if (cap <= 0) continue;
          next[m.soItemId] = turningOn
            ? { picked: true, qty: cap }
            : { picked: false, qty: 0 };
        }
        return next;
      });
      if (turningOn && splitOff.length > 0) {
        const codes = [...new Set(splitOff.map((r) => `${r.itemCode} · ${r.mainSupplierName ?? r.mainSupplierCode}`))];
        setDialog({
          title: 'Accessories need their own PO',
          body: `On SO ${row.soDocNo}, these accessories belong to a different supplier and can't share the sofa's PO. Convert them separately to their own supplier:\n` + codes.map((c) => `• ${c}`).join('\n'),
        });
      }
      return;
    }

    setPicks((s) => ({
      ...s,
      [id]: turningOn ? { picked: true, qty: s[id]?.qty || remaining } : { picked: false, qty: 0 },
    }));
  };

  const setQty = (id: string, qty: number) =>
    setPicks((s) => ({ ...s, [id]: { picked: true, qty } }));

  // Select / clear all currently-VISIBLE rows (respects the active filters).
  // Commander 2026-05-30 — default each row's qty to its EFFECTIVE remaining
  // (remaining − draftQty) so bulk-select honours the draft too.
  const selectAll = () =>
    setPicks((s) => {
      const next = { ...s };
      for (const l of rows) {
        const cap = effectiveRemaining(l);
        if (cap <= 0) continue;
        next[l.soItemId] = { picked: true, qty: cap };
      }
      return next;
    });

  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  // ── Columns — memoized on `picks` so the controlled checkbox + qty input
  //    re-render when pick state changes (DataGrid is React.memo'd). ───────
  const columns = useMemo<DataGridColumn<OutstandingSoItem>[]>(() => [
    {
      key: 'pick', label: '', width: 40, sortable: false, groupable: false,
      accessor: (r) => {
        const on = Boolean(picks[r.soItemId]?.picked);
        const locked = isRowLocked(r);
        return (
          <input
            type="checkbox"
            checked={on}
            disabled={locked}
            onChange={() => togglePick(r.soItemId, effectiveRemaining(r))}
            // Stop the row-select click from also firing.
            onClick={(e) => e.stopPropagation()}
            aria-label={`Pick ${r.itemCode}`}
            style={locked ? { cursor: 'not-allowed' } : undefined}
          />
        );
      },
    },
    {
      key: 'soDocNo', label: 'SO Doc No', width: 120, sortable: true, groupable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.soDocNo}</span>,
      searchValue: (r) => r.soDocNo,
    },
    {
      key: 'debtorName', label: 'Customer', width: 180, sortable: true, groupable: true,
      accessor: (r) => r.debtorName ?? '—',
      searchValue: (r) => r.debtorName ?? '',
      groupValue: (r) => r.debtorName ?? '(none)',
    },
    {
      key: 'itemGroup', label: 'Category', width: 110, sortable: true, groupable: true,
      accessor: (r) => <ItemGroupPill group={r.itemGroup} />,
      searchValue: (r) => r.itemGroup ?? '',
      groupValue: (r) => (r.itemGroup ?? '(none)').toUpperCase(),
    },
    {
      /* Commander 2026-05-28 — the SKU's main supplier (where this line's PO
         goes). "— none —" means unbound: it can't be converted until assigned
         a supplier. */
      key: 'mainSupplier', label: 'Main Supplier', width: 200, sortable: true, groupable: true,
      accessor: (r) =>
        r.mainSupplierCode
          ? <span>{r.mainSupplierCode}{r.mainSupplierName ? ` · ${r.mainSupplierName}` : ''}</span>
          : <span className={styles.muted} style={{ color: 'var(--c-festive-b, #B8331F)' }}>— none —</span>,
      searchValue: (r) => `${r.mainSupplierCode ?? ''} ${r.mainSupplierName ?? ''}`.trim(),
      groupValue: (r) => r.mainSupplierName ?? r.mainSupplierCode ?? '(none)',
    },
    {
      key: 'itemCode', label: 'Item Code', width: 130, sortable: true,
      accessor: (r) => <span style={{ fontWeight: 600 }}>{r.itemCode}</span>,
      searchValue: (r) => r.itemCode ?? '',
    },
    {
      key: 'description', label: 'Description', width: 240, sortable: true,
      accessor: (r) => {
        const draftQty = draftQtyById.get(r.soItemId) ?? 0;
        return (
          <div>
            <VariantDescription
              itemCode={r.itemCode}
              itemGroup={r.itemGroup}
              variants={r.variants}
              description={r.description}
              mutedClassName={styles.muted}
            />
            {draftQty > 0 && (
              <div style={{
                marginTop: 2, fontSize: 'var(--fs-11)', fontWeight: 600,
                color: 'var(--c-burnt)',
              }}>
                In draft: {draftQty} · remaining {effectiveRemaining(r)}
              </div>
            )}
          </div>
        );
      },
      searchValue: (r) => r.description ?? '',
    },
    {
      key: 'qty', label: 'SO Qty', width: 70, align: 'right', sortable: true,
      accessor: (r) => String(r.qty),
      sortFn: (a, b) => a.qty - b.qty,
    },
    {
      key: 'poQtyPicked', label: 'Done', width: 70, align: 'right', sortable: true,
      accessor: (r) => <span className={styles.muted}>{r.poQtyPicked}</span>,
      sortFn: (a, b) => a.poQtyPicked - b.poQtyPicked,
    },
    {
      key: 'pickQty', label: 'Pick Qty', width: 90, align: 'right', sortable: false, groupable: false,
      accessor: (r) => {
        const p = picks[r.soItemId];
        const on = Boolean(p?.picked);
        const locked = isRowLocked(r);
        /* Commander 2026-05-30 — cap the input at the EFFECTIVE remaining
           (remaining − draft) so a partially-consumed SO line can't over-pick
           across the draft + new picks. */
        const cap = effectiveRemaining(r);
        return (
          <input
            type="number"
            min={0}
            max={cap}
            value={on ? p!.qty : ''}
            placeholder={String(cap)}
            disabled={locked}
            /* Commander 2026-05-28 — always editable: typing a qty auto-selects
               the row (no need to tick the checkbox first). */
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              setQty(r.soItemId, Math.min(cap, Math.max(0, Number(e.target.value) || 0)))}
            style={{ ...FILTER_INPUT, width: 64, textAlign: 'right', ...(locked ? { cursor: 'not-allowed', background: 'var(--c-cream)' } : null) }}
          />
        );
      },
    },
    {
      /* Commander 2026-05-29 — add Processing Date column. */
      key: 'processingDate', label: 'Processing Date', width: 120, sortable: true,
      accessor: (r) => fmtDateOrDash(r.processingDate ?? null),
      searchValue: (r) => r.processingDate ?? '',
      sortFn: (a, b) => String(a.processingDate ?? '').localeCompare(String(b.processingDate ?? '')),
    },
    {
      key: 'deliveryDate', label: 'Delivery Date', width: 120, sortable: true,
      accessor: (r) => fmtDateOrDash((r.lineDeliveryDate ?? r.deliveryDate) ?? null),
      searchValue: (r) => r.lineDeliveryDate ?? r.deliveryDate ?? '',
      sortFn: (a, b) =>
        String(a.lineDeliveryDate ?? a.deliveryDate ?? '')
          .localeCompare(String(b.lineDeliveryDate ?? b.deliveryDate ?? '')),
    },
    {
      key: 'lineValue', label: 'Line Value', width: 120, align: 'right', sortable: true,
      accessor: (r) => {
        const p = picks[r.soItemId];
        /* Commander 2026-05-30 — preview value defaults to the EFFECTIVE
           remaining (after draft) so the muted value matches the cap. */
        const pickQty = p?.picked ? p.qty : effectiveRemaining(r);
        return (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
            {fmtRm(pickQty * r.unitPriceSen)}
          </span>
        );
      },
      sortFn: (a, b) => a.remainingQty * a.unitPriceSen - b.remainingQty * b.unitPriceSen,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  ], [picks, draftQtyById]);

  // ── Add to PO ────────────────────────────────────────────────────────
  // Commander 2026-05-29 — two modes:
  //   • PO-scoped (?poId): APPEND the picked lines straight to that PO, then
  //     return to the PO detail page (Transfer from Sales Order / Add Line Item).
  //   • Default: stash the picks + feed the New PO form (/scm/purchase-orders/new).
  const onSave = () => {
    if (pickedCount === 0) { setDialog({ title: 'Nothing picked', body: 'Tick at least one SO line first.' }); return; }

    if (targetPoId) {
      const picksPayload = picked.map(([soItemId, v]) => ({ soItemId, qty: v.qty }));
      createPos.mutate(
        { picks: picksPayload, targetPoId, idempotencyKey: idemKey },
        {
          onSuccess: (res) => {
            // Land back on the PO still in Edit mode so the new lines are right there.
            navigate(`/scm/purchase-orders/${res.targetPoId ?? targetPoId}?edit=1`);
          },
          onError: (e) => setDialog({
            title: 'Add failed',
            body: e instanceof Error ? e.message : 'Something went wrong.',
          }),
        },
      );
      return;
    }

    const out = picked
      .map(([soItemId, v]) => {
        const row = items.find((r) => r.soItemId === soItemId);
        return row ? { ...row, _pickQty: v.qty } : null;
      })
      .filter(Boolean);
    if (!writeScmHandoff('poFromSoPicks', out)) {
      setDialog({ title: 'Unable to continue', body: 'This browser could not safely store your picked lines. Your selection is still here; free some browser storage and try again.' });
      return;
    }
    navigate('/scm/purchase-orders/new');
  };

  // ── Toolbar (filters + select/clear) rendered inside the DataGrid ──────
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
        {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      {/* Date-range filter — pick which date field + from/to. */}
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
      {/* Explicit back target, not history-back: this picker is reachable from
          a PO being edited, from New PO, and from the list, and each entry
          point has its own correct destination (carried over verbatim from the
          action-rail link this replaced). */}
      <PageHeader
        back={targetPoId ? `/scm/purchase-orders/${targetPoId}?edit=1`
          : cameFromNewPage ? '/scm/purchase-orders/new'
          : '/scm/purchase-orders'}
        eyebrow="Procurement"
        title={`Pick Sales Orders for this PO${targetPoNumber ? ` · ${targetPoNumber}` : ''}`}
        actions={
          <div className={styles.actions}>
            <Button
              variant="ghost" size="md"
              onClick={() => navigate(
                targetPoId ? `/scm/purchase-orders/${targetPoId}?edit=1`
                : cameFromNewPage ? '/scm/purchase-orders/new'
                : '/scm/purchase-orders'
              )}
            >
              <X {...ICON} /> Cancel
            </Button>
            <Button
              variant="primary" size="md"
              onClick={onSave}
              disabled={pickedCount === 0 || createPos.isPending}
              title={targetPoId ? 'Add the picked SO lines into this PO' : 'Add the picked SO lines into the New PO form'}
            >
              <Save {...ICON} />
              {createPos.isPending
                ? 'Adding…'
                : pickedCount === 0 ? 'Pick at least 1 line' : `Add ${pickedCount} line${pickedCount === 1 ? '' : 's'} to PO`}
            </Button>
          </div>
        }
      />
      {lockedSupplier && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          One supplier per PO — locked to <strong>{lockedSupplier}</strong>. Other suppliers' lines
          are greyed out; clear picks to switch.
        </p>
      )}

      <DataGrid<OutstandingSoItem>
        rows={rows}
        columns={columns}
        storageKey={STORAGE_KEY}
        rowKey={(r) => r.soItemId}
        searchPlaceholder="Search SO, customer, item…"
        /* Commander 2026-05-28 — click anywhere on a row to toggle its pick
           (the checkbox is just a visual). */
        onRowClick={(r) => togglePick(r.soItemId, r.remainingQty)}
        /* Commander 2026-05-29 — grey out rows whose supplier conflicts with
           the locked one so the disabled state is obvious. */
        rowStyle={(r) => isRowLocked(r)
          ? { opacity: 0.45, background: 'var(--c-cream)', cursor: 'not-allowed' }
          : undefined}
        toolbar={toolbar}
        groupBanner={false}
        isLoading={itemsQ.isLoading}
        /* A failed read must NEVER render as the sentence below. "We couldn't
           load the lines" and "there are no lines left to do" are opposite
           facts, and the operator acts on the second one by walking away from
           work that is still outstanding.

           NEITHER MAY AN EMPTY ONE (owner 2026-08-17). This screen used to
           report an empty result as a finished job — "every line has been
           fully ...". An empty result is only ever evidence that THE QUERY
           FOUND NOTHING: the read is scoped to the active company and
           scopeToCompany FAILS CLOSED (scm/lib/companyScope.ts ->
           .in('company_id', []) returns [] with error: null), PostgREST
           truncates at db-max-rows without saying so, and a swallowed read
           error is shaped identically to an empty one. The same claim was
           removed from the from-PO picker in #2367 and reintroduced five
           commits later, which is why backend/scripts/check-empty-state-claims.mjs
           now gates it instead of a comment asking nicely. */
        emptyMessage={itemsQ.isError
          ? "We couldn't load the outstanding lines, so this list is incomplete. That is not the same as there being none left — please refresh and try again."
          : items.length > 0
            ? `None of the ${items.length} outstanding SO line(s) that loaded match the filters on this screen. Clear the filters to see them.`
            : "This search came back with no outstanding SO lines. That is not the same as everything having been converted — the list only covers the company you are working in, and lines it cannot see look identical to lines that are done. Open the sales order and check its balance before treating this as nothing left to purchase."}
      />

      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          primaryLabel={dialog.goTo ? 'Open Purchase Orders' : undefined}
          onPrimary={dialog.goTo ? () => { const g = dialog.goTo!; setDialog(null); navigate(g); } : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
