// ----------------------------------------------------------------------------
// MerchantChargesReport — the Merchant charges tab (owner 2026-09-12: 我需要知道
// merchant charge 多少%，就是 charge / received amount，每个月的然后每个 merchant
// … 每个不同 merchant 都要能看到，我指的是 gross … 每个月全部 merchant 加起来的%).
// A month is a block: its line across every merchant first, then a line per
// merchant; a merchant opens to the reports (files) behind it. The fee % is
// the merchant's fee against the gross; the bank's own payout charge sits
// beside it and the two together are the total charge %. Export writes the
// table as CSV.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useMerchantChargesReport, type ChargeFigures, type MerchantChargesReport } from '../../vendor/scm/lib/merchant-charges-queries';
import { fmtDateOrDash } from '../../vendor/shared/format';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const thisMonth = (): string => myt().slice(0, 7);
const monthsAgo = (n: number): string => {
  const [y, m] = thisMonth().split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 - n, 1));
  return d.toISOString().slice(0, 7);
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const danger = 'var(--c-festive-b, #B8331F)';

const fmtRm = (sen: number): string => {
  const abs = Math.abs(sen) / 100;
  const text = abs.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${text})` : text;
};
const fmtPct = (pct: number): string => `${pct.toFixed(1)}%`;
/* Months read as the ISO word the data carries, 2026-06 — no month-name table,
   no locale (the date-format gate's rule). */

const COLUMNS = ['Month / merchant', 'Lines', 'Gross', 'Merchant fee', 'Fee %', 'Bank charge', 'Total charge', 'Charge %', 'Net'] as const;

/* The table as CSV: a month line, its merchants, their reports. */
export const merchantChargesCsv = (r: MerchantChargesReport): string => {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const figures = (f: ChargeFigures) => [f.lines, fmtRm(f.grossSen), fmtRm(f.feeSen), fmtPct(f.feePct), fmtRm(f.bankChargeSen), fmtRm(f.chargeSen), fmtPct(f.chargePct), fmtRm(f.netSen)];
  const lines: string[] = [COLUMNS.map(esc).join(',')];
  for (const m of r.months) {
    lines.push([`${m.month} · all merchants`, ...figures(m)].map(esc).join(','));
    for (const a of m.acquirers) {
      lines.push([`${m.month} · ${a.acquirer}`, ...figures(a)].map(esc).join(','));
      for (const rep of a.reports) lines.push([`${m.month} · ${a.acquirer} · ${rep.fileName ?? `batch ${rep.batchId}`}`, ...figures(rep)].map(esc).join(','));
    }
  }
  lines.push(['Total', ...figures(r.totals)].map(esc).join(','));
  return `${lines.join('\n')}\n`;
};

const downloadText = (name: string, text: string) => {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

export const MerchantChargesTab = () => {
  const [from, setFrom] = useState(monthsAgo(5));
  const [to, setTo] = useState(thisMonth());
  const [acquirer, setAcquirer] = useState<string | null>(null);
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = useMerchantChargesReport(from, to, acquirer, confirmedOnly);
  const r = q.data;

  /* The merchants the range had, for the filter — remembered off an
     unfiltered answer so picking one does not empty the list. */
  const [merchants, setMerchants] = useState<string[]>([]);
  useMemo(() => {
    if (r && acquirer == null) setMerchants([...new Set(r.months.flatMap((m) => m.acquirers.map((a) => a.acquirer)))].sort());
  }, [r, acquirer]);

  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>From month</span>
        <input type="month" value={from} onChange={(e) => { if (e.target.value) setFrom(e.target.value); }} aria-label="Merchant charges from month" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }} />
        <span style={soft}>to</span>
        <input type="month" value={to} onChange={(e) => { if (e.target.value) setTo(e.target.value); }} aria-label="Merchant charges to month" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }} />
        <select value={acquirer ?? ''} onChange={(e) => setAcquirer(e.target.value || null)} aria-label="Merchant" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }}>
          <option value="">Every merchant</option>
          {merchants.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} aria-label="Confirmed lines only" />
          confirmed lines only
        </label>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={() => { if (r) downloadText(`merchant-charges-${from}-${to}.csv`, merchantChargesCsv(r)); }} disabled={!r}>
          <Download size={16} strokeWidth={1.75} /> Export
        </Button>
      </div>
      <div style={soft}>
        Fee % is the merchant's fee against the gross they reported. Bank charge is what the bank took on the payout day (booked on Payment advice); Charge % is fee and bank charge together against the gross. A merchant opens to its reports.
      </div>

      {q.isLoading && <div style={soft}>Working the months out…</div>}
      {q.isError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>The report did not load — adjust the months to retry.</div>}
      {r && r.months.length === 0 && <div style={soft}>No merchant report in these months.</div>}
      {r && r.months.length > 0 && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr>{COLUMNS.map((c, i) => <th key={c} style={{ ...th, textAlign: i === 0 ? 'left' : 'right' }}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {r.months.map((m) => (
                <MonthBlock key={m.month} month={m} open={open} onToggle={toggle} />
              ))}
              <FigureLine label="Total" figures={r.totals} strong indent={0} />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const MonthBlock = ({ month, open, onToggle }: { month: MerchantChargesReport['months'][number]; open: Set<string>; onToggle: (key: string) => void }) => (
  <>
    <FigureLine label={`${month.month} · all merchants`} figures={month} strong indent={0} top />
    {month.acquirers.map((a) => {
      const key = `${month.month}|${a.acquirer}`;
      return (
        <MerchantLines key={key} label={a.acquirer} figures={a} reports={a.reports} isOpen={open.has(key)} onToggle={() => onToggle(key)} monthLabel={month.month} />
      );
    })}
  </>
);

const Cells = ({ f }: { f: ChargeFigures }) => {
  const cell: React.CSSProperties = { padding: '4px 10px', ...num };
  return (
    <>
      <td style={cell}>{f.lines}</td>
      <td style={cell}>{fmtRm(f.grossSen)}</td>
      <td style={cell}>{fmtRm(f.feeSen)}</td>
      <td style={cell}>{fmtPct(f.feePct)}</td>
      <td style={{ ...cell, color: f.bankChargeSen > 0 ? danger : undefined }}>{f.bankChargeSen > 0 ? fmtRm(f.bankChargeSen) : '—'}</td>
      <td style={cell}>{fmtRm(f.chargeSen)}</td>
      <td style={cell}>{fmtPct(f.chargePct)}</td>
      <td style={cell}>{fmtRm(f.netSen)}</td>
    </>
  );
};

const FigureLine = ({ label, figures, strong, indent, top }: { label: string; figures: ChargeFigures; strong?: boolean; indent: number; top?: boolean }) => (
  <tr style={{ borderTop: top ? '2px solid var(--c-ink, #221f20)' : '1px solid var(--border-weak, #f0eee8)', fontWeight: strong ? 700 : 400 }}>
    <td style={{ padding: '6px 10px', paddingLeft: 10 + indent }}>{label}</td>
    <Cells f={figures} />
  </tr>
);

const MerchantLines = ({ label, figures, reports, isOpen, onToggle, monthLabel }: {
  label: string; figures: ChargeFigures; reports: MerchantChargesReport['months'][number]['acquirers'][number]['reports'];
  isOpen: boolean; onToggle: () => void; monthLabel: string;
}) => (
  <>
    <tr style={{ borderTop: '1px solid var(--border-weak, #f0eee8)', background: isOpen ? 'var(--c-cream, #faf7f0)' : undefined }}>
      <td style={{ padding: '4px 10px 4px 28px' }}>
        <button type="button" onClick={onToggle} aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} the reports of ${label} for ${monthLabel}`}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit', fontWeight: 600 }}>
          {isOpen ? '▾' : '▸'} {label}
        </button>
      </td>
      <Cells f={figures} />
    </tr>
    {isOpen && reports.map((rep) => (
      <tr key={rep.batchId} data-report={rep.batchId} style={{ background: 'var(--c-cream, #faf7f0)', fontSize: 'var(--fs-12)' }}>
        <td style={{ padding: '2px 10px 2px 46px' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{rep.fileName ?? `batch ${rep.batchId}`}</span>
          <span style={soft}> · {fmtDateOrDash(rep.periodFrom)}{rep.periodTo && rep.periodTo !== rep.periodFrom ? ` → ${fmtDateOrDash(rep.periodTo)}` : ''}</span>
        </td>
        <Cells f={rep} />
      </tr>
    ))}
  </>
);
