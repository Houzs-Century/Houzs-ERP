// ----------------------------------------------------------------------------
// Accounting page — PR #36.
//
// Tab strip:
//   1. Journal Entries — list w/ filter, drill into lines
//   2. General Ledger — flat GL stream, filter by account / date
//   3. Balances — trial-balance-style view (Σ Dr, Σ Cr, balance)
//   4. AR Aging — outstanding SI bucketed (CURRENT / 1-30 / 31-60 / 61-90 / 90+)
//   5. AP Aging — outstanding PI bucketed
//
// Commander 2026-05-25 "OK A": don't fork Odoo (AGPL), reference ERPNext
// (MIT), build a simple journal-entries + GL + AR/AP aging.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { BookOpen, FileText, Receipt, TrendingDown, TrendingUp } from 'lucide-react';
import {
  useJournalEntries,
  useGlEntries,
  useAccountBalances,
  useArAging,
  useApAging,
  useAccounts,
  type ArAgingRow,
  type ApAgingRow,
  type JournalEntry,
} from '../../vendor/scm/lib/accounting-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { fmtCenti } from '../../vendor/shared/format';
import { byText } from '../../vendor/scm/lib/sort-options';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtDateOrDash } from '@2990s/shared';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// The ONE guarded centi→"RM …" formatter — returns "—" for an absent/non-finite
// amount, never "RM NaN". Kept under the local name so callsites are unchanged.
const fmt = (sen: number | null | undefined) => fmtCenti(sen);

type Tab = 'je' | 'gl' | 'balances' | 'ar' | 'ap';

export const Accounting = () => {
  const [tab, setTab] = useState<Tab>('je');

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Accounting" />

      <div className={styles.statusChips} style={{ gap: 'var(--space-2)' }}>
        <TabBtn label="Journal Entries" icon={<BookOpen {...ICON} />} active={tab === 'je'}    onClick={() => setTab('je')} />
        <TabBtn label="General Ledger"  icon={<FileText {...ICON} />} active={tab === 'gl'}    onClick={() => setTab('gl')} />
        <TabBtn label="Balances"        icon={<Receipt {...ICON} />}  active={tab === 'balances'} onClick={() => setTab('balances')} />
        <TabBtn label="AR Aging"        icon={<TrendingUp {...ICON} />} active={tab === 'ar'}  onClick={() => setTab('ar')} />
        <TabBtn label="AP Aging"        icon={<TrendingDown {...ICON} />} active={tab === 'ap'} onClick={() => setTab('ap')} />
      </div>

      {tab === 'je'       && <JeTab />}
      {tab === 'gl'       && <GlTab />}
      {tab === 'balances' && <BalancesTab />}
      {tab === 'ar'       && <ArAgingTab />}
      {tab === 'ap'       && <ApAgingTab />}
    </div>
  );
};

const TabBtn = ({
  label, icon, active, onClick,
}: { label: string; icon: React.ReactNode; active: boolean; onClick: () => void }) => (
  <button type="button" onClick={onClick}
    style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 12px',
      border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
      borderRadius: 'var(--radius-md)',
      background: active ? 'var(--c-ink)' : 'transparent',
      color: active ? 'var(--c-cream)' : 'var(--c-ink)',
      fontSize: 'var(--fs-13)',
      cursor: 'pointer',
    }}>
    {icon}
    <span>{label}</span>
  </button>
);

/* ── Journal Entries ─────────────────────────────────────────────────── */

/* JE status label — REVERSED wins over POSTED, then DRAFT. */
const jeStatus = (r: JournalEntry): string =>
  r.reversed ? 'REVERSED' : r.posted ? 'POSTED' : 'DRAFT';

/* Shared DataTable (batch 2 of the SO-sample unification, owner 2026-07-28:
   ALL Accounting tabs converge on DataTable — this tab was the last DataGrid
   holdout). The source-type scope select stays a page-level control above the
   table, same rule as GL's account scope: the DataTable toolbar owns
   search/export/columns. */
