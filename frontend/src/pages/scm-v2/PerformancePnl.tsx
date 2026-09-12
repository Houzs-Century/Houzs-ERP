// ----------------------------------------------------------------------------
// PerformancePnl — the Performance P&L tab (owner 2026-09-12: 我还要多一份
// performance P&L，就是 sales 和 COGS 的数额是根据 sales order 的，expense 其他
// remain，但是 expense 的 operating 要根据 sales 的 16% 来算 … 分成 bedframe,
// mattress, sofa, dining, accessory, service … 16% 要设计成可调 … 只取代 900-O001，
// 然后在 performance P&L 要注明 … 放 finance report, CSV, PDF, 每组显示 gross
// profit 和 %; docs/bugs/0835). The numbers come from
// GET /accounting/reports/performance, computed live on every read; the rate
// and the account it stands in for are the company's settings, edited here.
// Export writes the CSV, PDF the printable — both off the same pure lines
// the screen draws.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DateField } from '../../vendor/scm/components/DateField';
import { downloadCSV, toCSV } from '../../lib/csv';
import {
  fmtPerf, fmtPerfPct, performanceNotes, performanceSummaryLines, usePerformanceReport, useSavePerformanceSettings,
  type PerformanceReport,
} from '../../vendor/scm/lib/performance-report-queries';
import { generatePerformancePdf } from '../../vendor/scm/lib/performance-pnl-pdf';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthStart = (): string => `${myt().slice(0, 7)}-01`;
const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left' };
const td: React.CSSProperties = { padding: '5px 10px', fontSize: 'var(--fs-13)', borderBottom: '1px solid var(--border-weak, #f0eee8)' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const danger = 'var(--c-festive-b, #B8331F)';
const good = 'var(--c-secondary-a, #2F5D4F)';
const input: React.CSSProperties = { padding: '4px 8px', fontSize: 'var(--fs-13)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6 };

/* The CSV: the groups table, the summary lines, the notes — the same lines
   the screen and the PDF read. */
export const performanceCsv = (r: PerformanceReport): string => {
  const groupRows = [
    ...r.groups.map((g) => ({ label: g.label, salesSen: g.salesSen, cogsSen: g.cogsSen, gpSen: g.gpSen, gpPct: g.gpPct })),
    { label: 'Total', salesSen: r.totals.salesSen, cogsSen: r.totals.cogsSen, gpSen: r.totals.gpSen, gpPct: r.totals.gpPct },
  ];
  const groups = toCSV(groupRows, [
    { key: 'group', label: 'Group', getValue: (x) => x.label },
    { key: 'sales', label: 'Sales', getValue: (x) => fmtPerf(x.salesSen) },
    { key: 'cogs', label: 'Cost of sales', getValue: (x) => fmtPerf(x.cogsSen) },
    { key: 'gp', label: 'Gross profit', getValue: (x) => fmtPerf(x.gpSen) },
    { key: 'pct', label: 'GP %', getValue: (x) => fmtPerfPct(x.gpPct) },
  ]);
  const summary = toCSV(performanceSummaryLines(r), [
    { key: 'line', label: 'Line', getValue: (l) => l.label },
    { key: 'amount', label: 'Amount', getValue: (l) => fmtPerf(l.amountSen) },
    { key: 'note', label: 'Note', getValue: (l) => l.note ?? '' },
  ]);
  const notes = toCSV(performanceNotes(r).map((n) => ({ n })), [{ key: 'note', label: 'Notes', getValue: (x) => x.n }]);
  return `${toCSV([{ p: `${r.from} to ${r.to}` }], [{ key: 'p', label: 'Performance P&L', getValue: (x) => x.p }])}\r\n\r\n${groups}\r\n\r\n${summary}\r\n\r\n${notes}`;
};

export const PerformanceTab = () => {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(myt());
  const q = usePerformanceReport(from, to);
  const r = q.data;
  const save = useSavePerformanceSettings();
  const [draft, setDraft] = useState<{ ratePct: string; account: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const v = draft ?? { ratePct: r ? (r.settings.rateBp / 100).toFixed(2) : '', account: r?.settings.account ?? '' };

  const saveSettings = () => {
    const rateBp = Math.round(Number(v.ratePct) * 100);
    if (v.ratePct.trim() === '' || !Number.isFinite(rateBp) || rateBp < 0 || rateBp > 10000) { setNote('The rate must be between 0% and 100%.'); return; }
    if (v.account.trim() === '') { setNote('Name the account the rate stands in for.'); return; }
    save.mutate({ rateBp, account: v.account.trim() }, {
      onSuccess: (res) => { setDraft(null); setNote(`Saved — ${(res.settings.rateBp / 100).toFixed(2)}% in place of ${res.settings.account}.`); },
      onError: (e) => setNote(errText(e)),
    });
  };

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>SO date from</span><DateField value={from} onChange={setFrom} aria-label="Performance from" />
        <span style={soft}>to</span><DateField value={to} onChange={setTo} aria-label="Performance to" />
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={() => { if (r) downloadCSV(`performance-pnl-${from}-${to}.csv`, performanceCsv(r)); }} disabled={!r}>
          <Download size={16} strokeWidth={1.75} /> Export
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { if (r) void generatePerformancePdf(r); }} disabled={!r}>
          <Printer size={16} strokeWidth={1.75} /> PDF
        </Button>
      </div>

      <section style={{ ...card, display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }} aria-label="Performance settings">
        <span>Operating expense =</span>
        <input type="number" min={0} max={100} step="0.01" value={v.ratePct} onChange={(e) => setDraft({ ...v, ratePct: e.target.value })}
          aria-label="Operating expense rate percent" style={{ ...input, width: 80, textAlign: 'right' }} />
        <span>% of sales excluding service, in place of account</span>
        <input value={v.account} onChange={(e) => setDraft({ ...v, account: e.target.value })} aria-label="Operating expense account" style={{ ...input, width: 120, fontFamily: 'var(--font-mono)' }} />
        {r && (r.operatingExpense.accountFound
          ? <span style={soft}>{r.operatingExpense.accountName}</span>
          : <span style={{ ...soft, color: danger }}>not in this company's chart</span>)}
        <Button size="sm" disabled={draft == null || save.isPending} onClick={saveSettings}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        {note && <span style={{ ...soft, color: note.startsWith('Saved') ? good : danger }}>{note}</span>}
      </section>

      {q.isLoading && <div style={soft}>Working the period out…</div>}
      {q.isError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>The report did not load — {errText(q.error)}</div>}
      {r && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Group</th><th style={{ ...th, textAlign: 'right' }}>Sales</th><th style={{ ...th, textAlign: 'right' }}>Cost of sales</th>
                <th style={{ ...th, textAlign: 'right' }}>Gross profit</th><th style={{ ...th, textAlign: 'right' }}>GP %</th>
              </tr>
            </thead>
            <tbody>
              {r.groups.map((g) => (
                <tr key={g.key} data-group={g.key}>
                  <td style={td}>{g.label}<span style={soft}> · {g.lines} {g.lines === 1 ? 'line' : 'lines'}</span></td>
                  <td style={{ ...td, ...num }}>{fmtPerf(g.salesSen)}</td>
                  <td style={{ ...td, ...num }}>{fmtPerf(g.cogsSen)}</td>
                  <td style={{ ...td, ...num, color: g.gpSen < 0 ? danger : undefined }}>{fmtPerf(g.gpSen)}</td>
                  <td style={{ ...td, ...num }}>{fmtPerfPct(g.gpPct)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--c-ink, #221f20)' }}>
                <td style={td}>Total<span style={{ ...soft, fontWeight: 400 }}> · {r.orders.counted} orders, {r.orders.notDelivered} not yet delivered</span></td>
                <td style={{ ...td, ...num }}>{fmtPerf(r.totals.salesSen)}</td>
                <td style={{ ...td, ...num }}>{fmtPerf(r.totals.cogsSen)}</td>
                <td style={{ ...td, ...num }}>{fmtPerf(r.totals.gpSen)}</td>
                <td style={{ ...td, ...num }}>{fmtPerfPct(r.totals.gpPct)}</td>
              </tr>
            </tbody>
          </table>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 'var(--space-3)' }} aria-label="Performance summary">
            <tbody>
              {performanceSummaryLines(r).map((l, i) => (
                <tr key={i} style={l.kind === 'net' ? { fontWeight: 700, borderTop: '2px solid var(--c-ink, #221f20)' } : l.kind === 'total' ? { fontWeight: 600 } : undefined}>
                  <td style={{ ...td, paddingLeft: l.kind === 'row' ? 24 : 10 }}>{l.label}</td>
                  <td style={{ ...td, ...num, color: l.kind === 'net' && l.amountSen < 0 ? danger : undefined }}>{fmtPerf(l.amountSen)}</td>
                  <td style={{ ...td, ...soft, whiteSpace: 'nowrap' }}>{l.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul style={{ ...soft, margin: 0, padding: 'var(--space-3) var(--space-3) var(--space-3) 28px' }} aria-label="Performance notes">
            {performanceNotes(r).map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
};
