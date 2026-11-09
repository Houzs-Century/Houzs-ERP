// ----------------------------------------------------------------------------
// JournalEntries — the Journal page grouped per entry, the AutoCount way
// (owner 2026-09-14, from his screenshots: the journal list, 660 rows, should
// group the lines under their entry — date / entry / references / description
// once, then the account lines; docs/bugs/0935). Every entry of the period is
// a group: its head row carries the date, the number, the journal, Ref. 1
// and Ref. 2 (the GL page's own references, acc/journal-refs), the narration,
// the totals and the status; beneath it one row per line — the account (code
// over name), the party, the note, debit or credit. Reversed entries and their
// contras are listed and marked — the journal keeps the record
// (docs/bugs/0923); the GL page leaves them out.
//
// In the owner's redesign (batch 6 §2): one toolbar row — the date range, the
// Journal, the Source, the search — over a grid whose columns are dragged
// wider and remembered; the entry's number opens its card in a right drawer
// (Post · Edit · Copy · Reverse on a manual journal; a document's entry opens
// its document), and "New manual journal" opens the form there. Excel, PDF
// and Print are the report sheet; the one-row-per-line CSV sits under ⋯.
//
// The filters live in the URL (/scm/accounting?tab=je&from=…&to=…&source=…
// &journal=…) so a period can be handed on as a link; the search box filters
// what is loaded.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, FileDown, FileSpreadsheet, MoreHorizontal, Plus, Printer, Search } from 'lucide-react';
import { DateRangeButton } from '../../components/DateRangeButton';
import { REPORT_RANGE_PRESETS, isIsoDay } from '../../lib/dateRangePresets';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import { useJournalEntriesGrouped, type JournalEntryGrouped, type JournalGroupedFilters } from './accounting-phase1-queries';
import { fmtLedger, fmtSide, journalLabel, type LedgerJournal } from '../../vendor/scm/lib/ledger-queries';
import { exportFileName } from '../../vendor/scm/lib/report-sheet';
import { triggerDownload } from '../../vendor/scm/lib/fabric-csv';
import { guardFormula } from '../../lib/csv';
import { fmtDate } from '../../vendor/shared/format';
import { SearchScopeHint } from '../../components/SearchScopeHint';
import { AccountCell, jeStatus, jeStatusTag, toneClass } from './JournalEntryCards';
import { useColumnWidths, type ColumnWidthSpec } from './finance/useColumnWidths';
import { AccountingHeader } from './books/AccountingHeader';
import { JournalDrawer, newJournalForm, type JournalDrawerState } from './books/JournalDrawer';
import { JOURNAL_REVERSALS, JOURNAL_SOURCES, sourceLabel } from './books/journal-sources';
import { journalSheet } from './books/journal-sheet';
import { useBooksToast } from './books/BooksToast';
import tokens from './finance/finance-ui.module.css';
import s from './books/Books.module.css';

/* The five journals, AutoCount's own vocabulary — the segments and the label. */
export const JOURNALS: readonly LedgerJournal[] = ['SALES', 'PURCHASE', 'BANK', 'CASH', 'GENERAL'];
const isJournal = (j: string): j is LedgerJournal => (JOURNALS as readonly string[]).includes(j);
/** The journal's word for a class the server stamped; the class itself when it is not one of the five. */
export const journalWord = (j: string): string => (isJournal(j) ? journalLabel(j) : j);

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthStart = (): string => `${myt().slice(0, 7)}-01`;

export type JournalPageParams = JournalGroupedFilters & { journal: string };

/** The page's filters as the URL carries them — one reader for the page and for a test. */
export const journalParamsFromSearch = (params: URLSearchParams): JournalPageParams => {
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const journal = (params.get('journal') ?? '').toUpperCase();
  return {
    from: isIsoDay(from) ? from : monthStart(),
    to: isIsoDay(to) ? to : myt(),
    sourceType: params.get('source') ?? '',
    journal: isJournal(journal) ? journal : '',
  };
};

/** A contra — the entry that undid another — is named by its source type. */
export const isContra = (r: Pick<JournalEntryGrouped, 'source_type'>): boolean => /_REVERSAL$/.test(r.source_type);

