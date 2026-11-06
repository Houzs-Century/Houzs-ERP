/* The Journal page grouped per entry (owner 2026-09-14: group the lines under
   their JE — date / entry / references / description once, then the account
   lines; docs/bugs/0935), in the owner's redesign (batch 6 §2). Pinned:
     · every entry is a group: its head row once (date, number, journal, Ref. 1,
       Ref. 2, narration, totals, status), then one row per line with the
       account as code over name, the party, the note, debit or credit;
     · reversed entries and their contras stay listed and are marked;
     · the filters live in the URL — the Journal segments, the Source (every
       type the engine writes, reversals apart) — and the search box reads the
       lines too;
     · the entry's number opens its card in the drawer; New manual journal
       opens the form there; the CSV is one row per line under ⋯;
     · the header reads "Finance · Books", or "Finance · Reports" from the list. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { JournalEntryGrouped } from './accounting-phase1-queries';

const { useAccounts, useJournalEntriesGrouped, useJournalEntryCard } = vi.hoisted(() => ({ useAccounts: vi.fn(), useJournalEntriesGrouped: vi.fn(), useJournalEntryCard: vi.fn() }));

vi.mock('../../vendor/scm/lib/accounting-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), useAccounts,
}));
vi.mock('./accounting-phase1-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), useJournalEntriesGrouped, useJournalEntryCard,
}));

import { JournalTab, journalParamsFromSearch, journalCsv, filterEntries, isContra } from './JournalEntries';
import { JOURNAL_REVERSALS, JOURNAL_SOURCES, sourceLabel } from './books/journal-sources';
import { journalSheet } from './books/journal-sheet';

const wrap = (ui: ReactNode, at: string) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter>
  </QueryClientProvider>
);

const base = { source_doc_no: null, posted: true, posted_at: '2026-08-10T00:00:00Z', reversed: false, created_at: '', who: null, reference: null };
const ENTRIES: JournalEntryGrouped[] = [
  { ...base, id: 'j1', je_no: '2990-JE-2608-0002', entry_date: '2026-08-10', source_type: 'PV', source_doc_no: '2990-HPV-2608-017', narration: 'Facebook ads August', total_debit_sen: 30_000, total_credit_sen: 30_000, journal_class: 'BANK',
    doc: '2990-HPV-2608-017', doc2: null, who: 'LOO WEN WEI',
    lines: [
      { line_no: 1, account_code: '900-A001', debit_sen: 30_000, credit_sen: 0, party_name: 'LOO WEN WEI', notes: 'Facebook ads' },
      { line_no: 2, account_code: '310-0010', debit_sen: 0, credit_sen: 30_000, party_name: null, notes: null },
    ] },
  { ...base, id: 'j2', je_no: '2990-JE-2608-0004', entry_date: '2026-08-20', source_type: 'SOPAY', source_doc_no: 'pay-1', narration: null, total_debit_sen: 161_000, total_credit_sen: 161_000, journal_class: 'BANK', reversed: true,
    doc: '2990-SO-2608-004', doc2: null, who: 'Keyed Twice',
    lines: [
      { line_no: 1, account_code: '310-0010', debit_sen: 161_000, credit_sen: 0, party_name: null, notes: null },
      { line_no: 2, account_code: '300-0000', debit_sen: 0, credit_sen: 161_000, party_name: 'Keyed Twice', notes: null },
    ] },
  { ...base, id: 'j3', je_no: '2990-JE-2609-0088', entry_date: '2026-09-15', source_type: 'SOPAY_REVERSAL', source_doc_no: 'pay-1', narration: 'Reversal of 2990-JE-2608-0004 — payment deleted', total_debit_sen: 161_000, total_credit_sen: 161_000, journal_class: 'BANK',
    doc: '2990-SO-2608-004', doc2: null, who: 'Keyed Twice',
    lines: [
      { line_no: 1, account_code: '300-0000', debit_sen: 161_000, credit_sen: 0, party_name: 'Keyed Twice', notes: null },
      { line_no: 2, account_code: '310-0010', debit_sen: 0, credit_sen: 161_000, party_name: null, notes: null },
    ] },
  { ...base, id: 'j4', je_no: '2990-JE-2608-0010', entry_date: '2026-08-31', source_type: 'MANUAL', narration: "Salary - Aug'26", total_debit_sen: 1_920_698, total_credit_sen: 1_920_698, journal_class: 'GENERAL',
    doc: null, doc2: null,
    lines: [
      { line_no: 1, account_code: '900-S100', debit_sen: 1_920_698, credit_sen: 0, party_name: null, notes: 'Gross salary' },
      { line_no: 2, account_code: '410-0010', debit_sen: 0, credit_sen: 1_920_698, party_name: null, notes: null },
    ] },
];
const nameOf = (code: string) => ({ '900-A001': 'ADVERTISEMENT', '310-0010': 'CASH AT BANK - MAYBANK', '300-0000': 'ACCOUNT RECEIVEABLE', '900-S100': 'GROSS SALARY', '410-0010': 'SALARY PAYABLE' } as Record<string, string>)[code] ?? '';

beforeEach(() => {
  useAccounts.mockReturnValue({ data: { accounts: [
    { account_code: '900-A001', account_name: 'ADVERTISEMENT', account_type: 'EXPENSE', is_active: true },
    { account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', is_active: true },
    { account_code: '300-0000', account_name: 'ACCOUNT RECEIVEABLE', account_type: 'ASSET', is_active: true },
    { account_code: '900-S100', account_name: 'GROSS SALARY', account_type: 'EXPENSE', is_active: true },
    { account_code: '410-0010', account_name: 'SALARY PAYABLE', account_type: 'LIABILITY', is_active: true },
  ] }, isLoading: false });
  useJournalEntriesGrouped.mockReturnValue({ data: { journalEntries: ENTRIES }, isLoading: false, isError: false });
  useJournalEntryCard.mockReturnValue({ data: { journalEntry: { ...ENTRIES[3], lines: undefined }, lines: [] }, isLoading: false, isError: false });
});
afterEach(cleanup);

const group = (container: HTMLElement, jeNo: string) => container.querySelector(`[data-je="${jeNo}"]`) as HTMLElement;
const rowsOf = (g: HTMLElement) => Array.from(g.querySelectorAll<HTMLElement>(':scope > [data-cw-row]'));

describe('the filters in the URL', () => {
  it('reads from, to, source and journal; defaults to this month and every journal', () => {
    const p = journalParamsFromSearch(new URLSearchParams('tab=je&from=2026-08-01&to=2026-08-31&source=PV&journal=bank'));
    expect(p).toEqual({ from: '2026-08-01', to: '2026-08-31', sourceType: 'PV', journal: 'BANK' });
    const d = journalParamsFromSearch(new URLSearchParams('tab=je&journal=nonsense&from=2026-02-30'));
    expect(d.from.endsWith('-01')).toBe(true);
    expect(d.to >= d.from).toBe(true);
    expect(d.journal).toBe('');
    expect(d.sourceType).toBe('');
  });

  it('offers every source the engine writes, each reversal apart, and names an unknown one by itself', () => {
    const codes = JOURNAL_SOURCES.map((x) => x.code);
    for (const c of ['SI', 'PI', 'API', 'PV', 'SOPAY', 'SIPAY', 'SOCONV', 'CASHUP', 'SETTLE', 'SETTLEADJ', 'SETTLEBANK', 'STOCKADJ', 'MANUAL', 'OPENING', 'DI', 'CN', 'DN', 'ODB', 'RCT', 'ODR']) {
      expect(codes).toContain(c);
    }
    expect(JOURNAL_REVERSALS.map((x) => x.code)).toContain('SI_REVERSAL');
    expect(sourceLabel('SI')).toBe('SI · Sales invoice');
    expect(sourceLabel('SI_REVERSAL')).toBe('SI reversal');
    expect(sourceLabel('MANUAL_REVERSAL')).toBe('Manual reversal');
    expect(sourceLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('the page', () => {
  it('groups: one head row per entry with its references and totals, then a row per line with the account as code over name', () => {
    const { container } = render(wrap(<JournalTab />, '/scm/accounting?tab=je&from=2026-08-01&to=2026-09-30'));
    expect(useJournalEntriesGrouped).toHaveBeenLastCalledWith({ from: '2026-08-01', to: '2026-09-30', sourceType: '' }, true);
    const g = group(container, '2990-JE-2608-0002');
    const rows = rowsOf(g);
    expect(rows).toHaveLength(3);
    const headRow = rows[0]!;
    expect(headRow.textContent).toContain('2026/08/10');
    expect(headRow.textContent).toContain('2990-JE-2608-0002');
    expect(headRow.textContent).toContain('Bank');
    expect(headRow.textContent).toContain('2990-HPV-2608-017');
    expect(headRow.textContent).toContain('Facebook ads August');
    expect(headRow.textContent).toContain('LOO WEN WEI');
    expect(headRow.textContent).toContain('300.00');
    expect(headRow.textContent).toContain('Posted');
    const first = rows[1]!;
    expect(within(first).getByText('900-A001').parentElement!.textContent).toContain('ADVERTISEMENT');
    expect(first.querySelector('br')).toBeTruthy();
    expect(first.textContent).toContain('Facebook ads');
    const cells = Array.from(first.children).map((c) => c.textContent);
    expect(cells[cells.length - 3]).toBe('300.00');
    expect(cells[cells.length - 2]).toBe('');
    const second = rows[2]!;
    const cells2 = Array.from(second.children).map((c) => c.textContent);
    expect(cells2[cells2.length - 2]).toBe('300.00');
    expect(screen.getByText('4 of 4 entries in the period')).toBeTruthy();
    /* The head: Books, the tab's name, the actions. */
    expect(screen.getByText('Finance · Books')).toBeTruthy();
    for (const label of ['New manual journal', 'Excel', 'PDF', 'Print']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
    /* The columns are dragged wider and fitted, each header with its edge. */
    expect(container.querySelectorAll('[title="Drag to resize · double-click to fit"]')).toHaveLength(9);
  });

  it('opened from the report list, the head reads Reports', () => {
    render(wrap(<JournalTab />, '/scm/accounting?tab=je&in=reports&from=2026-08-01&to=2026-09-30'));
    expect(screen.getByText('Finance · Reports')).toBeTruthy();
  });

  it('keeps a reversed entry and its contra, marked', () => {
    const { container } = render(wrap(<JournalTab />, '/scm/accounting?tab=je&from=2026-08-01&to=2026-09-30'));
    expect(group(container, '2990-JE-2608-0004').getAttribute('data-reversal')).toBe('reversed');
    const contra = group(container, '2990-JE-2609-0088');
    expect(contra.getAttribute('data-reversal')).toBe('contra');
    expect(within(contra).getByText('contra')).toBeTruthy();
    expect(within(group(container, '2990-JE-2608-0004')).getByText('Reversed')).toBeTruthy();
    expect(isContra({ source_type: 'PV_REVERSAL' })).toBe(true);
    expect(isContra({ source_type: 'PV' })).toBe(false);
  });

  it('the Journal segments narrow by class in the URL; the search box reads the lines', () => {
    const { container } = render(wrap(<JournalTab />, '/scm/accounting?tab=je&from=2026-08-01&to=2026-09-30'));
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(container.querySelectorAll('[data-je]')).toHaveLength(1);
    expect(group(container, '2990-JE-2608-0010')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(container.querySelectorAll('[data-je]')).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('Find an entry'), { target: { value: 'gross salary' } });
    expect(container.querySelectorAll('[data-je]')).toHaveLength(1);
    expect(screen.getByText('1 of 4 entries in the period')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Find an entry'), { target: { value: 'zzz' } });
    expect(screen.getByText('No entry matches.')).toBeTruthy();
    expect(filterEntries(ENTRIES, 'BANK', '', nameOf).map((r) => r.je_no)).toEqual(['2990-JE-2608-0002', '2990-JE-2608-0004', '2990-JE-2609-0088']);
    expect(filterEntries(ENTRIES, '', 'advertisement', nameOf).map((r) => r.je_no)).toEqual(['2990-JE-2608-0002']);
  });

  it('the Source is asked of the server', () => {
    render(wrap(<JournalTab />, '/scm/accounting?tab=je&from=2026-08-01&to=2026-09-30'));
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'SOPAY_REVERSAL' } });
    expect(useJournalEntriesGrouped).toHaveBeenLastCalledWith({ from: '2026-08-01', to: '2026-09-30', sourceType: 'SOPAY_REVERSAL' }, true);
  });

  it('the entry’s number opens its card; New manual journal opens the form; the states read plainly', () => {
    render(wrap(<JournalTab />, '/scm/accounting?tab=je&from=2026-08-01&to=2026-09-30'));
    fireEvent.click(screen.getByRole('button', { name: '2990-JE-2608-0010' }));
    expect(useJournalEntryCard).toHaveBeenLastCalledWith('j4');
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New manual journal' }));
    expect(screen.getAllByText('New manual journal').length).toBeGreaterThan(1);
    expect(screen.getByLabelText('Line 1 account')).toBeTruthy();
    cleanup();
    useJournalEntriesGrouped.mockReturnValue({ data: { journalEntries: [] }, isLoading: false, isError: false });
    render(wrap(<JournalTab />, '/scm/accounting?tab=je&from=2026-08-01&to=2026-08-31'));
    expect(screen.getByText('No entries in the period.')).toBeTruthy();
    cleanup();
    useJournalEntriesGrouped.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(wrap(<JournalTab />, '/scm/accounting?tab=je&from=2026-08-01&to=2026-08-31'));
    expect(screen.getByText(/did not load/)).toBeTruthy();
    cleanup();
    render(wrap(<JournalTab />, '/scm/accounting?tab=je&from=2026-09-30&to=2026-09-01'));
    expect(screen.getByText(/From is later than To/)).toBeTruthy();
    expect(useJournalEntriesGrouped).toHaveBeenLastCalledWith({ from: '2026-09-30', to: '2026-09-01', sourceType: '' }, false);
  });
});

