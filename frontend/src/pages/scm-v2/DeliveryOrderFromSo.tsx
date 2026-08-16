// ----------------------------------------------------------------------------
// DeliveryOrderFromSo — LINE-LEVEL, QUANTITY-BASED Sales Order → Delivery Order
// picker.
//
// Commander 2026-05-30 rewrite: partial-delivery model, mirroring the PO's
// line-level from-SO picker (pages/PurchaseOrderFromSo.tsx). Instead of ticking
// whole Sales Orders, the operator picks individual SO LINES, each with a qty
// 1..remaining. An SO line can be split across SEVERAL Delivery Orders until its
// remaining (qty − delivered + returned, derived LIVE by the server) reaches 0:
//   - Partially delivered (remaining > 0) → the line is still pickable.
//   - Fully delivered (remaining == 0) → the line drops out of the picker.
//   - Cancelling a DO, deleting a DO line, or processing a Delivery Return
//     RAISES remaining again automatically (the server re-derives it).
//
// A customer-lock keeps the merge clean: once one line is ticked, lines of a
// DIFFERENT customer grey out — a DO ships to ONE customer.
//
// On "Continue" the picked lines are carried into the normal New Delivery Order
// form (prefilled, reviewable) — NOTHING is created or shipped yet. The operator
// reviews/edits and clicks "Create DO" there to actually ship + deduct stock.
// This mirrors the PO picker (PurchaseOrderFromSo), which also stashes its picks
// and hands them to the New PO form rather than auto-creating.
//
// Routing: /scm/delivery-orders/from-so → /scm/delivery-orders/new.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { writeScmHandoff } from '../../lib/scmHandoffStorage';
import { readConvertScope, UnrecognisedScopeNotice } from '../../lib/convertScope';
import { ArrowRight, X, CheckSquare, Square } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import { useDeliverableSoLines, type DeliverableSoLine } from '../../vendor/scm/lib/delivery-order-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtMoneyCenti } from '@2990s/shared';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneyCenti(centi, currency);

const STORAGE_KEY = 'pr-g.do-from-so-lines.layout.v1';

/* Compact pill input — mirrors the PO picker's qty input. */
const QTY_INPUT: CSSProperties = {
  height: 28,
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 8px',
  fontSize: 'var(--fs-12)',
  background: 'var(--c-paper)',
  color: 'var(--c-ink)',
};

/* One distinct customer key per SO line — match the server's same-customer
   rule: debtor_code when present, else fall back to debtor_name. The lock greys
   out any line whose key differs from the first ticked one. */
const custKey = (l: DeliverableSoLine): string =>
  (l.debtorCode && l.debtorCode.trim())
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;

type Pick = { picked: boolean; qty: number };

