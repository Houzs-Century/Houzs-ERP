// ----------------------------------------------------------------------------
// DeliveryReturnFromDo — LINE-LEVEL, QUANTITY-BASED Delivery Order → Delivery
// Return picker.
//
// Commander 2026-05-30 (Phase B) rewrite: partial-return model, mirroring the
// SO→DO line-level picker (DeliveryOrderFromSo.tsx) + the new SI from-DO picker.
// Instead of ticking a whole Delivery Order, the operator picks individual DO
// LINES, each with a return qty 1..remaining (and a condition). A DO line can be
// returned across SEVERAL Delivery Returns until its remaining (delivered −
// invoiced − returned, derived LIVE by the server) reaches 0:
//   - Still returnable (remaining > 0) → the line is pickable.
//   - Fully invoiced/returned (remaining == 0) → the line drops out.
//   - Cancelling a return (or an invoice) RAISES remaining again automatically.
//
// Invoicing + returning compete for the SAME Pending pool, so an invoiced unit
// can't be returned — it never appears here.
//
// A customer-lock keeps the merge clean: once one line is ticked, lines of a
// DIFFERENT customer grey out — a return is for ONE customer.
//
// Continue stashes the picked lines (carrying each line's doItemId + condition)
// and opens the normal New Delivery Return form prefilled for review. No stock
// moves back IN until the operator clicks Create there — that POST increases
// stock and caps each line at its live remaining-to-return via the same guard
// the old auto-convert used.
//
// Routing: /delivery-returns/from-do.
// ----------------------------------------------------------------------------

import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { writeScmHandoff } from '../../lib/scmHandoffStorage';
import { ArrowRight, X, CheckSquare, Square } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import { useReturnableDoLines, type DoRemainingLine } from '../../vendor/scm/lib/delivery-return-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtMoneySen } from '@2990s/shared';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

const STORAGE_KEY = 'pr-g.dr-from-do-lines.layout.v1';

const CONDITIONS = ['NEW', 'OPENED', 'DAMAGED', 'DEFECTIVE'] as const;

/* Compact pill input — mirrors the SO→DO picker's qty input. */
const QTY_INPUT: CSSProperties = {
  height: 28,
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 8px',
  fontSize: 'var(--fs-12)',
  background: 'var(--c-paper)',
  color: 'var(--c-ink)',
};

/* One distinct customer key per DO line — match the server's same-customer rule:
   debtor_code when present, else fall back to debtor_name. */
const custKey = (l: DoRemainingLine): string =>
  (l.debtorCode && l.debtorCode.trim())
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;

type Pick = { picked: boolean; qty: number; condition: string };