describe('the exports', () => {
  it('the CSV is one row per line, the head repeated in front, the reversal state on the status', () => {
    const rows = journalCsv(ENTRIES.slice(0, 1).concat(ENTRIES[2]!), nameOf).split('\n');
    expect(rows[0]).toBe('Date,Entry,Journal,Ref. 1,Ref. 2,Description,Debit,Credit,Status,Account,Account name,Party,Note,Line debit,Line credit');
    expect(rows[1]).toBe('2026/08/10,2990-JE-2608-0002,Bank,2990-HPV-2608-017,,Facebook ads August,300.00,300.00,POSTED,900-A001,ADVERTISEMENT,LOO WEN WEI,Facebook ads,300.00,');
    expect(rows[2]).toBe('2026/08/10,2990-JE-2608-0002,Bank,2990-HPV-2608-017,,Facebook ads August,300.00,300.00,POSTED,310-0010,CASH AT BANK - MAYBANK,,,,300.00');
    expect(rows[3]).toContain('POSTED contra,300-0000');
    expect(rows).toHaveLength(5);
  });

  it('the report sheet: each entry a bold row with its figures, its lines one step in', () => {
    const sheet = journalSheet({
      rows: ENTRIES.slice(0, 1), from: '2026-08-01', to: '2026-08-31', narrowedBy: ['Bank journal'], nameOf,
      journalWord: () => 'Bank', statusWord: () => 'Posted',
    });
    expect(sheet.title).toBe('Journal entries');
    expect(sheet.subtitle).toBe('2026/08/01 – 2026/08/31 · Bank journal · 1 entry');
    const [table] = sheet.tables;
    expect(table!.columns.map((c) => c.label)).toEqual(['Date', 'Journal', 'Ref. 1', 'Ref. 2', 'Description', 'Debit', 'Credit', 'Status']);
    expect(table!.rows[0]).toEqual({ kind: 'category', depth: 0, label: '2990-JE-2608-0002', cells: ['2026/08/10', 'Bank', '2990-HPV-2608-017', '', 'Facebook ads August', 30_000, 30_000, 'Posted'] });
    expect(table!.rows[1]).toEqual({ kind: 'row', depth: 1, label: '900-A001 ADVERTISEMENT', cells: ['', '', 'LOO WEN WEI', '', 'Facebook ads', 30_000, '', ''] });
    expect(table!.rows[2]!.cells[6]).toBe(30_000);
  });
});
