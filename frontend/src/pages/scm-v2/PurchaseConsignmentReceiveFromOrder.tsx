// ----------------------------------------------------------------------------
// PurchaseConsignmentReceiveFromOrder — LINE-LEVEL, QUANTITY-BASED Purchase
// Consignment Order → Receive picker. Mirrors GrnFromPo on the consignment side:
// the operator picks individual PC Order LINES, each with a receive qty
// 1..outstanding (outstanding = ordered − received, derived LIVE by the server).
// A line can be received across several receives until outstanding reaches 0.
//
// A supplier-lock keeps the merge clean: once one line is ticked, lines of a
// DIFFERENT supplier grey out — a receive is for ONE supplier.
//
// Continue stashes the picked lines in the scoped SCM handoff store and
// opens the normal New Purchase Consignment Receive form prefilled for review
// (?fromPicks=1). No inventory moves until Create.
//
// Routing: /purchase-consignment-receive/from-pc-order.
// ----------------------------------------------------------------------------

import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { writeScmHandoff } from '../../lib/scmHandoffStorage';
import { ArrowRight, X, CheckSquare, Square } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useOutstandingPcOrderLines, type OutstandingPcOrderLine } from '../../vendor/scm/lib/purchase-consignment-receive-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const QTY_INPUT: CSSProperties = {
  height: 28,
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 8px',
  fontSize: 'var(--fs-12)',
  background: 'var(--c-paper)',
  color: 'var(--c-ink)',
};

const suppKey = (l: OutstandingPcOrderLine): string =>
  (l.supplierId && l.supplierId.trim())
    ? `id:${l.supplierId.trim()}`
    : `name:${(l.supplierName ?? '').trim().toUpperCase()}`;

type Pick = { picked: boolean; qty: number };

