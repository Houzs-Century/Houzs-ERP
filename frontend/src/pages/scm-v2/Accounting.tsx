// ----------------------------------------------------------------------------
// Accounting page — the ledger's face (accounting module, phase 1).
//
// Tab strip:
//   1. Chart of Accounts — the ACTIVE company's tree, read-only (maintenance
//      lives on the union page /scm/chart-of-accounts — one door only)
//   2. Journal Entries — list w/ filter, drill into lines, NEW manual journal,
//      post a draft, reverse a posted manual journal
//   3. General Ledger — flat GL stream, filter by account / date
//   4. Trial Balance — Σ Dr / Σ Cr per account + the report's own self-check:
//      the difference tile is 0.00 or the ledger is broken (brief §3.7)
//   5. AR Aging / 6. AP Aging — outstanding SI / PI bucketed
//   7. Self-check — reconciliation layer 1: control account vs documents,
//      drift named to the document (brief §3.5)
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { accountingTabFromSearch, type AccountingTab } from './accounting-tabs';
import { reportOfAccountingTab, type ReportItem } from './reports-catalog';
import { ReportShell } from './reports/ReportShell';
import {
  useAccountBalances,
  useAccounts,
  type Account,
} from '../../vendor/scm/lib/accounting-queries';
import { AgingReport } from './AgingReport';
import { DataTable, type Column } from '../../components/DataTable';
import { ItemGroupsTab } from './ItemGroups';
import { StockCloseTab } from './StockClose';
import { PnLTab, BalanceSheetTab } from './Reports';
import { ReceiptsPaymentsTab } from './ReceiptsPayments';
import { PaymentCorrectionsTab } from './PaymentCorrectionsTab';
import { CollectionTab } from './CollectionReport';
import { MerchantChargesTab } from './MerchantChargesReport';
import { PerformanceTab } from './PerformancePnl';
import { EventCostsTab } from './EventCosts';
import { EventCommissionTab } from './EventCommission';
import { ProductProfitTab } from './ProductProfit';
import { LogisticsCostTab } from './LogisticsCost';
import { fmtSen } from '../../vendor/shared/format';
import { byText } from '../../vendor/scm/lib/sort-options';
import styles from './Suppliers.module.css';
import { GeneralLedger } from './GeneralLedger';
import { JournalTab } from './JournalEntries';
import { SelfCheckTab } from './SelfCheck';
import { AccountingHeader } from './books/AccountingHeader';
import { humaniseStatusKey } from '../../vendor/scm/lib/status-pill';
import { DateField } from "../../vendor/scm/components/DateField";


// The ONE guarded centi→"RM …" formatter — returns "—" for an absent/non-finite
// amount, never "RM NaN". Kept under the local name so callsites are unchanged.
const fmt = (sen: number | null | undefined) => fmtSen(sen);

type Tab = AccountingTab;

/* The tabs that draw their own head, with their actions in it. */
const OWN_HEADER: ReadonlySet<Tab> = new Set<Tab>(['je', 'gl', 'check']);

export const Accounting = () => {
  /* THE TAB THE URL NAMES (docs/bugs/0824). The Finance sidebar deep-links
     every tab (/scm/accounting?tab=pnl …) and is the ONE way between them
     (owner 2026-09-12: 只靠侧栏就好，不然太乱了 — the strip of sixteen buttons
     that used to sit here repeated the sidebar's three groups; docs/bugs/0841).
     The page opens on the tab asked for, follows a sidebar click made while it
     is already open, and names the tab in its title. A name the page does not
     know falls back to the journal. */
  const [params] = useSearchParams();
  const wanted = accountingTabFromSearch(params.get('tab'));
  const [tab, setTabState] = useState<Tab>(wanted ?? 'je');
  useEffect(() => {
    if (wanted && wanted !== tab) setTabState(wanted);
  }, [wanted, tab]);

  /* A report tab is drawn in the report shell — the report list and the
     report's own header (batch 6 §4.3); Journal entries, the General ledger
     and the Trial balance too when opened from the list (`in=reports`). */
  const report = reportOfAccountingTab(tab, params.get('in') === 'reports');

  return (
    <AccountingFrame tab={tab} report={report}>
      {tab === 'coa'   && <CoaTab />}
      {tab === 'groups' && <ItemGroupsTab />}
      {tab === 'je'    && <JeTab />}
      {tab === 'gl'    && <GlTab />}
      {tab === 'tb'    && <TrialBalanceTab />}
      {tab === 'close' && <StockCloseTab />}
      {tab === 'pnl'   && <PnLTab />}
      {tab === 'bs'    && <BalanceSheetTab />}
      {tab === 'rp'    && <ReceiptsPaymentsTab />}
      {/* The formal debtor and creditor aging (owner 2026-10-02, B4: it replaces
          the old lists under the same names). */}
      {tab === 'ar'    && <AgingReport side="ar" />}
      {tab === 'ap'    && <AgingReport side="ap" />}
      {tab === 'check' && <SelfCheckTab />}
      {tab === 'corrections' && <PaymentCorrectionsTab />}
      {tab === 'collection' && <CollectionTab />}
      {tab === 'charges' && <MerchantChargesTab />}
      {tab === 'performance' && <PerformanceTab />}
      {tab === 'events' && <EventCostsTab />}
      {tab === 'commission' && <EventCommissionTab />}
      {tab === 'products' && <ProductProfitTab />}
      {tab === 'logistics' && <LogisticsCostTab />}
    </AccountingFrame>
  );
};

