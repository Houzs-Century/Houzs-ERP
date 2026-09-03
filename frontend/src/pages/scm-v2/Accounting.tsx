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

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, FileText, ListTree, Receipt, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';
import {
  useJournalEntries,
  useJournalEntryDetail,
  useCreateJournalEntry,
  usePostJournalEntry,
  useGlEntries,
  useAccountBalances,
  useArAging,
  useApAging,
  useAccounts,
  type Account,
  type ArAgingRow,
  type ApAgingRow,
  type JournalEntry,
  type JeLineIn,
} from '../../vendor/scm/lib/accounting-queries';
import {
  useReverseJournalEntry,
  useControlCheck,
  type ControlCheckRow,
  type UnbookedPayments,
} from './accounting-phase1-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { fmtSen } from '../../vendor/shared/format';
import { byText } from '../../vendor/scm/lib/sort-options';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// The ONE guarded centi→"RM …" formatter — returns "—" for an absent/non-finite
// amount, never "RM NaN". Kept under the local name so callsites are unchanged.
const fmt = (sen: number | null | undefined) => fmtSen(sen);

type Tab = 'coa' | 'je' | 'gl' | 'tb' | 'ar' | 'ap' | 'check';

export const Accounting = () => {
  const [tab, setTab] = useState<Tab>('je');

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Accounting" />

      <div className={styles.statusChips} style={{ gap: 'var(--space-2)' }}>
        <TabBtn label="Chart of Accounts" icon={<ListTree {...ICON} />} active={tab === 'coa'} onClick={() => setTab('coa')} />
        <TabBtn label="Journal Entries" icon={<BookOpen {...ICON} />} active={tab === 'je'}    onClick={() => setTab('je')} />
        <TabBtn label="General Ledger"  icon={<FileText {...ICON} />} active={tab === 'gl'}    onClick={() => setTab('gl')} />
        <TabBtn label="Trial Balance"   icon={<Receipt {...ICON} />}  active={tab === 'tb'} onClick={() => setTab('tb')} />
        <TabBtn label="AR Aging"        icon={<TrendingUp {...ICON} />} active={tab === 'ar'}  onClick={() => setTab('ar')} />
        <TabBtn label="AP Aging"        icon={<TrendingDown {...ICON} />} active={tab === 'ap'} onClick={() => setTab('ap')} />
        <TabBtn label="Self-check"      icon={<ShieldCheck {...ICON} />} active={tab === 'check'} onClick={() => setTab('check')} />
      </div>

      {tab === 'coa'   && <CoaTab />}
      {tab === 'je'    && <JeTab />}
      {tab === 'gl'    && <GlTab />}
      {tab === 'tb'    && <TrialBalanceTab />}
      {tab === 'ar'    && <ArAgingTab />}
      {tab === 'ap'    && <ApAgingTab />}
      {tab === 'check' && <SelfCheckTab />}
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

/* Small shared form styling for the phase-1 cards. */
const cardStyle: React.CSSProperties = {
  padding: 'var(--space-4)',
  background: 'var(--c-cream)',
  border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
  borderRadius: 'var(--radius-md)',
};
const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  borderRadius: 'var(--radius-sm, 6px)',
  fontSize: 'var(--fs-13)',
  background: 'white',
};
const btnStyle = (primary?: boolean): React.CSSProperties => ({
  padding: '6px 14px',
  border: '1px solid var(--c-ink)',
  borderRadius: 'var(--radius-md)',
  background: primary ? 'var(--c-ink)' : 'transparent',
  color: primary ? 'var(--c-cream)' : 'var(--c-ink)',
  fontSize: 'var(--fs-13)',
  fontWeight: 600,
  cursor: 'pointer',
});

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
          { key: 'type', label: 'Type', width: '110px', defaultHidden: true, getValue: (r) => r.account_type, render: (r) => r.account_type },
          { key: 'code', label: 'Code', width: '130px', getValue: (r) => r.account_code, render: (r) => <span className={styles.codeChip}>{r.account_code}</span> },
          {
            key: 'name', label: 'Name',
            getValue: (r) => r.account_name,
            // Children indent under their parent so the hierarchy reads as a tree.
            render: (r) => <span style={{ paddingLeft: r.parent_code ? 18 : 0 }}>{r.account_name}</span>,
          },
          { key: 'parent', label: 'Parent', width: '120px', getValue: (r) => r.parent_code ?? '', render: (r) => r.parent_code ?? '—' },
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
                {r.is_active ? 'ACTIVE' : 'INACTIVE'}
              </span>
            ),
          },
        ] satisfies Column<Account>[]}
      />
    </div>
  );
};

