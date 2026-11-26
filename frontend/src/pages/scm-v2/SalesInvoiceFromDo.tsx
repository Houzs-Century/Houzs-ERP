
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { writeScmHandoff } from '../../lib/scmHandoffStorage';
import { readConvertScope, UnrecognisedScopeNotice } from '../../lib/convertScope';
import { ArrowRight, X, CheckSquare, Square } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import { useInvoiceableDoLines, type DoRemainingLine } from '../../vendor/scm/lib/sales-invoice-queries';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { soRefOfCamelStamp } from '../../lib/so-ref-search';
import { fmtMoneySen, fmtQty } from '@2990s/shared';
import { lineDiscountShare } from '../../vendor/shared/line-discount-share';

const pickDiscount = (r: DoRemainingLine, pickQty: number): number =>
  lineDiscountShare(r.discountSen, r.delivered, r.delivered - r.remaining, pickQty);

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

const STORAGE_KEY = 'pr-g.si-from-do-lines.layout.v1';

const QTY_INPUT: CSSProperties = {
  height: 28,
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 8px',
  fontSize: 'var(--fs-12)',
  background: 'var(--c-paper)',
  color: 'var(--c-ink)',
};

const custKey = (l: DoRemainingLine): string =>
  (l.debtorCode && l.debtorCode.trim())
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;

type Pick = { picked: boolean; qty: number };

