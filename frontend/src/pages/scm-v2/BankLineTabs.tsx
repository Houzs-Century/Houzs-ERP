// ----------------------------------------------------------------------------
// BankLineTabs — a month's bank lines in the redesign's six tabs (the owner's
// Claude Design, batch 3): To match · To choose · No entry found ‖ Not on the
// bank yet ‖ Matched · Set aside. The rows that choose are the file screen's
// own (OpenLine, DoneLine), so one movement has one set of buttons wherever it
// is looked at. What sorts a line into a tab is what the matcher already
// decided; nothing here posts or links unless its own button is pressed.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { AlertTriangle, Landmark, Link2 } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { useBookBankReceipt, useMatchBankLine, type BankLine, type LedgerEntry } from './bank-queries';
import { BookAllMatched, DepWd, DoneLine, OpenLine, certainAllocation, decisionKey } from './BankStatementTab';
import { useReconcilePick } from './bank-reconcile-pick';
import { EntryDocument, entryDocText } from './bank-entry-doc';
import { ICON, fmt, refusalText } from './settlement-ui';
import { monthShort } from './BankStatementsTop';
import { fmtDate, fmtDateOrDash } from '../../vendor/shared/format';
import { BankRecordJournal, recordableLine } from './BankRecordJournal';
import { useBooksToast } from './books/BooksToast';
import tokens from './finance/finance-ui.module.css';
import look from './BankStatements.module.css';
import grid from './MerchantRecon.module.css';

export type LineTab = 'to-match' | 'to-choose' | 'no-entry' | 'not-on-bank' | 'matched' | 'set-aside';
type LineOnlyTab = Exclude<LineTab, 'not-on-bank'>;

/** Which tab a bank line sits in — what the matcher decided, in the redesign's words.
    `chooseAnyway` holds the lines a person pressed "Not this" on: they leave To match for To choose. */
export function bankLineTab(l: BankLine, chooseAnyway: ReadonlySet<number>): LineOnlyTab {
  if (l.state === 'POSTED') return 'matched';
  if (l.state === 'IGNORED') return 'set-aside';
  if (chooseAnyway.has(l.id)) return 'to-choose';
  /* A day's DuitNow QR money (owner 2026-11-09): ready to match to its sales, or still waiting on a link. */
  if (l.kind === 'QR') return l.qr_sales?.ready ? 'to-match' : 'to-choose';
  if (certainAllocation(l) != null) return 'to-match';
  if (l.kind === 'OTHER' && l.entryCandidates.length === 1) return 'to-match';
  if ((l.kind === 'OTHER' || l.kind === 'PAYOUT_NO_BATCH') && l.entryCandidates.length === 0 && l.candidates.length === 0) return 'no-entry';
  return 'to-choose';
}

export const LINE_TAB_LABEL: Record<LineTab, string> = {
  'to-match': 'To match', 'to-choose': 'To choose', 'no-entry': 'No entry found',
  'not-on-bank': 'Not on the bank yet', matched: 'Matched', 'set-aside': 'Set aside',
};
const HINT: Record<LineTab, string> = {
  'to-match': 'Same amount, one entry, names agree. Check each one, then match it.',
  'to-choose': 'More than one entry could fit, or one movement covers several entries.',
  'no-entry': 'Nothing in the books fits yet. Record what it is, or set it aside with a note.',
  'not-on-bank': 'In the ledger, not shown by the bank yet: a payment not paid out, a receipt not credited, or an entry after the statement ends. Each stays here month after month until the bank shows it and its line is matched.',
  matched: 'Lines you match here can be undone until the month is locked.',
  'set-aside': 'Kept on the statement with a note. Nothing posted.',
};
/* What an empty tab says — what it looked for, never a verdict on the month (the empty-state rule). */
const EMPTY: Record<LineTab, string> = {
  'to-match': 'No line waiting to be matched.', 'to-choose': 'Nothing to choose.', 'no-entry': 'No line without an entry.',
  'not-on-bank': 'No ledger entry waiting for the bank.', matched: 'Nothing matched yet.', 'set-aside': 'Nothing set aside.',
};
const ORDER: LineTab[] = ['to-match', 'to-choose', 'no-entry', 'not-on-bank', 'matched', 'set-aside'];
const OPEN_TABS: LineTab[] = ['to-match', 'to-choose', 'no-entry'];

export type TabCounts = Record<LineTab, number>;

export function tabCounts(lines: BankLine[], entries: LedgerEntry[], chooseAnyway: ReadonlySet<number>): TabCounts {
  const out: TabCounts = { 'to-match': 0, 'to-choose': 0, 'no-entry': 0, 'not-on-bank': entries.length, matched: 0, 'set-aside': 0 };
  for (const l of lines) out[bankLineTab(l, chooseAnyway)] += 1;
  return out;
}

/** The tab a month opens on: the one asked for, else the first with lines to work, else Matched. */
export const openingTab = (asked: string | null, counts: TabCounts): LineTab =>
  (ORDER as string[]).includes(asked ?? '') ? asked as LineTab : OPEN_TABS.find((t) => counts[t] > 0) ?? 'matched';