/* ── Journal Entries ─────────────────────────────────────────────────── */

/* JE status label — REVERSED wins over POSTED, then DRAFT. */
const jeStatus = (r: JournalEntry): string =>
  r.reversed ? 'REVERSED' : r.posted ? 'POSTED' : 'DRAFT';

const JeTab = () => {
  const [sourceType, setSourceType] = useState<string>('');
  const q = useJournalEntries(sourceType ? { sourceType } : undefined);
  const rows = useMemo(() => q.data?.journalEntries ?? [], [q.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={btnStyle(true)} onClick={() => { setCreating((v) => !v); setSelectedId(null); }}>
          {creating ? 'Close journal form' : 'New manual journal'}
        </button>
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value)}
          className={styles.searchInput}
          style={{ maxWidth: 220 }}>
          <option value="">All sources</option>
          <option value="SI">SI — Sales Invoice</option>
          <option value="SI_REVERSAL">SI Reversal</option>
          <option value="PI">PI — Purchase Invoice</option>
          <option value="PI_REVERSAL">PI Reversal</option>
          <option value="PV">PV — Payment Voucher</option>
          <option value="PV_REVERSAL">PV Reversal</option>
          <option value="MANUAL">Manual</option>
          <option value="MANUAL_REVERSAL">Manual Reversal</option>
        </select>
      </div>

      {creating && <NewJournalForm onDone={() => setCreating(false)} />}
      {selectedId && <JeDetailCard id={selectedId} onClose={() => setSelectedId(null)} />}

      <DataTable<JournalEntry>
        tableId="accounting-je"
        layoutFamily="accounting-je"
        exportName="journal-entries"
        rows={q.isLoading ? null : visible}
        loading={q.isLoading}
        emptyLabel="No entries."
        getRowKey={(r) => r.id}
        onRowClick={(r) => { setSelectedId(r.id); setCreating(false); }}
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

/* RM string → integer sen; null when the input is not money. */
const rmToSen = (raw: string): number | null => {
  const t = raw.trim();
  if (!t) return 0;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
};

type DraftLine = { accountCode: string; debit: string; credit: string; notes: string };
const EMPTY_LINE: DraftLine = { accountCode: '', debit: '', credit: '', notes: '' };

const NewJournalForm = ({ onDone }: { onDone: () => void }) => {
  const accounts = useAccounts();
  const createM = useCreateJournalEntry();
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);

  const all = accounts.data?.accounts ?? [];
  const parents = useMemo(() => new Set(all.map((a) => a.parent_code).filter(Boolean) as string[]), [all]);
  // Postable = active and not a header — the same rule the engine enforces,
  // applied here so the picker cannot offer an account the post will refuse.
  const postable = all.filter((a) => a.is_active && !parents.has(a.account_code));

  const totals = useMemo(() => {
    let dr = 0; let cr = 0; let bad = false;
    for (const l of lines) {
      const d = rmToSen(l.debit); const c = rmToSen(l.credit);
      if (d == null || c == null) { bad = true; continue; }
      dr += d; cr += c;
      if (d > 0 && c > 0) bad = true;
    }
    return { dr, cr, bad };
  }, [lines]);

  const canSave = !totals.bad && totals.dr === totals.cr && totals.dr > 0
    && lines.every((l) => l.accountCode || (!l.debit && !l.credit));

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = () => {
    const body = {
      entryDate,
      narration: narration.trim() || null,
      lines: lines
        .filter((l) => l.accountCode)
        .map((l): JeLineIn => ({
          accountCode: l.accountCode,
          debitSen: rmToSen(l.debit) ?? 0,
          creditSen: rmToSen(l.credit) ?? 0,
          notes: l.notes.trim() || null,
        })),
    };
    createM.mutate(body, { onSuccess: onDone });
  };

  return (
    <div style={cardStyle} className="space-y-3">
      <div style={{ fontWeight: 700 }}>New manual journal (draft — posting is a separate step)</div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <DateField style={fieldStyle} value={entryDate} onChange={(iso) => setEntryDate(iso)}/>
        <input style={{ ...fieldStyle, flex: 1, minWidth: 240 }} placeholder="Narration (what is this entry?)"
          value={narration} onChange={(e) => setNarration(e.target.value)} />
      </div>

      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <select style={{ ...fieldStyle, minWidth: 260 }} value={l.accountCode} onChange={(e) => setLine(i, { accountCode: e.target.value })}>
            <option value="">Select account…</option>
            {[...postable].sort((a, b) => byText(a.account_code, b.account_code)).map((a) => (
              <option key={a.account_code} value={a.account_code}>{a.account_code} — {a.account_name}</option>
            ))}
          </select>
          <input style={{ ...fieldStyle, width: 120 }} placeholder="Debit RM" inputMode="decimal"
            value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} />
          <input style={{ ...fieldStyle, width: 120 }} placeholder="Credit RM" inputMode="decimal"
            value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} />
          <input style={{ ...fieldStyle, flex: 1, minWidth: 160 }} placeholder="Line note"
            value={l.notes} onChange={(e) => setLine(i, { notes: e.target.value })} />
          {lines.length > 2 && (
            <button type="button" style={btnStyle()} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={btnStyle()} onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}>Add line</button>
        <span style={{ fontSize: 'var(--fs-13)' }}>
          Dr {fmt(totals.dr)} · Cr {fmt(totals.cr)} ·{' '}
          {totals.dr === totals.cr && totals.dr > 0 && !totals.bad
            ? <b style={{ color: 'var(--c-secondary-a, #2F5D4F)' }}>balanced</b>
            : <b style={{ color: 'var(--c-festive-b, #B8331F)' }}>{totals.bad ? 'invalid amounts' : 'not balanced'}</b>}
        </span>
        <button type="button" style={btnStyle(true)} disabled={!canSave || createM.isPending} onClick={submit}>
          {createM.isPending ? 'Saving…' : 'Save draft'}
        </button>
      </div>
    </div>
  );
};