export const SalesInvoiceFromDo = () => {
  const navigate = useNavigate();
  const linesQ = useInvoiceableDoLines();

  const [searchParams] = useSearchParams();
  const scope = useMemo(
    () => readConvertScope('doToSi', searchParams, []),
    [searchParams],
  );

  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [dialog, setDialog] = useState<{ title: string; body: string } | null>(null);

  const allRows = useMemo<DoRemainingLine[]>(() => linesQ.data ?? [], [linesQ.data]);
  const rows = useMemo<DoRemainingLine[]>(
    () => (scope.keys.size === 0
      ? allRows
      : allRows.filter((r) => scope.keys.has(r.deliveryOrderId))),
    [allRows, scope.keys],
  );

  const rowById = useMemo(() => {
    const m = new Map<string, DoRemainingLine>();
    for (const r of rows) m.set(r.doItemId, r);
    return m;
  }, [rows]);

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
    const lockTo = custKey(first);
    setPicks(() => {
      const next: Record<string, Pick> = {};
      for (const l of mine) {
        if (custKey(l) !== lockTo) continue;
        next[l.doItemId] = { picked: true, qty: l.remaining };
      }
      return next;
    });
  }, [rows, linesQ.isLoading, scope.keys]);

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
        ? { picked: true, qty: s[r.doItemId]?.qty || r.remaining }
        : { picked: false, qty: 0 },
    }));
  };

  const setQty = (r: DoRemainingLine, qty: number) => {
    if (isRowLocked(r)) return;
    setPicks((s) => ({ ...s, [r.doItemId]: { picked: true, qty } }));
  };

  const [visibleRows, setVisibleRows] = useState<DoRemainingLine[]>([]);

  const selectableVisibleKeys = useMemo(
    () => visibleRows.filter((r) => !isRowLocked(r)).map((r) => r.doItemId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isRowLocked derives from picks/lockedCustomer, both listed
    [visibleRows, picks, lockedCustomer],
  );

  const toggleKeys = (keys: string[], allSelected: boolean) => {
    setPicks((s) => {
      const next = { ...s };
      if (allSelected) {
        for (const k of keys) next[k] = { picked: false, qty: 0 };
        return next;
      }
      const firstVisible = keys.map((k) => rowById.get(k)).find((r): r is DoRemainingLine => Boolean(r));
      const key = lockedCustomer ?? (firstVisible ? custKey(firstVisible) : null);
      if (!key) return next;
      for (const k of keys) {
        const r = rowById.get(k);
        if (r && custKey(r) === key) next[k] = { picked: true, qty: r.remaining };
      }
      return next;
    });
  };

  const selectAll = () => toggleKeys(selectableVisibleKeys, false);
  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  const pickedKeys = useMemo(
    () => new Set(Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0).map(([id]) => id)),
    [picks],
  );

  const columns = useMemo<GridColumn<DoRemainingLine>[]>(() => [
    {
      key: 'doNumber', label: 'DO No', width: 140, sortable: true, groupable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.doNumber}</span>,
      searchValue: (r) => r.doNumber,
      groupValue: (r) => r.doNumber,
    },
    {
      key: 'soRef', label: 'Ref No.', width: 150, sortable: true,
      accessor: (r) => soRefOfCamelStamp(r) || '—',
      searchValue: (r) => soRefOfCamelStamp(r),
      sortFn: (a, b) => soRefOfCamelStamp(a).localeCompare(soRefOfCamelStamp(b)),
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
      key: 'delivered', label: 'Delivered', width: 80, align: 'right', sortable: true,
      accessor: (r) => String(r.delivered),
      sortFn: (a, b) => a.delivered - b.delivered,
    },
    {
      key: 'invoiced', label: 'Invoiced', width: 80, align: 'right', sortable: true,
      accessor: (r) => <span className={styles.muted}>{r.invoiced}</span>,
      sortFn: (a, b) => a.invoiced - b.invoiced,
    },
    {
      key: 'remaining', label: 'Remaining', width: 80, align: 'right', sortable: true,
      accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{fmtQty(r.remaining)}</span>,
      sortFn: (a, b) => a.remaining - b.remaining,
    },
    {
      key: 'pickQty', label: 'Qty to Invoice', width: 110, align: 'right', sortable: false, groupable: false,
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
      key: 'lineValue', label: 'Line Value', width: 130, align: 'right', sortable: true,
      accessor: (r) => {
        const p = picks[r.doItemId];
        const pickQty = p?.picked ? p.qty : r.remaining;
        return (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
            {fmtRm(pickQty * r.unitPriceSen - pickDiscount(r, pickQty))}
          </span>
        );
      },
      exportValue: (r) => {
        const q = Object.hasOwn(picks, r.doItemId) && picks[r.doItemId].picked ? picks[r.doItemId].qty : r.remaining;
        return (q * r.unitPriceSen - pickDiscount(r, q)) / 100;
      },
      exportFormat: 'money',
      sortFn: (a, b) => a.remaining * a.unitPriceSen - b.remaining * b.unitPriceSen,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  ], [picks, lockedCustomer]);

  const onContinue = () => {
    if (pickedCount === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Delivery Order line to invoice first.' });
      return;
    }
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
          unitPriceSen: r.unitPriceSen,
          discountSen: pickDiscount(r, v.qty),
          unitCostSen: r.unitCostSen,
          variants: r.variants,
          lineDeliveryDate: r.lineDeliveryDate,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    if (stash.length === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Delivery Order line to invoice first.' });
      return;
    }

    const firstDoId = stash.map((s) => s.deliveryOrderId).sort()[0] ?? '';
    if (!writeScmHandoff('siFromDoPicks', stash)) {
      setDialog({ title: 'Unable to continue', body: 'This browser could not safely store your picked lines. Your selection is still here; free some browser storage and try again.' });
      return;
    }
    navigate(`/scm/sales-invoices/new?fromDo=${encodeURIComponent(firstDoId)}&fromPicks=1`);
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
        title="Pick Delivery Order lines to invoice"
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/sales-invoices')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button
              variant="primary" size="md"
              onClick={onContinue}
              disabled={pickedCount === 0}
              title="Open the New Sales Invoice form prefilled with the picked Delivery Order lines"
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
        Pick the Delivery Order lines you want to invoice and set the quantity for each. A line can be
        invoiced in parts across several invoices — only the remaining (not-yet-invoiced, not-yet-returned)
        quantity is shown. Continuing opens the normal New Sales Invoice form, prefilled for review —
        nothing is invoiced and no revenue is recorded until you click Create on that screen.
      </p>
      <UnrecognisedScopeNotice unknown={scope.unknown} />
      {scope.keys.size > 0 && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          Showing the invoiceable lines of{' '}
          <strong>
            {scope.keys.size === 1
              ? (rows[0]?.doNumber ?? 'this Delivery Order')
              : `${scope.keys.size} Delivery Orders`}
          </strong>{' '}
          only.{' '}
          <Link to="/scm/sales-invoices/from-do" style={{ color: 'var(--c-burnt)', textDecoration: 'underline' }}>
            Show all Delivery Orders
          </Link>
        </p>
      )}
      {lockedCustomerName && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          One customer per Sales Invoice — locked to <strong>{lockedCustomerName}</strong>. Other
          customers' lines are greyed out; clear picks to switch.
        </p>
      )}

      <DataGridCompat<DoRemainingLine>
        rows={rows}
        columns={columns}
        storageKey={STORAGE_KEY}
        rowKey={(r) => r.doItemId}
        searchPlaceholder="Search DO, customer, item…"
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
          : allRows.length > 0
            ? `None of the ${allRows.length} invoiceable Delivery Order line(s) that loaded belong to the note you came from. Use Show all above to see the rest — this says nothing about whether that note still owes an invoice.`
            : "This search came back with no invoiceable Delivery Order lines. That is not the same as everything having been invoiced or returned — the list only covers the company you are working in, and lines it cannot see look identical to lines that are done. Open the delivery order and check its balance before treating this as nothing left to invoice."}
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
