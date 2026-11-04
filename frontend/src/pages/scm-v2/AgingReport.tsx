// ----------------------------------------------------------------------------
// AgingReport — Finance › Reports › AR aging / AP aging, the formal debtor and
// creditor aging (owner 2026-10-02: 「现在的 aging 没有那种正式 account 的
// debtor & creditor aging」). As the owner settled it:
//   as at any day; one row per debtor or creditor; columns by the invoice's
//   month — This month · 1 · 2 · 3 · 4 months + (B1a, B2a 「跟发票的月份」), or by
//   days, or by due date; money not tied to a bill in Unapplied (未冲, B3a); a
//   row opens its bills and its unapplied money; the rows add up to the
//   control accounts, and the foot says so; it replaces the old screens (B4).
// In the owner's Claude Design report shell (batch 6 step 6, question g1's
// default — today's report and its choices, in English): As at is the shared
// range's end; the tiles are the five columns, Unapplied and Total, and a tile
// filters the table to the rows with money in it; the parties on a Finance
// table that opens to their bills; a second view, By invoice, is the design's
// flat table — each open bill with its Days overdue and the design's bucket
// tag. Excel / PDF / Print draw exactly what is shown (report-sheet).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import {
  AGING_COLUMN_LABELS, useAging,
  type AgingBasis, type AgingBuckets, type AgingControl, type AgingReportData, type AgingRow, type AgingSide,
} from '../../vendor/scm/lib/aging-queries';
import { AMOUNT_COLUMN, type ReportSheet, type SheetColumn, type SheetRow } from '../../vendor/scm/lib/report-sheet';
import { DateField } from '../../vendor/scm/components/DateField';
import { fmtDate, fmtDateOrDash, fmtSenPlain } from '../../vendor/shared/format';
import { isIsoDay } from '../../lib/dateRangePresets';
import { DataTable, type Column } from '../../components/DataTable';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { Tag } from './finance/SetupParts';
import { useReportRange } from './reports/useReportRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import {
  OVERDUE_BUCKET, UNAPPLIED_LABEL, agingInvoiceLines, agingPartyCounts, bucketLabel, linesIn, partiesIn, soOfGroup,
  type AgingInvoiceLine, type AgingPick,
} from './reports/agingViews';
import css from './reports/Aging.module.css';

const SIDE: Record<AgingSide, { title: string; party: string; parties: string; trade: string; other: string }> = {
  ar: { title: 'AR aging', party: 'Debtor', parties: 'debtors', trade: 'Trade debtors', other: 'Other debtors' },
  ap: { title: 'AP aging', party: 'Creditor', parties: 'creditors', trade: 'Trade creditors', other: 'Other creditors' },
};

/** The columns' dots, the older the warmer — the tones of the design's tags. */
const COLUMN_DOTS = ['var(--fin-calm-fg)', 'var(--fin-info-fg)', 'var(--fin-warn-fg)', 'var(--fin-late-fg)', 'var(--fin-late-fg)'];

/** A figure as the statements print it: 1,234.56, a negative in brackets, nothing as a dash. */
const money = (sen: number): string => (sen === 0 ? '—' : fmtSenPlain(sen));
const sumOf = <T,>(rows: readonly T[], sen: (r: T) => number): number => rows.reduce((n, r) => n + sen(r), 0);

const partyLabel = (code: string | null, name: string): string => (code && code !== name ? `${code} · ${name}` : name);
const basisWords = (b: AgingBasis): string => (b === 'due' ? 'due date' : 'invoice date');
const bucketWords = (b: AgingBuckets): string => (b === 'month' ? 'by month' : 'by days');
const partyCount = (side: AgingSide, n: number): string => `${n} ${n === 1 ? SIDE[side].party.toLowerCase() : SIDE[side].parties}`;
/** Days overdue as the table prints them: a bill not yet due shows a dash. */
const daysText = (days: number | null): string | null => (days != null && days > 0 ? String(days) : null);

/** The party view as the screen shows it, for Excel and PDF: the rows (in the
 *  table's order), the opened ones' bills and unapplied money, the total. */