/** What the search box reads of an entry: its head, its references, its accounts and parties. */
const haystack = (r: JournalEntryGrouped, nameOf: (code: string) => string): string =>
  [r.je_no, r.entry_date, fmtDate(r.entry_date), r.source_type, sourceLabel(r.source_type), r.doc ?? '', r.doc2 ?? '', r.narration ?? '', r.who ?? '', journalWord(r.journal_class), jeStatus(r),
    ...r.lines.flatMap((l) => [l.account_code, nameOf(l.account_code), l.party_name ?? '', l.notes ?? ''])]
    .join(' ').toLowerCase();

export const filterEntries = (rows: JournalEntryGrouped[], journal: string, search: string, nameOf: (code: string) => string): JournalEntryGrouped[] => {
  const inJournal = journal ? rows.filter((r) => r.journal_class === journal) : rows;
  const term = search.trim().toLowerCase();
  return term ? inJournal.filter((r) => haystack(r, nameOf).includes(term)) : inJournal;
};

/** The page's columns — ONE home for the grid, the CSV and the widths. */
export const JOURNAL_COLUMNS = ['Date', 'Entry', 'Journal', 'Ref. 1', 'Ref. 2', 'Description', 'Debit', 'Credit', 'Status'] as const;
const RIGHT = [false, false, false, false, false, false, true, true, false];
/* The design's tracks (Finance-1a-Reports, CW.je); dates, numbers and amounts never narrower than they read. */
const WIDTHS: ColumnWidthSpec = {
  defaults: ['78px', '108px', '60px', '108px', '96px', 'minmax(200px,1fr)', '96px', '96px', '116px'],
  min: [60, 72, 40, 48, 48, 80, 56, 56, 64],
  fit: [true, true, true, false, false, false, true, true, true],
  gap: 12,
};
/** Entries drawn at a time; "Show more" adds the next lot of what loaded. */
const PAGE = 100;
/** The server's own cap on one period's read (accounting.ts journalEntriesList). */
const LOADED_LIMIT = 500;