export const firstOpenTab = (counts: TabCounts): LineTab => OPEN_TABS.find((t) => counts[t] > 0) ?? 'matched';

export function LineTabs({ tab, counts, locked, onTab }: { tab: LineTab; counts: TabCounts; locked: boolean; onTab: (t: LineTab) => void }) {
  return (
    <div className={look.tabsRow}>
      <div className={look.tabs} role="tablist" aria-label="Bank lines">
        {ORDER.map((t) => {
          const hot = counts[t] > 0 && (OPEN_TABS.includes(t));
          return (
            <span key={t} className={look.tabWrap}>
              {(t === 'not-on-bank' || t === 'matched') && <span className={look.tabSep} aria-hidden />}
              <button type="button" role="tab" aria-selected={tab === t} className={`${look.tab} ${tab === t ? look.tabOn : ''}`} onClick={() => onTab(t)}>
                {LINE_TAB_LABEL[t]}
                <span className={`${look.tabCount} ${hot ? (t === 'no-entry' ? look.countLate : t === 'to-choose' ? look.countWarn : look.countInfo) : counts[t] > 0 ? look.countSome : ''}`}>{counts[t]}</span>
              </button>
            </span>
          );
        })}
      </div>
      <span className={look.muted}>{tab === 'matched' && locked ? 'The month is locked, so undo is closed.' : HINT[tab]}</span>
    </div>
  );
}

/* ── To match: one entry, or one report owed exactly this ─────────────────── */

function ToMatchRow({ line, locked, onNotThis }: { line: BankLine; locked: boolean; onNotThis: () => void }) {
  const book = useBookBankReceipt();
  const match = useMatchBankLine();
  const allocation = certainAllocation(line);
  const report = allocation ? line.candidates.find((b) => b.id === allocation.batchId) ?? null : null;
  const entry = allocation ? null : line.entryCandidates.at(0) ?? null;
  const failed = book.isError ? book.error : match.isError ? match.error : null;
  const busy = book.isPending || match.isPending;
  return (
    <tr>
      <td className={look.dateCell}>{fmtDate(line.booked_on)}</td>
      <td>
        {line.reference && <div><b>{line.reference}</b></div>}
        <div className={grid.sub} style={{ wordBreak: 'break-word' }}>{line.description}</div>
      </td>
      <DepWd amountSen={line.amount_sen} />
      <td>{report ? <b>{report.fileName ?? `report ${report.id}`}</b> : <b>{entry ? <EntryDocument text={entryDocText(entry)} /> : '—'}</b>}</td>
      <td>{report ? `${line.acquirer_code ?? ''} card payout` : entry?.who ?? entry?.partyName ?? '—'}</td>
      <td>{entry ? <>{entry.jeNo}{entry.daysApart > 0 && <span className={grid.sub}> · {entry.daysApart}d apart</span>}</> : <span className={grid.sub}>posted on Money received</span>}</td>
      <td className={look.actionsCell}>
        {!locked && (
          <span className={look.actions}>
            <button type="button" className={look.textBtn} onClick={onNotThis}>Not this</button>
            {allocation
              ? <button type="button" className={`${look.btn} ${look.primary}`} disabled={busy}
                  onClick={() => book.mutate({ lineId: line.id, allocations: [allocation] })}>
                  <Landmark {...ICON} /> {book.isPending ? 'Posting…' : 'Money received'}
                </button>
              : entry && <button type="button" className={`${look.btn} ${look.primary}`} disabled={busy}
                  onClick={() => match.mutate({ lineId: line.id, jeNo: entry.jeNo })}>
                  <Link2 {...ICON} /> {match.isPending ? 'Matching…' : 'Match'}
                </button>}
          </span>
        )}
        {failed != null && <div className={look.refusal}><AlertTriangle {...ICON} /> {refusalText(failed, 'That was not accepted.')}</div>}
      </td>
    </tr>
  );
}

/* ── Not on the bank yet: what the ledger holds that the bank has not shown ── */

function entryState(e: LedgerEntry, open: BankLine[], chooseAnyway: ReadonlySet<number>, periodTo: string): string | null {
  const offered = open.find((l) => l.entryCandidates.some((c) => c.jeNo === e.jeNo));
  if (offered) return `Offered under ${LINE_TAB_LABEL[bankLineTab(offered, chooseAnyway)]}`;
  if (e.carried) return `Earlier month · ${monthShort(e.entryDate.slice(0, 7))}`;
  if (e.entryDate > periodTo) return `Statement stops at ${fmtDate(periodTo)}`;
  return null;
}

