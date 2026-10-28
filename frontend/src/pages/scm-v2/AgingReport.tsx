// ----------------------------------------------------------------------------
// AgingReport — Finance › Reports › AR Aging / AP Aging, the formal debtor and
// creditor aging (owner 2026-10-02: 「现在的 aging 没有那种正式 account 的
// debtor & creditor aging」). As the owner settled it:
//   截至 any day; one row per debtor or creditor; columns by the invoice's
//   month — 本月 · 1 · 2 · 3 · 4 个月以上 (B1a, B2a 「跟发票的月份」), or by days,
//   or by due date; money not tied to a bill in 未冲 (B3a); ▸ opens a row's
//   bills and its 未冲; the rows add up to the control accounts, and the foot
//   says so; it replaces the old screens under their names (B4).
// Excel and PDF draw exactly what is shown (report-sheet), like the statements.
// ----------------------------------------------------------------------------

import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Download, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  AGING_COLUMN_LABELS, useAging,
  type AgingBasis, type AgingBuckets, type AgingControl, type AgingReportData, type AgingRow, type AgingSide,
} from '../../vendor/scm/lib/aging-queries';
import { AMOUNT_COLUMN, type ReportSheet, type SheetRow } from '../../vendor/scm/lib/report-sheet';
import { downloadReportXlsx } from '../../vendor/scm/lib/report-sheet-xlsx';
import { generateReportPdf } from '../../vendor/scm/lib/report-sheet-pdf';
import { DateField } from '../../vendor/scm/components/DateField';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { fmtDateOrDash, fmtSenPlain } from '../../vendor/shared/format';

const SIDE: Record<AgingSide, { title: string; party: string; trade: string; other: string }> = {
  ar: { title: 'AR Aging · 应收账龄', party: 'Debtor', trade: 'Trade debtors', other: 'Other debtors' },
  ap: { title: 'AP Aging · 应付账龄', party: 'Creditor', trade: 'Trade creditors', other: 'Other creditors' },
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const th: React.CSSProperties = {
  padding: '6px 8px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
  color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left',
};
const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--border-weak, #efede6)', verticalAlign: 'top' };
const chip = (on: boolean): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 999, fontSize: 'var(--fs-12)', cursor: 'pointer',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  background: on ? 'var(--c-ink)' : 'transparent', color: on ? 'var(--c-cream)' : 'var(--c-ink)',
});
/** A figure as the statements print it: 1,234.56, a negative in brackets, nothing as a dash. */
const money = (sen: number): string => (sen === 0 ? '—' : fmtSenPlain(sen));

const partyLabel = (r: AgingRow): string => (r.code && r.code !== r.name ? `${r.code} · ${r.name}` : r.name);