export const DeliveryReturnFromDo = () => {
  const navigate = useNavigate();
  const linesQ = useReturnableDoLines();

  // Map<doItemId, { picked, qty, condition }>. Defaults: picked = false; when
  // ticked, qty defaults to the line's remaining, condition to NEW.
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [dialog, setDialog] = useState<{ title: string; body: string } | null>(null);

  const rows = useMemo<DoRemainingLine[]>(() => linesQ.data ?? [], [linesQ.data]);

  const rowById = useMemo(() => {
    const m = new Map<string, DoRemainingLine>();
    for (const r of rows) m.set(r.doItemId, r);
    return m;
  }, [rows]);

  const lockedCustomer = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const r = rowById.get(id);
      if (r) return custKey(r);
    }
    return null;
  }, [picks, rowById]);

  const lockedCustomerName = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const r = rowById.get(id);
      if (r) return r.debtorName ?? r.debtorCode ?? '(none)';
    }
    return null;
  }, [picks, rowById]);

  const isRowLocked = (r: DoRemainingLine): boolean =>
    Boolean(lockedCustomer && custKey(r) !== lockedCustomer && !picks[r.doItemId]?.picked);

  const togglePick = (r: DoRemainingLine) => {
    if (isRowLocked(r)) return;
    const turningOn = !picks[r.doItemId]?.picked;
    setPicks((s) => ({
      ...s,
      [r.doItemId]: turningOn
        ? { picked: true, qty: s[r.doItemId]?.qty || r.remaining, condition: s[r.doItemId]?.condition || 'NEW' }
        : { picked: false, qty: 0, condition: s[r.doItemId]?.condition || 'NEW' },
    }));
  };

  const setQty = (r: DoRemainingLine, qty: number) => {
    if (isRowLocked(r)) return;
    setPicks((s) => ({ ...s, [r.doItemId]: { picked: true, qty, condition: s[r.doItemId]?.condition || 'NEW' } }));
  };

  const setCondition = (r: DoRemainingLine, condition: string) => {
    if (isRowLocked(r)) return;
    setPicks((s) => {
      const prev = s[r.doItemId];
      return { ...s, [r.doItemId]: { picked: prev?.picked ?? true, qty: prev?.picked ? prev.qty : r.remaining, condition } };
    });
  };

  const selectAll = () => {
    setPicks((s) => {
      const next = { ...s };
      const key = lockedCustomer ?? (rows[0] ? custKey(rows[0]) : null);
      if (!key) return next;
      for (const r of rows) if (custKey(r) === key) next[r.doItemId] = { picked: true, qty: r.remaining, condition: next[r.doItemId]?.condition || 'NEW' };
      return next;
    });
  };
  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  const columns = useMemo<DataGridColumn<DoRemainingLine>[]>(() => [
    {
      key: 'pick', label: '', width: 40, sortable: false, groupable: false,
      accessor: (r) => {
        const on = Boolean(picks[r.doItemId]?.picked);
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
      key: 'doNumber', label: 'DO No', width: 140, sortable: true, groupable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.doNumber}</span>,
      searchValue: (r) => r.doNumber,
      groupValue: (r) => r.doNumber,
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
      key: 'delivered', label: 'Delivered', width: 80, align: 'right', sortable: true,
      accessor: (r) => String(r.delivered),
      sortFn: (a, b) => a.delivered - b.delivered,
    },
    {
      key: 'returned', label: 'Returned', width: 80, align: 'right', sortable: true,
      accessor: (r) => <span className={styles.muted}>{r.returned}</span>,
      sortFn: (a, b) => a.returned - b.returned,
    },
    {
      key: 'remaining', label: 'Remaining', width: 80, align: 'right', sortable: true,
      accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{r.remaining}</span>,
      sortFn: (a, b) => a.remaining - b.remaining,
    },
    {
      key: 'pickQty', label: 'Qty to Return', width: 110, align: 'right', sortable: false, groupable: false,
      accessor: (r) => {
        const p = picks[r.doItemId];
        const on = Boolean(p?.picked);
        const locked = isRowLocked(r);
        return (
          <input
            type="number"
            min={0}
            max={r.remaining}
            value={on ? p!.qty : ''}
            placeholder={String(r.remaining)}
            disabled={locked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              setQty(r, Math.min(r.remaining, Math.max(0, Number(e.target.value) || 0)))}
            style={{ ...QTY_INPUT, width: 76, textAlign: 'right', ...(locked ? { cursor: 'not-allowed', background: 'var(--c-cream)' } : null) }}
          />
        );
      },
    },
    {
      key: 'condition', label: 'Condition', width: 130, sortable: false, groupable: false,
      accessor: (r) => {
        const p = picks[r.doItemId];
        const locked = isRowLocked(r);
        return (
          <select
            value={p?.condition ?? 'NEW'}
            disabled={locked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setCondition(r, e.target.value)}
            style={{ ...QTY_INPUT, width: 118, ...(locked ? { cursor: 'not-allowed', background: 'var(--c-cream)' } : null) }}
          >
            {sortByText(CONDITIONS).map((cond) => <option key={cond} value={cond}>{cond}</option>)}
          </select>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  ], [picks, lockedCustomer]);

  const onContinue = () => {
    if (pickedCount === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Delivery Order line to return first.' });
      return;
    }
    // Stash the picked lines (qty + condition) and open the normal New Delivery
    // Return form prefilled for review. No stock moves back IN until the operator
    // clicks Create on that screen.
    const stash = picked
      .map(([doItemId, v]) => {
        const r = rowById.get(doItemId);
        if (!r) return null;
        return {
          doItemId,
          deliveryOrderId: r.deliveryOrderId,
          itemCode: r.itemCode,
          itemGroup: r.itemGroup,
          description: r.description,
          uom: r.uom,
          qty: v.qty,
          condition: v.condition,
          unitPriceSen: r.unitPriceSen,
          discountSen: r.discountSen,
          unitCostSen: r.unitCostSen,
          variants: r.variants,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    if (stash.length === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Delivery Order line to return first.' });
      return;
    }

    const firstDoId = stash.map((s) => s.deliveryOrderId).sort()[0] ?? '';
    if (!writeScmHandoff('drFromDoPicks', stash)) {
      setDialog({ title: 'Unable to continue', body: 'This browser could not safely store your picked lines. Your selection is still here; free some browser storage and try again.' });
      return;
    }
    navigate(`/scm/delivery-returns/new?fromDo=${encodeURIComponent(firstDoId)}&fromPicks=1`);
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
        title="Pick Delivery Order lines to return"
        actions={
          <>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/delivery-returns')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button
                variant="primary" size="md"
                onClick={onContinue}
                disabled={pickedCount === 0}
                title="Open the New Delivery Return form prefilled with the picked Delivery Order lines"
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
        Pick the Delivery Order lines being returned and set the quantity + condition for each. A line can be
        returned in parts across several returns — only the remaining (not-yet-returned, not-yet-invoiced)
        quantity is shown. Continuing opens the normal New Delivery Return form, prefilled for review — no
        stock goes back IN until you click Create on that screen.
      </p>
      {lockedCustomerName && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          One customer per Delivery Return — locked to <strong>{lockedCustomerName}</strong>. Other
          customers' lines are greyed out; clear picks to switch.
        </p>
      )}

      <DataGrid<DoRemainingLine>
        rows={rows}
        columns={columns}
        storageKey={STORAGE_KEY}
        rowKey={(r) => r.doItemId}
        searchPlaceholder="Search DO, customer, item…"
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
          : "This search came back with no returnable Delivery Order lines. That is not the same as everything having been returned or invoiced — the list only covers the company you are working in, and lines it cannot see look identical to lines that are done. Open the delivery order and check its balance before treating this as nothing left to return."}
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
