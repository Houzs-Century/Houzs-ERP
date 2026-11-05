// ----------------------------------------------------------------------------
// OfficialDocs — 欠正式单 (owner 2026-10-01, payment-request item 3: 他们有时是给
// proforma invoice, 这样我要 follow up 回 original 单, 所以我有一个 list 看到这些要
// follow up 的). Finance's list of the payments made on a proforma or a quotation
// that still owe the official invoice — the longest waiting first — and the ones
// whose official invoice came and waits to be checked, with what the bill reader
// found against the proforma. A requester sees their own on Payment Requests.
// Server: backend/src/scm/routes/official-docs.ts.
//
// The redesign (owner's Claude Design, batch 4 §5): an ERP-only page that stays
// under Money out, restyled by the design's shared rules — English views with
// counts, the state as a status tag, the paying document's number opening it in
// its own tab (so does a double-click on the row), no monospace.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useOfficialDocs, type OfficialDocRow, type OfficialState } from '../../vendor/scm/lib/official-doc-queries';
import { OfficialDocActions } from '../../vendor/scm/components/OfficialDoc';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { fmtDate, fmtSen } from '../../vendor/shared/format';
import { FinanceDocLink, financeDocHref } from './finance/FinanceDocLink';
import { Tag, Views, type Tone, type ViewOption } from './MoneyOutErpParts';
import css from './MoneyOutErp.module.css';

type View = 'owed' | 'received' | 'all';

/** Each state of the official invoice as the page's status tag. */
const stateTag = (state: OfficialState): { text: string; tone: Tone } => {
  switch (state) {
    case 'OWED': return { text: 'Owed', tone: 'late' };
    case 'RECEIVED': return { text: 'To check', tone: 'warn' };
    default: return { text: 'Checked', tone: 'calm' };
  }
};

/** Whole days since an ISO time, in Malaysia time. */
const daysSince = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86_400_000)) : null;
};

/** The paying document's number — a voucher always has one (a draft's too). */
const docNo = (r: OfficialDocRow): string => r.number ?? (r.kind === 'PV' ? 'Draft voucher' : 'AP bill');

/* A double-click on the marks is not a double-click on the row. */
const keepDoubleClick = (e: React.MouseEvent) => e.stopPropagation();

export const OfficialDocs = () => {
  const [view, setView] = useState<View>('owed');
  const q = useOfficialDocs(view === 'all');
  const openInTab = useOpenDocInTab();
  const rows = useMemo(() => {
    const all = q.data?.rows ?? [];
    if (view === 'owed') return all.filter((r) => r.state === 'OWED');
    if (view === 'received') return all.filter((r) => r.state === 'RECEIVED');
    return all;
  }, [q.data, view]);
  const counts = useMemo(() => {
    const all = q.data?.rows ?? [];
    return { owed: all.filter((r) => r.state === 'OWED').length, received: all.filter((r) => r.state === 'RECEIVED').length };
  }, [q.data]);

  /* Owed and To check are counted on either read; All only once its own read
     (the checked ones too) is the one loaded. */
  const views: ViewOption<View>[] = [
    { key: 'owed', label: 'Owed', count: q.data ? counts.owed : null, work: 'late' },
    { key: 'received', label: 'To check', count: q.data ? counts.received : null, work: 'warn' },
    { key: 'all', label: 'All', count: q.data && view === 'all' ? q.data.rows.length : null },
  ];

  const columns = useMemo<Column<OfficialDocRow>[]>(() => [
    {
      key: 'doc', label: 'Paid by',
      render: (r) => <FinanceDocLink to={financeDocHref(r.kind, r.id)}>{docNo(r)}</FinanceDocLink>,
      getValue: (r) => r.number ?? '',
    },
    { key: 'payee', label: 'Pay to', render: (r) => r.payee ?? '—', getValue: (r) => r.payee ?? '' },
    {
      key: 'amount', label: 'Amount', align: 'right', render: (r) => <span className={css.money}>{fmtSen(r.totalSen)}</span>,
      getValue: (r) => r.totalSen, exportValue: (r) => r.totalSen / 100, exportFormat: 'money',
    },
    { key: 'paid', label: 'Paid', render: (r) => (r.paidAt ? fmtDate(r.paidAt) : <span className={css.muted}>not yet</span>), getValue: (r) => r.paidAt ?? '' },
    {
      key: 'request', label: 'Asked by',
      render: (r) => (r.request
        ? (
          <span>
            {r.request.requestedBy ?? '—'} <span className={css.muted}>· </span>
            <FinanceDocLink to={`/scm/payment-requests?open=${encodeURIComponent(r.request.id)}`}>{r.request.requestNo}</FinanceDocLink>
          </span>
        )
        : <span className={css.muted}>Finance</span>),
      getValue: (r) => r.request?.requestedBy ?? '',
    },
    { key: 'waiting', label: 'Waiting', align: 'right', render: (r) => { const d = daysSince(r.since); return d == null ? '—' : `${d} day${d === 1 ? '' : 's'}`; }, getValue: (r) => daysSince(r.since) ?? -1 },
    {
      key: 'state', label: 'Official invoice', width: '360px',
      render: (r) => {
        const t = stateTag(r.state);
        return (
          <span onDoubleClick={keepDoubleClick}>
            <OfficialDocActions kind={r.kind} id={r.id} state={r.state} note={r.note}
              stateTag={<Tag tone={t.tone}>{t.text}</Tag>} buttonClassName={css.textBtn} />
          </span>
        );
      },
      getValue: (r) => stateTag(r.state).text,
    },
  ], []);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · Money out" title="Official invoices owed" />
      <section className={css.card}>
        <div className={css.cardTop}>
          <Views label="Official invoices" options={views} value={view} onChange={setView} />
          <span className={css.hint}>Marked when a payment is made on a proforma or quotation; the requester uploads the official invoice on their request.</span>
        </div>
        <div className={css.cardBody}>
          <DataTable<OfficialDocRow>
            tableId="official-docs"
            exportName="official-invoices-owed"
            columns={columns}
            rows={q.data ? rows : null}
            loading={q.isLoading}
            error={q.isError ? `The list could not be loaded — ${q.error instanceof Error ? q.error.message : 'something went wrong.'}` : null}
            emptyLabel={view === 'owed' ? 'No payment owes its official invoice.' : view === 'received' ? 'Nothing waits to be checked.' : 'No payment was ever marked.'}
            getRowKey={(r) => `${r.kind}-${r.id}`}
            onRowDoubleClick={(r) => openInTab(financeDocHref(r.kind, r.id))}
          />
        </div>
      </section>
    </div>
  );
};
