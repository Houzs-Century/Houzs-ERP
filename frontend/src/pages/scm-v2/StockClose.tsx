// ----------------------------------------------------------------------------
// Stock close — Books › Stock close in the owner's redesign (batch 6 §3,
// Finance-1a-Books-checks): the month-end stock close's visible half (GL
// redesign item 4). The close runs itself every night at 00:05 MYT; this
// screen is the owner's window into it (他的原话: 我有没有办法可以看到你每天检查的
// 成果): the stock now with its five closing stocks (customer, display,
// service, showroom, others — owner 2026-09-30; question g5), every month the
// close has booked and until when it is re-checked, and every run of the last
// 90 days — the quiet "no change" ones included — with Run now for the
// impatient path (any month, as today). Running it never locks a month.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { DataTable, type Column } from '../../components/DataTable';
import { monthEnd, monthStart } from '../../lib/dateRangePresets';
import { fmtDate, fmtDateTime, fmtSen, todayMY } from '../../vendor/shared/format';
import { fmtLedger } from '../../vendor/scm/lib/ledger-queries';
import {
  useRunStockClose, useStockClose, type ClosedStockMonth, type StockBucketValues, type StockCloseRun,
} from './accounting-phase1-queries';
import { AccountingHeader } from './books/AccountingHeader';
import { useBooksToast } from './books/BooksToast';
import tokens from './finance/finance-ui.module.css';
import b from './books/Books.module.css';
import s from './books/StockClose.module.css';

/** The five closing stocks, in account order (-0001 … -0005), as the screen names them. */
const BUCKETS: ReadonlyArray<{ bucket: keyof StockBucketValues; name: string; short: string; swatch: string }> = [
  { bucket: 'customer', name: 'Customer stock', short: 'Customer', swatch: s.customer },
  { bucket: 'display', name: 'Display stock', short: 'Display', swatch: s.display },
  { bucket: 'service', name: 'Service stock', short: 'Service', swatch: s.service },
  { bucket: 'showroom', name: 'Showroom stock', short: 'Showroom', swatch: s.showroom },
  { bucket: 'others', name: 'Other stock', short: 'Others', swatch: s.others },
];

const OTHER_MONTH = 'other';

/** "2026-09" → "September 2026" (a month, not a date). */
export const monthName = (ym: string): string =>
  (/^\d{4}-\d{2}$/.test(ym)
    ? new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : ym);

/** What a run did, as its tag says it. */
export function resultTag(action: string): { label: string; tone: string } {
  switch (action) {
    case 'posted': return { label: 'Posted', tone: b.toneInfo };
    case 'reposted': return { label: 'Re-posted', tone: b.toneWarn };
    case 'failed': return { label: 'Failed', tone: b.toneLate };
    default: return { label: 'No change', tone: b.toneCalm };
  }
}

/** Until when the nightly run re-checks a month: it re-checks the last two closed months, so through the end of M+2. */
export function recheck(month: string, today: string): { label: string; tone: string } {
  const until = monthEnd(`${month}-01`, 2);
  return until >= today ? { label: `Until ${fmtDate(until)}`, tone: b.toneInfo } : { label: `Ended ${fmtDate(until)}`, tone: b.toneCalm };
}

/** Whole-number shares of the positive values that add up to 100 (largest remainder); all 0 when nothing is positive. */
export function wholeShares(values: readonly number[]): number[] {
  const pos = values.map((v) => Math.max(0, v));
  const total = pos.reduce((t, v) => t + v, 0);
  if (total <= 0) return values.map(() => 0);
  const raw = pos.map((v) => (v / total) * 100);
  const out = raw.map((r) => Math.floor(r));
  let left = 100 - out.reduce((t, v) => t + v, 0);
  const byRemainder = raw.map((r, i) => ({ i, rest: r - Math.floor(r) })).sort((x, y) => y.rest - x.rest || x.i - y.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left -= 1;
  }
  return out;
}

const Tag = ({ t }: { t: { label: string; tone: string } }) => <span className={`${b.tag} ${t.tone}`}>{t.label}</span>;

type RunFilter = 'all' | 'changes' | 'failed';
const isChange = (r: StockCloseRun): boolean => r.action === 'posted' || r.action === 'reposted';

