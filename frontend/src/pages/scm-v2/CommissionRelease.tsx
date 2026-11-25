// ----------------------------------------------------------------------------
// Commission release — Books › Commission release (owner 2026-11-25). The
// commission bills sit on PREPAYMENT COMMISSION (salespeople are paid in full
// when the order is taken); every night at 00:05 the release books each month
// that has ended: the part of each bill whose orders became net sales (sales
// invoices plus deposit invoices, less the credit notes that contra them) moves
// to the commission expense. This screen is the window into it: what the
// prepayment holds bill by bill and how each is split over its orders, what
// every month releases against what is booked, one bill's orders, every run —
// and the company's switch. Off, it shows what it would book and books nothing.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Power, RefreshCw, X } from 'lucide-react';
import { DataTable, type Column } from '../../components/DataTable';
import { fmtDate, fmtDateTime, fmtSen } from '../../vendor/shared/format';
import { fmtLedger } from '../../vendor/scm/lib/ledger-queries';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import {
  useCommissionRelease, useCommissionReleaseOrders, useCommissionReleaseSwitch, useRunCommissionRelease,
  type CommissionReleaseStatus, type LayerOrder, type ReleaseLayer, type ReleaseMonth, type ReleaseRun,
} from './commission-release-queries';
import { monthName } from './StockClose';
import { AccountingHeader } from './books/AccountingHeader';
import { useBooksToast } from './books/BooksToast';
import tokens from './finance/finance-ui.module.css';
import b from './books/Books.module.css';
import s from './books/StockClose.module.css';

/** "2026-10" → "Oct 2026 bill"; the opening as the books call it. */
export const layerName = (l: Pick<ReleaseLayer, 'key' | 'month'>): string =>
  l.key === 'opening' || l.month == null ? 'Opening balance' : `${monthName(l.month)} bill`;

/** How a bill is split over its orders, as the Split by column says it. */
const BASIS: Record<ReleaseLayer['basis'], string> = {
  close: 'Event Commission close',
  goods: 'Goods of the orders',
  none: 'Nothing carries it',
};

/** The month after a YYYY-MM month, as the day the nightly run books it. */
const bookedOnDay = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
};

type MonthRow = ReleaseMonth & { bookedSen: number | null; jeNo: string | null; reposted: boolean };

/** What a month's row says: booked as worked out, waiting, or due to change tonight. */
export function monthState(r: MonthRow, data: Pick<CommissionReleaseStatus, 'on' | 'currentMonth'>): { label: string; tone: string } {
  if (r.month >= data.currentMonth) return { label: `Books on ${fmtDate(bookedOnDay(r.month))}`, tone: b.toneInfo };
  if (r.bookedSen == null) {
    if (r.totalSen === 0) return { label: 'Nothing to release', tone: b.toneCalm };
    return data.on ? { label: 'Books tonight', tone: b.toneWarn } : { label: 'Not booked — release is off', tone: b.toneCalm };
  }
  if (r.bookedSen !== r.totalSen) return data.on ? { label: 'Changes tonight', tone: b.toneWarn } : { label: 'Differs — release is off', tone: b.toneLate };
  return { label: r.reposted ? 'Booked (re-posted)' : 'Booked', tone: b.toneCalm };
}

export function runTag(action: ReleaseRun['action']): { label: string; tone: string } {
  switch (action) {
    case 'posted': return { label: 'Posted', tone: b.toneInfo };
    case 'reposted': return { label: 'Re-posted', tone: b.toneWarn };
    case 'cleared': return { label: 'Cleared', tone: b.toneWarn };
    case 'failed': return { label: 'Failed', tone: b.toneLate };
    default: return { label: 'No change', tone: b.toneCalm };
  }
}

const Tag = ({ t }: { t: { label: string; tone: string } }) => <span className={`${b.tag} ${t.tone}`}>{t.label}</span>;
const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;
const sum = <T,>(rows: T[], f: (r: T) => number): number => rows.reduce((t, r) => t + f(r), 0);

type RunFilter = 'all' | 'changes' | 'failed';
const isChange = (r: ReleaseRun): boolean => r.action === 'posted' || r.action === 'reposted' || r.action === 'cleared';