const JeTab = () => {
  const [sourceType, setSourceType] = useState<string>('');
  const q = useJournalEntries(sourceType ? { sourceType } : undefined);
  const rows = useMemo(() => q.data?.journalEntries ?? [], [q.data]);

  // Loaded-only search over the visible entries (the old DataGrid's
  // "Filter visible entries…" box) — DataTable renders the box + scope hint,
  // the page does the filtering (DeliveryReturnsListV2 convention).
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) =>
      `${r.je_no} ${r.entry_date} ${r.source_type} ${r.source_doc_no ?? ''} ${jeStatus(r)}`
        .toLowerCase()
        .includes(term),
    );
  }, [rows, search]);

  return (
    <div className="space-y-3">
      <select
        value={sourceType}
        onChange={(e) => setSourceType(e.target.value)}
        className={styles.searchInput}
        style={{ maxWidth: 200 }}>
        <option value="">All sources</option>
        <option value="SI">SI — Sales Invoice</option>
        <option value="PI">PI — Purchase Invoice</option>
        <option value="SI_PAYMENT">SI Payment</option>
        <option value="PI_PAYMENT">PI Payment</option>
        <option value="MANUAL">Manual</option>
      </select>
      <DataTable<JournalEntry>
        tableId="accounting-je"
        layoutFamily="accounting-je"
        exportName="journal-entries"
        rows={q.isLoading ? null : visible}
        loading={q.isLoading}
        emptyLabel="No entries."
        getRowKey={(r) => r.id}
        /* Search is loaded-only (the JE query caps at 500 — searchScope
           contract): DataTable renders the box + scope hint, the page owns
           the actual filtering, per the DeliveryReturnsListV2 convention. */
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Filter visible entries…',
          loadedLimit: 500,
        }}
        columns={[
          { key: 'je_no', label: 'JE No', width: '140px', getValue: (r) => r.je_no, render: (r) => <span className={styles.codeChip}>{r.je_no}</span> },
          { key: 'entry_date', label: 'Date', width: '110px', getValue: (r) => r.entry_date, render: (r) => fmtDateOrDash(r.entry_date) },
          { key: 'source', label: 'Source', width: '110px', getValue: (r) => r.source_type, render: (r) => r.source_type },
          { key: 'doc', label: 'Doc', width: '140px', getValue: (r) => r.source_doc_no ?? '', render: (r) => r.source_doc_no ?? '—' },
          { key: 'debit', label: 'Debit', align: 'right', width: '130px', getValue: (r) => r.total_debit_sen / 100, render: (r) => fmt(r.total_debit_sen) },
          { key: 'credit', label: 'Credit', align: 'right', width: '130px', getValue: (r) => r.total_credit_sen / 100, render: (r) => fmt(r.total_credit_sen) },
          {
            key: 'status', label: 'Status', width: '110px',
            getValue: (r) => jeStatus(r),
            render: (r) => (
              <span className={`${styles.statusPill} ${r.posted ? styles.statusActive : styles.statusInactive}`}>
                {jeStatus(r)}
              </span>
            ),
          },
        ] satisfies Column<JournalEntry>[]}
      />
    </div>
  );
};