export const StockCloseTab = () => {
  const q = useStockClose();
  const runClose = useRunStockClose();
  const toast = useBooksToast();
  const [picked, setPicked] = useState('');
  const [other, setOther] = useState('');
  const [filter, setFilter] = useState<RunFilter>('all');
  const today = todayMY();

  const data = q.data;
  const runs = useMemo(() => data?.runs ?? [], [data]);
  const months = useMemo(() => data?.months ?? [], [data]);

  /* The months the select offers: the two the nightly run re-checks, then every month with a run, then any other. */
  const monthOptions = useMemo(() => {
    const sweep = data?.sweepMonths ?? (data ? [data.defaultMonth] : []);
    const seen = new Set(sweep);
    const rest = [...new Set([...runs.map((r) => r.month), ...months.map((m) => m.month)])]
      .filter((m) => !seen.has(m)).sort((x, y) => y.localeCompare(x));
    return [...sweep, ...rest];
  }, [data, runs, months]);
  const selected = picked || data?.defaultMonth || '';
  const month = selected === OTHER_MONTH ? other : selected;

  const run = () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    runClose.mutate({ month }, {
      onSuccess: (r) => {
        const word = resultTag(r.outcome.action).label.toLowerCase();
        toast.say(`${monthName(month)} checked · ${word}${r.outcome.valueSen != null ? ` · ${fmtSen(r.outcome.valueSen)}` : ''}`);
      },
    });
  };

  const last = runs.at(0);
  const description = last
    ? `Every night at 00:05 it re-checks the last two months · last run ${fmtDateTime(last.ran_at)}${last.trigger === 'manual' ? ' by hand' : ''} · ${resultTag(last.action).label.toLowerCase()}`
    : 'Every night at 00:05 it re-checks the last two months';

  const actions = (
    <div className={s.headTools}>
      <span className={b.selectWrap}>
        <select className={b.select} aria-label="Close month" value={selected} onChange={(e) => setPicked(e.target.value)}>
          {monthOptions.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          <option value={OTHER_MONTH}>Other month…</option>
        </select>
        <ChevronDown size={12} className={b.selectChevron} aria-hidden />
      </span>
      {selected === OTHER_MONTH && (
        <input type="month" className={s.monthInput} aria-label="Other month" value={other} onChange={(e) => setOther(e.target.value)} />
      )}
      <button type="button" className={b.btnSolid} disabled={runClose.isPending || !/^\d{4}-\d{2}$/.test(month)} onClick={run}
        title="Re-checks the month now instead of waiting for tonight: no change if nothing moved, a re-post (contra + new entry) if something did, the first close if the month was never booked.">
        <RefreshCw size={14} aria-hidden />{runClose.isPending ? 'Running…' : 'Run now'}
      </button>
    </div>
  );

  /* Stock now: the live value, split by bucket on a share bar. */
  const live = data?.liveBuckets ?? null;
  const positive = live ? BUCKETS.reduce((t, x) => t + Math.max(0, live[x.bucket]), 0) : 0;
  const shares = live ? wholeShares(BUCKETS.map((x) => live[x.bucket])) : [];
  const thisMonth = today.slice(0, 7);
  const nowNote = `${monthName(thisMonth).split(' ')[0]} is booked on ${fmtDate(monthStart(`${thisMonth}-01`, 1))} at 00:05 and re-checked every night until ${fmtDate(monthEnd(`${thisMonth}-01`, 2))}`;

  /* A bucket nothing was ever booked on stays out of the table until asked for. */
  const emptyBucket = (k: keyof StockBucketValues): boolean => months.every((m) => m.buckets[k] === 0);
  const monthCols: Column<ClosedStockMonth>[] = [
    { key: 'month', label: 'Month', getValue: (m) => m.month, render: (m) => monthName(m.month) },
    ...BUCKETS.map((x): Column<ClosedStockMonth> => ({
      key: `${x.bucket}_value`, label: x.short, align: 'right', defaultHidden: emptyBucket(x.bucket),
      getValue: (m) => m.buckets[x.bucket] / 100, exportValue: (m) => m.buckets[x.bucket] / 100, exportFormat: 'money',
      render: (m) => <span className={b.muted}>{fmtLedger(m.buckets[x.bucket])}</span>,
    })),
    {
      key: 'closing_total', label: 'Closing stock', align: 'right', getValue: (m) => m.totalSen / 100, exportValue: (m) => m.totalSen / 100, exportFormat: 'money',
      render: (m) => <span className={b.strong}>{fmtLedger(m.totalSen)}</span>,
    },
    {
      key: 'posted_date', label: 'Booked', getValue: (m) => m.bookedOn ?? '',
      render: (m) => <span className={b.muted}>{m.action === 'reposted' ? 'Re-posted' : 'Posted'}{m.bookedOn ? ` ${fmtDate(m.bookedOn)}` : ''}</span>,
    },
    { key: 'je_no', label: 'Entry', getValue: (m) => m.jeNo, render: (m) => <span title={m.revJeNo ? `Opening ${m.revJeNo}` : undefined}>{m.jeNo}</span> },
    { key: 'recheck_date', label: 'Nightly re-check', getValue: (m) => recheck(m.month, today).label, render: (m) => <Tag t={recheck(m.month, today)} /> },
  ];

  const nChanges = runs.filter(isChange).length;
  const nFailed = runs.filter((r) => r.action === 'failed').length;
  const shownRuns = filter === 'changes' ? runs.filter(isChange) : filter === 'failed' ? runs.filter((r) => r.action === 'failed') : runs;
  const runCols: Column<StockCloseRun>[] = [
    { key: 'ran_date', label: 'Checked at', getValue: (r) => String(r.ran_at), render: (r) => <span className={b.muted}>{fmtDateTime(r.ran_at)}</span> },
    { key: 'by', label: 'By', getValue: (r) => (r.trigger === 'manual' ? 'By hand' : 'Nightly'), render: (r) => (r.trigger === 'manual' ? 'By hand' : 'Nightly') },
    { key: 'month', label: 'Month', getValue: (r) => r.month, render: (r) => monthName(r.month) },
    {
      key: 'value', label: 'Stock value', align: 'right', getValue: (r) => r.stock_value_sen / 100, exportValue: (r) => r.stock_value_sen / 100, exportFormat: 'money',
      render: (r) => (r.action === 'failed' && r.stock_value_sen === 0 ? '—' : fmtLedger(r.stock_value_sen)),
    },
    { key: 'result', label: 'Result', getValue: (r) => resultTag(r.action).label, render: (r) => <Tag t={resultTag(r.action)} /> },
    {
      key: 'entries', label: 'Entries', getValue: (r) => [r.je_no, r.rev_je_no].filter(Boolean).join(' · '),
      render: (r) => (r.je_no ? `${r.je_no}${r.rev_je_no ? ` · reversal ${r.rev_je_no}` : ''}` : '—'),
    },
    { key: 'note', label: 'Note', getValue: (r) => r.note ?? '', render: (r) => <span className={b.muted}>{r.note ?? ''}</span> },
  ];
  const seg = (id: RunFilter, label: string, n: number) => (
    <button key={id} type="button" className={`${b.segBtn} ${filter === id ? b.segOn : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>
      {label}<span className={b.segCount}>{n}</span>
    </button>
  );

  return (
    <div className={`${tokens.root} ${b.page}`}>
      <AccountingHeader tab="close" description={description} actions={actions} />
      {runClose.isError && (
        <div className={b.problem}>{String((runClose.error as { message?: string } | null)?.message ?? 'The run failed.')}</div>
      )}
      {q.isError && <div className={b.problem}>The stock close did not load — refresh to retry.</div>}
      {q.isLoading && (
        <div className={`${s.card} ${b.skeleton}`} aria-label="Loading the stock close">
          {[0, 1, 2].map((i) => <div key={i} className={b.skeletonBar} style={{ width: `${88 - i * 14}%` }} />)}
        </div>
      )}
      {data && (
        <>
          <section className={`${s.card} ${s.now}`} aria-label="Stock now">
            <div>
              <div className={s.nowLabel}>Stock now · {fmtDate(today)}</div>
              <div className={s.nowTotal}>{fmtSen(data.liveValueSen)}</div>
              <div className={s.nowNote}>{nowNote}</div>
            </div>
            {live && (
              <div className={s.split}>
                <div className={s.bar} aria-hidden>
                  {BUCKETS.filter((x) => live[x.bucket] > 0).map((x) => (
                    <span key={x.bucket} className={`${s.barPart} ${x.swatch}`} style={{ width: `${(live[x.bucket] / (positive || 1)) * 100}%` }} />
                  ))}
                </div>
                <div className={s.legend}>
                  {BUCKETS.map((x, i) => (
                    <div key={x.bucket} style={{ minWidth: 0 }}>
                      <div className={s.legendName}>
                        <span className={`${s.swatch} ${x.swatch}`} />{x.name}
                        <span className={s.share}>{positive > 0 ? `${shares[i] ?? 0}%` : '—'}</span>
                      </div>
                      <div className={s.legendAmount}>{fmtSen(live[x.bucket])}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className={s.card} aria-label="Closed months">
            <div className={s.cardHead}><span className={s.cardTitle}>Closed months</span></div>
            <div className={s.cardBody}>
              <DataTable<ClosedStockMonth>
                tableId="stock-close-months" exportName="stock-close-months" exportXlsx freezeHeight="off"
                columns={monthCols} rows={months} getRowKey={(m) => m.month}
                emptyLabel="No month has been booked by the close yet."
              />
            </div>
          </section>

          <section className={s.card} aria-label="Every run">
            <div className={s.cardHead}>
              <span className={s.cardTitle}>Every run</span>
              <span className={s.cardSub}>Last 90 days</span>
              <span className={b.grow} />
              <span className={b.seg} role="group" aria-label="Runs">
                {seg('all', 'Every run', runs.length)}
                {seg('changes', 'Changes', nChanges)}
                {seg('failed', 'Failed', nFailed)}
              </span>
            </div>
            <div className={s.cardBody}>
              <DataTable<StockCloseRun>
                tableId="stock-close-runs" exportName="stock-close-runs" exportXlsx freezeHeight="off"
                columns={runCols} rows={shownRuns} getRowKey={(r) => `${r.month}-${r.ran_at}-${r.action}-${r.trigger}`}
                emptyLabel="No run matches."
              />
            </div>
          </section>
        </>
      )}
      {toast.node}
    </div>
  );
};
