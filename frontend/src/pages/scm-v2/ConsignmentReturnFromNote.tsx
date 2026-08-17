// ----------------------------------------------------------------------------
// ConsignmentReturnFromNote — LINE-LEVEL, QUANTITY-BASED Consignment Note →
// Consignment Return picker. Faithful clone of DeliveryReturnFromDo.tsx, on the
// consignment side: the operator picks individual Consignment Note LINES, each
// with a return qty 1..remaining (and a condition). A note line can be returned
// across SEVERAL Consignment Returns until its remaining (delivered − returned,
// derived LIVE by the server) reaches 0.
//
// A debtor-lock keeps the merge clean: once one line is ticked, lines of a
// DIFFERENT debtor grey out — a return is for ONE debtor.
//
// Continue stashes the picked lines (carrying each line's noteItemId + condition)
// to the scoped SCM handoff store and opens the normal New Consignment
// Return form prefilled for review (?fromPicks=1). No stock moves until Create.
//
// Routing: /scm/consignment-returns/from-note.
// ----------------------------------------------------------------------------

import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { writeScmHandoff } from '../../lib/scmHandoffStorage';
import { ArrowRight, X, CheckSquare, Square } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import { useReturnableNoteLines, type ReturnableNoteLine } from '../../vendor/scm/lib/consignment-return-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const CONDITIONS = ['NEW', 'OPENED', 'DAMAGED', 'DEFECTIVE'] as const;

const QTY_INPUT: CSSProperties = {
  height: 28,
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 8px',
  fontSize: 'var(--fs-12)',
  background: 'var(--c-paper)',
  color: 'var(--c-ink)',
};

const custKey = (l: ReturnableNoteLine): string =>
  (l.debtorCode && l.debtorCode.trim())
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;

type Pick = { picked: boolean; qty: number; condition: string };

export const ConsignmentReturnFromNote = () => {
  const navigate = useNavigate();
  const linesQ = useReturnableNoteLines();

  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [dialog, setDialog] = useState<{ title: string; body: string } | null>(null);

  const rows = useMemo<ReturnableNoteLine[]>(() => linesQ.data ?? [], [linesQ.data]);

  const rowById = useMemo(() => {
    const m = new Map<string, ReturnableNoteLine>();
    for (const r of rows) m.set(r.noteItemId, r);
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

  const isRowLocked = (r: ReturnableNoteLine): boolean =>
    Boolean(lockedDebtor && custKey(r) !== lockedDebtor && !picks[r.noteItemId]?.picked);

  const togglePick = (r: ReturnableNoteLine) => {
    if (isRowLocked(r)) return;
    const turningOn = !picks[r.noteItemId]?.picked;
    setPicks((s) => ({
      ...s,
      [r.noteItemId]: turningOn
        ? { picked: true, qty: s[r.noteItemId]?.qty || r.remaining, condition: s[r.noteItemId]?.condition || 'NEW' }
        : { picked: false, qty: 0, condition: s[r.noteItemId]?.condition || 'NEW' },
    }));
  };

  const setQty = (r: ReturnableNoteLine, qty: number) => {
    if (isRowLocked(r)) return;
    setPicks((s) => ({ ...s, [r.noteItemId]: { picked: true, qty, condition: s[r.noteItemId]?.condition || 'NEW' } }));
  };

  const setCondition = (r: ReturnableNoteLine, condition: string) => {
    if (isRowLocked(r)) return;
    setPicks((s) => {
      const prev = s[r.noteItemId];
      return { ...s, [r.noteItemId]: { picked: prev?.picked ?? true, qty: prev?.picked ? prev.qty : r.remaining, condition } };
    });
  };

  const selectAll = () => {
    setPicks((s) => {
      const next = { ...s };
      const key = lockedDebtor ?? (rows[0] ? custKey(rows[0]) : null);
      if (!key) return next;
      for (const r of rows) if (custKey(r) === key) next[r.noteItemId] = { picked: true, qty: r.remaining, condition: next[r.noteItemId]?.condition || 'NEW' };
      return next;
    });
  };
  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  const columns = useMemo<DataGridColumn<ReturnableNoteLine>[]>(() => [
    {
      key: 'pick', label: '', width: 40, sortable: false, groupable: false,
      accessor: (r) => {
        const on = Boolean(picks[r.noteItemId]?.picked);
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
      key: 'noteNumber', label: 'Note No', width: 150, sortable: true, groupable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.noteNumber}</span>,
      searchValue: (r) => r.noteNumber,
      groupValue: (r) => r.noteNumber,
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
        const p = picks[r.noteItemId];
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
        const p = picks[r.noteItemId];
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
  ], [picks, lockedDebtor]);

  const onContinue = () => {
    if (pickedCount === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Consignment Note line to return first.' });
      return;
    }
    const stash = picked
      .map(([noteItemId, v]) => {
        const r = rowById.get(noteItemId);
        if (!r) return null;
        return {
          noteItemId,
          consignmentDoId: r.consignmentDoId,
          noteNumber: r.noteNumber,
          debtorCode: r.debtorCode,
          debtorName: r.debtorName,
          itemCode: r.itemCode,
          itemGroup: r.itemGroup,
          description: r.description,
          uom: r.uom,
          qty: v.qty,
          condition: v.condition,
          unitPriceCenti: r.unitPriceCenti,
          discountCenti: r.discountCenti,
          unitCostCenti: r.unitCostCenti,
          variants: r.variants,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    if (stash.length === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Consignment Note line to return first.' });
      return;
    }

    if (!writeScmHandoff('crFromNotePicks', stash)) {
      setDialog({ title: 'Unable to continue', body: 'This browser could not safely store your picked lines. Your selection is still here; free some browser storage and try again.' });
      return;
    }
    navigate(`/scm/consignment-returns/new?fromPicks=1`);
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
        title="Pick Consignment Note lines to return"
        actions={
          <>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/consignment-returns')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button
                variant="primary" size="md"
                onClick={onContinue}
                disabled={pickedCount === 0}
                title="Open the New Consignment Return form prefilled with the picked Consignment Note lines"
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
        Pick the Consignment Note lines being returned and set the quantity + condition for each. A line can be
        returned in parts across several returns — only the remaining (not-yet-returned) quantity is shown.
        Continuing opens the normal New Consignment Return form, prefilled for review.
      </p>
      {lockedDebtorName && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          One customer per Consignment Return — locked to <strong>{lockedDebtorName}</strong>. Other
          customers' lines are greyed out; clear picks to switch.
        </p>
      )}

      <DataGrid<ReturnableNoteLine>
        rows={rows}
        columns={columns}
        storageKey="cr-g.cr-from-note-lines.layout.v1"
        rowKey={(r) => r.noteItemId}
        searchPlaceholder="Search note, customer, item…"
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
          : "This search came back with no returnable Consignment Note lines. That is not the same as everything having been returned — the list only covers the company you are working in, and lines it cannot see look identical to lines that are done. Open the consignment note and check its balance before treating this as nothing left to return."}
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