/* ── GL ──────────────────────────────────────────────────────────────── */
const GlTab = () => {
  const accounts = useAccounts();
  const [accountCode, setAccountCode] = useState<string>('');
  const q = useGlEntries(accountCode ? { accountCode } : undefined);
  const rows = q.data?.glEntries ?? [];

  type GlRow = (typeof rows)[number];
  return (
    <div className="space-y-3">
      {/* Account scope select stays a page-level control above the table
          (the DataTable toolbar owns search/export/columns). */}
      <select
        value={accountCode}
        onChange={(e) => setAccountCode(e.target.value)}
        className={styles.searchInput}
        style={{ maxWidth: 320 }}>
        <option value="">All accounts</option>
        {[...(accounts.data?.accounts ?? [])]
          .sort((a, b) => byText(a.account_code, b.account_code))
          .map((a) => (
          <option key={a.account_code} value={a.account_code}>
            {a.account_code} — {a.account_name}
          </option>
        ))}
      </select>
      <DataTable<GlRow>
        tableId="accounting-gl"
        layoutFamily="accounting-gl"
        exportName="general-ledger"
        rows={q.isLoading ? null : rows}
        loading={q.isLoading}
        emptyLabel="No GL entries posted yet."
        getRowKey={(r) => r.line_id}
        columns={[
          { key: 'entry_date', label: 'Date', width: '110px', getValue: (r) => r.entry_date, render: (r) => fmtDateOrDash(r.entry_date) },
          { key: 'je_no', label: 'JE No', width: '130px', getValue: (r) => r.je_no, render: (r) => <span className={styles.codeChip}>{r.je_no}</span> },
          { key: 'source', label: 'Source', width: '180px', getValue: (r) => `${r.source_type}${r.source_doc_no ? ` · ${r.source_doc_no}` : ''}`, render: (r) => `${r.source_type}${r.source_doc_no ? ` · ${r.source_doc_no}` : ''}` },
          { key: 'account', label: 'Account', getValue: (r) => `${r.account_code} — ${r.account_name}`, render: (r) => `${r.account_code} — ${r.account_name}` },
          { key: 'debit', label: 'Debit', align: 'right', width: '120px', getValue: (r) => r.debit_sen / 100, render: (r) => (r.debit_sen > 0 ? fmt(r.debit_sen) : '—') },
          { key: 'credit', label: 'Credit', align: 'right', width: '120px', getValue: (r) => r.credit_sen / 100, render: (r) => (r.credit_sen > 0 ? fmt(r.credit_sen) : '—') },
          { key: 'party', label: 'Party', width: '160px', getValue: (r) => r.party_name ?? r.party_code ?? '', render: (r) => r.party_name ?? r.party_code ?? '—' },
        ] satisfies Column<GlRow>[]}
      />
    </div>
  );
};

/* ── Balances ────────────────────────────────────────────────────────── */
const ACCOUNT_TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