const csvCell = (raw: string): string => {
  const v = guardFormula(raw);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

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

const Group = ({ r, nameOf, template, onOpen }: { r: JournalEntryGrouped; nameOf: (code: string) => string; template: string; onOpen: () => void }) => {
  const tag = jeStatusTag(r);
  const desc = r.narration ?? r.who ?? '—';
  return (
    <div data-je={r.je_no} data-reversal={r.reversed ? 'reversed' : isContra(r) ? 'contra' : undefined}
      className={`${s.entry} ${r.reversed || isContra(r) ? s.dim : ''}`}>
      <div data-cw-row="" className={`${s.row} ${s.gap12} ${s.entryHead}`} style={{ gridTemplateColumns: template }} onDoubleClick={onOpen}>
        <span className={s.muted}>{fmtDate(r.entry_date)}</span>
        <span className={s.cell}><button type="button" className={s.entryNo} onClick={onOpen} title="Open the entry">{r.je_no}</button></span>
        <span className={s.muted}>{journalWord(r.journal_class)}</span>
        <span className={s.cell} title={r.doc ?? undefined}>{r.doc ?? '—'}</span>
        <span className={`${s.cell} ${s.muted}`} title={r.doc2 ?? undefined}>{r.doc2 ?? '—'}</span>
        <span className={`${s.cell} ${s.desc}`} title={desc}>
          {desc}
          {r.who && r.narration && r.who !== r.narration && <span className={s.soft}> · {r.who}</span>}
        </span>
        <span className={`${s.num} ${s.strong}`}>{fmtLedger(r.total_debit_sen)}</span>
        <span className={`${s.num} ${s.strong}`}>{fmtLedger(r.total_credit_sen)}</span>
        <span className={s.tags}>
          <span className={`${s.tag} ${toneClass(tag.tone)}`}>{tag.label}</span>
          {isContra(r) && <span className={`${s.tag} ${s.toneCalm}`}>contra</span>}
        </span>
      </div>
      {r.lines.map((l) => (
        <div key={l.line_no} data-cw-row="" data-line={l.line_no} className={`${s.row} ${s.gap12} ${s.entryLine}`} style={{ gridTemplateColumns: template }}>
          <span />
          <span className={s.cell} style={{ gridColumn: 'span 2' }}><AccountCell code={l.account_code} name={nameOf(l.account_code)} /></span>
          <span className={`${s.cell} ${s.muted}`} style={{ gridColumn: 'span 2' }}>{l.party_name ?? ''}</span>
          <span className={`${s.cell} ${s.muted}`} title={l.notes ?? undefined}>{l.notes ?? ''}</span>
          <span className={s.num}>{fmtSide(l.debit_sen)}</span>
          <span className={s.num}>{fmtSide(l.credit_sen)}</span>
          <span />
        </div>
      ))}
    </div>
  );
};

/** The header's ⋯: what the design does not show and the ERP keeps. */
function MoreMenu({ items }: { items: Array<{ label: string; onClick: () => void; disabled?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={ref} className={s.menuWrap}>
      <button type="button" className={s.more} aria-label="More" title="More" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className={s.menu} role="menu">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={s.menuItem} disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

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

  const rangeOk = isIsoDay(p.from) && isIsoDay(p.to) && p.from <= p.to;
  const q = useJournalEntriesGrouped({ from: p.from, to: p.to, sourceType: p.sourceType }, rangeOk);
  const rows = useMemo(() => q.data?.journalEntries ?? [], [q.data]);
  const [search, setSearch] = useState('');
  const visible = useMemo(() => filterEntries(rows, p.journal, search, nameOf), [rows, p.journal, search, nameOf]);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setShown(PAGE); }, [p.from, p.to, p.sourceType, p.journal, search]);
  const page = visible.slice(0, shown);

  const cw = useColumnWidths('je', WIDTHS);
  const [drawer, setDrawer] = useState<JournalDrawerState | null>(null);
  const toast = useBooksToast();

  const narrowedBy = [
    ...(p.journal ? [`${journalWord(p.journal)} journal`] : []),
    ...(p.sourceType ? [`Source: ${sourceLabel(p.sourceType)}`] : []),
    ...(search.trim() ? [`“${search.trim()}”`] : []),
  ];
  const sheet = () => journalSheet({ rows: visible, from: p.from, to: p.to, narrowedBy, nameOf, journalWord, statusWord: (r) => (isContra(r) ? `${jeStatusTag(r).label} · contra` : jeStatusTag(r).label) });
  const excel = async () => {
    const { downloadReportXlsx } = await import('../../vendor/scm/lib/report-sheet-xlsx');
    await downloadReportXlsx(sheet(), exportFileName('journal-entries', p.from, p.to, 'xlsx'));
  };
  const pdf = async (action: 'preview' | 'print') => {
    const { generateReportPdf } = await import('../../vendor/scm/lib/report-sheet-pdf');
    await generateReportPdf(sheet(), { fileName: exportFileName('journal-entries', p.from, p.to, 'pdf'), action });
  };
  const nothing = visible.length === 0;

  const actions = (
    <div className={s.headActions}>
      <button type="button" className={s.btnPrimary} onClick={() => setDrawer(newJournalForm())}><Plus size={14} aria-hidden />New manual journal</button>
      <button type="button" className={s.btn} disabled={nothing} onClick={() => { void excel(); }}><FileSpreadsheet size={14} aria-hidden />Excel</button>
      <button type="button" className={s.btn} disabled={nothing} onClick={() => { void pdf('preview'); }}><FileDown size={14} aria-hidden />PDF</button>
      <button type="button" className={s.btn} disabled={nothing} onClick={() => { void pdf('print'); }}><Printer size={14} aria-hidden />Print</button>
      <MoreMenu items={[{
        label: 'CSV · one row per line', disabled: nothing,
        onClick: () => triggerDownload(`journal-${p.from}-to-${p.to}.csv`, '﻿' + journalCsv(visible, nameOf)),
      }]} />
    </div>
  );

  const description = rangeOk
    ? `${p.from === p.to ? fmtDate(p.from) : `${fmtDate(p.from)} – ${fmtDate(p.to)}`}${q.data ? ` · ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}` : ''}`
    : 'Check the dates';

  return (
    <div className={`${tokens.root} ${s.page}`}>
      <AccountingHeader tab="je" description={description} actions={actions} />

      <div className={s.tools}>
        <DateRangeButton from={p.from} to={p.to} presets={REPORT_RANGE_PRESETS} today={myt()} label="Entry dates"
          onChange={(from, to) => update({ from, to })} />
        <span className={s.tool}>
          <span className={s.toolLabel}>Journal</span>
          <span className={s.seg} role="group" aria-label="Journal">
            {(['', ...JOURNALS] as const).map((jc) => (
              <button key={jc || 'all'} type="button" className={`${s.segBtn} ${p.journal === jc ? s.segOn : ''}`} aria-pressed={p.journal === jc}
                onClick={() => update({ journal: jc })}>
                {jc ? journalLabel(jc) : 'All'}
              </button>
            ))}
          </span>
        </span>
        <span className={s.tool}>
          <span className={s.toolLabel}>Source</span>
          <span className={s.selectWrap}>
            <select value={p.sourceType ?? ''} onChange={(e) => update({ sourceType: e.target.value })} className={s.select} aria-label="Source">
              <option value="">All sources</option>
              {JOURNAL_SOURCES.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              <optgroup label="Reversals">
                {JOURNAL_REVERSALS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              </optgroup>
            </select>
            <ChevronDown size={12} className={s.selectChevron} aria-hidden />
          </span>
        </span>
        <label className={s.search}>
          <Search size={13} aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find an entry, document, account or party" aria-label="Find an entry" />
        </label>
      </div>
      <div className={s.toolNote}>
        <span>
          {q.data ? `${visible.length} of ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} in the period` : ''}
          {rows.length >= LOADED_LIMIT ? ' — the first 500 loaded; narrow the period for the rest' : ''}
        </span>
        {search.trim() && <SearchScopeHint scope="loaded" loadedLimit={500} resultCount={visible.length} term={search} />}
      </div>

      {!rangeOk && <div className={s.problem}>From is later than To — adjust the dates.</div>}
      {rangeOk && q.isError && <div className={s.problem}>The journal did not load — adjust the filters to retry.</div>}

      {rangeOk && !q.isError && (
        <div className={s.card}>
          <div className={s.scroll}>
            <div data-cw-root="je" style={{ minWidth: cw.minWidth }}>
              <div data-cw-row="" className={`${s.row} ${s.gap12} ${s.gridHead}`} style={{ gridTemplateColumns: cw.template }}>
                {JOURNAL_COLUMNS.map((label, i) => (
                  <span key={label} data-cw-cell={i} className={`${s.headCell} ${RIGHT[i] ? s.right : ''}`}>
                    <span data-cw-lbl="">{label}</span>
                    <span className={s.resize} {...cw.handle(i)}><span className={s.resizeLine} /></span>
                  </span>
                ))}
              </div>
              {q.isLoading && (
                <div className={s.skeleton} aria-label="Loading the journal">
                  {[0, 1, 2, 3, 4].map((i) => <div key={i} className={s.skeletonBar} style={{ width: `${92 - i * 9}%` }} />)}
                </div>
              )}
              {page.map((r) => (
                <Group key={r.id} r={r} nameOf={nameOf} template={cw.template}
                  onOpen={() => setDrawer({ mode: 'card', id: r.id, refs: { journal: journalWord(r.journal_class), doc: r.doc, doc2: r.doc2, who: r.who } })} />
              ))}
              {q.data && rows.length === 0 && <div className={s.empty}>No entries in the period.</div>}
              {q.data && rows.length > 0 && visible.length === 0 && <div className={s.empty}>No entry matches.</div>}
              {visible.length > shown && (
                <div className={s.moreRow}>
                  <button type="button" className={s.moreLink} onClick={() => setShown((n) => n + PAGE)}>
                    Show {Math.min(PAGE, visible.length - shown)} more {Math.min(PAGE, visible.length - shown) === 1 ? 'entry' : 'entries'}
                  </button>
                  <span className={s.soft}> · {shown} of {visible.length} shown</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {cw.custom && (
        <div className={s.resetRow}><button type="button" className={s.resetLink} onClick={cw.reset}>Reset column widths</button></div>
      )}

      <JournalDrawer state={drawer} onChange={setDrawer} onClose={() => setDrawer(null)} onToast={toast.say}
        backLabel="Journal entries" range={rangeOk ? { from: p.from, to: p.to } : null} />
      {toast.node}
    </div>
  );
};