/* The frame a tab is drawn in: a report in the report shell (a tab that draws
   its own head keeps it, the shell adds the report list), any other tab under
   the redesign's head (batch 6 §1.2) — "Finance · <section>" over the tab's
   own name, unless the tab draws its own with its actions in it. */
const AccountingFrame = ({ tab, report, children }: { tab: Tab; report: ReportItem | null; children: ReactNode }) => (
  report
    ? <ReportShell report={report.id} ownHeader={OWN_HEADER.has(tab)}>{children}</ReportShell>
    : (
      <div className="space-y-4">
        {!OWN_HEADER.has(tab) && <AccountingHeader tab={tab} />}
        {children}
      </div>
    )
);

/* ── Chart of Accounts ───────────────────────────────────────────────── */
const ACCOUNT_TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

const CoaTab = () => {
  const q = useAccounts();
  const [showInactive, setShowInactive] = useState(false);

  const all = useMemo(() => q.data?.accounts ?? [], [q.data]);
  const parents = useMemo(() => new Set(all.map((a) => a.parent_code).filter(Boolean) as string[]), [all]);
  const rows = useMemo(() => {
    const rank = (t: string) => {
      const i = ACCOUNT_TYPE_ORDER.indexOf(t);
      return i === -1 ? ACCOUNT_TYPE_ORDER.length : i;
    };
    return all
      .filter((a) => showInactive || a.is_active)
      .sort((a, b) => rank(a.account_type) - rank(b.account_type) || byText(a.account_code, b.account_code));
  }, [all, showInactive]);

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {/* This tab is the ACTIVE company's ledger view. The chart is
            MAINTAINED in one place only — the union page with the per-company
            ticks (the owner, 2026-09-03: 照理说应该维护 overall chart of
            account 罢了). Adding here used to create the row in whichever
            company you happened to be standing in; that door is closed. */}
        <Link to="/scm/chart-of-accounts" style={{ fontSize: 'var(--fs-13)', fontWeight: 600, color: 'var(--c-orange)' }}>
          Maintain the chart (all companies) →
        </Link>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-13)' }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show deactivated (legacy codes)
        </label>
      </div>

      <DataTable<Account>
        tableId="accounting-coa"
        layoutFamily="accounting-coa"
        exportName="chart-of-accounts"
        rows={q.isLoading ? null : rows}
        loading={q.isLoading}
        emptyLabel="No accounts."
        getRowKey={(r) => r.account_code}
        groupBy={{ key: 'type' }}
        columns={[
          { key: 'type', label: 'Type', width: '110px', defaultHidden: true, getValue: (r) => r.account_type, render: (r) => humaniseStatusKey(r.account_type) },
          {
            key: 'code', label: 'Code', width: '130px', getValue: (r) => r.account_code,
            render: (r) => (
              <span className={styles.codeChip} style={parents.has(r.account_code) ? { fontWeight: 700 } : undefined}>
                {r.account_code}
              </span>
            ),
          },
          {
            key: 'name', label: 'Name',
            getValue: (r) => r.account_name,
            /* 父子 account 不是很明显 (the owner, 2026-09-03, this very table
               in hand): headers now carry WEIGHT like the union page's —
               bold, tagged — and children step in behind a tree glyph
               instead of a barely-there 18px. */
            render: (r) => (
              parents.has(r.account_code)
                ? (
                  <span style={{ fontWeight: 700 }}>
                    {r.account_name}
                    <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', fontWeight: 400, color: 'var(--c-ink-soft, #666)' }}>header</span>
                  </span>
                )
                : r.parent_code
                  ? (
                    <span style={{ paddingLeft: 26, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span aria-hidden style={{ color: 'var(--c-ink-soft, #999)' }}>└</span>
                      {r.account_name}
                    </span>
                  )
                  : <span>{r.account_name}</span>
            ),
          },
          {
            key: 'parent', label: 'Parent', width: '120px', getValue: (r) => r.parent_code ?? '',
            render: (r) => r.parent_code
              ? <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--c-ink-soft, #666)' }}>{r.parent_code}</span>
              : '—',
          },
          {
            key: 'kind', label: 'Posting', width: '110px',
            getValue: (r) => (parents.has(r.account_code) ? 'HEADER' : 'POSTABLE'),
            render: (r) => parents.has(r.account_code)
              ? <span className={`${styles.statusPill} ${styles.statusInactive}`}>HEADER</span>
              : <span style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #666)' }}>postable</span>,
          },
          {
            key: 'status', label: 'Status', width: '110px',
            getValue: (r) => (r.is_active ? 'ACTIVE' : 'INACTIVE'),
            render: (r) => (
              <span className={`${styles.statusPill} ${r.is_active ? styles.statusActive : styles.statusInactive}`}>
                {r.is_active ? 'Active' : 'Inactive'}
              </span>
            ),
          },
        ] satisfies Column<Account>[]}
      />
    </div>
  );
};

/* ── Journal Entries ─────────────────────────────────────────────────── */

/* The Journal page grouped per entry — the AutoCount way (docs/bugs/0935).
   Its filters live in the URL; the entry card and the draft form ride with it. */
const JeTab = () => <JournalTab />;

/* ── GL ──────────────────────────────────────────────────────────────── */
/* The General Ledger the AutoCount way — per-account blocks, BALANCE B/F, a
   running balance, the journal's references (docs/bugs/0924). Its filters
   live in the URL, so a figure on a statement opens it on that account. */
const GlTab = () => <GeneralLedger />;

/* ── Trial Balance ───────────────────────────────────────────────────── */

export const TrialBalanceTab = () => {
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

  /* The report's own self-check (brief §3.7: every report is born carrying
     one): Σ debits must equal Σ credits over the whole ledger. Anything but
     0.00 is a BUG in the books, not an opinion about them. */
  const totals = useMemo(() => {
    let dr = 0; let cr = 0;
    for (const r of rows) { dr += r.total_debit_sen; cr += r.total_credit_sen; }
    return { dr, cr, diff: dr - cr };
  }, [rows]);

  type BalanceRow = (typeof rows)[number];
  /* A self-check folded over a list that is empty BECAUSE THE READ FAILED
     computes dr === cr === 0, which reads as "the books balance" — in the green
     frame, as a finding. It is not a finding about the ledger, it is the
     absence of one. `isLoading` alone cannot tell them apart: it is FALSE after
     a failed fetch, which is exactly when `rows` is emptiest. So the tiles show
     the unknown marker and the failure is stated. */
  const unknown = q.isError || (!q.isSuccess && rows.length === 0);
  const NOT_KNOWN = '—';
  return (
    <div className="space-y-3">
      {q.isError && (
        <div style={{
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(184, 51, 31, 0.10)',
          border: '1px solid var(--c-festive-b, #B8331F)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
          color: 'var(--c-festive-b, #B8331F)',
        }}>
          <strong>The account balances could not be loaded, so this report is not a statement about the books.</strong>{' '}
          {q.error instanceof Error ? q.error.message : 'Please try again.'}
        </div>
      )}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)' }}>
        <SummaryTile label="Σ Debit" value={unknown ? NOT_KNOWN : fmt(totals.dr)} />
        <SummaryTile label="Σ Credit" value={unknown ? NOT_KNOWN : fmt(totals.cr)} />
        <div style={{
          padding: 'var(--space-3) var(--space-4)',
          background: unknown ? 'var(--c-cream)' : totals.diff === 0 ? 'rgba(47, 93, 79, 0.10)' : 'rgba(184, 51, 31, 0.10)',
          border: `1px solid ${unknown ? 'var(--c-line, rgba(34,31,32,0.08))' : totals.diff === 0 ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--c-festive-b, #B8331F)'}`,
          borderRadius: 'var(--radius-md)',
        }}>
          <div className={styles.subtitle} style={{ marginBottom: 2 }}>Difference (must be 0.00)</div>
          <div style={{ fontSize: 'var(--fs-16)', fontWeight: 900, color: unknown ? 'var(--c-ink)' : totals.diff === 0 ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--c-festive-b, #B8331F)' }}>
            {unknown
              ? `${NOT_KNOWN} — not checked`
              : `${fmt(totals.diff)}${totals.diff === 0 ? ' — books balance' : ' — BOOKS DO NOT BALANCE'}`}
          </div>
        </div>
      </section>

      <DataTable<BalanceRow>
        tableId="accounting-balances"
        layoutFamily="accounting-balances"
        exportName="trial-balance"
        rows={q.isLoading || q.isError ? null : rows}
        loading={q.isLoading}
        emptyLabel={q.isError ? 'The account balances could not be loaded.' : 'No balances yet.'}
        getRowKey={(r) => r.account_code}
        groupBy={{ key: 'type' }}
        columns={[
          { key: 'type', label: 'Type', width: '110px', defaultHidden: true, getValue: (r) => r.account_type, render: (r) => humaniseStatusKey(r.account_type) },
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
    </div>
  );
};

/* ── Helpers ─────────────────────────────────────────────────────────── */
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