export function agingSheet(side: AgingSide, d: AgingReportData, rows: readonly AgingRow[], openRows: ReadonlySet<string>): ReportSheet {
  const labels = AGING_COLUMN_LABELS[d.buckets];
  const out: SheetRow[] = [];
  for (const r of rows) {
    out.push({ kind: 'row', depth: 0, label: partyLabel(r.code, r.name), cells: [r.balanceSen, ...r.cells, r.unappliedSen] });
    if (!openRows.has(r.key)) continue;
    for (const i of r.items) {
      const cells: Array<number | null> = Array<number | null>(labels.length + 2).fill(null);
      cells[1 + i.column] = i.openSen;
      out.push({ kind: 'memo', depth: 1, label: `${i.docNo} · ${i.kind} · ${fmtDateOrDash(i.date)}`, cells });
    }
    for (const u of r.unapplied) {
      const cells: Array<number | null> = Array<number | null>(labels.length + 2).fill(null);
      cells[labels.length + 1] = u.amountSen;
      out.push({ kind: 'memo', depth: 1, label: `${u.docNo} · ${u.kind} · ${fmtDateOrDash(u.date)} · ${UNAPPLIED_LABEL}`, cells });
    }
  }
  /* Every row shown: the report's own totals. Fewer (a tile or the find):
     the total of the rows shown, as the table's foot prints it. */
  const every = rows.length === d.rows.length;
  const total = every
    ? [d.totals.balanceSen, ...d.totals.cells, d.totals.unappliedSen]
    : [sumOf(rows, (r) => r.balanceSen), ...labels.map((_, c) => sumOf(rows, (r) => r.cells[c])), sumOf(rows, (r) => r.unappliedSen)];
  out.push({ kind: 'total', depth: 0, label: every ? 'Total' : `Total of the ${rows.length} shown`, cells: total });
  return {
    title: SIDE[side].title,
    subtitle: `As at ${fmtDateOrDash(d.asOf)} · by ${basisWords(d.basis)} · ${bucketWords(d.buckets)} · RM`,
    meta: [
      { label: 'As at', value: fmtDateOrDash(d.asOf) },
      { label: 'Accounts', value: d.controls.map((k) => k.code).join(' + ') },
      { label: SIDE[side].party, value: String(rows.length) },
    ],
    tables: [{ columns: [AMOUNT_COLUMN('Balance'), ...labels.map((l) => AMOUNT_COLUMN(l)), AMOUNT_COLUMN(UNAPPLIED_LABEL)], rows: out }],
    notes: agingNotes(side, d),
  };
}

/** The By invoice view as the screen shows it, for Excel and PDF. */
export function agingInvoiceSheet(side: AgingSide, d: AgingReportData, lines: readonly AgingInvoiceLine[]): ReportSheet {
  const text = (label: string): SheetColumn => ({ label, kind: 'text' });
  const rows: SheetRow[] = lines.map((l) => ({
    kind: 'row', depth: 0, label: l.docNo,
    cells: [l.kind, partyLabel(l.partyCode, l.partyName), fmtDate(l.date), l.dueDate ? fmtDate(l.dueDate) : null, l.outstandingSen, daysText(l.daysOverdue), bucketLabel(l.bucket)],
  }));
  rows.push({ kind: 'total', depth: 0, label: 'Total', cells: [null, null, null, null, sumOf(lines, (l) => l.outstandingSen), null, null] });
  return {
    title: SIDE[side].title,
    subtitle: `As at ${fmtDateOrDash(d.asOf)} · by invoice · days overdue from the due date · RM`,
    meta: [
      { label: 'As at', value: fmtDateOrDash(d.asOf) },
      { label: 'Accounts', value: d.controls.map((k) => k.code).join(' + ') },
      { label: 'Lines', value: String(lines.length) },
    ],
    tables: [{
      columns: [text('Kind'), text(SIDE[side].party), text('Date'), text('Due'), AMOUNT_COLUMN('Outstanding'), text('Days overdue'), text('Age')],
      rows,
    }],
    notes: agingNotes(side, d),
  };
}

/** The foot: the books' figure beside the report's, and what is not in the books. */
export function agingNotes(side: AgingSide, d: AgingReportData): string[] {
  const books = d.controls.reduce((n, k) => n + k.balanceSen, 0);
  const notes = [
    `In the books (${d.controls.map((k) => k.code).join(' + ')}) as at ${fmtDateOrDash(d.asOf)}: ${fmtSenPlain(books)} · difference ${fmtSenPlain(d.differenceSen)}.`,
  ];
  if (d.outside.count > 0) {
    notes.push(`${d.outside.count} ${side === 'ar' ? 'customer' : 'supplier'} invoice(s) brought over from AutoCount are open for ${fmtSenPlain(d.outside.sen)} — they were never booked in the ERP, so they are not in this aging.`);
  }
  if (d.paidBeforeErp && d.paidBeforeErp.orders > 0) {
    notes.push(`${d.paidBeforeErp.orders} order(s) show ${fmtSenPlain(d.paidBeforeErp.sen)} owed here although AutoCount took their deposit before the ERP — that money is not in the ERP's books yet.`);
  }
  return notes;
}

