// ----------------------------------------------------------------------------
// JournalEntries — the Journal page grouped per entry, the AutoCount way
// (owner 2026-09-14, from his screenshots: the journal list, 660 rows, should
// group the lines under their entry — date / entry / references / description
// once, then the account lines; docs/bugs/0935). Every entry of the period is
// a group: its header row carries the date, the number, the journal, Ref. 1
// and Ref. 2 (the GL page's own references, acc/journal-refs), the narration,
// the totals and the status; beneath it one row per line — the account (code
// over name), the party, the note, debit or credit. Tapping the header opens
// the entry's card (Post / Reverse / Copy / Edit); "New manual journal" opens
// the draft form. Reversed entries and their contras are listed and marked —
// the journal keeps the record (docs/bugs/0923); the GL page leaves them out.
//
// The filters live in the URL (/scm/accounting?tab=je&from=…&to=…&source=…
// &journal=…) so a period can be handed on as a link; the search box filters
// what is loaded.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@2990s/design-system';
import { Download } from 'lucide-react';
import { DateField } from '../../vendor/scm/components/DateField';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import { useJournalEntriesGrouped, type JournalEntryGrouped, type JournalGroupedFilters } from './accounting-phase1-queries';
import { fmtLedger, fmtSide, journalLabel, type LedgerJournal } from '../../vendor/scm/lib/ledger-queries';
import { triggerDownload } from '../../vendor/scm/lib/fabric-csv';
import { fmtDate } from '../../vendor/shared/format';
import { SearchScopeHint } from '../../components/SearchScopeHint';
import { NewJournalForm, JeDetailCard, AccountCell, jeStatus, btnStyle, type DraftSeed, type EditSeed } from './JournalEntryCards';
import styles from './Suppliers.module.css';

/* The five journals, AutoCount's own vocabulary — the chips and the label. */
export const JOURNALS: readonly LedgerJournal[] = ['SALES', 'PURCHASE', 'BANK', 'CASH', 'GENERAL'];
const isJournal = (j: string): j is LedgerJournal => (JOURNALS as readonly string[]).includes(j);
/** The journal's word for a class the server stamped; the class itself when it is not one of the five. */
export const journalWord = (j: string): string => (isJournal(j) ? journalLabel(j) : j);

const SOURCES: ReadonlyArray<[string, string]> = [
  ['SI', 'SI — Sales Invoice'], ['SI_REVERSAL', 'SI Reversal'], ['PI', 'PI — Purchase Invoice'], ['PI_REVERSAL', 'PI Reversal'],
  ['PV', 'PV — Payment Voucher'], ['PV_REVERSAL', 'PV Reversal'], ['MANUAL', 'Manual'], ['MANUAL_REVERSAL', 'Manual Reversal'],
];

