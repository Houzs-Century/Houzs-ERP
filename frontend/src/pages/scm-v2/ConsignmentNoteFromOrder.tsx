// ----------------------------------------------------------------------------
// ConsignmentNoteFromOrder — LINE-LEVEL, QUANTITY-BASED Consignment Order →
// Consignment Note picker. Mirrors DeliveryOrderFromSo on the consignment side:
// the operator picks individual Consignment Order LINES, each with a deliver qty
// 1..outstanding (outstanding = ordered − already-noted, derived LIVE by the
// server). A line can be noted across several Consignment Notes until its
// outstanding reaches 0.
//
// A debtor-lock keeps the merge clean: once one line is ticked, lines of a
// DIFFERENT debtor grey out — a note is for ONE debtor.
//
// Continue stashes the picked lines in the scoped SCM handoff store and
// opens the normal New Consignment Note form prefilled for review (?fromPicks=1).
//
// Routing: /scm/consignment-notes/from-order.
// ----------------------------------------------------------------------------

import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { writeScmHandoff } from '../../lib/scmHandoffStorage';
import { ArrowRight, X, CheckSquare, Square } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import { useDeliverableOrderLines, type DeliverableOrderLine } from '../../vendor/scm/lib/consignment-note-queries';
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

const custKey = (l: DeliverableOrderLine): string =>
  (l.debtorCode && l.debtorCode.trim())
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;

type Pick = { picked: boolean; qty: number };

