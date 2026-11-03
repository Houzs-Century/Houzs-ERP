// ----------------------------------------------------------------------------
// EventCosts — Finance › Reports › Event costs (owner 2026-09-29/30: 我的
// payment 可能需要绑定 event). Every event starting in the chosen months, with
// what was booked against it: the journal legs voucher and AP invoice lines
// tagged with the event wrote, posted, a cancelled or edited document's pair
// left out — the ledger's own answer, so it agrees with the P&L it is a slice
// of. Cost is the expense accounts; Other is everything else tagged (a rental
// deposit is an asset, not a cost). An event opens to its accounts and the
// entries behind them.
//
// The owner's redesign (batch 6 §5.11): inside the report shell — the period
// in the subtitle, Excel · PDF · Print in the header and the CSV under its ⋯;
// one toolbar row (the shared range in whole months, the find box, Only
// events with money booked); four tiles; the events on the Finance-Table.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '../../components/DataTable';
import { monthEnd, monthStart } from '../../lib/dateRangePresets';
import { eventLabel, useEventCosts, type EventCostRow, type EventCosts } from '../../vendor/scm/lib/event-queries';
import { AMOUNT_COLUMN, type ReportSheet, type SheetRow } from '../../vendor/scm/lib/report-sheet';
import { fmtDateOrDash, fmtDayMonthRange, fmtSenPlain } from '../../vendor/shared/format';
import { AccountCell } from './JournalEntryCards';
import { FinanceDateRange } from './reports/FinanceDateRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportMore, ReportSwitch, ReportTiles, ReportTool, ReportToolbar, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { monthName } from './reports/statementColumns';
import { useReportRange } from './reports/useReportRange';
import s from './EventCosts.module.css';