const BalancesTab = () => {
  const q = useAccountBalances();
  // Pre-sort into the canonical statement order — DataTable's groupBy buckets
  // in first-seen row order, so this IS the group order until the user sorts.
  const rows = useMemo(() => {
    const all = q.data?.balances ?? [];
    const rank = (t: string) => {
      const i = ACCOUNT_TYPE_ORDER.indexOf(t);
      return i === -1 ? ACCOUNT_TYPE_ORDER.length : i;
    };
    return [...all].sort(
      (a, b) => rank(a.account_type) - rank(b.account_type) || a.account_code.localeCompare(b.account_code),
    );
  }, [q.data]);

  type BalanceRow = (typeof rows)[number];
  return (
    <DataTable<BalanceRow>
      tableId="accounting-balances"
      layoutFamily="accounting-balances"
      exportName="account-balances"
      rows={q.isLoading ? null : rows}
      loading={q.isLoading}
      emptyLabel="No balances yet."
      getRowKey={(r) => r.account_code}
      groupBy={{ key: 'type' }}
      columns={[
        // Grouping key — the collapsible header row shows the type, so the
        // column itself starts hidden (still revealable from Columns).
        { key: 'type', label: 'Type', width: '110px', defaultHidden: true, getValue: (r) => r.account_type, render: (r) => r.account_type },
        { key: 'account', label: 'Account', getValue: (r) => `${r.account_code} — ${r.account_name}`, render: (r) => `${r.account_code} — ${r.account_name}` },
        { key: 'debit', label: 'Σ Debit', align: 'right', width: '140px', getValue: (r) => r.total_debit_sen / 100, render: (r) => fmt(r.total_debit_sen) },
        { key: 'credit', label: 'Σ Credit', align: 'right', width: '140px', getValue: (r) => r.total_credit_sen / 100, render: (r) => fmt(r.total_credit_sen) },
        {
          key: 'balance', label: 'Balance', align: 'right', width: '150px',
          getValue: (r) => r.balance_sen / 100,
          render: (r) => (
            <span style={{ fontWeight: 700, color: r.balance_sen < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-ink)' }}>
              {fmt(r.balance_sen)}
            </span>
          ),
        },
      ] satisfies Column<BalanceRow>[]}
    />
  );
};

/* ── AR Aging ────────────────────────────────────────────────────────── */
const ArAgingTab = () => {
  const q = useArAging();
  const rows = useMemo(() => q.data?.arAging ?? [], [q.data]);
  const totals = useMemo(() => bucketTotals<ArAgingRow>(rows), [rows]);

  return (
    <>
      <BucketSummary totals={totals} grandTotal={rows.reduce((s, r) => s + r.outstanding_centi, 0)} />
      <DataTable<ArAgingRow>
        tableId="accounting-ar-aging"
        layoutFamily="accounting-ar-aging"
        exportName="ar-aging"
        rows={q.isLoading ? null : rows}
        loading={q.isLoading}
        emptyLabel="No outstanding AR."
        getRowKey={(r) => r.invoice_id}
        columns={[
          { key: 'invoice', label: 'Invoice', width: '140px', getValue: (r) => r.invoice_number, render: (r) => <span className={styles.codeChip}>{r.invoice_number}</span> },
          { key: 'customer', label: 'Customer', getValue: (r) => `${r.debtor_name}${r.debtor_code ? ` (${r.debtor_code})` : ''}`, render: (r) => `${r.debtor_name}${r.debtor_code ? ` (${r.debtor_code})` : ''}` },
          { key: 'invoice_date', label: 'Date', width: '110px', getValue: (r) => r.invoice_date, render: (r) => fmtDateOrDash(r.invoice_date) },
          { key: 'due', label: 'Due', width: '110px', getValue: (r) => r.due_date ?? '', render: (r) => r.due_date ?? '—' },
          {
            key: 'outstanding', label: 'Outstanding', align: 'right', width: '140px',
            getValue: (r) => r.outstanding_centi / 100,
            render: (r) => <span style={{ fontWeight: 700 }}>{fmt(r.outstanding_centi)}</span>,
          },
          { key: 'days_overdue', label: 'Days Overdue', align: 'right', width: '120px', getValue: (r) => r.days_overdue, render: (r) => (r.days_overdue > 0 ? r.days_overdue : '—') },
          { key: 'bucket', label: 'Bucket', width: '110px', getValue: (r) => r.aging_bucket, render: (r) => <BucketPill bucket={r.aging_bucket} /> },
        ] satisfies Column<ArAgingRow>[]}
      />
    </>
  );
};

/* ── AP Aging ────────────────────────────────────────────────────────── */
const ApAgingTab = () => {
  const q = useApAging();
  const rows = useMemo(() => q.data?.apAging ?? [], [q.data]);
  const totals = useMemo(() => bucketTotals<ApAgingRow>(rows), [rows]);

  return (
    <>
      <BucketSummary totals={totals} grandTotal={rows.reduce((s, r) => s + r.outstanding_centi, 0)} />
      <DataTable<ApAgingRow>
        tableId="accounting-ap-aging"
        layoutFamily="accounting-ap-aging"
        exportName="ap-aging"
        rows={q.isLoading ? null : rows}
        loading={q.isLoading}
        emptyLabel="No outstanding AP."
        getRowKey={(r) => r.invoice_id}
        columns={[
          { key: 'invoice', label: 'Invoice', width: '140px', getValue: (r) => r.invoice_number, render: (r) => <span className={styles.codeChip}>{r.invoice_number}</span> },
          // Owner 2026-07-24: supplier NAME and CODE are separate columns on
          // every procurement table, not one combined cell.
          { key: 'supplier', label: 'Supplier', getValue: (r) => r.supplier_name ?? '', render: (r) => r.supplier_name ?? '—' },
          {
            key: 'supplier_code', label: 'Supplier Code', width: '130px',
            getValue: (r) => r.supplier_code ?? '',
            render: (r) => (r.supplier_code ? <span className={styles.codeChip}>{r.supplier_code}</span> : '—'),
          },
          { key: 'invoice_date', label: 'Date', width: '110px', getValue: (r) => r.invoice_date, render: (r) => fmtDateOrDash(r.invoice_date) },
          { key: 'due', label: 'Due', width: '110px', getValue: (r) => r.due_date ?? '', render: (r) => r.due_date ?? '—' },
          {
            key: 'outstanding', label: 'Outstanding', align: 'right', width: '140px',
            getValue: (r) => r.outstanding_centi / 100,
            render: (r) => <span style={{ fontWeight: 700 }}>{fmt(r.outstanding_centi)}</span>,
          },
          { key: 'days_overdue', label: 'Days Overdue', align: 'right', width: '120px', getValue: (r) => r.days_overdue, render: (r) => (r.days_overdue > 0 ? r.days_overdue : '—') },
          { key: 'bucket', label: 'Bucket', width: '110px', getValue: (r) => r.aging_bucket, render: (r) => <BucketPill bucket={r.aging_bucket} /> },
        ] satisfies Column<ApAgingRow>[]}
      />
    </>
  );
};

/* ── Helpers ─────────────────────────────────────────────────────────── */
type Bucket = 'CURRENT' | '1-30' | '31-60' | '61-90' | '90+';

const bucketTotals = <T extends { aging_bucket: Bucket; outstanding_centi: number }>(rows: T[]) => {
  const out: Record<Bucket, number> = { 'CURRENT': 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of rows) out[r.aging_bucket] += r.outstanding_centi;
  return out;
};

const BucketSummary = ({
  totals, grandTotal,
}: { totals: Record<Bucket, number>; grandTotal: number }) => (
  <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-3)' }}>
    {(['CURRENT', '1-30', '31-60', '61-90', '90+'] as const).map((b) => (
      <SummaryTile key={b} label={b} value={fmt(totals[b])} muted={b === 'CURRENT'} />
    ))}
    <SummaryTile label="Total" value={fmt(grandTotal)} bold />
  </section>
);

