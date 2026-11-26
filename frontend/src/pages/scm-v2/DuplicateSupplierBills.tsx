// ----------------------------------------------------------------------------
// DuplicateSupplierBills — the supplier bills booked more than once before the
// server started refusing a second copy (#5535). One row per copy, grouped by
// supplier + bill number; what paid or knocked off each copy sits beside it, so
// a bill paid twice stands out. Read-only: Finance opens the wrong copy and
// cancels it on its own page. Server: backend/src/scm/routes/ap-duplicate-bills.ts.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useDuplicateSupplierBills, type DuplicateBillCopy, type DuplicateBillGroup } from '../../vendor/scm/lib/ap-invoice-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { fmtDateOrDash, fmtSen } from '../../vendor/shared/format';
import { humaniseStatusKey } from '../../vendor/scm/lib/status-pill';
import { FinanceDocLink, financeDocHref } from './finance/FinanceDocLink';
import { Tag } from './MoneyOutErpParts';
import css from './MoneyOutErp.module.css';

type Row = DuplicateBillCopy & { group: DuplicateBillGroup; first: boolean };

const kindWord = (g: DuplicateBillGroup): string =>
  g.kind === 'PI' ? 'Purchase invoice' : g.docKind === 'DN' ? 'Supplier debit note' : 'AP bill';

export const DuplicateSupplierBills = () => {
  const q = useDuplicateSupplierBills();
  const openInTab = useOpenDocInTab();
  const groups = q.data?.groups;
  const rows = useMemo<Row[] | null>(() => (groups
    ? groups.flatMap((g) => g.copies.map((c, i) => ({ ...c, group: g, first: i === 0 })))
    : null), [groups]);
  const paidTwice = (groups ?? []).filter((g) => g.paidMoreThanOnce).length;

  const columns: Column<Row>[] = useMemo(() => [
    {
      key: 'bill', label: 'Supplier bill',
      render: (r) => (r.first ? (
        <span>
          <strong>{r.group.supplierName ?? r.group.supplierCode ?? 'Unknown supplier'}</strong>
          <span className={css.muted}> · {r.supplierInvoiceRef ?? r.group.billKey} · {r.group.copies.length} copies</span>
          {r.group.paidMoreThanOnce && <> <Tag tone="late">Money on more than one copy</Tag></>}
        </span>
      ) : <span className={css.muted}>same bill</span>),
      getValue: (r) => `${r.group.supplierName ?? ''} ${r.group.billKey}`,
    },
    {
      key: 'doc', label: 'Document',
      render: (r) => <FinanceDocLink to={financeDocHref(r.group.kind, r.id)}>{r.invoiceNumber}</FinanceDocLink>,
      getValue: (r) => r.invoiceNumber,
    },
    { key: 'kind', label: 'Kind', render: (r) => kindWord(r.group), getValue: (r) => kindWord(r.group) },
    { key: 'ref', label: 'Bill no. as keyed', render: (r) => r.supplierInvoiceRef ?? '—', getValue: (r) => r.supplierInvoiceRef ?? '' },
    { key: 'date', label: 'Date', render: (r) => fmtDateOrDash(r.invoiceDate), getValue: (r) => r.invoiceDate ?? '' },
    { key: 'total', label: 'Total', align: 'right', render: (r) => <span className={css.money}>{fmtSen(r.totalSen)}</span>, getValue: (r) => r.totalSen },
    { key: 'status', label: 'Status', render: (r) => humaniseStatusKey(r.status), getValue: (r) => r.status },
    { key: 'paid', label: 'Paid', align: 'right', render: (r) => <span className={css.money}>{fmtSen(r.paidSen)}</span>, getValue: (r) => r.paidSen },
    {
      key: 'settled', label: 'Paid or knocked off by',
      render: (r) => (r.settlements.length === 0 ? <span className={css.muted}>nothing</span> : (
        <span>
          {r.settlements.map((s, i) => (
            <span key={`${s.kind}-${s.id}-${i}`}>
              {i > 0 && ', '}
              {s.kind === 'PV'
                ? <FinanceDocLink to={financeDocHref('PV', s.id)}>{s.number}</FinanceDocLink>
                : s.number}
              <span className={css.muted}> {fmtSen(s.amountSen)} ({humaniseStatusKey(s.status)})</span>
            </span>
          ))}
        </span>
      )),
      getValue: (r) => r.settlements.map((s) => s.number).join(' '),
    },
  ], []);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · Money out" title="Duplicate supplier bills" />
      <section className={css.card}>
        <div className={css.cardTop}>
          <span className={css.hint}>
            The same supplier bill number booked on more than one live invoice of the same supplier, from before the system refused it.
            Open the wrong copy and cancel it there; one with money on it needs the payment sorted first.
            {paidTwice > 0 && <> <strong>{paidTwice} of {groups?.length} {paidTwice === 1 ? 'has' : 'have'} money on more than one copy.</strong></>}
          </span>
        </div>
        <div className={css.cardBody}>
          <DataTable<Row>
            tableId="duplicate-supplier-bills"
            exportName="duplicate-supplier-bills"
            columns={columns}
            rows={rows}
            loading={q.isLoading}
            error={q.isError ? `The list could not be loaded — ${q.error instanceof Error ? q.error.message : 'something went wrong.'}` : null}
            emptyLabel="No supplier bill is booked twice."
            getRowKey={(r) => `${r.group.kind}-${r.id}`}
            onRowDoubleClick={(r) => openInTab(financeDocHref(r.group.kind, r.id))}
          />
        </div>
      </section>
    </div>
  );
};
