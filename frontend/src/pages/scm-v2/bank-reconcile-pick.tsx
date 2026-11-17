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

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Link2 } from 'lucide-react';
import { cardPaymentKey, useMatchBankGroup, useMatchWithCards, type BankCardPayment, type BankCardPayments, type BankLine, type LedgerEntry } from './bank-queries';
import { cardPickState } from './bank-card-pick';
import { ICON, fmt, btn, softText, danger, good, refusalText } from './settlement-ui';
import { dropReturnPicks, peekReturnPicks, rememberReturnPicks } from '../../lib/returnScroll';

export type ReconcilePick = {
  pickedLines: number[];
  pickedEntries: string[];
  /** Card payments no report carries, ticked for the movement to take in (cardPaymentKey). */
  pickedCards: string[];
  toggleLine: (id: number) => void;
  toggleEntry: (jeNo: string) => void;
  toggleCard: (key: string) => void;
  clear: () => void;
  /** Note the ticks as a document opens from this page, for the way back. */
  keepForReturn: () => void;
};

const Ctx = createContext<ReconcilePick | null>(null);
/** The pick state where there may be none — a link that notes the ticks when there are any. */
export const ReconcilePickContext = Ctx;

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

/** `ready`: the lists have arrived (a screen that mounts this while it loads says
    when), so a tick they do not hold may be let go. */
export type CardSetup = Pick<BankCardPayments, 'feeAccount' | 'feeProblem' | 'maxChargePct'>;

export const ReconcilePickProvider = ({ lines, entries, cards = [], cardSetup = null, ready = true, children }: {
  lines: BankLine[]; entries: LedgerEntry[];
  /** The card payments no report carries (the month view lists them in its own tab); none elsewhere. */
  cards?: BankCardPayment[]; cardSetup?: CardSetup | null;
  ready?: boolean; children: React.ReactNode;
}) => {
  /* What was ticked when an order was opened from here comes back with the page
     (owner 2026-11-10: 点开后也可以返回这里), once. */
  const [ticked, setTicked] = useState<number[]>(() => peekReturnPicks()?.lines ?? []);
  const [tickedEntries, setTickedEntries] = useState<string[]>(() => peekReturnPicks()?.entries ?? []);
  const [tickedCards, setTickedCards] = useState<string[]>([]);
  useEffect(() => { dropReturnPicks(); }, []);
  /* Only what is still on the screen is ticked (owner 2026-11-10: 这个情况不应该出现啊).
     A movement ticked, then matched another way, left the list but kept its tick —
     unseen, not in the bar's totals, and still sent, so the next match was refused
     over a line nobody could see ("Movement 1197 is already posted"). A tick whose
     row has gone is dropped, and forgotten, so a row that comes back (an undo) comes
     back unticked. */
  const listedLines = useMemo(() => new Set(lines.map((l) => l.id)), [lines]);
  const listedEntries = useMemo(() => new Set(entries.map((e) => e.jeNo)), [entries]);
  const listedCards = useMemo(() => new Set(cards.map(cardPaymentKey)), [cards]);
  const pickedLines = useMemo(() => ticked.filter((id) => listedLines.has(id)), [ticked, listedLines]);
  const pickedEntries = useMemo(() => tickedEntries.filter((je) => listedEntries.has(je)), [tickedEntries, listedEntries]);
  const pickedCards = useMemo(() => tickedCards.filter((k) => listedCards.has(k)), [tickedCards, listedCards]);
  useEffect(() => {
    if (!ready) return;
    setTicked((was) => (was.every((id) => listedLines.has(id)) ? was : was.filter((id) => listedLines.has(id))));
    setTickedEntries((was) => (was.every((je) => listedEntries.has(je)) ? was : was.filter((je) => listedEntries.has(je))));
    setTickedCards((was) => (was.every((k) => listedCards.has(k)) ? was : was.filter((k) => listedCards.has(k))));
  }, [ready, listedLines, listedEntries, listedCards]);
  const value = useMemo<ReconcilePick>(() => ({
    pickedLines,
    pickedEntries,
    pickedCards,
    toggleLine: (id) => setTicked((was) => (was.includes(id) ? was.filter((x) => x !== id) : [...was, id])),
    toggleEntry: (je) => setTickedEntries((was) => (was.includes(je) ? was.filter((x) => x !== je) : [...was, je])),
    toggleCard: (k) => setTickedCards((was) => (was.includes(k) ? was.filter((x) => x !== k) : [...was, k])),
    clear: () => { setTicked([]); setTickedEntries([]); setTickedCards([]); },
    keepForReturn: () => rememberReturnPicks({ lines: pickedLines, entries: pickedEntries }),
  }), [pickedLines, pickedEntries, pickedCards]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <MatchBar lines={lines} entries={entries} cards={cards} cardSetup={cardSetup} />
    </Ctx.Provider>
  );
};

