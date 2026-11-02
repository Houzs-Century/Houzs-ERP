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
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Calendar, ChevronLeft, ChevronRight, ImageDown, Printer } from 'lucide-react';
import { useDailyBank, useDailyClose, useSaveDailyClose, useConfirmDailyClose } from './accounting-phase1-queries';
import { fmtSen, fmtSenPlain } from '../../vendor/shared/format';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';
import { DateField } from "../../vendor/scm/components/DateField";
import { DailyBankBoardView } from './DailyBankBoard';
import { DailyBankAccounts } from './DailyBankAccounts';
import { DailyBankClose } from './DailyBankClose';
import { DailyBankImageModal, DailyBankPrintModal } from './DailyBankPrint';
import css from './DailyBank.module.css';

const fmt = (sen: number | null | undefined) => fmtSen(sen);
const ICON = { size: 16, strokeWidth: 1.75 } as const;

const todayLocal = (): string => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

const shiftDate = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

const btnStyle = (primary?: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 14px',
  border: '1px solid var(--c-ink)',
  borderRadius: 'var(--radius-md)',
  background: primary ? 'var(--c-ink)' : 'transparent',
  color: primary ? 'var(--c-cream)' : 'var(--c-ink)',
  fontSize: 'var(--fs-13)',
  fontWeight: 600,
  cursor: 'pointer',
});

type DailyBankView = 'board' | 'accounts' | 'close';
const VIEWS: Array<[DailyBankView, string]> = [['board', 'Board'], ['accounts', 'Accounts'], ['close', 'Daily close']];
const isDay = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

export const DailyBank = () => {
  /* Board / Accounts / Daily close and the day live in the address (the redesign:
     Money today opens the Board and stays lit while it shows). */
  const [params, setParams] = useSearchParams();
  const rawView = params.get('view');
  const view: DailyBankView = rawView === 'accounts' || rawView === 'close' ? rawView : 'board';
  const dayParam = params.get('date');
  const date = isDay(dayParam) ? dayParam : todayLocal();
  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v == null) next.delete(k); else next.set(k, v); }
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if (rawView !== 'board' && rawView !== 'accounts' && rawView !== 'close') setParam({ view: 'board' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a missing or unknown view is rewritten
  }, [rawView]);
  const setView = (v: DailyBankView) => setParam({ view: v });
  const setDate = (d: string) => setParam({ date: d === todayLocal() ? null : d });
  const [focus, setFocus] = useState<string | null>(null);

  const q = useDailyBank(date);
  const board = q.data ?? null;
  /* Print opens the day's sheet (or the count sheet); Export image its picture. */
  const [printing, setPrinting] = useState(false);
  const [imaging, setImaging] = useState(false);
  const future = date > todayLocal();

  return (
    <div className={css.page}>
      <PageHeader eyebrow="Finance · Bank & cards" title="Daily Bank" />

      <div className={css.topBar}>
        <span className={css.segmented} role="group" aria-label="View">
          {VIEWS.map(([v, label]) => (
            <button key={v} type="button" className={view === v ? css.segOn : ''} aria-pressed={view === v} onClick={() => setView(v)}>{label}</button>
          ))}
        </span>
        <span className={css.dayNav}>
          <button type="button" className={css.navButton} onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day"><ChevronLeft {...ICON} /></button>
          <DateField value={date} onChange={(iso) => { if (iso) setDate(iso); }} aria-label="Day" />
          <button type="button" className={css.navButton} onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day"><ChevronRight {...ICON} /></button>
          <button type="button" className={css.navButton} onClick={() => setDate(todayLocal())}><Calendar {...ICON} /> Today</button>
        </span>
        <span className={css.grow} />
        <button type="button" className={css.navButton} onClick={() => setPrinting(true)} disabled={view !== 'close' && !board}
          title={view === 'close' ? 'Print the count sheet' : 'Print the day: every account with its movements'}><Printer {...ICON} /> Print</button>
        {view !== 'close' && !future && (
          <button type="button" className={css.solidButton} onClick={() => setImaging(true)} disabled={!board}
            title="A picture of the day's bank balances for WhatsApp"><ImageDown {...ICON} /> Export image</button>
        )}
      </div>

      {view === 'close' && <DailyBankClose date={date} today={todayLocal()} />}

      {view !== 'close' && q.isLoading && <div className={css.muted}>Loading the board…</div>}
      {view !== 'close' && q.isError && <div role="alert" className={css.problem}>The board could not be loaded — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</div>}

      {view === 'board' && board && (
        <DailyBankBoardView board={board} onOpenAccount={(code) => { setFocus(code); setView('accounts'); }} />
      )}

      {view === 'accounts' && board && <DailyBankAccounts board={board} focus={focus} future={future} />}

      {printing && <DailyBankPrintModal kind={view === 'close' ? 'close' : 'bank'} board={board} date={date} today={todayLocal()} onClose={() => setPrinting(false)} />}
      {imaging && board && <DailyBankImageModal board={board} onClose={() => setImaging(false)} />}
    </div>
  );
};
