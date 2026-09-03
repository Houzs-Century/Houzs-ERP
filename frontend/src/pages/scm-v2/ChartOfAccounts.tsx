// ----------------------------------------------------------------------------
// ChartOfAccounts — the maintenance page at /scm/chart-of-accounts.
//
// The owner's selective sharing (2026-09-02): 我要做选择性公用是因为往后可能会
// 在加公司，所以要可以公用，可能类似recon setup 我tick 后选择这个公司要不要用.
// One tree of every account any company carries, a TICK COLUMN PER COMPANY —
// tick = that company uses it (the row is instantiated from the master
// definition, parent riding along), untick = it does not (children cascade
// off, after a confirm). A future company is a new column, never a new
// spreadsheet exercise.
//
// The Upload button takes the accountant's AutoCount export (xlsx) straight
// from disk: codes (digit and letter series), two-tier indentation → parent,
// section headings → account_type, Special Acc Type → acc_money (SBK/SCH).
// Rows are pre-classified shared vs company-specific (banks, cash, related-
// party loans, directors, HP/borrowings stay home); the tick columns are
// where a person adjusts afterwards. The file itself never enters the repo.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Upload } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useChartUnion, useChartTick, useChartImport,
  type ChartRow, type ChartImportRow,
} from '../../vendor/scm/lib/accounting-queries';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* ── The AutoCount export, parsed (the scan page's discipline) ───────────── */

const CODE_RE = /^(\s*)(\d{3}-[A-Za-z0-9]{4})\s*$/;

const SECTION_TYPE: Record<string, ChartImportRow['accountType']> = {
  'CAPITAL': 'EQUITY', 'RETAINED EARNING': 'EQUITY',
  'FIXED ASSETS': 'ASSET', 'OTHER ASSETS': 'ASSET', 'CURRENT ASSETS': 'ASSET',
  'CURRENT LIABILITIES': 'LIABILITY', 'LONG TERM LIABILITIES': 'LIABILITY',
  'SALES': 'INCOME', 'SALES ADJUSTMENTS': 'INCOME', 'OTHER INCOMES': 'INCOME',
  'COST OF GOODS SOLD': 'EXPENSE', 'EXPENSES': 'EXPENSE', 'TAXATION': 'EXPENSE',
};

/* Company-specific by nature: banks and cash are THIS company's accounts
   (SBK/SCH), and the related-party/director/HP/borrowing series name real
   counterparties of one company. Everything else defaults to shared — the
   tick columns are where a person narrows afterwards. */
const isExclusive = (code: string, special: string): boolean =>
  ['SBK', 'SCH'].includes(special) || /^(350|351|430|450|451|460|406)-/.test(code);

export type ParsedChart = { rows: ChartImportRow[]; sections: string[]; unknownSections: string[] };

export function parseChartXlsx(wb: XLSX.WorkBook): ParsedChart {
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet!, { header: 1, raw: false });
  const rows: ChartImportRow[] = [];
  const sections: string[] = [];
  const unknownSections: string[] = [];
  let section = '';
  const prevByDepth: Record<number, string> = {};
  for (const r of grid) {
    const c0 = String(r[0] ?? '');
    const m = c0.match(CODE_RE);
    if (!m) {
      const label = c0.trim().toUpperCase();
      /* Section headings are short single-cell lines. The company letterhead
         and page furniture are not sections. */
      if (label && r.length <= 2 && !label.includes('ACC')
        && !label.includes('SDN') && !label.includes('BHD') && !label.includes('PAGE')) {
        section = label;
        sections.push(label);
        if (!(label in SECTION_TYPE)) unknownSections.push(label);
      }
      continue;
    }
    const depth = Math.floor(m[1]!.length / 4);
    const code = m[2]!;
    prevByDepth[depth] = code;
    const special = r[8] != null ? String(r[8]).trim().toUpperCase() : '';
    rows.push({
      code,
      name: String(r[1] ?? '').trim() || code,
      accountType: SECTION_TYPE[section] ?? 'EXPENSE',
      parentCode: depth > 0 ? (prevByDepth[depth - 1] ?? null) : null,
      accMoney: special === 'SBK' || special === 'SCH',
      shared: !isExclusive(code, special),
    });
  }
  return { rows, sections, unknownSections };
}

/* ── The tree order: parents first, children under them ──────────────────── */
function treeOrder(accounts: ChartRow[]): ChartRow[] {
  const byParent = new Map<string | null, ChartRow[]>();
  for (const a of accounts) {
    const list = byParent.get(a.parentCode) ?? [];
    list.push(a);
    byParent.set(a.parentCode, list);
  }
  for (const list of byParent.values()) list.sort((x, y) => x.code.localeCompare(y.code));
  const out: ChartRow[] = [];
  const walk = (parent: string | null) => {
    for (const a of byParent.get(parent) ?? []) {
      out.push(a);
      walk(a.code);
    }
  };
  walk(null);
  /* Orphans (parent not in the union — should not happen, but a broken tree
     must still RENDER) trail at the end rather than vanishing. */
  const seen = new Set(out.map((a) => a.code));
  for (const a of accounts) if (!seen.has(a.code)) out.push(a);
  return out;
}

const TYPE_TONE: Record<string, string> = {
  ASSET: '#2F5D4F', LIABILITY: '#B06000', EQUITY: '#4A4A8A', INCOME: '#16695f', EXPENSE: '#8A3B3B',
};

