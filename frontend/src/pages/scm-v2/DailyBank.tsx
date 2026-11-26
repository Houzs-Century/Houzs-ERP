// ----------------------------------------------------------------------------
// Daily Bank — "today, where is the money, and how much can actually move"
// (accounting module phase 2B; brief §3.6, owner decision 2b).
//
// Reads one live endpoint (/accounting/daily-bank) computed from the ledger —
// no cache, so this board, the Trial Balance and the GL can never disagree.
//
// By bank since 2026-09-29 (owner, his "BANK BALANCE AVAILABLE" sample: 1 By
// bank · 2 pending = checked, not yet approved — approved 了就会扣钱 · 3 show
// what was paid · 4 keep the three totals; then settlement in transit 放在相对应
// 的银行, and 要 the line with it added): the three totals stay on top; under a
// dark bar, one table per money account with its Bank Balance in the header —
// Balance B/F, Received today, Paid today, Pending payment, Available (after
// pending), In transit per acquirer, Available + in transit — in three number
// columns, one kind each: RECEIVED, PAYMENT (paid today and pending), BALANCE. The table model
// is ONE (daily-bank-report.ts), read by this page, the image and the PDF.
// Get image copies a PNG to the clipboard for WhatsApp (download fallback);
// PNG saves it; PDF saves the same table on the letterhead.
//
// The cash book (owner 2026-11-23: 原版的daily bank还是要保留哦，我这算是新的daily
// bank) is a second page on the same frame, /scm/daily-bank-cashbook: its board
// (/accounting/daily-bank/cashbook/board) reads each bank from the starting
// balance the owner types, the receipts he types and the approved vouchers, and
// its third view is where he types them. This page, the original, is untouched.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Calendar, ChevronLeft, ChevronRight, ImageDown, Printer } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useDailyBank, type DailyBankBoard } from './accounting-phase1-queries';
import { useDailyBankCashbookBoard } from './daily-bank-cashbook-queries';
import { PageHeader } from '../../components/Layout';
import { DateField } from "../../vendor/scm/components/DateField";
import { DailyBankBoardView } from './DailyBankBoard';
import { DailyBankAccounts } from './DailyBankAccounts';
import { DailyBankClose } from './DailyBankClose';
import { DailyBankCashbook } from './DailyBankCashbook';
import { DailyBankImageModal, DailyBankPrintModal } from './DailyBankPrint';
import css from './DailyBank.module.css';
import { todayMyt } from '../../vendor/scm/lib/dates';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const shiftDate = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

type Book = 'ledger' | 'cashbook';
type DailyBankView = 'board' | 'accounts' | 'close' | 'entries';
const VIEWS: Record<Book, Array<[DailyBankView, string]>> = {
  ledger: [['board', 'Board'], ['accounts', 'Accounts'], ['close', 'Daily close']],
  cashbook: [['board', 'Board'], ['accounts', 'Accounts'], ['entries', 'Receipts & starts']],
};
const isDay = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

function useDailyBankAddress(book: Book) {
  const [params, setParams] = useSearchParams();
  const views = VIEWS[book];
  const known = (v: string | null): v is DailyBankView => views.some(([k]) => k === v);
  const rawView = params.get('view');
  const view: DailyBankView = known(rawView) ? rawView : 'board';
  const dayParam = params.get('date');
  const date = isDay(dayParam) ? dayParam : todayMyt();
  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v == null) next.delete(k); else next.set(k, v); }
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if (!known(rawView)) setParam({ view: 'board' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a missing or unknown view is rewritten
  }, [rawView]);
  return {
    view,
    date,
    setView: (v: DailyBankView) => setParam({ view: v }),
    setDate: (d: string) => setParam({ date: d === todayMyt() ? null : d }),
  };
}

function DailyBankFrame({ book, nav, q }: { book: Book; nav: ReturnType<typeof useDailyBankAddress>; q: UseQueryResult<DailyBankBoard> }) {
  const { view, date, setView, setDate } = nav;
  const [focus, setFocus] = useState<string | null>(null);
  const board = q.data ?? null;
  const [printing, setPrinting] = useState(false);
  const [imaging, setImaging] = useState(false);
  const future = date > todayMyt();
  const boardView = view === 'board' || view === 'accounts';

  return (
    <div className={css.page}>
      <PageHeader eyebrow="Finance · Bank & cards" title={book === 'cashbook' ? 'Daily Bank (cash book)' : 'Daily Bank'} />

      <div className={css.topBar}>
        <span className={css.segmented} role="group" aria-label="View">
          {VIEWS[book].map(([v, label]) => (
            <button key={v} type="button" className={view === v ? css.segOn : ''} aria-pressed={view === v} onClick={() => setView(v)}>{label}</button>
          ))}
        </span>
        <span className={css.dayNav}>
          <button type="button" className={css.navButton} onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day"><ChevronLeft {...ICON} /></button>
          <DateField value={date} onChange={(iso) => { if (iso) setDate(iso); }} aria-label="Day" />
          <button type="button" className={css.navButton} onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day"><ChevronRight {...ICON} /></button>
          <button type="button" className={css.navButton} onClick={() => setDate(todayMyt())}><Calendar {...ICON} /> Today</button>
        </span>
        <span className={css.grow} />
        <button type="button" className={css.navButton} onClick={() => setPrinting(true)} disabled={view !== 'close' && !board}
          title={view === 'close' ? 'Print the count sheet' : 'Print the day: every account with its movements'}><Printer {...ICON} /> Print</button>
        {view !== 'close' && !future && (
          <button type="button" className={css.solidButton} onClick={() => setImaging(true)} disabled={!board}
            title="A picture of the day's bank balances for WhatsApp"><ImageDown {...ICON} /> Export image</button>
        )}
      </div>

      {view === 'close' && <DailyBankClose date={date} today={todayMyt()} />}
      {view === 'entries' && <DailyBankCashbook date={date} today={todayMyt()} />}

      {boardView && q.isLoading && <div className={css.muted}>Loading the board…</div>}
      {boardView && q.isError && <div role="alert" className={css.problem}>The board could not be loaded — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</div>}

      {view === 'board' && board && (
        <DailyBankBoardView board={board} onOpenAccount={(code) => { setFocus(code); setView('accounts'); }}
          cashbook={book === 'cashbook' ? { onOpenEntries: () => setView('entries') } : null} />
      )}

      {view === 'accounts' && board && <DailyBankAccounts board={board} focus={focus} future={future} />}

      {printing && <DailyBankPrintModal kind={view === 'close' ? 'close' : 'bank'} board={board} date={date} today={todayMyt()} onClose={() => setPrinting(false)} />}
      {imaging && board && <DailyBankImageModal board={board} onClose={() => setImaging(false)} />}
    </div>
  );
}

/** The original Daily Bank, from the ledger. */
export const DailyBank = () => {
  const nav = useDailyBankAddress('ledger');
  const q = useDailyBank(nav.date);
  return <DailyBankFrame book="ledger" nav={nav} q={q} />;
};

/** The owner's cash book, a second Daily Bank beside the original (2026-11-23). */
export const DailyBankCashbookPage = () => {
  const nav = useDailyBankAddress('cashbook');
  const q = useDailyBankCashbookBoard(nav.date);
  return <DailyBankFrame book="cashbook" nav={nav} q={q} />;
};