function NotOnBankYet({ entries, open, chooseAnyway, periodTo }: { entries: LedgerEntry[]; open: BankLine[]; chooseAnyway: ReadonlySet<number>; periodTo: string }) {
  /* The tick matches entries to the lines ticked under To choose / No entry
     found; the bar at the foot carries the totals (bank-reconcile-pick). */
  const pick = useReconcilePick();
  return (
    <table className={grid.grid}>
      <thead>
        <tr><th /><th>Date</th><th>Document</th><th>Party</th><th className={grid.num}>In</th><th className={grid.num}>Out</th><th>Entry</th><th>State</th></tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const st = entryState(e, open, chooseAnyway, periodTo);
          return (
            <tr key={e.jeNo} className={pick.pickedEntries.includes(e.jeNo) ? look.picked : undefined}>
              <td><input type="checkbox" checked={pick.pickedEntries.includes(e.jeNo)} onChange={() => pick.toggleEntry(e.jeNo)} aria-label={`Entry ${e.jeNo} for the picked movements`} /></td>
              <td className={look.dateCell}>{fmtDateOrDash(e.entryDate)}</td>
              <td><b><EntryDocument text={entryDocText(e)} /></b></td>
              <td>{e.who ?? e.partyName ?? e.notes ?? '—'}</td>
              <td className={grid.num}>{e.debitSen > 0 ? fmt(e.debitSen) : ''}</td>
              <td className={grid.num}>{e.creditSen > 0 ? fmt(e.creditSen) : ''}</td>
              <td>{e.jeNo}</td>
              <td>{st && <span className={`${look.pill} ${st.startsWith('Offered') ? look.toneInfo : look.toneCalm}`}>{st}</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ── The tab's body ──────────────────────────────────────────────────────── */

type TabBodyProps = {
  tab: LineTab; lines: BankLine[]; entries: LedgerEntry[]; locked: boolean; periodTo: string;
  chooseAnyway: ReadonlySet<number>; onNotThis: (lineId: number) => void;
};

export function LineTabBody({ accountCode, ...body }: TabBodyProps & {
  /** The bank account the month is of — its ledger code; Record journal posts its leg there. */
  accountCode?: string;
}) {
  const { can } = useAuth();
  /* Record journal (No entry found): the same right as posting a manual journal
     and matching bank lines, and never on a locked month. */
  const mayRecord = !body.locked && accountCode != null && can('scm.payment_voucher.post');
  const [recording, setRecording] = useState<BankLine | null>(null);
  const toast = useBooksToast();
  return (
    <>
      <TabBody {...body} onRecord={mayRecord ? setRecording : null} />
      {/* Beside the tab, not inside it: once its journal posts, the line leaves
          No entry found on the next read while the drawer still has things to say. */}
      {accountCode != null && (
        <BankRecordJournal line={recording} accountCode={accountCode} onClose={() => setRecording(null)} onToast={toast.say} />
      )}
      {toast.node && <div className={tokens.root}>{toast.node}</div>}
    </>
  );
}

function TabBody({ tab, lines, entries, locked, periodTo, chooseAnyway, onNotThis, onRecord }: TabBodyProps & {
  /** Record journal on a No entry found line; null where it is not offered. */
  onRecord: ((line: BankLine) => void) | null;
}) {
  const pick = useReconcilePick();
  const inTab = tab === 'not-on-bank' ? [] : lines.filter((l) => bankLineTab(l, chooseAnyway) === tab);
  const open = lines.filter((l) => l.state === 'OPEN');
  if ((tab === 'not-on-bank' ? entries.length : inTab.length) === 0) return <div className={look.emptyTab}>{EMPTY[tab]}</div>;
  if (tab === 'not-on-bank') return <NotOnBankYet entries={entries} open={open} chooseAnyway={chooseAnyway} periodTo={periodTo} />;
  if (tab === 'to-match') {
    return (
      <div className={look.section}>
        {/* Every certain payout in one press — the rows' own door, one by one (docs/bugs/0868). */}
        {!locked && <BookAllMatched lines={inTab} />}
        <table className={grid.grid}>
          <thead>
            <tr><th>Date</th><th>Description</th><th className={grid.num}>In</th><th className={grid.num}>Out</th><th>Document</th><th>Party</th><th>Entry</th><th /></tr>
          </thead>
          <tbody>
            {inTab.map((l) => <ToMatchRow key={decisionKey(l)} line={l} locked={locked} onNotThis={() => onNotThis(l.id)} />)}
          </tbody>
        </table>
      </div>
    );
  }
  if (tab === 'to-choose' || tab === 'no-entry') {
    return (
      <table className={grid.grid}>
        <thead>
          <tr>
            <th />
            <th>Bank statement</th>
            <th className={grid.num}>In</th>
            <th className={grid.num}>Out</th>
            <th>What it looks like</th>
            <th>Ledger entry · what to do</th>
          </tr>
        </thead>
        <tbody>
          {/* KEYED ON THE DECISION (docs/bugs/0870): a changed decision remounts the row. */}
          {inTab.map((l) => (
            <OpenLine key={decisionKey(l)} line={l} isPicked={pick.pickedLines.includes(l.id)} onPick={() => pick.toggleLine(l.id)}
              onRecordJournal={tab === 'no-entry' && onRecord && recordableLine(l) ? () => onRecord(l) : undefined} />
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className={grid.grid}>
      <thead>
        <tr><th>Bank statement</th><th className={grid.num}>In</th><th className={grid.num}>Out</th><th>{tab === 'matched' ? 'What it was matched to' : 'Note'}</th><th /></tr>
      </thead>
      <tbody>
        {inTab.map((l) => <DoneLine key={l.id} line={l} />)}
      </tbody>
    </table>
  );
}