const SummaryTile = ({
  label, value, muted, bold,
}: { label: string; value: string; muted?: boolean; bold?: boolean }) => (
  <div style={{
    padding: 'var(--space-3) var(--space-4)',
    background: 'var(--c-cream)',
    border: `1px solid ${muted ? 'var(--c-line, rgba(34,31,32,0.08))' : 'var(--c-orange)'}`,
    borderRadius: 'var(--radius-md)',
  }}>
    <div className={styles.subtitle} style={{ marginBottom: 2 }}>{label}</div>
    <div style={{ fontSize: 'var(--fs-16)', fontWeight: bold ? 900 : 700, color: 'var(--c-ink)' }}>
      {value}
    </div>
  </div>
);

const BucketPill = ({ bucket }: { bucket: Bucket }) => {
  const colorMap: Record<Bucket, { bg: string; fg: string }> = {
    'CURRENT': { bg: 'rgba(47, 93, 79, 0.12)', fg: 'var(--c-secondary-a, #2F5D4F)' },
    '1-30':    { bg: 'rgba(232, 107, 58, 0.10)', fg: 'var(--c-orange)' },
    '31-60':   { bg: 'rgba(232, 107, 58, 0.18)', fg: 'var(--c-orange)' },
    '61-90':   { bg: 'rgba(184, 51, 31, 0.10)', fg: 'var(--c-festive-b, #B8331F)' },
    '90+':     { bg: 'rgba(184, 51, 31, 0.18)', fg: 'var(--c-festive-b, #B8331F)' },
  };
  const c = colorMap[bucket];
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px',
      borderRadius: 999, background: c.bg, color: c.fg,
      fontSize: 'var(--fs-12)', fontWeight: 700,
    }}>
      {bucket}
    </span>
  );
};