export const CommissionReleaseTab = () => {
  const q = useCommissionRelease();
  const run = useRunCommissionRelease();
  const toggle = useCommissionReleaseSwitch();
  const confirm = useConfirm();
  const toast = useBooksToast();
  const [layer, setLayer] = useState<string | null>(null);
  const [filter, setFilter] = useState<RunFilter>('all');
  const orders = useCommissionReleaseOrders(layer);

  const data = q.data;
  const layers = useMemo(() => data?.layers ?? [], [data]);
  const runs = useMemo(() => data?.runs ?? [], [data]);
  const nameOf = useMemo(() => new Map(layers.map((l) => [l.key, layerName(l)])), [layers]);
  const monthRows: MonthRow[] = useMemo(() => {
    const posted = new Map((data?.posted ?? []).map((p) => [p.month, p]));
    return (data?.months ?? []).map((m) => {
      const p = posted.get(m.month);
      return { ...m, bookedSen: p ? p.releasedSen : null, jeNo: p?.jeNo ?? null, reposted: p?.reposted ?? false };
    });
  }, [data]);

  const expense = data ? `${data.accounts.expense.code}${data.accounts.expense.name ? ` ${data.accounts.expense.name}` : ''}` : '';
  const prepaid = data ? `${data.accounts.prepaid.code}${data.accounts.prepaid.name ? ` ${data.accounts.prepaid.name}` : ''}` : '';
  const due = monthRows.filter((m) => data && m.month < data.currentMonth && m.totalSen !== 0);

  const turnOn = async () => {
    if (!data) return;
    const lines = due.map((m) => `${monthName(m.month)}: ${fmtLedger(m.totalSen)}`).join('\n');
    const ok = await confirm({
      title: 'Turn on the monthly commission release?',
      body: `It books these months now, each on the month's last day — Dr ${expense} / Cr ${prepaid}:\n${lines || 'nothing yet'}\n\nFrom then on, every night at 00:05 it books the month that has ended and re-books an earlier month whose figure moved (a bill booked late, an invoice keyed back).`,
      confirmLabel: 'Turn on and book',
    });
    if (!ok) return;
    toggle.mutate(true, { onSuccess: (r) => toast.say(`Release on · ${r.outcomes.filter((o) => o.action === 'posted' || o.action === 'reposted').length} month(s) booked`) });
  };
  const turnOff = async () => {
    const ok = await confirm({
      title: 'Turn the monthly release off?',
      body: 'What is booked stays booked. Nothing new is booked, and a month whose figure moves is not re-booked, until it is turned on again.',
      confirmLabel: 'Turn off',
      danger: true,
    });
    if (ok) toggle.mutate(false, { onSuccess: () => toast.say('Release off') });
  };
  const runNow = () => run.mutate(undefined, {
    onSuccess: (r) => {
      const moved = r.outcomes.filter((o) => o.action !== 'unchanged').length;
      toast.say(moved > 0 ? `Checked · ${moved} month(s) changed` : 'Checked · no change');
    },
  });

  const last = runs.at(0);
  const description = !data
    ? undefined
    : data.on
      ? `On · every night at 00:05 it books the month that has ended${last ? ` · last run ${fmtDateTime(last.ran_at)}${last.trigger === 'manual' ? ' by hand' : ''}` : ''}`
      : 'Off · nothing is booked — below is what it would book';

  const actions = data && (
    <div className={s.headTools}>
      {data.on ? (
        <>
          <button type="button" className={b.btn} disabled={toggle.isPending} onClick={() => void turnOff()}>
            <Power size={14} aria-hidden />Turn off
          </button>
          <button type="button" className={b.btnSolid} disabled={run.isPending} onClick={runNow}
            title="Works every month out again now instead of waiting for tonight: no change if nothing moved, a re-post (contra + new entry) if something did.">
            <RefreshCw size={14} aria-hidden />{run.isPending ? 'Running…' : 'Run now'}
          </button>
        </>
      ) : (
        <button type="button" className={b.btnSolid} disabled={toggle.isPending || layers.length === 0} onClick={() => void turnOn()}>
          <Power size={14} aria-hidden />{toggle.isPending ? 'Turning on…' : 'Turn on'}
        </button>
      )}
    </div>
  );

  const heldSen = sum(layers, (l) => l.amountSen);
  const releasedSen = sum(layers, (l) => l.releasedSen);
  const bookedSen = sum(data?.posted ?? [], (p) => p.releasedSen);
  const layerCols: Column<ReleaseLayer>[] = [
    { key: 'bill_month', label: 'Bill month', getValue: (l) => layerName(l), render: (l) => <span className={b.strong}>{layerName(l)}</span>, total: () => 'Total' },
    { key: 'doc_nos', label: 'Documents', getValue: (l) => l.docs.join(', '), render: (l) => <span className={b.muted}>{l.docs.join(', ')}</span> },
    {
      key: 'amount', label: 'Amount', align: 'right', getValue: (l) => l.amountSen / 100, exportValue: (l) => l.amountSen / 100, exportFormat: 'money',
      render: (l) => fmtLedger(l.amountSen), total: (rows) => fmtLedger(sum(rows, (r) => r.amountSen)),
    },
    { key: 'share_source', label: 'Shares from', getValue: (l) => BASIS[l.basis], render: (l) => <span className={b.muted}>{BASIS[l.basis]}</span> },
    { key: 'orders_qty', label: 'Orders', align: 'right', getValue: (l) => l.orders, render: (l) => l.orders.toLocaleString('en-MY') },
    {
      key: 'released_amount', label: 'Released to date', align: 'right', getValue: (l) => l.releasedSen / 100, exportValue: (l) => l.releasedSen / 100, exportFormat: 'money',
      render: (l) => fmtLedger(l.releasedSen), total: (rows) => fmtLedger(sum(rows, (r) => r.releasedSen)),
    },
    {
      key: 'left_amount', label: 'Left in prepayment', align: 'right', getValue: (l) => l.leftSen / 100, exportValue: (l) => l.leftSen / 100, exportFormat: 'money',
      render: (l) => <span className={b.strong}>{fmtLedger(l.leftSen)}</span>, total: (rows) => fmtLedger(sum(rows, (r) => r.leftSen)),
    },
    { key: 'note', label: 'Note', getValue: (l) => l.note ?? '', render: (l) => <span className={b.muted}>{l.note ?? ''}</span> },
  ];

  const monthCols: Column<MonthRow>[] = [
    { key: 'month', label: 'Month', getValue: (m) => m.month, render: (m) => <span className={b.strong}>{monthName(m.month)}</span> },
    {
      key: 'release_amount', label: 'Release', align: 'right', getValue: (m) => m.totalSen / 100, exportValue: (m) => m.totalSen / 100, exportFormat: 'money',
      render: (m) => fmtLedger(m.totalSen), total: (rows) => fmtLedger(sum(rows, (r) => r.totalSen)),
    },
    {
      key: 'made_of_lines', label: 'Made of', getValue: (m) => m.parts.map((p) => `${nameOf.get(p.key) ?? p.key} ${fmtLedger(p.sen)}`).join(' · '),
      render: (m) => <span className={b.muted}>{m.parts.map((p) => `${nameOf.get(p.key) ?? p.key} ${fmtLedger(p.sen)}`).join(' · ') || '—'}</span>,
    },
    {
      key: 'booked_amount', label: 'Booked', align: 'right', getValue: (m) => (m.bookedSen == null ? '' : m.bookedSen / 100), exportValue: (m) => (m.bookedSen == null ? null : m.bookedSen / 100), exportFormat: 'money',
      render: (m) => (m.bookedSen == null ? '—' : fmtLedger(m.bookedSen)), total: (rows) => fmtLedger(sum(rows, (r) => r.bookedSen ?? 0)),
    },
    { key: 'je_no', label: 'Entry', getValue: (m) => m.jeNo ?? '', render: (m) => m.jeNo ?? '—' },
    { key: 'month_status', label: 'Status', getValue: (m) => (data ? monthState(m, data).label : ''), render: (m) => (data ? <Tag t={monthState(m, data)} /> : null) },
  ];

  const orderCols: Column<LayerOrder>[] = [
    { key: 'so_doc_no', label: 'SO number', getValue: (o) => o.docNo, render: (o) => <span className={b.strong}>{o.docNo}</span> },
    { key: 'so_date', label: 'SO date', getValue: (o) => o.soDate ?? '', render: (o) => (o.soDate ? fmtDate(o.soDate) : '—') },
    { key: 'status', label: 'Status', getValue: (o) => o.status, render: (o) => <span className={b.muted}>{o.status}</span> },
    { key: 'total', label: 'Order total', align: 'right', getValue: (o) => o.totalSen / 100, exportValue: (o) => o.totalSen / 100, exportFormat: 'money', render: (o) => fmtLedger(o.totalSen) },
    {
      key: 'share', label: 'Commission share', align: 'right', getValue: (o) => o.shareSen / 100, exportValue: (o) => o.shareSen / 100, exportFormat: 'money',
      render: (o) => fmtLedger(o.shareSen), total: (rows) => fmtLedger(sum(rows, (r) => r.shareSen)),
    },
    { key: 'invoiced_pct', label: 'Invoiced', align: 'right', getValue: (o) => o.sold, render: (o) => pct(o.sold) },
    {
      key: 'released_amount', label: 'Released', align: 'right', getValue: (o) => o.releasedSen / 100, exportValue: (o) => o.releasedSen / 100, exportFormat: 'money',
      render: (o) => fmtLedger(o.releasedSen), total: (rows) => fmtLedger(sum(rows, (r) => r.releasedSen)),
    },
    {
      key: 'left_amount', label: 'Left', align: 'right', getValue: (o) => o.leftSen / 100, exportValue: (o) => o.leftSen / 100, exportFormat: 'money',
      render: (o) => fmtLedger(o.leftSen), total: (rows) => fmtLedger(sum(rows, (r) => r.leftSen)),
    },
  ];

  const nChanges = runs.filter(isChange).length;
  const nFailed = runs.filter((r) => r.action === 'failed').length;
  const shownRuns = filter === 'changes' ? runs.filter(isChange) : filter === 'failed' ? runs.filter((r) => r.action === 'failed') : runs;
  const runCols: Column<ReleaseRun>[] = [
    { key: 'ran_date', label: 'Checked at', getValue: (r) => String(r.ran_at), render: (r) => <span className={b.muted}>{fmtDateTime(r.ran_at)}</span> },
    { key: 'by', label: 'By', getValue: (r) => (r.trigger === 'manual' ? 'By hand' : 'Nightly'), render: (r) => (r.trigger === 'manual' ? 'By hand' : 'Nightly') },
    { key: 'month', label: 'Month', getValue: (r) => String(r.month).slice(0, 7), render: (r) => monthName(String(r.month).slice(0, 7)) },
    {
      key: 'release_amount', label: 'Release', align: 'right', getValue: (r) => r.released_sen / 100, exportValue: (r) => r.released_sen / 100, exportFormat: 'money',
      render: (r) => fmtLedger(r.released_sen),
    },
    { key: 'result', label: 'Result', getValue: (r) => runTag(r.action).label, render: (r) => <Tag t={runTag(r.action)} /> },
    { key: 'je_no', label: 'Entry', getValue: (r) => r.je_no ?? '', render: (r) => r.je_no ?? '—' },
    { key: 'note', label: 'Note', getValue: (r) => r.note ?? '', render: (r) => <span className={b.muted}>{r.note ?? ''}</span> },
  ];
  const seg = (id: RunFilter, label: string, n: number) => (
    <button key={id} type="button" className={`${b.segBtn} ${filter === id ? b.segOn : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>
      {label}<span className={b.segCount}>{n}</span>
    </button>
  );
  const picked = layers.find((l) => l.key === layer) ?? null;
  const guessed = (data?.prepaid ?? []).filter((p) => p.monthGuessed);

  return (
    <div className={`${tokens.root} ${b.page}`}>
      <AccountingHeader tab="commrel" description={description} actions={actions || undefined} />
      {(run.isError || toggle.isError) && (
        <div className={b.problem}>{String(((run.error ?? toggle.error) as { message?: string } | null)?.message ?? 'The run failed.')}</div>
      )}
      {q.isError && <div className={b.problem}>The commission release did not load — refresh to retry.</div>}
      {q.isLoading && (
        <div className={`${s.card} ${b.skeleton}`} aria-label="Loading the commission release">
          {[0, 1, 2].map((i) => <div key={i} className={b.skeletonBar} style={{ width: `${88 - i * 14}%` }} />)}
        </div>
      )}
      {data && (
        <>
          <section className={`${s.card} ${s.now}`} aria-label="Prepayment now">
            <div>
              <div className={s.nowLabel}>Commission bills on {prepaid}</div>
              <div className={s.nowTotal}>{fmtSen(heldSen)}</div>
              <div className={s.nowNote}>Released to {expense}</div>
            </div>
            <div className={s.split}>
              <div className={s.legend}>
                {([
                  ['Released to date', releasedSen, 'what the orders sold so far release, this month included'],
                  ['Booked', bookedSen, 'the entries of the months that have ended'],
                  ['Left on the prepayment', heldSen - releasedSen, 'the share of orders not sold yet'],
                ] as const).map(([name, sen, hint]) => (
                  <div key={name} style={{ minWidth: 0 }} title={hint}>
                    <div className={s.legendName}>{name}</div>
                    <div className={s.legendAmount}>{fmtSen(sen)}</div>
                  </div>
                ))}
              </div>
              <div className={s.nowNote}>
                Each order's share moves as its net sales arrive — sales invoices and deposit invoices, less the credit notes that contra them — and whatever is left the day it is cancelled or closed.
              </div>
            </div>
          </section>

          {guessed.length > 0 && (
            <div className={b.problem}>
              {guessed.length === 1 ? 'A line' : `${guessed.length} lines`} on the prepayment name no month ({guessed.map((g) => g.docNo).join(', ')}) and are read as the month they were booked in. Name the month in the line (OCT&apos;26) to move one.
            </div>
          )}

          <section className={s.card} aria-label="Bills">
            <div className={s.cardHead}>
              <span className={s.cardTitle}>What the prepayment holds</span>
              <span className={s.cardSub}>Click a bill for its orders</span>
            </div>
            <div className={s.cardBody}>
              <DataTable<ReleaseLayer>
                tableId="commission-release-bills" exportName="commission-release-bills" exportXlsx freezeHeight="off"
                columns={layerCols} rows={layers} getRowKey={(l) => l.key}
                onRowClick={(l) => setLayer(l.key === layer ? null : l.key)}
                emptyLabel="Nothing is on the prepayment account."
              />
            </div>
          </section>

          {picked && (
            <section className={s.card} aria-label="Orders of the bill">
              <div className={s.cardHead}>
                <span className={s.cardTitle}>{layerName(picked)} — its orders</span>
                <span className={s.cardSub}>Shares from: {BASIS[picked.basis]} · invoiced to date</span>
                <span className={b.grow} />
                <button type="button" className={b.btn} onClick={() => setLayer(null)} aria-label="Close the orders"><X size={14} aria-hidden />Close</button>
              </div>
              <div className={s.cardBody}>
                {orders.isError && <div className={b.problem}>The orders did not load — refresh to retry.</div>}
                <DataTable<LayerOrder>
                  tableId="commission-release-orders" exportName={`commission-release-${picked.key.replace(':', '-')}`} exportXlsx freezeHeight="off"
                  columns={orderCols} rows={orders.data?.orders ?? []} getRowKey={(o) => o.docNo}
                  emptyLabel={orders.isLoading ? 'Loading the orders…' : 'No order carries this bill.'}
                />
              </div>
            </section>
          )}

          <section className={s.card} aria-label="Month by month">
            <div className={s.cardHead}>
              <span className={s.cardTitle}>Month by month</span>
              <span className={s.cardSub}>From {monthName(data.booksStart)} · each month booked on its last day</span>
            </div>
            <div className={s.cardBody}>
              <DataTable<MonthRow>
                tableId="commission-release-months" exportName="commission-release-months" exportXlsx freezeHeight="off"
                columns={monthCols} rows={monthRows} getRowKey={(m) => m.month}
                emptyLabel="No month to release yet."
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
              <DataTable<ReleaseRun>
                tableId="commission-release-runs" exportName="commission-release-runs" exportXlsx freezeHeight="off"
                columns={runCols} rows={shownRuns} getRowKey={(r) => `${r.month}-${r.ran_at}-${r.action}-${r.trigger}`}
                emptyLabel={data.on ? 'No run matches.' : 'No run yet — the release is off.'}
              />
            </div>
          </section>
        </>
      )}
      {toast.node}
    </div>
  );
};