const JeDetailCard = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const q = useJournalEntryDetail(id);
  const postM = usePostJournalEntry();
  const reverseM = useReverseJournalEntry();
  const je = q.data?.journalEntry;
  const lines = q.data?.lines ?? [];

  return (
    <div style={cardStyle} className="space-y-3">
      {!je ? (
        <div style={{ fontSize: 'var(--fs-13)' }}>{q.isLoading ? 'Loading…' : 'Entry not found.'}</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={styles.codeChip}>{je.je_no}</span>
            <span>{fmtDateOrDash(je.entry_date)}</span>
            <span>{je.source_type}{je.source_doc_no ? ` · ${je.source_doc_no}` : ''}</span>
            <span className={`${styles.statusPill} ${je.posted ? styles.statusActive : styles.statusInactive}`}>{jeStatus(je)}</span>
            <span style={{ flex: 1 }} />
            {je.source_type === 'MANUAL' && !je.posted && !je.reversed && (
              <button type="button" style={btnStyle(true)} disabled={postM.isPending}
                onClick={() => postM.mutate(id)}>
                {postM.isPending ? 'Posting…' : 'Post'}
              </button>
            )}
            {je.source_type === 'MANUAL' && je.posted && !je.reversed && (
              <button type="button" style={btnStyle()} disabled={reverseM.isPending}
                onClick={() => reverseM.mutate(id)}>
                {reverseM.isPending ? 'Reversing…' : 'Reverse'}
              </button>
            )}
            <button type="button" style={btnStyle()} onClick={onClose}>Close</button>
          </div>
          {je.narration && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-ink-soft, #555)' }}>{je.narration}</div>}
          <table style={{ width: '100%', fontSize: 'var(--fs-13)', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.12))' }}>
                <th style={{ padding: '4px 8px' }}>#</th>
                <th style={{ padding: '4px 8px' }}>Account</th>
                <th style={{ padding: '4px 8px', textAlign: 'right' }}>Debit</th>
                <th style={{ padding: '4px 8px', textAlign: 'right' }}>Credit</th>
                <th style={{ padding: '4px 8px' }}>Party</th>
                <th style={{ padding: '4px 8px' }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} style={{ borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' }}>
                  <td style={{ padding: '4px 8px' }}>{l.line_no}</td>
                  <td style={{ padding: '4px 8px' }}>{l.account_code}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{l.debit_sen > 0 ? fmt(l.debit_sen) : '—'}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{l.credit_sen > 0 ? fmt(l.credit_sen) : '—'}</td>
                  <td style={{ padding: '4px 8px' }}>{l.party_name ?? l.party_code ?? '—'}</td>
                  <td style={{ padding: '4px 8px' }}>{l.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
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
    </div>
  );
};

/* ── Self-check (control accounts vs documents) ──────────────────────── */

const SelfCheckTab = () => {
  const q = useControlCheck();
  const checks = q.data?.checks ?? [];

  return (
    <div className="space-y-3">
      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Running checks…</div>}
      {checks.map((check) => <ControlCheckCard key={check.role} check={check} />)}
      {q.data?.payments && <UnbookedPaymentsCard p={q.data.payments} />}
    </div>
  );
};

/* ── Money on a document that never reached the ledger ──────────────────────
   A booking failure does not fail the operator's save — sales must be able to
   record money whatever accounting is doing — so until this card existed the
   only trace was a server log. Owner, asked whether this page should say so: 要.

   The BOUNDARY is shown, not hidden. About 2,700 historical payments are
   deliberately unbooked, so the server reports from the first day this company
   ever booked one; a card that silently spoke about a period nobody could see
   would be its own kind of lie. */

const UnbookedPaymentsCard = ({ p }: { p: UnbookedPayments }) => {
  const good = 'var(--c-secondary-a, #2F5D4F)';
  const bad = 'var(--c-festive-b, #B8331F)';
  const clean = p.ok && p.rows.length === 0;

  return (
    <div style={{ ...cardStyle, borderColor: clean ? good : bad }} className="space-y-2">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <b>Payments that reached the ledger</b>
        <span style={{
          padding: '2px 10px', borderRadius: 999, fontWeight: 700, fontSize: 'var(--fs-12)',
          background: clean ? 'rgba(47, 93, 79, 0.12)' : 'rgba(184, 51, 31, 0.12)',
          color: clean ? good : bad,
        }}>
          {clean ? 'all of them' : `${p.rows.length} did not`}
        </span>
        {!clean && <span>{fmt(p.totalSen)} on documents and not in the books</span>}
      </div>

      {p.error && <div style={{ fontSize: 'var(--fs-13)', color: bad }}>The check could not run: {p.error}</div>}

      {/* The period this card is speaking about, always — including when it is
          speaking about nothing. */}
      <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #777)' }}>
        {p.since == null
          ? 'No payment has been booked in this company yet, so there is no period to check. '
            + 'Payments recorded before the accounting module starts here are expected to be unbooked.'
          : `Counting payments from ${p.since}, the first day this company booked one. `
            + 'Anything earlier is history that was deliberately left unbooked.'}
      </div>

      {p.rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.18))' }}>
              <th>Document</th><th>Paid on</th><th>How</th><th style={{ textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={`${r.source}:${r.id}`} style={{ borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.10))' }}>
                <td>{r.docNo}</td>
                <td>{r.paidOn}</td>
                <td>{r.method}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.amountSen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

const ControlCheckCard = ({ check }: { check: ControlCheckRow }) => {
  if ('error' in check) {
    return (
      <div style={{ ...cardStyle, borderColor: 'var(--c-festive-b, #B8331F)' }}>
        <b>{check.role} · {check.accountCode}</b> — check could not run: {check.error}
      </div>
    );
  }
  const ok = check.ok;
  return (
    <div style={{ ...cardStyle, borderColor: ok ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--c-festive-b, #B8331F)' }} className="space-y-2">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{check.role === 'AR' ? 'Accounts Receivable control'
          : check.role === 'AR_OTHER' ? 'Other Debtors control'
          : check.role === 'AP_OTHER' ? 'Other Creditors control'
          : 'Accounts Payable control'}</b>
        <span className={styles.codeChip}>{check.accountCode}</span>
        <span>GL balance {fmt(check.glBalanceSen)}</span>
        <span style={{
          padding: '2px 10px', borderRadius: 999, fontWeight: 700, fontSize: 'var(--fs-12)',
          background: ok ? 'rgba(47, 93, 79, 0.12)' : 'rgba(184, 51, 31, 0.12)',
          color: ok ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--c-festive-b, #B8331F)',
        }}>
          {ok ? 'CLEAN' : `${check.driftDocs.length + check.foreignLines.length} FINDING${check.driftDocs.length + check.foreignLines.length === 1 ? '' : 'S'}`}
        </span>
      </div>

      {check.driftDocs.length > 0 && (
        <table style={{ width: '100%', fontSize: 'var(--fs-13)', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.12))' }}>
              <th style={{ padding: '4px 8px' }}>Document</th>
              <th style={{ padding: '4px 8px', textAlign: 'right' }}>Document total</th>
              <th style={{ padding: '4px 8px', textAlign: 'right' }}>Journal total</th>
              <th style={{ padding: '4px 8px', textAlign: 'right' }}>Difference</th>
              <th style={{ padding: '4px 8px' }}>What is wrong</th>
            </tr>
          </thead>
          <tbody>
            {check.driftDocs.map((d) => (
              <tr key={d.docNo} style={{ borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' }}>
                <td style={{ padding: '4px 8px' }}><span className={styles.codeChip}>{d.docNo}</span></td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>{fmt(d.docTotalSen)}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>{fmt(d.jeTotalSen)}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 700 }}>{fmt(d.diffSen)}</td>
                <td style={{ padding: '4px 8px' }}>{d.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {check.foreignLines.length > 0 && (
        <div style={{ fontSize: 'var(--fs-13)' }}>
          Lines on this control account from sources that do not belong here:{' '}
          {check.foreignLines.map((f) => `${f.jeNo} (${f.sourceType})`).join(', ')}
        </div>
      )}
    </div>
  );
};

/* ── AR Aging ────────────────────────────────────────────────────────── */
const ArAgingTab = () => {
  const q = useArAging();
  const rows = useMemo(() => q.data?.arAging ?? [], [q.data]);
  const totals = useMemo(() => bucketTotals<ArAgingRow>(rows), [rows]);

  return (
    <>
      <BucketSummary totals={totals} grandTotal={rows.reduce((s, r) => s + r.outstanding_sen, 0)} />
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
            getValue: (r) => r.outstanding_sen / 100,
            render: (r) => <span style={{ fontWeight: 700 }}>{fmt(r.outstanding_sen)}</span>,
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
      <BucketSummary totals={totals} grandTotal={rows.reduce((s, r) => s + r.outstanding_sen, 0)} />
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
            getValue: (r) => r.outstanding_sen / 100,
            render: (r) => <span style={{ fontWeight: 700 }}>{fmt(r.outstanding_sen)}</span>,
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

const bucketTotals = <T extends { aging_bucket: Bucket; outstanding_sen: number }>(rows: T[]) => {
  const out: Record<Bucket, number> = { 'CURRENT': 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of rows) out[r.aging_bucket] += r.outstanding_sen;
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