export const ConsignmentNoteFromOrder = () => {
  const navigate = useNavigate();
  const linesQ = useDeliverableOrderLines();

  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [dialog, setDialog] = useState<{ title: string; body: string } | null>(null);

  const rows = useMemo<DeliverableOrderLine[]>(() => linesQ.data ?? [], [linesQ.data]);

  const rowById = useMemo(() => {
    const m = new Map<string, DeliverableOrderLine>();
    for (const r of rows) m.set(r.orderItemId, r);
    return m;
  }, [rows]);

  const lockedDebtor = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const r = rowById.get(id);
      if (r) return custKey(r);
    }
    return null;
  }, [picks, rowById]);

  const lockedDebtorName = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const r = rowById.get(id);
      if (r) return r.debtorName ?? r.debtorCode ?? '(none)';
    }
    return null;
  }, [picks, rowById]);

  const isRowLocked = (r: DeliverableOrderLine): boolean =>
    Boolean(lockedDebtor && custKey(r) !== lockedDebtor && !picks[r.orderItemId]?.picked);

  const togglePick = (r: DeliverableOrderLine) => {
    if (isRowLocked(r)) return;
    const turningOn = !picks[r.orderItemId]?.picked;
    setPicks((s) => ({
      ...s,
      [r.orderItemId]: turningOn
        ? { picked: true, qty: s[r.orderItemId]?.qty || r.outstanding }
        : { picked: false, qty: 0 },
    }));
  };

  const setQty = (r: DeliverableOrderLine, qty: number) => {
    if (isRowLocked(r)) return;
    setPicks((s) => ({ ...s, [r.orderItemId]: { picked: true, qty } }));
  };

  const selectAll = () => {
    setPicks((s) => {
      const next = { ...s };
      const key = lockedDebtor ?? (rows[0] ? custKey(rows[0]) : null);
      if (!key) return next;
      for (const r of rows) if (custKey(r) === key) next[r.orderItemId] = { picked: true, qty: r.outstanding };
      return next;
    });
  };
  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  const columns = useMemo<DataGridColumn<DeliverableOrderLine>[]>(() => [
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
      key: 'orderDocNo', label: 'Order No', width: 150, sortable: true, groupable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.orderDocNo}</span>,
      searchValue: (r) => r.orderDocNo,
      groupValue: (r) => r.orderDocNo,
    },
    {
      key: 'debtorName', label: 'Customer', width: 200, sortable: true, groupable: true,
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
      searchValue: (r) => `${r.description ?? ''} ${r.description2 ?? ''}`.trim(),
    },
    {
      key: 'ordered', label: 'Ordered', width: 80, align: 'right', sortable: true,
      accessor: (r) => String(r.ordered),
      sortFn: (a, b) => a.ordered - b.ordered,
    },
    {
      key: 'delivered', label: 'Noted', width: 80, align: 'right', sortable: true,
      accessor: (r) => <span className={styles.muted}>{r.delivered}</span>,
      sortFn: (a, b) => a.delivered - b.delivered,
    },
    {
      key: 'outstanding', label: 'Outstanding', width: 90, align: 'right', sortable: true,
      accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{r.outstanding}</span>,
      sortFn: (a, b) => a.outstanding - b.outstanding,
    },
    {
      key: 'pickQty', label: 'Qty to Note', width: 110, align: 'right', sortable: false, groupable: false,
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
            style={{ ...QTY_INPUT, width: 80, textAlign: 'right', ...(locked ? { cursor: 'not-allowed', background: 'var(--c-cream)' } : null) }}
          />
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  ], [picks, lockedDebtor]);

  const onContinue = () => {
    if (pickedCount === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Consignment Order line to note first.' });
      return;
    }
    const stash = picked
      .map(([orderItemId, v]) => {
        const r = rowById.get(orderItemId);
        if (!r) return null;
        return {
          orderItemId,
          orderDocNo: r.orderDocNo,
          debtorCode: r.debtorCode,
          debtorName: r.debtorName,
          itemCode: r.itemCode,
          itemGroup: r.itemGroup,
          description: r.description,
          uom: r.uom,
          qty: v.qty,
          unitPriceSen: r.unitPriceSen,
          discountSen: r.discountSen,
          unitCostSen: r.unitCostSen,
          variants: r.variants,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    if (stash.length === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Consignment Order line to note first.' });
      return;
    }

    const firstDocNo = stash[0]?.orderDocNo ?? '';
    if (!writeScmHandoff('cnFromOrderPicks', stash)) {
      setDialog({ title: 'Unable to continue', body: 'This browser could not safely store your picked lines. Your selection is still here; free some browser storage and try again.' });
      return;
    }
    navigate(`/scm/consignment-notes/new?fromConsignmentOrder=${encodeURIComponent(firstDocNo)}&fromPicks=1`);
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
        eyebrow="Supply Chain"
        title="Pick Consignment Order lines to note"
        actions={
          <>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/consignment-notes')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button
                variant="primary" size="md"
                onClick={onContinue}
                disabled={pickedCount === 0}
                title="Open the New Consignment Note form prefilled with the picked Consignment Order lines"
              >
                <ArrowRight {...ICON} />
                {pickedCount === 0
                  ? 'Pick at least 1 line'
                  : `Continue with ${pickedCount} line${pickedCount === 1 ? '' : 's'}`}
              </Button>
            </div>
          </>
        }
      />
      <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        Pick the Consignment Order lines being placed at the showroom and set the quantity for each. A line can
        be noted in parts across several notes — only the outstanding (not-yet-noted) quantity is shown.
        Continuing opens the normal New Consignment Note form, prefilled for review.
      </p>
      {lockedDebtorName && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          One customer per Consignment Note — locked to <strong>{lockedDebtorName}</strong>. Other customers'
          lines are greyed out; clear picks to switch.
        </p>
      )}

      <DataGrid<DeliverableOrderLine>
        rows={rows}
        columns={columns}
        storageKey="cn-g.cn-from-order-lines.layout.v1"
        rowKey={(r) => r.orderItemId}
        searchPlaceholder="Search order, customer, item…"
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
          : "This search came back with no outstanding Consignment Order lines. That is not the same as everything having been noted — the list only covers the company you are working in, and lines it cannot see look identical to lines that are done. Open the consignment order and check its balance before treating this as nothing left to note."}
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