export const ChartOfAccounts = () => {
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const canManage = can('scm.payment_voucher.post');

  const unionQ = useChartUnion();
  const tick = useChartTick();
  const doImport = useChartImport();
  const fileRef = useRef<HTMLInputElement>(null);

  const companies = unionQ.data?.companies ?? [];
  const accounts = useMemo(() => treeOrder(unionQ.data?.accounts ?? []), [unionQ.data]);
  const [parsed, setParsed] = useState<ParsedChart | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const onTick = async (companyId: number, row: ChartRow, next: boolean) => {
    if (!next) {
      const kids = accounts.filter((a) => a.parentCode === row.code && a.perCompany[companyId]?.active);
      const ok = await askConfirm({
        title: `Untick ${row.code} for ${companies.find((c) => c.id === companyId)?.code ?? companyId}?`,
        body: kids.length > 0
          ? `This is a header — its ${kids.length} active sub-account(s) go off with it.`
          : 'The account is kept (history stays); it just stops being offered in this company.',
        confirmLabel: 'Untick',
      });
      if (!ok) return;
    }
    setBusyKey(`${companyId}:${row.code}`);
    try {
      await tick.mutateAsync({ companyId, code: row.code, active: next });
    } catch (e) {
      void notify({ title: 'Tick failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    } finally {
      setBusyKey(null);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const p = parseChartXlsx(wb);
      if (p.rows.length === 0) {
        void notify({ title: 'Nothing to import', body: 'No account codes were found in the file — is this the AutoCount chart export?', tone: 'error' });
        return;
      }
      setParsed(p);
    } catch (e) {
      void notify({ title: 'Could not read the file', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const runImport = async () => {
    if (!parsed) return;
    try {
      const res = await doImport.mutateAsync({ companyId: 1, rows: parsed.rows });
      setParsed(null);
      void notify({
        title: `${res.imported} account(s) imported`,
        body: res.shared > 0 && res.sharedTo.length > 0
          ? `${res.shared} shared row(s) copied to ${res.sharedTo.length} other company(ies); the rest stay HOUZS-only. Adjust any tick below.`
          : 'Adjust the ticks below.',
        tone: 'info',
      });
    } catch (e) {
      void notify({ title: 'Import failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const exclusiveRows = parsed?.rows.filter((r) => !r.shared) ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="Chart of Accounts"
        actions={canManage ? (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
            <Upload {...ICON} /> Upload AutoCount chart
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
              onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        ) : undefined}
      />

      {parsed && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Ready to import</h2>
          </div>
          <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <div>
              {parsed.rows.length} account(s) read · {parsed.rows.length - exclusiveRows.length} will be SHARED to every company ·{' '}
              {exclusiveRows.length} stay HOUZS-only (banks, cash, related-party loans, directors, HP/borrowings).
            </div>
            {parsed.unknownSections.length > 0 && (
              <div style={{ color: 'var(--c-festive-b, #B8331F)' }}>
                Unknown section(s) fell back to EXPENSE: {parsed.unknownSections.join(', ')} — check them after import.
              </div>
            )}
            <details>
              <summary style={{ cursor: 'pointer' }}>The HOUZS-only list ({exclusiveRows.length})</summary>
              <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
                {exclusiveRows.map((r) => <div key={r.code}>{r.code} · {r.name}</div>)}
              </div>
            </details>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="primary" size="sm" onClick={() => void runImport()} disabled={doImport.isPending}>
                {doImport.isPending ? 'Importing…' : `Import ${parsed.rows.length} accounts`}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setParsed(null)} disabled={doImport.isPending}>
                Cancel
              </Button>
            </div>
          </div>
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Every account, every company</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            tick = the company uses it · unticking a header takes its children · headers never book (父户不记账)
          </span>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          {unionQ.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading the chart…</div>}
          {unionQ.error != null && (
            <div className={styles.bannerWarn}>
              Failed to load the chart. {unionQ.error instanceof Error ? unionQ.error.message : ''}
            </div>
          )}
          {!unionQ.isLoading && accounts.length === 0 && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
              No accounts yet — upload the AutoCount chart to begin.
            </div>
          )}
          {accounts.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-weak, #e3e1da)' }}>
                  <th style={{ padding: '6px 8px' }}>Code</th>
                  <th style={{ padding: '6px 8px' }}>Name</th>
                  <th style={{ padding: '6px 8px' }}>Type</th>
                  {companies.map((co) => (
                    <th key={co.id} style={{ padding: '6px 8px', textAlign: 'center' }}>{co.code}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const isParent = accounts.some((x) => x.parentCode === a.code);
                  return (
                    <tr key={a.code} style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)' }}>
                      <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', paddingLeft: a.parentCode ? 28 : 8, fontWeight: isParent ? 700 : 400 }}>
                        {a.code}
                      </td>
                      <td style={{ padding: '4px 8px', fontWeight: isParent ? 700 : 400 }}>
                        {a.name}
                        {a.accMoney && <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', color: 'var(--c-secondary-a, #2F5D4F)' }}>money</span>}
                        {isParent && <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>header</span>}
                      </td>
                      <td style={{ padding: '4px 8px', fontSize: 'var(--fs-11)', color: TYPE_TONE[a.type] ?? 'inherit' }}>{a.type}</td>
                      {companies.map((co) => {
                        const active = a.perCompany[co.id]?.active === true;
                        const key = `${co.id}:${a.code}`;
                        return (
                          <td key={co.id} style={{ padding: '4px 8px', textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              aria-label={`${a.code} for ${co.code}`}
                              checked={active}
                              disabled={!canManage || busyKey === key || tick.isPending}
                              onChange={(e) => void onTick(co.id, a, e.target.checked)}
                              style={{ width: 15, height: 15, accentColor: 'var(--c-orange)' }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
};