export const DeliveryOrderFromSo = () => {
  const navigate = useNavigate();
  const linesQ = useDeliverableSoLines();

  /* "Deliver" on a Sales Order row lands here with ?soDocNo=<doc no> so the
     operator sees the order they were just looking at, not every open SO in the
     company. The parameter was being constructed by the caller and dropped here
     until 2026-08-16. The key is the DOC NUMBER, not an id — deliverable-so-lines
     returns docNo and no order id, and the parameter is named for what it
     carries. No parameter → the full picker (the list toolbar's "From Sales
     Order" button). */
  const [searchParams] = useSearchParams();
  const scope = useMemo(
    () => readConvertScope('soToDo', searchParams, []),
    [searchParams],
  );

  // Map<soItemId, { picked, qty }>. Defaults: picked = false; when ticked,
  // qty defaults to the line's remaining.
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [dialog, setDialog] = useState<{ title: string; body: string } | null>(null);

  const allRows = useMemo<DeliverableSoLine[]>(() => linesQ.data ?? [], [linesQ.data]);
  const rows = useMemo<DeliverableSoLine[]>(
    () => (scope.keys.size === 0 ? allRows : allRows.filter((r) => scope.keys.has(r.docNo))),
    [allRows, scope.keys],
  );

  const rowById = useMemo(() => {
    const m = new Map<string, DeliverableSoLine>();
    for (const r of rows) m.set(r.soItemId, r);
    return m;
  }, [rows]);

  /* ONE SALES ORDER IS ONE CUSTOMER — resolve the lock key per DOC, not per line.
     mfg_sales_order_items carries its own debtor_code/debtor_name copy and those
     copies DRIFT: on 2990-SO-2606-034 the two sofa lines say "The Wei chin", the
     delivery line says "Teh Wei chin" and the disposal line says nothing, while
     the SO header says "Teh Wei chin" for all four. Keying the lock off the line
     copy therefore split ONE order across three customers — ticking a sofa greyed
     out the other half of the same order, and Select all could only ever reach 2
     of 4 lines (Nico, 2026-08-03).
     The backend now stamps the header's debtor on every line, which fixes this at
     the source; keying per doc here means the picker is also right against data
     that has already drifted, and stays right afterwards (once every line of a
     doc agrees, first-non-empty IS that agreed value). */
  const docCustKey = useMemo(() => {
    const m = new Map<string, { key: string; label: string }>();
    for (const r of rows) {
      if (m.has(r.docNo)) continue;
      const code = (r.debtorCode ?? '').trim();
      const name = (r.debtorName ?? '').trim();
      if (!code && !name) continue; // a blank line can't name the order's customer
      m.set(r.docNo, { key: custKey(r), label: name || code });
    }
    return m;
  }, [rows]);

  /* The line's effective customer: its ORDER's, falling back to its own copy for
     an order whose every line is blank. */
  const keyOf = (r: DeliverableSoLine): string => docCustKey.get(r.docNo)?.key ?? custKey(r);
  const labelOf = (r: DeliverableSoLine): string =>
    docCustKey.get(r.docNo)?.label ?? r.debtorName ?? r.debtorCode ?? '(none)';

  /* The customer locked in by the current picks — the key of the first picked
     line. Null when nothing is picked (every line is selectable). */
  const lockedCustomer = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const r = rowById.get(id);
      if (r) return keyOf(r);
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyOf derives from docCustKey, listed
  }, [picks, rowById, docCustKey]);

  const lockedCustomerName = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const r = rowById.get(id);
      if (r) return labelOf(r);
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelOf derives from docCustKey, listed
  }, [picks, rowById, docCustKey]);

  // A row is LOCKED when a different customer is already picked.
  const isRowLocked = (r: DeliverableSoLine): boolean =>
    Boolean(lockedCustomer && keyOf(r) !== lockedCustomer && !picks[r.soItemId]?.picked);

  /* Scoped entry pre-ticks the order's remaining lines at full quantity, so the
     screen is a ready-to-review draft rather than a filtered list to re-tick by
     hand. Copies GrnFromPo, the one convert that already worked. Nothing ships
     and no stock moves here — Continue only carries the picks to the New DO
     form. */
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current) return;
    if (scope.keys.size === 0) return;
    if (linesQ.isLoading) return;
    prefilled.current = true;
    const mine = rows.filter((r) => r.remaining > 0);
    const first = mine[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mine[0] is typed non-optional without noUncheckedIndexedAccess; an empty scope match is real
    if (!first) return;
    // Honour the one-customer-per-DO lock: tick only the first line's customer,
    // even if the scope somehow spans two.
    const lockTo = keyOf(first);
    setPicks(() => {
      const next: Record<string, Pick> = {};
      for (const l of mine) {
        if (keyOf(l) !== lockTo) continue;
        next[l.soItemId] = { picked: true, qty: l.remaining };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyOf derives from docCustKey, listed
  }, [rows, linesQ.isLoading, scope.keys, docCustKey]);

  const togglePick = (r: DeliverableSoLine) => {
    if (isRowLocked(r)) return; // can't tick a different customer
    const turningOn = !picks[r.soItemId]?.picked;
    setPicks((s) => ({
      ...s,
      [r.soItemId]: turningOn
        ? { picked: true, qty: s[r.soItemId]?.qty || r.remaining }
        : { picked: false, qty: 0 },
    }));
  };

  const setQty = (r: DeliverableSoLine, qty: number) => {
    if (isRowLocked(r)) return;
    setPicks((s) => ({ ...s, [r.soItemId]: { picked: true, qty } }));
  };

  /* Select-all acts on WHAT THE OPERATOR SEES.
     Until 2026-08-03 it walked `rows` — the whole 175-line dataset — and seeded
     the customer lock from `rows[0]`, the first row of the UNFILTERED list. So
     searching "2606-034" and hitting Select all silently ticked a completely
     different customer's lines and carried SO 2606-002 into the new DO (Nico,
     2026-08-03). Both the header checkbox and this button now operate on the
     post-search / post-filter rows the grid hands back. */
  const [visibleRows, setVisibleRows] = useState<DeliverableSoLine[]>([]);

  const selectableVisibleKeys = useMemo(
    () => visibleRows.filter((r) => !isRowLocked(r)).map((r) => r.soItemId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isRowLocked derives from picks/lockedCustomer, both listed
    [visibleRows, picks, lockedCustomer],
  );

  /* Tick/untick the given (visible, unlocked) keys. Select respects the lock: it
     only adds lines of the locked customer, or — when nothing is picked yet — of
     the FIRST VISIBLE row's customer, so the result is always a valid
     single-customer set. */
  const toggleKeys = (keys: string[], allSelected: boolean) => {
    setPicks((s) => {
      const next = { ...s };
      if (allSelected) {
        for (const k of keys) next[k] = { picked: false, qty: 0 };
        return next;
      }
      const firstVisible = keys.map((k) => rowById.get(k)).find((r): r is DeliverableSoLine => Boolean(r));
      const key = lockedCustomer ?? (firstVisible ? keyOf(firstVisible) : null);
      if (!key) return next;
      for (const k of keys) {
        const r = rowById.get(k);
        if (r && keyOf(r) === key) next[k] = { picked: true, qty: r.remaining };
      }
      return next;
    });
  };

  const selectAll = () => toggleKeys(selectableVisibleKeys, false);
  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  /* Ticked rows for the grid's checkbox column — same rule Continue applies, so
     a row typed down to qty 0 reads as unticked. */
  const pickedKeys = useMemo(
    () => new Set(Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0).map(([id]) => id)),
    [picks],
  );

  const columns = useMemo<DataGridColumn<DeliverableSoLine>[]>(() => [
    /* The per-row tick lives in the grid's first-class `selectable` column, so
       the header carries a real select-all checkbox scoped to the filtered
       rows. Don't re-add a hand-rolled `pick` column here — that header can
       only hold a plain string label. */
    {
      key: 'docNo', label: 'SO No', width: 140, sortable: true, groupable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.docNo}</span>,
      searchValue: (r) => r.docNo,
      groupValue: (r) => r.docNo,
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
      key: 'description', label: 'Description', width: 260, sortable: true,
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
      key: 'qty', label: 'SO Qty', width: 70, align: 'right', sortable: true,
      accessor: (r) => String(r.qty),
      sortFn: (a, b) => a.qty - b.qty,
    },
    {
      key: 'delivered', label: 'Delivered', width: 80, align: 'right', sortable: true,
      accessor: (r) => <span className={styles.muted}>{r.delivered}</span>,
      sortFn: (a, b) => a.delivered - b.delivered,
    },
    {
      key: 'remaining', label: 'Remaining', width: 80, align: 'right', sortable: true,
      accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{r.remaining}</span>,
      sortFn: (a, b) => a.remaining - b.remaining,
    },
    {
      key: 'pickQty', label: 'Qty to Deliver', width: 110, align: 'right', sortable: false, groupable: false,
      accessor: (r) => {
        const p = picks[r.soItemId];
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
            /* Always editable: typing a qty auto-selects the row (no need to
               tick the checkbox first). */
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              setQty(r, Math.min(r.remaining, Math.max(0, Number(e.target.value) || 0)))}
            style={{ ...QTY_INPUT, width: 76, textAlign: 'right', ...(locked ? { cursor: 'not-allowed', background: 'var(--c-cream)' } : null) }}
          />
        );
      },
    },
    {
      key: 'lineValue', label: 'Line Value', width: 130, align: 'right', sortable: true,
      accessor: (r) => {
        const p = picks[r.soItemId];
        const pickQty = p?.picked ? p.qty : r.remaining;
        return (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
            {fmtRm(pickQty * r.unitPriceCenti)}
          </span>
        );
      },
      sortFn: (a, b) => a.remaining * a.unitPriceCenti - b.remaining * b.unitPriceCenti,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  ], [picks, lockedCustomer]);

  const onContinue = () => {
    if (pickedCount === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Sales Order line to deliver first.' });
      return;
    }
    /* Carry the picked lines into the normal New Delivery Order form (prefilled,
       reviewable) — NOTHING is created or shipped here. The operator reviews the
       draft and clicks Create on the next screen. Mirrors the PO picker, which
       also stashes picks and navigates to the New PO form. */
    const stash = picked
      .map(([soItemId, v]) => {
        const r = rowById.get(soItemId);
        if (!r) return null;
        return {
          soItemId,
          docNo: r.docNo,
          itemCode: r.itemCode,
          itemGroup: r.itemGroup ?? 'others',
          description: r.description ?? '',
          uom: r.uom ?? 'UNIT',
          qty: v.qty,
          unitPriceCenti: r.unitPriceCenti,
          discountCenti: r.discountCenti,
          unitCostCenti: r.unitCostCenti,
          variants: r.variants ?? {},
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (stash.length === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Sales Order line to deliver first.' });
      return;
    }
    /* Header/address prefill mirrors the same-customer rule: use the SO of the
       sorted-first picked line. Each line keeps its own soItemId, so multiple
       same-customer SOs still link back correctly. */
    const firstDocNo = stash.map((s) => s.docNo).sort()[0] ?? '';
    if (!writeScmHandoff('doFromSoPicks', stash)) {
      setDialog({ title: 'Unable to continue', body: 'This browser could not safely store your picked lines. Your selection is still here; free some browser storage and try again.' });
      return;
    }
    navigate(`/scm/delivery-orders/new?fromSo=${encodeURIComponent(firstDocNo)}&fromPicks=1`);
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
        title="Pick Sales Order lines to deliver"
        actions={
          <>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/delivery-orders')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button
                variant="primary" size="md"
                onClick={() => onContinue()}
                disabled={pickedCount === 0}
                title="Carry the picked Sales Order lines into a new Delivery Order to review"
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
        Pick the Sales Order lines you want to deliver and set the quantity for each. A line can be
        delivered in parts across several Delivery Orders — only the remaining (not-yet-delivered)
        quantity is shown. Continue carries the picked lines into a new Delivery Order form for you to
        review — nothing ships and no stock is deducted until you click Create on that screen.
      </p>
      <UnrecognisedScopeNotice unknown={scope.unknown} />
      {scope.keys.size > 0 && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          Showing the deliverable lines of{' '}
          <strong>
            {scope.keys.size === 1 ? [...scope.keys][0] : `${scope.keys.size} Sales Orders`}
          </strong>{' '}
          only.{' '}
          <Link to="/scm/delivery-orders/from-so" style={{ color: 'var(--c-burnt)', textDecoration: 'underline' }}>
            Show all Sales Orders
          </Link>
        </p>
      )}
      {lockedCustomerName && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          One customer per Delivery Order — locked to <strong>{lockedCustomerName}</strong>. Other
          customers' lines are greyed out; clear picks to switch.
        </p>
      )}

      <DataGrid<DeliverableSoLine>
        rows={rows}
        columns={columns}
        storageKey={STORAGE_KEY}
        rowKey={(r) => r.soItemId}
        searchPlaceholder="Search SO, customer, item…"
        onRowClick={(r) => togglePick(r)}
        onFilteredRowsChange={setVisibleRows}
        selectable={{
          selectedKeys: pickedKeys,
          onToggle: (key) => { const r = rowById.get(key); if (r) togglePick(r); },
          onToggleAll: toggleKeys,
          isDisabled: (key) => { const r = rowById.get(key); return r ? isRowLocked(r) : false; },
        }}
        rowStyle={(r) => isRowLocked(r)
          ? { opacity: 0.45, background: 'var(--c-cream)', cursor: 'not-allowed' }
          : undefined}
        toolbar={toolbar}
        groupBanner={false}
        isLoading={linesQ.isLoading}
        /* A failed read must NEVER render as the sentence below. "We couldn't
           load the lines" and "there are no lines left to do" are opposite
           facts, and the operator acts on the second one by walking away from
           work that is still outstanding. */
        emptyMessage={linesQ.isError
          ? "We couldn't load the outstanding lines, so this list is incomplete. That is not the same as there being none left — please refresh and try again."
          : scope.keys.size > 0
            ? "Nothing left to deliver on the Sales Order you came from — every line of it has been fully delivered. Other orders may still have lines; use Show all above."
            : "No deliverable Sales Order lines — every line has been fully delivered (or there are no Sales Orders)."}
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