/** A party: its code over its name. */
function PartyCell({ code, name }: { code: string | null; name: string }) {
  return (
    <span className={css.party}>
      {code && code !== name ? <span className={css.partyCode}>{code}</span> : null}
      <span className={css.partyName}>{name}</span>
    </span>
  );
}

/** A bill's number: on AR, the order it belongs to opens in a tab of its own. */
function BillNo({ side, docNo, so }: { side: AgingSide; docNo: string; so: string | null }) {
  return side === 'ar' && so ? <FinanceDocLink to={`/scm/sales-orders/${encodeURIComponent(so)}`}>{docNo}</FinanceDocLink> : <>{docNo}</>;
}

function AgeTag({ bucket }: { bucket: AgingInvoiceLine['bucket'] }) {
  if (bucket === 'unapplied') return <Tag tone="brass">{UNAPPLIED_LABEL}</Tag>;
  const b = OVERDUE_BUCKET[bucket];
  return <Tag tone={b.tone} dot={b.dot}>{b.label}</Tag>;
}

/** A party's bills and its unapplied money, under its row. */
function PartyBills({ side, row, labels }: { side: AgingSide; row: AgingRow; labels: readonly string[] }) {
  return (
    <table className={css.bills} aria-label={`${row.name}'s bills`}>
      <thead>
        <tr>
          <th>Bill</th><th>Kind</th><th>Date</th><th>Due</th>
          <th className={css.num}>Amount</th><th className={css.num}>Outstanding</th><th>Column</th>
        </tr>
      </thead>
      <tbody>
        {row.items.map((i, n) => (
          <tr key={`b${n}`}>
            <td><BillNo side={side} docNo={i.docNo} so={soOfGroup(i.group)} /></td>
            <td>{i.kind}</td>
            <td>{fmtDate(i.date)}</td>
            <td>{fmtDateOrDash(i.dueDate)}</td>
            <td className={css.num}>{fmtSenPlain(i.amountSen)}</td>
            <td className={`${css.num} ${css.strong}`}>{fmtSenPlain(i.openSen)}</td>
            <td>{labels[i.column]}</td>
          </tr>
        ))}
        {row.unapplied.map((u, n) => (
          <tr key={`u${n}`}>
            <td>{u.docNo}</td>
            <td>{u.kind}</td>
            <td>{fmtDate(u.date)}</td>
            <td>—</td>
            <td className={css.num} />
            <td className={`${css.num} ${css.unapplied}`}>{fmtSenPlain(u.amountSen)}</td>
            <td><Tag tone="brass">{UNAPPLIED_LABEL}</Tag></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type View = 'party' | 'invoice';

export const AgingReport = ({ side }: { side: AgingSide }) => {
  const r = useReportRange();
  const asAt = isIsoDay(r.to) ? r.to : r.today;
  const [basis, setBasis] = useState<AgingBasis>('invoice');
  const [buckets, setBuckets] = useState<AgingBuckets>('month');
  const [control, setControl] = useState<AgingControl>('all');
  const [view, setView] = useState<View>('party');
  const [find, setFind] = useState('');
  const [pick, setPick] = useState<AgingPick>(null);
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  /* What the tables show after their own funnels and sort — what the exports draw. */
  const [shownParties, setShownParties] = useState<AgingRow[] | null>(null);
  const [shownLines, setShownLines] = useState<AgingInvoiceLine[] | null>(null);
  const q = useAging(side, { asOf: asAt, basis, buckets, control });
  const d = q.data;
  const labels = AGING_COLUMN_LABELS[buckets];
  const words = SIDE[side];
  const party = words.party.toLowerCase();

  /* Worked out once, read by the tiles, both tables and the exports. */
  const found = useMemo(() => {
    const all = d?.rows ?? [];
    const needle = find.trim().toLowerCase();
    return needle ? all.filter((row) => `${row.code ?? ''} ${row.name}`.toLowerCase().includes(needle)) : all;
  }, [d, find]);
  const parties = useMemo(() => partiesIn(found, pick), [found, pick]);
  const lines = useMemo(() => (d ? linesIn(agingInvoiceLines(found, d.asOf), pick) : []), [d, found, pick]);
  const counts = useMemo(() => agingPartyCounts(d?.rows ?? [], labels.length), [d, labels.length]);

  const toggle = (key: string) => setOpenRows((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const allOpen = parties.length > 0 && parties.every((row) => openRows.has(row.key));
  const pickTile = (p: AgingPick) => setPick((now) => (now === p ? null : p));
  const pickName = pick === null ? '' : pick === 'unapplied' ? UNAPPLIED_LABEL : labels[pick];

  useReportSubtitle(`As at ${fmtDate(asAt)} · aged by ${basisWords(basis)} · columns ${bucketWords(buckets)}`);

  const tiles: ReportTile[] = [
    ...labels.map((label, i): ReportTile => ({
      key: `c${i}`, label, dot: COLUMN_DOTS[i],
      value: d ? fmtSenPlain(d.totals.cells[i]) : '',
      sub: partyCount(side, counts.cells[i]),
      onClick: () => pickTile(i), on: pick === i,
    })),
    {
      key: 'unapplied', label: UNAPPLIED_LABEL, dot: 'var(--fin-brass)',
      value: d ? fmtSenPlain(d.totals.unappliedSen) : '',
      sub: partyCount(side, counts.unapplied),
      onClick: () => pickTile('unapplied'), on: pick === 'unapplied',
    },
    {
      key: 'total', label: 'Total', value: d ? fmtSenPlain(d.totals.balanceSen) : '',
      sub: partyCount(side, counts.all),
      onClick: () => setPick(null), on: pick === null,
    },
  ];

  const empty = !d ? ''
    : d.rows.length === 0 ? `Nothing owed on these accounts as at ${fmtDate(d.asOf)}.`
      : found.length === 0 ? `No ${party} matches “${find.trim()}”.`
        : view === 'party' ? `No ${party} with money in ${pickName}.` : `No line in ${pickName}.`;

  const partyColumns = useMemo((): Column<AgingRow>[] => [
    {
      key: 'party', label: words.party, alwaysVisible: true,
      getValue: (row) => partyLabel(row.code, row.name), sortValue: (row) => row.name.toLowerCase(),
      render: (row) => <PartyCell code={row.code} name={row.name} />,
    },
    {
      key: 'balance', label: 'Balance', align: 'right',
      getValue: (row) => row.balanceSen / 100, exportValue: (row) => row.balanceSen / 100, exportFormat: 'money',
      render: (row) => <span className={css.strong}>{money(row.balanceSen)}</span>,
      total: (rows) => fmtSenPlain(sumOf(rows, (row) => row.balanceSen)),
    },
    ...labels.map((label, c): Column<AgingRow> => ({
      key: `c${c}`, label, align: 'right',
      getValue: (row) => row.cells[c] / 100, exportValue: (row) => row.cells[c] / 100, exportFormat: 'money',
      render: (row) => money(row.cells[c]),
      total: (rows) => fmtSenPlain(sumOf(rows, (row) => row.cells[c])),
    })),
    {
      key: 'unapplied', label: UNAPPLIED_LABEL, align: 'right',
      description: 'Money not tied to a bill — a deposit, an advance, a credit note not knocked off',
      getValue: (row) => row.unappliedSen / 100, exportValue: (row) => row.unappliedSen / 100, exportFormat: 'money',
      render: (row) => <span className={row.unappliedSen ? css.unapplied : undefined}>{money(row.unappliedSen)}</span>,
      total: (rows) => fmtSenPlain(sumOf(rows, (row) => row.unappliedSen)),
    },
  ], [labels, words.party]);

  const invoiceColumns = useMemo((): Column<AgingInvoiceLine>[] => [
    { key: 'doc', label: 'Invoice', alwaysVisible: true, getValue: (l) => l.docNo, render: (l) => <BillNo side={side} docNo={l.docNo} so={l.so} /> },
    { key: 'kind', label: 'Kind', getValue: (l) => l.kind, render: (l) => l.kind },
    { key: 'party', label: words.party, getValue: (l) => l.partyName, render: (l) => l.partyName },
    { key: 'code', label: `${words.party} code`, getValue: (l) => l.partyCode ?? '', render: (l) => l.partyCode ?? '—' },
    { key: 'date', label: 'Date', getValue: (l) => l.date, render: (l) => fmtDate(l.date) },
    { key: 'due', label: 'Due', getValue: (l) => l.dueDate ?? '', render: (l) => fmtDateOrDash(l.dueDate) },
    {
      key: 'outstanding', label: 'Outstanding', align: 'right',
      getValue: (l) => l.outstandingSen / 100, exportValue: (l) => l.outstandingSen / 100, exportFormat: 'money',
      render: (l) => <span className={l.bucket === 'unapplied' ? css.unapplied : css.strong}>{fmtSenPlain(l.outstandingSen)}</span>,
      total: (ls) => fmtSenPlain(sumOf(ls, (l) => l.outstandingSen)),
    },
    {
      key: 'days', label: 'Days overdue', align: 'right', getValue: (l) => l.daysOverdue,
      render: (l) => {
        const t = daysText(l.daysOverdue);
        return t ? <span className={`${css.days} ${(l.daysOverdue ?? 0) > 60 ? css.daysLate : ''}`}>{t}</span> : '—';
      },
    },
    { key: 'age', label: 'Age', getValue: (l) => bucketLabel(l.bucket), render: (l) => <AgeTag bucket={l.bucket} /> },
  ], [side, words.party]);

  const sheet = (): ReportSheet | null => {
    if (!d) return null;
    return view === 'party'
      ? agingSheet(side, d, shownParties ?? parties, openRows)
      : agingInvoiceSheet(side, d, shownLines ?? lines);
  };

  return (
    <div className={css.body}>
      <ReportHeaderActions>
        <ReportExports sheet={sheet} fileBase={`${side}-aging-${view === 'invoice' ? 'by-invoice-' : ''}${asAt}`} />
      </ReportHeaderActions>
      <ReportToolbar>
        <ReportTool label="As at">
          <DateField value={asAt} onChange={r.setAsAt} aria-label={`${words.title} as at`} />
        </ReportTool>
        <ReportTool label="Age by">
          <Segmented label="Age by" value={basis} onChange={setBasis}
            options={[{ value: 'invoice', label: 'Invoice date' }, { value: 'due', label: 'Due date' }]} />
        </ReportTool>
        <ReportTool label="Columns">
          <Segmented label="Columns" value={buckets} onChange={setBuckets}
            options={[{ value: 'month', label: 'By month' }, { value: 'day', label: 'By days' }]} />
        </ReportTool>
        <ReportTool label="Accounts">
          <Segmented label="Accounts" value={control} onChange={setControl}
            options={[{ value: 'all', label: 'All' }, { value: 'trade', label: words.trade }, { value: 'other', label: words.other }]} />
        </ReportTool>
        <ReportTool label="View">
          <Segmented label="View" value={view} onChange={setView}
            options={[{ value: 'party', label: 'By party' }, { value: 'invoice', label: 'By invoice' }]} />
        </ReportTool>
        {view === 'party' && (
          <ReportTool label="Rows">
            <Segmented label="Rows" value={allOpen ? 'detail' : 'summary'}
              onChange={(v) => setOpenRows(v === 'detail' ? new Set(parties.map((row) => row.key)) : new Set())}
              options={[{ value: 'summary', label: 'Summary' }, { value: 'detail', label: 'Detail' }]} />
          </ReportTool>
        )}
        <ReportTool>
          <input className={css.find} value={find} onChange={(e) => setFind(e.target.value)}
            placeholder={`Find a ${party}`} aria-label={`Find a ${party}`} />
        </ReportTool>
      </ReportToolbar>

      {q.isError ? (
        <ReportMessage tone="error">The aging did not load — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</ReportMessage>
      ) : (
        <>
          <ReportTiles label={`${words.title} figures`} tiles={tiles} pending={!d} />
          {view === 'party' ? (
            <section aria-label={`${words.title} by ${party}`}>
              <DataTable<AgingRow>
                tableId={`aging-${side}-parties`}
                columns={partyColumns}
                rows={d ? parties : null}
                loading={!d}
                getRowKey={(row) => row.key}
                emptyLabel={empty}
                onRowClick={(row) => toggle(row.key)}
                expandable={{
                  render: (row) => <PartyBills side={side} row={row} labels={labels} />,
                  rowKey: (row) => row.key, expandedIds: openRows, onExpandedChange: setOpenRows,
                }}
                onFilteredRowsChange={setShownParties}
                exportName={`${side}-aging-parties`}
                exportXlsx
              />
            </section>
          ) : (
            <section aria-label={`${words.title} by invoice`}>
              <DataTable<AgingInvoiceLine>
                tableId={`aging-${side}-invoices`}
                columns={invoiceColumns}
                rows={d ? lines : null}
                loading={!d}
                getRowKey={(l) => l.key}
                emptyLabel={empty}
                onFilteredRowsChange={setShownLines}
                exportName={`${side}-aging-invoices`}
                exportXlsx
              />
            </section>
          )}
          {d && (
            <ul className={css.notes} aria-label="Aging notes">
              {agingNotes(side, d).map((n, i) => (
                <li key={n} className={i === 0 ? (d.differenceSen === 0 ? css.noteGood : css.noteBad) : undefined}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
};
