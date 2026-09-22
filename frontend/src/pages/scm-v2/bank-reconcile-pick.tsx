// ----------------------------------------------------------------------------
// bank-reconcile-pick — ticking movements and entries to match them, on one
// screen without a second list (owner 2026-09-15, docs/bugs/0918: 我要 manual
// 用打勾 match 时为什么还要跳出来？下面不是有 list 了吗 … these are that entry 要做到
// 容易点，不需要一张划上划下). The movements still to decide are ticked in
// their own table, the entries in the outstanding list below it — the list
// the screen already had — and a bar FIXED to the foot of the window carries
// the two totals and the button, so nothing is scrolled to. The state lives
// here, in a provider both tables read, so the two tables stay two tables.
// Shared by the statement view and the month view.
// ----------------------------------------------------------------------------

import { createContext, useContext, useMemo, useState } from 'react';
import { Link2 } from 'lucide-react';
import { useMatchBankGroup, type BankLine, type LedgerEntry } from './bank-queries';
import { ICON, fmt, btn, softText, danger, good, refusalText } from './settlement-ui';

export type ReconcilePick = {
  pickedLines: number[];
  pickedEntries: string[];
  toggleLine: (id: number) => void;
  toggleEntry: (jeNo: string) => void;
  clear: () => void;
};

const Ctx = createContext<ReconcilePick | null>(null);

/** The pick state, for a table inside the provider. */
export const useReconcilePick = (): ReconcilePick => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useReconcilePick must be used within <ReconcilePickProvider>');
  return v;
};

/** Movements by the day the bank booked them, oldest first, then by line —
    the order a statement reads in (owner: 不是根据日期往下排的). */
export const byDateThenLine = <T extends { booked_on: string; line_no: number }>(lines: T[]): T[] =>
  [...lines].sort((a, b) => String(a.booked_on).localeCompare(String(b.booked_on)) || a.line_no - b.line_no);

export const ReconcilePickProvider = ({ lines, entries, children }: { lines: BankLine[]; entries: LedgerEntry[]; children: React.ReactNode }) => {
  const [pickedLines, setPickedLines] = useState<number[]>([]);
  const [pickedEntries, setPickedEntries] = useState<string[]>([]);
  const value = useMemo<ReconcilePick>(() => ({
    pickedLines,
    pickedEntries,
    toggleLine: (id) => setPickedLines((was) => (was.includes(id) ? was.filter((x) => x !== id) : [...was, id])),
    toggleEntry: (je) => setPickedEntries((was) => (was.includes(je) ? was.filter((x) => x !== je) : [...was, je])),
    clear: () => { setPickedLines([]); setPickedEntries([]); },
  }), [pickedLines, pickedEntries]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <MatchBar lines={lines} entries={entries} />
    </Ctx.Provider>
  );
};

/* ── The bar at the foot of the window ────────────────────────────────────── */

const MatchBar = ({ lines, entries }: { lines: BankLine[]; entries: LedgerEntry[] }) => {
  const pick = useReconcilePick();
  const group = useMatchBankGroup();
  if (pick.pickedLines.length === 0 && pick.pickedEntries.length === 0) return null;

  const chosenLines = lines.filter((l) => pick.pickedLines.includes(l.id));
  const chosenEntries = entries.filter((e) => pick.pickedEntries.includes(e.jeNo));
  const linesSen = chosenLines.reduce((s, l) => s + l.amount_sen, 0);
  const entriesSen = chosenEntries.reduce((s, e) => s + (e.debitSen - e.creditSen), 0);
  const oneSide = chosenLines.length <= 1 || chosenEntries.length <= 1;
  const agrees = chosenLines.length > 0 && chosenEntries.length > 0 && linesSen === entriesSen && oneSide;
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : (word === 'entry' ? 'ies' : 's')}`.replace('entryies', 'entries');

  return (
    /* In the page column, stuck to the foot of the scrolling pane (the provider
       renders it after the tab's content, so it stays in flow); the right padding
       keeps the bottom-right + / Assistant / Back-to-top cluster (~144px) off the
       buttons — the New PI page's own rule. It was `position: fixed` across the
       window: the sidebar covered its left, the cluster its buttons (owner
       2026-09-22 screenshot: 被挡着，超出了格子). */
    <div role="region" aria-label="Match the ticked movements and entries" className="pr-4 lg:pr-36"
      style={{
        position: 'sticky', bottom: 0, zIndex: 20, marginTop: 'var(--space-3)',
        display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap',
        paddingTop: 'var(--space-2)', paddingBottom: 'var(--space-2)', paddingLeft: 'var(--space-4)', background: 'var(--c-paper, #fff)',
        borderTop: '2px solid var(--c-ink, #221f20)', boxShadow: '0 -4px 12px rgba(0,0,0,0.08)', fontSize: 'var(--fs-13)',
      }}>
      <span>
        <b>{n(chosenLines.length, 'movement')}</b> · {fmt(linesSen)}
        {' — '}
        <b>{n(chosenEntries.length, 'entry')}</b> · {fmt(entriesSen)}
      </span>
      <span style={{ color: agrees ? good : danger }}>
        {chosenLines.length === 0 && 'Tick the movement(s) above.'}
        {chosenLines.length > 0 && chosenEntries.length === 0 && 'Tick the entry (or entries) below.'}
        {chosenLines.length > 0 && chosenEntries.length > 0 && linesSen !== entriesSen && `${fmt(linesSen - entriesSen)} out — the totals must agree.`}
        {!oneSide && ' Several movements to several entries is two matches; do one side at a time.'}
        {agrees && 'The totals agree.'}
      </span>
      <span style={{ flex: 1 }} />
      <button type="button" style={btn(true, !agrees || group.isPending)} disabled={!agrees || group.isPending}
        onClick={() => group.mutate({ lineIds: pick.pickedLines, jeNos: pick.pickedEntries }, { onSuccess: () => pick.clear() })}>
        <Link2 {...ICON} /> {group.isPending ? 'Matching…' : 'These are that entry'}
      </button>
      <button type="button" style={{ ...btn(), padding: '2px 8px' }} onClick={pick.clear}>Clear</button>
      {group.isError && <span style={{ ...softText, color: danger, width: '100%' }}>{refusalText(group.error, 'That was not accepted.')}</span>}
    </div>
  );
};