/* ── The bar at the foot of the window ────────────────────────────────────── */

const MatchBar = ({ lines, entries, cards, cardSetup }: { lines: BankLine[]; entries: LedgerEntry[]; cards: BankCardPayment[]; cardSetup: CardSetup | null }) => {
  const pick = useReconcilePick();
  const group = useMatchBankGroup();
  const withCards = useMatchWithCards();
  /* A refusal answers the ticks it was sent with; once they change it is old news
     (the owner's next pair still carried the first one's red line, 2026-11-10). */
  const ticks = `${pick.pickedLines.join(',')}|${pick.pickedEntries.join(',')}|${pick.pickedCards.join(',')}`;
  const [sentWith, setSentWith] = useState<string | null>(null);
  if (pick.pickedLines.length === 0 && pick.pickedEntries.length === 0 && pick.pickedCards.length === 0) return null;

  const chosenLines = lines.filter((l) => pick.pickedLines.includes(l.id));
  const chosenEntries = entries.filter((e) => pick.pickedEntries.includes(e.jeNo));
  const chosenCards = cards.filter((p) => pick.pickedCards.includes(cardPaymentKey(p)));
  const linesSen = chosenLines.reduce((s, l) => s + l.amount_sen, 0);
  const entriesSen = chosenEntries.reduce((s, e) => s + (e.debitSen - e.creditSen), 0);
  const cardsSen = chosenCards.reduce((s, p) => s + p.amountSen, 0);
  /* Card payments ticked: the movement takes them in itself and the difference
     goes to the charges account (owner 2026-11-17; bank-card-pick). */
  const cardMode = chosenCards.length > 0;
  const card = cardMode
    ? cardPickState({ lines: chosenLines, entriesSen, cards: chosenCards, maxChargePct: cardSetup?.maxChargePct ?? 0, feeAccount: cardSetup?.feeAccount ?? null, feeProblem: cardSetup?.feeProblem ?? null })
    : null;
  const oneSide = chosenLines.length <= 1 || chosenEntries.length <= 1;
  const agrees = card ? card.ok : chosenLines.length > 0 && chosenEntries.length > 0 && linesSen === entriesSen && oneSide;
  const busy = group.isPending || withCards.isPending;
  const failed = cardMode ? (withCards.isError ? withCards.error : null) : (group.isError ? group.error : null);
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
        paddingTop: 'var(--space-2)', paddingBottom: 'var(--space-2)', paddingLeft: 'var(--space-4)', background: 'var(--c-paper, var(--hz-c-surface))',
        borderTop: '2px solid var(--c-ink, #221f20)', boxShadow: '0 -4px 12px rgba(0,0,0,0.08)', fontSize: 'var(--fs-13)',
      }}>
      <span>
        <b>{n(chosenLines.length, 'movement')}</b> · {fmt(linesSen)}
        {' — '}
        <b>{n(chosenEntries.length, 'entry')}</b> · {fmt(entriesSen)}
        {cardMode && <>{' + '}<b>{n(chosenCards.length, 'card payment')}</b> · {fmt(cardsSen)}</>}
      </span>
      <span style={{ color: agrees ? good : danger }}>
        {card && card.message}
        {!card && chosenLines.length === 0 && 'Tick the movement(s) above.'}
        {!card && chosenLines.length > 0 && chosenEntries.length === 0 && 'Tick the entry (or entries) below.'}
        {!card && chosenLines.length > 0 && chosenEntries.length > 0 && linesSen !== entriesSen && `${fmt(linesSen - entriesSen)} out — the totals must agree.`}
        {!card && !oneSide && ' Several movements to several entries is two matches; do one side at a time.'}
        {!card && agrees && 'The totals agree.'}
      </span>
      <span style={{ flex: 1 }} />
      <button type="button" style={btn(true, !agrees || busy)} disabled={!agrees || busy}
        onClick={() => {
          setSentWith(ticks);
          if (cardMode) {
            withCards.mutate(
              { lineId: pick.pickedLines[0]!, jeNos: pick.pickedEntries, cardPayments: chosenCards.map((p) => ({ source: p.source, id: p.id })) },
              { onSuccess: () => pick.clear() },
            );
          } else {
            group.mutate({ lineIds: pick.pickedLines, jeNos: pick.pickedEntries }, { onSuccess: () => pick.clear() });
          }
        }}>
        <Link2 {...ICON} /> {busy ? 'Matching…' : cardMode ? 'Match, difference to charges' : 'These are that entry'}
      </button>
      <button type="button" style={{ ...btn(), padding: '2px 8px' }} onClick={pick.clear}>Clear</button>
      {failed != null && sentWith === ticks && <span style={{ ...softText, color: danger, width: '100%' }}>{refusalText(failed, 'That was not accepted.')}</span>}
    </div>
  );
};