/** The report as the screen shows it, for Excel and PDF. */
export function agingSheet(side: AgingSide, d: AgingReportData, rows: AgingRow[], openRows: ReadonlySet<string>): ReportSheet {
  const labels = AGING_COLUMN_LABELS[d.buckets];
  const out: SheetRow[] = [];
  for (const r of rows) {
    out.push({ kind: 'row', depth: 0, label: partyLabel(r), cells: [r.balanceSen, ...r.cells, r.unappliedSen] });
    if (!openRows.has(r.key)) continue;
    for (const i of r.items) {
      const cells: Array<number | null> = Array<number | null>(labels.length + 2).fill(null);
      cells[1 + i.column] = i.openSen;
      out.push({ kind: 'memo', depth: 1, label: `${i.docNo} · ${i.kind} · ${fmtDateOrDash(i.date)}`, cells });
    }
    for (const u of r.unapplied) {
      const cells: Array<number | null> = Array<number | null>(labels.length + 2).fill(null);
      cells[labels.length + 1] = u.amountSen;
      out.push({ kind: 'memo', depth: 1, label: `${u.docNo} · ${u.kind} · ${fmtDateOrDash(u.date)} · 未冲`, cells });
    }
  }
  out.push({ kind: 'total', depth: 0, label: 'Total', cells: [d.totals.balanceSen, ...d.totals.cells, d.totals.unappliedSen] });
  return {
    title: side === 'ar' ? 'AR Aging' : 'AP Aging',
    subtitle: `As at ${fmtDateOrDash(d.asOf)} · by ${d.basis === 'due' ? 'due date' : 'invoice date'} · ${d.buckets === 'month' ? 'by month' : 'by days'} · RM`,
    meta: [
      { label: 'As at', value: fmtDateOrDash(d.asOf) },
      { label: 'Accounts', value: d.controls.map((k) => k.code).join(' + ') },
      { label: SIDE[side].party, value: String(rows.length) },
    ],
    tables: [{ columns: [AMOUNT_COLUMN('Balance'), ...labels.map((l) => AMOUNT_COLUMN(l)), AMOUNT_COLUMN('未冲')], rows: out }],
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

export const AgingReport = ({ side }: { side: AgingSide }) => {
  const [asOf, setAsOf] = useState(() => todayMyt());
  const [basis, setBasis] = useState<AgingBasis>('invoice');
  const [buckets, setBuckets] = useState<AgingBuckets>('month');
  const [control, setControl] = useState<AgingControl>('all');
  const [find, setFind] = useState('');
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const q = useAging(side, { asOf, basis, buckets, control });
  const d = q.data;
  const labels = AGING_COLUMN_LABELS[buckets];
  const words = SIDE[side];

  const rows = useMemo(() => {
    const all = d?.rows ?? [];
    const needle = find.trim().toLowerCase();
    return needle ? all.filter((r) => `${r.code ?? ''} ${r.name}`.toLowerCase().includes(needle)) : all;
  }, [d, find]);
  const toggle = (key: string) => setOpenRows((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const allOpen = rows.length > 0 && rows.every((r) => openRows.has(r.key));
  const fileBase = `${side}-aging-${asOf}`;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
        <span style={soft}>截至 · As at</span>
        <DateField value={asOf} onChange={(v) => setAsOf(v || todayMyt())} aria-label="As at" />
        <span style={soft}>按 · Age by</span>
        <select value={basis} onChange={(e) => setBasis(e.target.value === 'due' ? 'due' : 'invoice')} aria-label="Age by" style={{ fontSize: 'var(--fs-13)' }}>
          <option value="invoice">发票日期 · Invoice date</option>
          <option value="due">Due date</option>
        </select>
        <span style={soft}>分栏 · Columns</span>
        <select value={buckets} onChange={(e) => setBuckets(e.target.value === 'day' ? 'day' : 'month')} aria-label="Columns" style={{ fontSize: 'var(--fs-13)' }}>
          <option value="month">按月 · By month</option>
          <option value="day">按天 · By days</option>
        </select>
        {(['all', 'trade', 'other'] as const).map((k) => (
          <button key={k} type="button" style={chip(control === k)} aria-pressed={control === k} onClick={() => setControl(k)}>
            {k === 'all' ? 'All' : k === 'trade' ? words.trade : words.other}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={`Find a ${words.party.toLowerCase()}`} aria-label={`Find a ${words.party.toLowerCase()}`} style={{ fontSize: 'var(--fs-13)', minWidth: 180 }} />
        <Button variant="ghost" size="sm" disabled={!d} onClick={() => setOpenRows(allOpen ? new Set() : new Set(rows.map((r) => r.key)))}>
          {allOpen ? '汇总 · Summary' : '明细 · Detail'}
        </Button>
        <Button variant="ghost" size="sm" disabled={!d} onClick={() => { if (d) void downloadReportXlsx(agingSheet(side, d, rows, openRows), `${fileBase}.xlsx`); }}>
          <Download size={16} strokeWidth={1.75} /> Excel
        </Button>
        <Button variant="ghost" size="sm" disabled={!d} onClick={() => { if (d) void generateReportPdf(agingSheet(side, d, rows, openRows), { fileName: `${fileBase}.pdf` }); }}>
          <Printer size={16} strokeWidth={1.75} /> PDF
        </Button>
      </div>

      {q.isLoading && <div style={soft} role="status">Working the aging out…</div>}
      {q.isError && <div role="alert" style={{ color: 'var(--c-festive-b, #B8331F)' }}>The aging did not load — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</div>}

      {d && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }} aria-label={words.title}>
            <thead>
              <tr>
                <th style={th}>{words.party}</th>
                <th style={{ ...th, ...num }}>Balance</th>
                {labels.map((l) => <th key={l} style={{ ...th, ...num }}>{l}</th>)}
                <th style={{ ...th, ...num }} title="Money not tied to a bill — a deposit, an advance, a credit note not knocked off">未冲</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={labels.length + 3} style={{ ...td, ...soft }}>{(d.rows.length > 0) ? `No ${words.party.toLowerCase()} matches “${find}”.` : `Nothing owed on these accounts as at ${fmtDateOrDash(d.asOf)}.`}</td></tr>
              )}
              {rows.map((r) => {
                const open = openRows.has(r.key);
                return (
                  <Fragment key={r.key}>
                    <tr>
                      <td style={td}>
                        <button type="button" onClick={() => toggle(r.key)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${r.name}'s bills`}
                          style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'inherit', font: 'inherit', textAlign: 'left' }}>
                          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {r.code && r.code !== r.name ? <span style={{ ...mono, ...soft }}>{r.code}</span> : null}
                          <span>{r.name}</span>
                        </button>
                      </td>
                      <td style={{ ...td, ...num, fontWeight: 600 }}>{money(r.balanceSen)}</td>
                      {r.cells.map((v, i) => <td key={i} style={{ ...td, ...num }}>{money(v)}</td>)}
                      <td style={{ ...td, ...num, color: r.unappliedSen ? 'var(--c-secondary-a, #2F5D4F)' : undefined }}>{money(r.unappliedSen)}</td>
                    </tr>
                    {open && r.items.map((i) => (
                      <tr key={`${r.key}-i-${i.group}-${i.docNo}-${i.date}`} style={{ background: 'var(--c-cream, #f7f5ef)' }}>
                        <td style={{ ...td, paddingLeft: 30 }}>
                          {side === 'ar' && i.group.startsWith('SO:')
                            ? <Link to={`/scm/sales-orders/${encodeURIComponent(i.group.slice(3))}`} style={{ ...mono, color: 'var(--c-orange)' }}>{i.docNo}</Link>
                            : <span style={mono}>{i.docNo}</span>}
                          <span style={soft}> · {i.kind} · {fmtDateOrDash(i.date)}{i.dueDate ? ` · due ${fmtDateOrDash(i.dueDate)}` : ''}{i.openSen !== i.amountSen ? ` · of ${fmtSenPlain(i.amountSen)}` : ''}</span>
                        </td>
                        <td style={td} />
                        {labels.map((_, c) => <td key={c} style={{ ...td, ...num }}>{c === i.column ? fmtSenPlain(i.openSen) : ''}</td>)}
                        <td style={td} />
                      </tr>
                    ))}
                    {open && r.unapplied.map((u) => (
                      <tr key={`${r.key}-u-${u.docNo}-${u.date}-${u.amountSen}`} style={{ background: 'var(--c-cream, #f7f5ef)' }}>
                        <td style={{ ...td, paddingLeft: 30 }}>
                          <span style={mono}>{u.docNo}</span>
                          <span style={soft}> · {u.kind} · {fmtDateOrDash(u.date)} · 未冲</span>
                        </td>
                        <td style={td} />
                        {labels.map((_, c) => <td key={c} style={td} />)}
                        <td style={{ ...td, ...num }}>{fmtSenPlain(u.amountSen)}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--c-ink, #221f20)' }}>
                <td style={td}>Total{find.trim() ? ' (every row)' : ''}</td>
                <td style={{ ...td, ...num }}>{money(d.totals.balanceSen)}</td>
                {d.totals.cells.map((v, i) => <td key={i} style={{ ...td, ...num }}>{money(v)}</td>)}
                <td style={{ ...td, ...num }}>{money(d.totals.unappliedSen)}</td>
              </tr>
            </tbody>
          </table>
          <ul style={{ margin: 'var(--space-3) 0 0', paddingLeft: 18, display: 'grid', gap: 4 }} aria-label="Aging notes">
            {agingNotes(side, d).map((n) => (
              <li key={n} style={{ fontSize: 'var(--fs-12)', color: n.startsWith('In the books') ? (d.differenceSen === 0 ? 'var(--c-green, #2f7d32)' : 'var(--c-festive-b, #B8331F)') : 'var(--fg-muted)' }}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
