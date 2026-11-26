
import { useProductCategories } from '../../vendor/scm/lib/product-categories-store';
import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Save, X, CheckSquare, Square, Filter } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { fmtDateOrDash, fmtMoneySen, fmtQty } from '@2990s/shared';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import {
  useOutstandingSoItems,
  useCreatePosFromSoItems,
  usePurchaseOrderDetail,
  type OutstandingSoItem,
} from '../../vendor/scm/lib/suppliers-queries';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, writeScmHandoff } from '../../lib/scmHandoffStorage';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { soRefOfCamelStamp } from '../../lib/so-ref-search';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

const STORAGE_KEY = 'po-from-so.layout.v1';

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
  { value: 'soDate',       label: 'SO Date' },
  { value: 'processing',   label: 'Processing Date' },
  { value: 'delivery',     label: 'Delivery Date' },
] as const;
type DateField = typeof DATE_FIELD_OPTIONS[number]['value'];

const rowDateFor = (r: OutstandingSoItem, field: DateField): string | null => {
  if (field === 'soDate')     return r.soDate ?? null;
  if (field === 'processing') return r.processingDate ?? null;
  return r.lineDeliveryDate ?? r.deliveryDate ?? null;
};

type Pick = { picked: boolean; qty: number };

export const PurchaseOrderFromSo = () => {
  const navigate = useNavigate();
  const CATEGORY_OPTIONS = [
    { value: 'all', label: 'All categories' },
    ...useProductCategories().active.map((c) => ({ value: c.code.toLowerCase(), label: c.name })),
  ];
  const itemsQ   = useOutstandingSoItems();

  const [searchParams] = useSearchParams();
  const targetPoId = searchParams.get('poId');
  const targetPoQ = usePurchaseOrderDetail(targetPoId);
  const targetPoSupplierCode = targetPoQ.data?.purchaseOrder?.supplier?.code ?? null;
  const targetPoNumber = targetPoQ.data?.purchaseOrder?.po_number ?? null;
  const createPos = useCreatePosFromSoItems();
  const idemKey = useIdempotencyKey();

  const [picks, setPicks] = useState<Record<string, Pick>>({});

  const [category, setCategory]   = useState<string>('all');
  const [dateField, setDateField] = useState<DateField>('soDate');
  const [dateFrom, setDateFrom]   = useState<string>('');
  const [dateTo, setDateTo]       = useState<string>('');

  const [dialog, setDialog] = useState<{ title: string; body: string; goTo?: string } | null>(null);

  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);

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

  const effectiveRemaining = (r: OutstandingSoItem): number =>
    r.remainingQty - (draftQtyById.get(r.soItemId) ?? 0);

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

  const lockedSupplier = useMemo(() => {
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

  const togglePick = (id: string, remaining: number) => {
    const row = items.find((r) => r.soItemId === id);
    if (!row) return;
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

  const columns = useMemo<GridColumn<OutstandingSoItem>[]>(() => [
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
      key: 'soRef', label: 'Ref No.', width: 150, sortable: true,
      accessor: (r) => soRefOfCamelStamp(r) || '—',
      searchValue: (r) => soRefOfCamelStamp(r),
      sortFn: (a, b) => soRefOfCamelStamp(a).localeCompare(soRefOfCamelStamp(b)),
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
      key: 'mainSupplier', label: 'Main Supplier', width: 200, sortable: true, groupable: true,
      accessor: (r) =>
        r.mainSupplierCode
          ? <span>{r.mainSupplierCode}{r.mainSupplierName ? ` · ${r.mainSupplierName}` : ''}</span>
          : <span className={styles.muted} style={{ color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>— none —</span>,
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
      accessor: (r) => fmtQty(r.qty),
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
        const cap = effectiveRemaining(r);
        return (
          <input
            type="number"
            min={0}
            max={cap}
            value={on ? p!.qty : ''}
            placeholder={String(cap)}
            disabled={locked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              setQty(r.soItemId, Math.min(cap, Math.max(0, Number(e.target.value) || 0)))}
            style={{ ...FILTER_INPUT, width: 64, textAlign: 'right', ...(locked ? { cursor: 'not-allowed', background: 'var(--c-cream)' } : null) }}
          />
        );
      },
    },
    {
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
        const pickQty = p?.picked ? p.qty : effectiveRemaining(r);
        return (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
            {fmtRm(pickQty * r.unitPriceSen)}
          </span>
        );
      },
      exportValue: (r) => ((Object.hasOwn(picks, r.soItemId) && picks[r.soItemId].picked ? picks[r.soItemId].qty : effectiveRemaining(r)) * r.unitPriceSen) / 100,
      exportFormat: 'money',
      sortFn: (a, b) => a.remainingQty * a.unitPriceSen - b.remainingQty * b.unitPriceSen,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  ], [picks, draftQtyById]);

  const onSave = () => {
    if (pickedCount === 0) { setDialog({ title: 'Nothing picked', body: 'Tick at least one SO line first.' }); return; }

    if (targetPoId) {
      const picksPayload = picked.map(([soItemId, v]) => ({ soItemId, qty: v.qty }));
      createPos.mutate(
        { picks: picksPayload, targetPoId, idempotencyKey: idemKey },
        {
          onSuccess: (res) => {
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
        {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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

      <DataGridCompat<OutstandingSoItem>
        rows={rows}
        columns={columns}
        storageKey={STORAGE_KEY}
        rowKey={(r) => r.soItemId}
        searchPlaceholder="Search SO, customer, item…"
        onRowClick={(r) => togglePick(r.soItemId, r.remainingQty)}
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