const card: React.CSSProperties = {
  padding: 0,
  background: 'var(--c-cream)',
  border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
  borderRadius: 'var(--radius-md)',
  overflowX: 'auto',
};
const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };
const th: React.CSSProperties = { padding: '6px 8px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left' };
const td: React.CSSProperties = { padding: '4px 8px', verticalAlign: 'top', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' };
const num: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const head: React.CSSProperties = { ...td, background: 'var(--c-cream-2, rgba(34,31,32,0.03))', fontWeight: 600, cursor: 'pointer' };

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthStart = (): string => `${myt().slice(0, 7)}-01`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type JournalPageParams = JournalGroupedFilters & { journal: string };

/** The page's filters as the URL carries them — one reader for the page and for a test. */
export const journalParamsFromSearch = (params: URLSearchParams): JournalPageParams => {
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const journal = (params.get('journal') ?? '').toUpperCase();
  return {
    from: DATE.test(from) ? from : monthStart(),
    to: DATE.test(to) ? to : myt(),
    sourceType: params.get('source') ?? '',
    journal: isJournal(journal) ? journal : '',
  };
};

/** A contra — the entry that undid another — is named by its source type. */
export const isContra = (r: Pick<JournalEntryGrouped, 'source_type'>): boolean => /_REVERSAL$/.test(r.source_type);

/** What the search box reads of an entry: its head, its references, its accounts. */
const haystack = (r: JournalEntryGrouped, nameOf: (code: string) => string): string =>
  [r.je_no, r.entry_date, r.source_type, r.doc ?? '', r.doc2 ?? '', r.narration ?? '', r.who ?? '', journalWord(r.journal_class), jeStatus(r),
    ...r.lines.flatMap((l) => [l.account_code, nameOf(l.account_code), l.party_name ?? '', l.notes ?? ''])]
    .join(' ').toLowerCase();

export const filterEntries = (rows: JournalEntryGrouped[], journal: string, search: string, nameOf: (code: string) => string): JournalEntryGrouped[] => {
  const inJournal = journal ? rows.filter((r) => r.journal_class === journal) : rows;
  const term = search.trim().toLowerCase();
  return term ? inJournal.filter((r) => haystack(r, nameOf).includes(term)) : inJournal;
};

/** The page's columns — ONE home for the screen and the CSV. */
export const JOURNAL_COLUMNS = ['Date', 'Entry', 'Journal', 'Ref. 1', 'Ref. 2', 'Description', 'Debit', 'Credit', 'Status'] as const;

const csvCell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The journal as a flat CSV: one row per line, the entry's head repeated in
    front of it, the line's account, party and note behind. */
export function journalCsv(rows: JournalEntryGrouped[], nameOf: (code: string) => string): string {
  const out: string[][] = [[...JOURNAL_COLUMNS, 'Account', 'Account name', 'Party', 'Note', 'Line debit', 'Line credit']];
  for (const r of rows) {
    const headCells = [fmtDate(r.entry_date), r.je_no, journalWord(r.journal_class), r.doc ?? '', r.doc2 ?? '', r.narration ?? '', fmtLedger(r.total_debit_sen), fmtLedger(r.total_credit_sen), isContra(r) ? `${jeStatus(r)} contra` : jeStatus(r)];
    if (r.lines.length === 0) { out.push([...headCells, '', '', '', '', '', '']); continue; }
    for (const l of r.lines) out.push([...headCells, l.account_code, nameOf(l.account_code), l.party_name ?? '', l.notes ?? '', fmtSide(l.debit_sen), fmtSide(l.credit_sen)]);
  }
  return out.map((row) => row.map(csvCell).join(',')).join('\n');
}

const Group = ({ r, nameOf, onOpen }: { r: JournalEntryGrouped; nameOf: (code: string) => string; onOpen: () => void }) => (
  <tbody data-je={r.je_no} data-reversal={r.reversed ? 'reversed' : isContra(r) ? 'contra' : undefined}
    style={r.reversed || isContra(r) ? { color: 'var(--text-soft, #8a8578)' } : undefined}>
    <tr onClick={onOpen} role="button" aria-label={`Open ${r.je_no}`}>
      <td style={{ ...head, whiteSpace: 'nowrap' }}>{fmtDate(r.entry_date)}</td>
      <td style={head}><span className={styles.codeChip}>{r.je_no}</span></td>
      <td style={head}>{journalWord(r.journal_class)}</td>
      <td style={head}>{r.doc ?? '—'}</td>
      <td style={head}>{r.doc2 ?? '—'}</td>
      <td style={{ ...head, fontWeight: 500 }}>
        {r.narration ?? r.who ?? '—'}
        {r.who && r.narration && r.who !== r.narration && <span style={soft}> · {r.who}</span>}
      </td>
      <td style={{ ...head, ...num }}>{fmtLedger(r.total_debit_sen)}</td>
      <td style={{ ...head, ...num }}>{fmtLedger(r.total_credit_sen)}</td>
      <td style={head}>
        <span className={`${styles.statusPill} ${r.posted ? styles.statusActive : styles.statusInactive}`}>{jeStatus(r)}</span>
        {isContra(r) && <span className={styles.codeChip} style={{ marginLeft: 6 }}>contra</span>}
      </td>
    </tr>
    {r.lines.map((l) => (
      <tr key={l.line_no} data-line={l.line_no}>
        <td style={td} />
        <td style={td} colSpan={2}><AccountCell code={l.account_code} name={nameOf(l.account_code)} /></td>
        <td style={td} colSpan={2}>{l.party_name ?? ''}</td>
        <td style={td}>{l.notes ?? ''}</td>
        <td style={num}>{fmtSide(l.debit_sen)}</td>
        <td style={num}>{fmtSide(l.credit_sen)}</td>
        <td style={td} />
      </tr>
    ))}
  </tbody>
);

export const JournalTab = () => {
  const [params, setParams] = useSearchParams();
  const p = useMemo(() => journalParamsFromSearch(params), [params]);
  const accounts = useAccounts();
  const nameOf = useMemo(() => {
    const m = new Map((accounts.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string) => m.get(code) ?? '';
  }, [accounts.data]);

  /* Every filter change is written to the URL — the page has no state of its own but the search box. */
  const update = (patch: Partial<JournalPageParams>) => {
    const next = { ...p, ...patch };
    const q = new URLSearchParams(params);
    q.set('tab', 'je');
    q.set('from', next.from);
    q.set('to', next.to);
    if (next.sourceType) q.set('source', next.sourceType); else q.delete('source');
    if (next.journal) q.set('journal', next.journal); else q.delete('journal');
    setParams(q, { replace: true });
  };

  const rangeOk = p.from <= p.to;
  const q = useJournalEntriesGrouped({ from: p.from, to: p.to, sourceType: p.sourceType }, rangeOk);
  const rows = useMemo(() => q.data?.journalEntries ?? [], [q.data]);
  const [search, setSearch] = useState('');
  const visible = useMemo(() => filterEntries(rows, p.journal, search, nameOf), [rows, p.journal, search, nameOf]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /* A copy of an opened manual journal: the seed the draft form opens with,
     and a fresh key so a second Copy starts a fresh form (docs/bugs/0920).
     An EDIT carries the entry as well — the form then saves to it (docs/bugs/0932). */
  const [seed, setSeed] = useState<{ key: number; draft: DraftSeed; editing?: EditSeed } | null>(null);

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={btnStyle(true)} onClick={() => { setCreating((v) => !v); setSelectedId(null); setSeed(null); }}>
          {creating ? 'Close journal form' : 'New manual journal'}
        </button>
        <span style={soft}>From</span><DateField value={p.from} onChange={(v) => update({ from: v })} aria-label="Journal from" />
        <span style={soft}>To</span><DateField value={p.to} onChange={(v) => update({ to: v })} aria-label="Journal to" />
        <select value={p.sourceType ?? ''} onChange={(e) => update({ sourceType: e.target.value })} className={styles.searchInput} style={{ maxWidth: 220 }} aria-label="Source">
          <option value="">All sources</option>
          {SOURCES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} className={styles.searchInput} style={{ maxWidth: 260 }}
            placeholder="Filter loaded entries…" aria-label="Filter loaded entries" />
          <SearchScopeHint scope="loaded" loadedLimit={500} resultCount={visible.length} term={search} />
        </span>
        <Button variant="ghost" size="sm" disabled={visible.length === 0}
          onClick={() => triggerDownload(`journal-${p.from}-to-${p.to}.csv`, '﻿' + journalCsv(visible, nameOf))}>
          <Download size={16} strokeWidth={1.75} /> Export
        </Button>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={btnStyle(p.journal === '')} onClick={() => update({ journal: '' })}>All journals</button>
        {JOURNALS.map((jc) => (
          <button key={jc} type="button" style={btnStyle(p.journal === jc)} onClick={() => update({ journal: p.journal === jc ? '' : jc })}>
            {journalLabel(jc)}
          </button>
        ))}
        <span style={soft}>
          {q.data ? `${visible.length} of ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} in the period` : ''}
          {rows.length >= 500 ? ' — the first 500 loaded; narrow the period for the rest' : ''}
        </span>
      </div>

      {creating && <NewJournalForm key={seed?.key ?? 0} initial={seed?.draft ?? null} editing={seed?.editing ?? null} onDone={() => { setCreating(false); setSeed(null); }} />}
      {selectedId && (
        <JeDetailCard id={selectedId} onClose={() => setSelectedId(null)}
          onCopy={(draft) => { setSeed({ key: Date.now(), draft }); setCreating(true); setSelectedId(null); }}
          onEdit={(editing) => { setSeed({ key: Date.now(), draft: editing, editing }); setCreating(true); setSelectedId(null); }} />
      )}

      {!rangeOk && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>From is later than To — adjust the dates.</div>}
      {rangeOk && q.isLoading && <div style={soft}>Loading the journal…</div>}
      {rangeOk && q.isError && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The journal did not load — adjust the filters to retry.</div>}
      {q.data && rows.length === 0 && <div style={soft}>No entries in the period.</div>}
      {q.data && rows.length > 0 && visible.length === 0 && <div style={soft}>No entry matches.</div>}
      {visible.length > 0 && (
        <div style={card}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr>
                {JOURNAL_COLUMNS.map((c) => (
                  <th key={c} style={c === 'Debit' || c === 'Credit' ? { ...th, textAlign: 'right' } : th}>{c}</th>
                ))}
              </tr>
            </thead>
            {visible.map((r) => <Group key={r.id} r={r} nameOf={nameOf} onOpen={() => { setSelectedId(r.id); setCreating(false); }} />)}
          </table>
        </div>
      )}
    </div>
  );
};