export const PurchaseConsignmentReceiveFromOrder = () => {
  const navigate = useNavigate();
  const linesQ = useOutstandingPcOrderLines();

  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [dialog, setDialog] = useState<{ title: string; body: string } | null>(null);

  const rows = useMemo<OutstandingPcOrderLine[]>(() => linesQ.data ?? [], [linesQ.data]);

  const rowById = useMemo(() => {
    const m = new Map<string, OutstandingPcOrderLine>();
    for (const r of rows) m.set(r.orderItemId, r);
    return m;
  }, [rows]);

  const lockedSupplier = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const r = rowById.get(id);
      if (r) return suppKey(r);
    }
    return null;
  }, [picks, rowById]);

  const lockedSupplierName = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const r = rowById.get(id);
      if (r) return r.supplierName ?? '(none)';
    }
    return null;
  }, [picks, rowById]);

  const isRowLocked = (r: OutstandingPcOrderLine): boolean =>
    Boolean(lockedSupplier && suppKey(r) !== lockedSupplier && !picks[r.orderItemId]?.picked);

  const togglePick = (r: OutstandingPcOrderLine) => {
    if (isRowLocked(r)) return;
    const turningOn = !picks[r.orderItemId]?.picked;
    setPicks((s) => ({
      ...s,
      [r.orderItemId]: turningOn
        ? { picked: true, qty: s[r.orderItemId]?.qty || r.outstanding }
        : { picked: false, qty: 0 },
    }));
  };

  const setQty = (r: OutstandingPcOrderLine, qty: number) => {
    if (isRowLocked(r)) return;
    setPicks((s) => ({ ...s, [r.orderItemId]: { picked: true, qty } }));
  };

  const selectAll = () => {
    setPicks((s) => {
      const next = { ...s };
      const key = lockedSupplier ?? (rows[0] ? suppKey(rows[0]) : null);
      if (!key) return next;
      for (const r of rows) if (suppKey(r) === key) next[r.orderItemId] = { picked: true, qty: r.outstanding };
      return next;
    });
  };
  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  const columns = useMemo<DataGridColumn<OutstandingPcOrderLine>[]>(() => [
    {
      key: 'pick', label: '', width: 40, sortable: false, groupable: false,
      accessor: (r) => {
        const on = Boolean(picks[r.orderItemId]?.picked);
        const locked = isRowLocked(r);
        return (
          <input
            type="checkbox"
            checked={on}
            disabled={locked}
            onChange={() => togglePick(r)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Pick ${r.itemCode}`}
            style={locked ? { cursor: 'not-allowed' } : undefined}
          />
        );
      },
    },
    {
      key: 'pcNumber', label: 'PC No', width: 150, sortable: true, groupable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.pcNumber}</span>,
      searchValue: (r) => r.pcNumber,
      groupValue: (r) => r.pcNumber,
    },
    {
      key: 'supplierName', label: 'Supplier', width: 200, sortable: true, groupable: true,
      accessor: (r) => r.supplierName ?? '—',
      searchValue: (r) => r.supplierName ?? '',
      groupValue: (r) => r.supplierName ?? '(none)',
    },
    {
      key: 'itemGroup', label: 'Category', width: 110, sortable: true, groupable: true,
      accessor: (r) => <ItemGroupPill group={r.itemGroup} />,
      searchValue: (r) => r.itemGroup ?? '',
      groupValue: (r) => (r.itemGroup ?? '(none)').toUpperCase(),
    },
    {
      key: 'itemCode', label: 'Material Code', width: 140, sortable: true,
      accessor: (r) => <span style={{ fontWeight: 600 }}>{r.itemCode}</span>,
      searchValue: (r) => r.itemCode ?? '',
    },
    {
      key: 'materialName', label: 'Material', width: 220, sortable: true,
      accessor: (r) => r.materialName || <span className={styles.muted}>—</span>,
      searchValue: (r) => `${r.materialName ?? ''} ${r.description ?? ''}`.trim(),
    },
    {
      key: 'ordered', label: 'Ordered', width: 80, align: 'right', sortable: true,
      accessor: (r) => String(r.ordered),
      sortFn: (a, b) => a.ordered - b.ordered,
    },
    {
      key: 'received', label: 'Received', width: 80, align: 'right', sortable: true,
      accessor: (r) => <span className={styles.muted}>{r.received}</span>,
      sortFn: (a, b) => a.received - b.received,
    },
    {
      key: 'outstanding', label: 'Outstanding', width: 90, align: 'right', sortable: true,
      accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{r.outstanding}</span>,
      sortFn: (a, b) => a.outstanding - b.outstanding,
    },
    {
      key: 'pickQty', label: 'Qty to Receive', width: 120, align: 'right', sortable: false, groupable: false,
      accessor: (r) => {
        const p = picks[r.orderItemId];
        const on = Boolean(p?.picked);
        const locked = isRowLocked(r);
        return (
          <input
            type="number"
            min={0}
            max={r.outstanding}
            value={on ? p!.qty : ''}
            placeholder={String(r.outstanding)}
            disabled={locked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              setQty(r, Math.min(r.outstanding, Math.max(0, Number(e.target.value) || 0)))}
            style={{ ...QTY_INPUT, width: 84, textAlign: 'right', ...(locked ? { cursor: 'not-allowed', background: 'var(--c-cream)' } : null) }}
          />
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  ], [picks, lockedSupplier]);

  const onContinue = () => {
    if (pickedCount === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one PC Order line to receive first.' });
      return;
    }
    const stash = picked
      .map(([orderItemId, v]) => {
        const r = rowById.get(orderItemId);
        if (!r) return null;
        return {
          orderItemId,
          purchaseConsignmentOrderId: r.purchaseConsignmentOrderId,
          pcNumber: r.pcNumber,
          supplierId: r.supplierId,
          supplierName: r.supplierName,
          materialKind: r.materialKind,
          itemCode: r.itemCode,
          materialName: r.materialName,
          supplierSku: r.supplierSku,
          itemGroup: r.itemGroup,
          description: r.description,
          uom: r.uom,
          qty: v.qty,
          unitPriceSen: r.unitPriceSen,
          variants: r.variants,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    if (stash.length === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one PC Order line to receive first.' });
      return;
    }

    const firstOrderId = stash[0]?.purchaseConsignmentOrderId ?? '';
    if (!writeScmHandoff('pcrFromOrderPicks', stash)) {
      setDialog({ title: 'Unable to continue', body: 'This browser could not safely store your picked lines. Your selection is still here; free some browser storage and try again.' });
      return;
    }
    navigate(`/scm/purchase-consignment-receives/new?fromPcOrder=${encodeURIComponent(firstOrderId)}&fromPicks=1`);
  };

  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <Button variant="ghost" size="sm" onClick={selectAll} disabled={rows.length === 0}>
        <CheckSquare {...ICON} /> Select all
      </Button>
      <Button variant="ghost" size="sm" onClick={clearAll} disabled={pickedCount === 0}>
        <Square {...ICON} /> Clear all
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Procurement"
        title="Pick PC Order lines to receive"
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-consignment-receives')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button
              variant="primary" size="md"
              onClick={onContinue}
              disabled={pickedCount === 0}
              title="Open the New Purchase Consignment Receive form prefilled with the picked PC Order lines"
            >
              <ArrowRight {...ICON} />
              {pickedCount === 0
                ? 'Pick at least 1 line'
                : `Continue with ${pickedCount} line${pickedCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        }
      />
      <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        Pick the Purchase Consignment Order lines being received and set the quantity for each. A line can be
        received in parts across several receives — only the outstanding (not-yet-received) quantity is shown.
        Continuing opens the normal New Purchase Consignment Receive form, prefilled for review.
      </p>
      {lockedSupplierName && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          One supplier per Receive — locked to <strong>{lockedSupplierName}</strong>. Other suppliers' lines
          are greyed out; clear picks to switch.
        </p>
      )}

      <DataGrid<OutstandingPcOrderLine>
        rows={rows}
        columns={columns}
        storageKey="pcr-g.pcr-from-order-lines.layout.v1"
        rowKey={(r) => r.orderItemId}
        searchPlaceholder="Search PC No, supplier, material…"
        onRowClick={(r) => togglePick(r)}
        rowStyle={(r) => isRowLocked(r)
          ? { opacity: 0.45, background: 'var(--c-cream)', cursor: 'not-allowed' }
          : undefined}
        toolbar={toolbar}
        groupBanner={false}
        isLoading={linesQ.isLoading}
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
        emptyMessage={linesQ.isError
          ? "We couldn't load the outstanding lines, so this list is incomplete. That is not the same as there being none left — please refresh and try again."
          : "This search came back with no outstanding PC Order lines. That is not the same as everything having been received — the list only covers the company you are working in, and lines it cannot see look identical to lines that are done. Open the consignment order and check its balance before treating this as nothing left to receive."}
      />

      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