const fmtRm = (sen: number): string => {
  const abs = Math.abs(sen) / 100;
  const text = abs.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${text})` : text;
};
const isCancelled = (e: EventCostRow): boolean => String(e.event.status ?? '').toLowerCase() === 'cancelled';
const isCost = (row: EventCostRow, accountCode: string): boolean =>
  row.accounts.find((a) => a.accountCode === accountCode)?.accountType === 'EXPENSE';

/* The table as CSV: one row per event, then its entries beneath it. */
export const eventCostsCsv = (r: EventCosts): string => {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines: string[] = [['Event', 'Dates', 'Status', 'Entry', 'Date', 'Document', 'Account', 'Notes', 'Cost', 'Other'].map(esc).join(',')];
  for (const e of r.events) {
    lines.push([e.event.name, fmtDayMonthRange(e.event.startDate, e.event.endDate), e.event.status ?? '', '', '', '', '', '', fmtRm(e.costSen), fmtRm(e.otherSen)].map(esc).join(','));
    for (const l of e.lines) {
      const cost = isCost(e, l.accountCode);
      lines.push(['', '', '', l.jeNo, fmtDateOrDash(l.entryDate), l.sourceDocNo ?? '', l.accountCode, l.notes ?? '', cost ? fmtRm(l.amountSen) : '', cost ? '' : fmtRm(l.amountSen)].map(esc).join(','));
    }
  }
  lines.push(['Total', '', '', '', '', '', '', '', fmtRm(r.totals.costSen), fmtRm(r.totals.otherSen)].map(esc).join(','));
  return `${lines.join('\n')}\n`;
};

/** The table as the screen shows it, for Excel and PDF: one row per event, the
 *  entries of an opened event under it, the total. */
export function eventCostsSheet(rows: readonly EventCostRow[], open: ReadonlySet<string>, period: string, totals: { costSen: number; otherSen: number }): ReportSheet {
  const out: SheetRow[] = [];
  for (const e of rows) {
    out.push({
      kind: 'category', depth: 0, label: e.event.name + (e.event.boothNo ? ` · booth ${e.event.boothNo}` : ''),
      cells: [fmtDayMonthRange(e.event.startDate, e.event.endDate), e.event.status ?? '—', String(e.lines.length), e.lines.length > 0 ? e.costSen : null, e.otherSen !== 0 ? e.otherSen : null],
    });
    if (!open.has(String(e.event.id))) continue;
    for (const l of e.lines) {
      const cost = isCost(e, l.accountCode);
      out.push({
        kind: 'row', depth: 1, label: `${fmtDateOrDash(l.entryDate)} · ${l.jeNo}${l.sourceDocNo ? ` · ${l.sourceDocNo}` : ''} · ${l.accountCode}`,
        cells: [l.notes ?? '', '', '', cost ? l.amountSen : null, cost ? null : l.amountSen],
      });
    }
  }
  out.push({ kind: 'total', depth: 0, label: 'Total', cells: [null, null, null, totals.costSen, totals.otherSen] });
  return {
    title: 'Event costs',
    subtitle: `Events starting ${period} · as booked in the ledger · RM`,
    meta: [{ label: 'Events starting', value: period }, { label: 'Events', value: String(rows.length) }],
    tables: [{
      columns: [{ label: 'Dates', kind: 'text' }, { label: 'Status', kind: 'text' }, { label: 'Entries', kind: 'text' }, AMOUNT_COLUMN('Cost'), AMOUNT_COLUMN('Other')],
      rows: out,
    }],
    notes: ['Cost is the expense accounts tagged with the event; Other is every other account tagged (a rental deposit is an asset, not a cost).'],
  };
}

const downloadText = (name: string, text: string) => {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

const StatusTag = ({ row }: { row: EventCostRow }) => {
  const status = row.event.status;
  if (!status) return <span className={s.dash}>—</span>;
  return isCancelled(row)
    ? <span className={`${s.tag} ${s.tagLate}`}><span className={s.tagDot} aria-hidden />{status}</span>
    : <span className={`${s.tag} ${s.tagCalm}`}>{status}</span>;
};

export const EventCostsTab = () => {
  const r = useReportRange();
  /* Events starting in whole months: the range widens to its months' first and last days. */
  const from = r.usable ? monthStart(r.from) : monthStart(r.today);
  const to = r.usable ? monthEnd(r.to) : monthEnd(r.today);
  const fromMonth = from.slice(0, 7);
  const toMonth = to.slice(0, 7);
  const period = fromMonth === toMonth ? monthName(from) : `${monthName(from)} – ${monthName(to)}`;
  const [withMoneyOnly, setWithMoneyOnly] = useState(false);
  const [find, setFind] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = useEventCosts(from, to);
  const rep = q.data;

  const rows = useMemo<EventCostRow[]>(() => {
    const needle = find.trim().toLowerCase();
    return (rep?.events ?? []).filter((e) => (!withMoneyOnly || e.lines.length > 0)
      && (!needle || `${e.event.name} ${e.event.code ?? ''} ${e.event.boothNo ?? ''}`.toLowerCase().includes(needle)));
  }, [rep, withMoneyOnly, find]);
  const shown = useMemo(() => ({
    costSen: rows.reduce((t, e) => t + e.costSen, 0),
    otherSen: rows.reduce((t, e) => t + e.otherSen, 0),
    booked: rows.filter((e) => e.lines.length > 0).length,
    entries: rows.reduce((t, e) => t + e.lines.length, 0),
  }), [rows]);

  const partMonths = r.usable && (r.from !== from || r.to !== to);
  useReportSubtitle(`Events starting ${period}${partMonths ? ' · whole months' : ''} · as booked in the ledger`);
  const fileBase = `event-costs-${fromMonth}-${toMonth}`;

  const tiles: ReportTile[] = rep ? [
    { key: 'events', label: 'Events', value: String(rows.length), sub: `${shown.booked} with money booked` },
    { key: 'cost', label: 'Cost', value: fmtSenPlain(shown.costSen), sub: 'expense accounts tagged' },
    { key: 'other', label: 'Other tagged', value: fmtSenPlain(shown.otherSen), sub: 'deposits and other non-expense accounts' },
    { key: 'entries', label: 'Entries', value: String(shown.entries), sub: 'ledger lines tagged to them' },
  ] : [];

  const columns: Column<EventCostRow>[] = [
    {
      key: 'event_name', label: 'Event', getValue: (e) => e.event.name, searchValue: (e) => `${e.event.name} ${e.event.code ?? ''} ${e.event.boothNo ?? ''}`,
      render: (e) => (
        <span className={s.event}>
          <span className={s.eventName}>{e.event.name}</span>
          {e.event.boothNo && <span className={s.muted}>booth {e.event.boothNo}</span>}
          {e.event.archived && <span className={s.muted}>archived</span>}
        </span>
      ),
    },
    {
      key: 'event_dates', label: 'Dates', getValue: (e) => e.event.startDate ?? '', dateValue: (e) => e.event.startDate,
      render: (e) => fmtDayMonthRange(e.event.startDate, e.event.endDate),
    },
    { key: 'status', label: 'Status', getValue: (e) => e.event.status ?? '', render: (e) => <StatusTag row={e} /> },
    { key: 'entries', label: 'Entries', align: 'right', getValue: (e) => e.lines.length, render: (e) => e.lines.length },
    {
      key: 'cost_amount', label: 'Cost', align: 'right', getValue: (e) => e.costSen / 100, exportValue: (e) => e.costSen / 100, exportFormat: 'money',
      render: (e) => (e.lines.length > 0 ? fmtSenPlain(e.costSen) : <span className={s.dash}>—</span>),
      total: () => <span className={s.strong}>{fmtSenPlain(shown.costSen)}</span>,
    },
    {
      key: 'other_amount', label: 'Other', align: 'right', getValue: (e) => e.otherSen / 100, exportValue: (e) => e.otherSen / 100, exportFormat: 'money',
      render: (e) => (e.otherSen !== 0 ? fmtSenPlain(e.otherSen) : <span className={s.dash}>—</span>),
      total: () => <span className={s.strong}>{fmtSenPlain(shown.otherSen)}</span>,
    },
  ];

  const opened = (row: EventCostRow) => (
    <div className={s.open}>
      {row.lines.length === 0 ? <span className={s.label}>Nothing is booked on this event yet.</span> : (
        <>
          <div className={s.accounts}>
            {row.accounts.map((a) => (
              <div key={a.accountCode} className={s.account}>
                <AccountCell code={a.accountCode} name={a.accountName} />
                <div className={s.accountAmount}>{fmtSenPlain(a.amountSen)}</div>
              </div>
            ))}
          </div>
          <table className={s.lines} aria-label={`Entries on ${row.event.name}`}>
            <thead>
              <tr><th>Date</th><th>Entry</th><th>Document</th><th>Account</th><th>Notes</th><th className={s.num}>Amount</th></tr>
            </thead>
            <tbody>
              {row.lines.map((l, i) => (
                <tr key={`${l.jeNo}-${i}`}>
                  <td>{fmtDateOrDash(l.entryDate)}</td>
                  <td>{l.jeNo}</td>
                  <td>{l.sourceDocNo ?? '—'}</td>
                  <td><AccountCell code={l.accountCode} name={row.accounts.find((a) => a.accountCode === l.accountCode)?.accountName} /></td>
                  <td>{l.notes ?? ''}</td>
                  <td className={s.num}>{fmtSenPlain(l.amountSen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className={s.label}>{eventLabel(row.event)}</div>
    </div>
  );

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={() => (rep ? eventCostsSheet(rows, open, period, shown) : null)} fileBase={fileBase} />
        <ReportMore items={[{
          label: 'CSV', disabled: !rep,
          onClick: () => { if (rep) downloadText(`${fileBase}.csv`, eventCostsCsv({ ...rep, events: rows, totals: { costSen: shown.costSen, otherSen: shown.otherSen } })); },
        }]} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange label="Events starting" />
        <ReportTool>
          <input type="search" className={s.find} value={find} onChange={(e) => setFind(e.target.value)}
            placeholder="Find an event, venue or booth" aria-label="Find an event" />
        </ReportTool>
        <ReportSwitch on={withMoneyOnly} onChange={setWithMoneyOnly}>Only events with money booked</ReportSwitch>
      </ReportToolbar>

      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {q.isLoading && (
        <div className={s.skeleton} aria-label="Reading the ledger">
          {[0, 1, 2].map((i) => <div key={i} className={`skeleton ${s.skeletonBar}`} style={{ width: `${90 - i * 14}%` }} />)}
        </div>
      )}
      {q.isError && <ReportMessage tone="error">The report could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</ReportMessage>}
      {rep && (
        <>
          <ReportTiles tiles={tiles} label="Totals" />
          {rows.length === 0 ? (
            <ReportMessage>{rep.events.length === 0 ? 'No event starts in these months.' : 'No event here matches the filter.'}</ReportMessage>
          ) : (
            <section aria-label="Events">
              <DataTable<EventCostRow>
                tableId="event-costs"
                exportName={fileBase}
                exportXlsx
                freezeHeight="off"
                columns={columns}
                rows={rows}
                getRowKey={(e) => e.event.id}
                expandable={{ render: opened, expandedIds: open, onExpandedChange: setOpen }}
                emptyLabel="No event matches."
              />
            </section>
          )}
        </>
      )}
    </>
  );
};
