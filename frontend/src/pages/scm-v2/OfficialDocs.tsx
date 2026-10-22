// ----------------------------------------------------------------------------
// OfficialDocs — 欠正式单 (owner 2026-10-01, payment-request item 3: 他们有时是给
// proforma invoice, 这样我要 follow up 回 original 单, 所以我有一个 list 看到这些要
// follow up 的). Finance's list of the payments made on a proforma or a quotation
// that still owe the official invoice — the longest waiting first — and the ones
// whose official invoice came and waits to be checked, with what the bill reader
// found against the proforma. A requester sees their own on Payment Requests.
// Server: backend/src/scm/routes/official-docs.ts.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useOfficialDocs, type OfficialDocRow } from '../../vendor/scm/lib/official-doc-queries';
import { OfficialDocActions } from '../../vendor/scm/components/OfficialDoc';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { fmtDateOrDash, fmtSen } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';

type View = 'owed' | 'received' | 'all';
const VIEWS: Array<[View, string]> = [['owed', 'Owed · 欠正式单'], ['received', 'To check · 待核对'], ['all', 'All, checked too']];
const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };

/** Whole days since an ISO time, in Malaysia time. */
const daysSince = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86_400_000)) : null;
};

const docLink = (r: OfficialDocRow): string => (r.kind === 'PV' ? `/scm/payment-vouchers/${r.id}` : `/scm/ap-invoices?open=${encodeURIComponent(r.id)}`);

export const OfficialDocs = () => {
  const [view, setView] = useState<View>('owed');
  const q = useOfficialDocs(view === 'all');
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

  const columns = useMemo<Column<OfficialDocRow>[]>(() => [
    { key: 'doc', label: 'Paid by', render: (r) => <Link to={docLink(r)} style={{ fontFamily: 'var(--font-mono)', color: 'var(--c-orange)' }}>{r.number ?? (r.kind === 'PV' ? 'Draft voucher' : 'AP invoice')}</Link>, getValue: (r) => r.number ?? '' },
    { key: 'payee', label: 'Pay to', render: (r) => r.payee ?? '—', getValue: (r) => r.payee ?? '' },
    { key: 'amount', label: 'Amount', align: 'right', render: (r) => fmtSen(r.totalSen), getValue: (r) => r.totalSen, exportValue: (r) => r.totalSen / 100, exportFormat: 'money' },
    { key: 'paid', label: 'Paid', render: (r) => (r.paidAt ? fmtDateOrDash(r.paidAt) : <span style={soft}>not yet</span>), getValue: (r) => r.paidAt ?? '' },
    { key: 'request', label: 'Asked by', render: (r) => (r.request ? <span>{r.request.requestedBy ?? '—'} <span style={soft}>· {r.request.requestNo}</span></span> : <span style={soft}>Finance</span>), getValue: (r) => r.request?.requestedBy ?? '' },
    { key: 'waiting', label: 'Waiting', align: 'right', render: (r) => { const d = daysSince(r.since); return d == null ? '—' : `${d} day${d === 1 ? '' : 's'}`; }, getValue: (r) => daysSince(r.since) ?? -1 },
    { key: 'state', label: 'Official invoice', width: '360px', render: (r) => <OfficialDocActions kind={r.kind} id={r.id} state={r.state} note={r.note} />, getValue: (r) => r.state },
  ], []);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Money out" title="Official invoices owed · 欠正式单" />
      <section className={styles.card}>
        <div className={styles.cardHeader} style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {VIEWS.map(([key, label]) => (
              <button key={key} type="button" onClick={() => setView(key)} aria-pressed={view === key}
                style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid var(--line)', background: view === key ? 'var(--c-orange)' : 'transparent', color: view === key ? '#fff' : 'inherit', fontSize: 'var(--fs-12)', cursor: 'pointer' }}>
                {label}{key === 'owed' ? ` (${counts.owed})` : key === 'received' ? ` (${counts.received})` : ''}
              </button>
            ))}
          </div>
          <span style={soft}>Marked when a payment is made on a proforma or quotation; the requester uploads the official invoice on their request.</span>
        </div>
        <div className={styles.cardBody}>
          <DataTable<OfficialDocRow>
            tableId="official-docs"
            exportName="official-invoices-owed"
            columns={columns}
            rows={q.data ? rows : null}
            loading={q.isLoading}
            error={q.isError ? `The list could not be loaded — ${q.error instanceof Error ? q.error.message : 'something went wrong.'}` : null}
            emptyLabel={view === 'owed' ? 'No payment owes its official invoice.' : view === 'received' ? 'Nothing waits to be checked.' : 'No payment was ever marked.'}
            getRowKey={(r) => `${r.kind}-${r.id}`}
          />
        </div>
      </section>
    </div>
  );
};
