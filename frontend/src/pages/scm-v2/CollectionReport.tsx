// ----------------------------------------------------------------------------
// CollectionReport — the Collection tab (owner 2026-09-12: collection report …
// salesman 开了多少单，deposit 收了多少%，overall 的，filter date，below 50% 的我
// 也需要知道; then: 分主要看两个，deposit / sales order amount，一个是看 balance
// paid). Two views over the orders opened in a period (by SO date):
//   DEPOSIT — per salesman: orders, order value, deposit collected, deposit %,
//             and how many orders sit under the threshold (default 50%);
//   BALANCE — of the delivered (or invoiced) orders: balance due after
//             deposit, balance collected, balance %, outstanding — measured
//             against the FINAL INVOICE's total when one exists (docs/bugs/
//             0831), the order's otherwise.
// A salesman opens to the orders behind the figures; "only below" narrows to
// the orders under the line; Export writes the open view as CSV.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useCollectionReport, type CollectionOrder, type CollectionReport, type CollectionRow } from '../../vendor/scm/lib/collection-report-queries';
import { DateField } from '../../vendor/scm/components/DateField';
import { fmtDateOrDash } from '../../vendor/shared/format';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthStart = (): string => `${myt().slice(0, 7)}-01`;

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const danger = 'var(--c-festive-b, #B8331F)';

export const fmtRm = (sen: number): string => {
  const abs = Math.abs(sen) / 100;
  const text = abs.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${text})` : text;
};
const fmtPct = (pct: number): string => `${pct.toFixed(1)}%`;

type View = 'deposit' | 'balance';

/* The CSV of the open view — one line per salesman, then one per order. */
export const collectionCsv = (r: CollectionReport, view: View, onlyBelow: boolean): string => {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines: string[] = [];
  if (view === 'deposit') {
    lines.push(['Salesman', 'Orders', 'Order value', 'Deposit', 'Deposit %', `Below ${r.thresholdPct}%`].map(esc).join(','));
    for (const row of [...r.rows, r.totals]) lines.push([row.salesperson, row.orders, fmtRm(row.totalSen), fmtRm(row.depositSen), fmtPct(row.depositPct), row.belowCount].map(esc).join(','));
    lines.push('');
    lines.push(['Salesman', 'SO', 'Customer', 'SO date', 'Status', 'Order value', 'Deposit', 'Deposit %', 'Outstanding'].map(esc).join(','));
    for (const row of r.rows) for (const o of row.sos.filter((x) => !onlyBelow || x.belowThreshold)) {
      lines.push([row.salesperson, o.docNo, o.customer, o.soDate, o.status, fmtRm(o.totalSen), fmtRm(o.depositSen), fmtPct(o.depositPct), fmtRm(o.outstandingSen)].map(esc).join(','));
    }
  } else {
    lines.push(['Salesman', 'Delivered orders', 'Invoiced value', 'Deposit', 'Balance due', 'Balance paid', 'Balance %', 'Outstanding'].map(esc).join(','));
    for (const row of [...r.rows, r.totals]) {
      const d = row.delivered;
      lines.push([row.salesperson, d.orders, fmtRm(d.billedSen), fmtRm(d.depositSen), fmtRm(d.balanceDueSen), fmtRm(d.balancePaidSen), fmtPct(d.balancePct), fmtRm(d.outstandingSen)].map(esc).join(','));
    }
    lines.push('');
    lines.push(['Salesman', 'SO', 'Invoice', 'Customer', 'SO date', 'Status', 'Invoiced value', 'Deposit', 'Balance due', 'Balance paid', 'Balance %', 'Outstanding'].map(esc).join(','));
    for (const row of r.rows) for (const o of row.sos.filter((x) => x.delivered)) {
      lines.push([row.salesperson, o.docNo, o.invoiceNumber ?? '', o.customer, o.soDate, o.status, fmtRm(o.billedSen), fmtRm(o.depositSen), fmtRm(o.balanceDueSen), fmtRm(o.balancePaidSen), fmtPct(o.balancePct), fmtRm(o.outstandingSen)].map(esc).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
};

const downloadText = (name: string, text: string) => {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

export const CollectionTab = () => {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(myt());
  const [threshold, setThreshold] = useState(50);
  const [view, setView] = useState<View>('deposit');
  const [onlyBelow, setOnlyBelow] = useState(false);
  const [salesperson, setSalesperson] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = useCollectionReport(from, to, threshold, salesperson);
  const r = q.data;

  /* The salesmen the period had, for the filter — read off an unfiltered
     answer so picking one does not empty the list. */
  const [sellers, setSellers] = useState<Array<{ id: string; name: string }>>([]);
  useMemo(() => {
    if (r && salesperson == null) setSellers(r.rows.filter((x) => x.salespersonId).map((x) => ({ id: x.salespersonId as string, name: x.salesperson })));
  }, [r, salesperson]);

  const keyOf = (row: CollectionRow) => row.salespersonId ?? `agent:${row.salesperson}`;
  const toggle = (row: CollectionRow) => setOpen((prev) => {
    const next = new Set(prev); const k = keyOf(row);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>SO date from</span><DateField value={from} onChange={setFrom} aria-label="Collection from" />
        <span style={soft}>to</span><DateField value={to} onChange={setTo} aria-label="Collection to" />
        <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Below
          <input type="number" min={1} max={100} value={threshold} aria-label="Deposit threshold percent"
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0 && n <= 100) setThreshold(n); }}
            style={{ width: 56, padding: '4px 6px', fontSize: 'var(--fs-12)' }} />
          %
        </label>
        <select value={salesperson ?? ''} onChange={(e) => setSalesperson(e.target.value || null)} aria-label="Salesman" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }}>
          <option value="">Every salesman</option>
          {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={() => { if (r) downloadText(`collection-${view}-${from}-${to}.csv`, collectionCsv(r, view, onlyBelow)); }} disabled={!r}>
          <Download size={16} strokeWidth={1.75} /> Export
        </Button>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <div role="tablist" aria-label="Collection view" style={{ display: 'inline-flex', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, overflow: 'hidden' }}>
          {(['deposit', 'balance'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
              style={{ padding: '4px 12px', fontSize: 'var(--fs-12)', border: 'none', cursor: 'pointer', background: view === v ? 'var(--c-ink, #221f20)' : 'transparent', color: view === v ? '#fff' : 'inherit' }}>
              {v === 'deposit' ? 'Deposit' : 'Balance'}
            </button>
          ))}
        </div>
        {view === 'deposit' && (
          <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={onlyBelow} onChange={(e) => setOnlyBelow(e.target.checked)} aria-label="Only orders below the threshold" />
            only orders below {threshold}%
          </label>
        )}
        <span style={soft}>
          {view === 'deposit'
            ? 'Deposit collected against order value, for the orders opened in the period. A salesman opens to the orders.'
            : 'Of the delivered or invoiced orders: the balance after deposit and how much of it has come in — against the final invoice when there is one.'}
        </span>
      </div>

      {q.isLoading && <div style={soft}>Working the period out…</div>}
      {q.isError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>The report did not load — adjust the dates to retry.</div>}
      {r && r.rows.length === 0 && <div style={soft}>No order was opened in this period.</div>}
      {r && r.rows.length > 0 && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              {view === 'deposit' ? (
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Salesman</th>
                  <th style={{ ...th, textAlign: 'right' }}>Orders</th>
                  <th style={{ ...th, textAlign: 'right' }}>Order value</th>
                  <th style={{ ...th, textAlign: 'right' }}>Deposit</th>
                  <th style={{ ...th, textAlign: 'right' }}>Deposit %</th>
                  <th style={{ ...th, textAlign: 'right' }}>Below {r.thresholdPct}%</th>
                </tr>
              ) : (
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Salesman</th>
                  <th style={{ ...th, textAlign: 'right' }}>Delivered</th>
                  <th style={{ ...th, textAlign: 'right' }}>Invoiced value</th>
                  <th style={{ ...th, textAlign: 'right' }}>Deposit</th>
                  <th style={{ ...th, textAlign: 'right' }}>Balance due</th>
                  <th style={{ ...th, textAlign: 'right' }}>Balance paid</th>
                  <th style={{ ...th, textAlign: 'right' }}>Balance %</th>
                  <th style={{ ...th, textAlign: 'right' }}>Outstanding</th>
                </tr>
              )}
            </thead>
            <tbody>
              {r.rows.map((row) => (
                <SellerLines key={keyOf(row)} row={row} view={view} thresholdPct={r.thresholdPct} onlyBelow={onlyBelow}
                  open={open.has(keyOf(row))} onToggle={() => toggle(row)} />
              ))}
              <TotalLine row={r.totals} view={view} />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const SellerLines = ({ row, view, thresholdPct, onlyBelow, open, onToggle }: {
  row: CollectionRow; view: View; thresholdPct: number; onlyBelow: boolean; open: boolean; onToggle: () => void;
}) => {
  const d = row.delivered;
  const orders = view === 'deposit' ? row.sos.filter((o) => !onlyBelow || o.belowThreshold) : row.sos.filter((o) => o.delivered);
  const cell: React.CSSProperties = { padding: '4px 10px' };
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--border-weak, #f0eee8)', background: open ? 'var(--c-cream, #faf7f0)' : undefined }}>
        <td style={cell}>
          <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the orders of ${row.salesperson}`}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit', fontWeight: 600 }}>
            {open ? '▾' : '▸'} {row.salesperson}
          </button>
        </td>
        {view === 'deposit' ? (
          <>
            <td style={{ ...cell, ...num }}>{row.orders}</td>
            <td style={{ ...cell, ...num }}>{fmtRm(row.totalSen)}</td>
            <td style={{ ...cell, ...num }}>{fmtRm(row.depositSen)}</td>
            <td style={{ ...cell, ...num, color: row.depositPct < thresholdPct ? danger : undefined }}>{fmtPct(row.depositPct)}</td>
            <td style={{ ...cell, ...num, color: row.belowCount > 0 ? danger : undefined }}>{row.belowCount}</td>
          </>
        ) : (
          <>
            <td style={{ ...cell, ...num }}>{d.orders}</td>
            <td style={{ ...cell, ...num }}>{fmtRm(d.billedSen)}</td>
            <td style={{ ...cell, ...num }}>{fmtRm(d.depositSen)}</td>
            <td style={{ ...cell, ...num }}>{fmtRm(d.balanceDueSen)}</td>
            <td style={{ ...cell, ...num }}>{fmtRm(d.balancePaidSen)}</td>
            <td style={{ ...cell, ...num }}>{fmtPct(d.balancePct)}</td>
            <td style={{ ...cell, ...num, color: d.outstandingSen > 0 ? danger : undefined }}>{fmtRm(d.outstandingSen)}</td>
          </>
        )}
      </tr>
      {open && orders.length === 0 && (
        <tr><td colSpan={view === 'deposit' ? 6 : 8} style={{ padding: '2px 10px 6px 28px', ...soft }}>{view === 'deposit' ? 'No order under the line.' : 'No delivered order in the period.'}</td></tr>
      )}
      {open && orders.map((o) => <OrderLine key={o.docNo} o={o} view={view} />)}
    </>
  );
};

const OrderLine = ({ o, view }: { o: CollectionOrder; view: View }) => {
  const cell: React.CSSProperties = { padding: '2px 10px', fontSize: 'var(--fs-12)' };
  return (
    <tr data-order={o.docNo} style={{ background: 'var(--c-cream, #faf7f0)' }}>
      <td style={{ ...cell, paddingLeft: 28 }}>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{o.docNo}</span>{o.invoiceNumber ? <> · <span style={{ fontFamily: 'var(--font-mono)' }}>{o.invoiceNumber}</span></> : null} · {o.customer ?? '—'} · {fmtDateOrDash(o.soDate)} · {o.status.replace(/_/g, ' ').toLowerCase()}
      </td>
      {view === 'deposit' ? (
        <>
          <td style={{ ...cell, ...num }} />
          <td style={{ ...cell, ...num }}>{fmtRm(o.totalSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(o.depositSen)}</td>
          <td style={{ ...cell, ...num, color: o.belowThreshold ? danger : undefined }}>{fmtPct(o.depositPct)}</td>
          <td style={{ ...cell, ...num }}>{o.belowThreshold ? 'below' : ''}</td>
        </>
      ) : (
        <>
          <td style={{ ...cell, ...num }} />
          <td style={{ ...cell, ...num }}>{fmtRm(o.billedSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(o.depositSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(o.balanceDueSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(o.balancePaidSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtPct(o.balancePct)}</td>
          <td style={{ ...cell, ...num, color: o.outstandingSen > 0 ? danger : undefined }}>{fmtRm(o.outstandingSen)}</td>
        </>
      )}
    </tr>
  );
};

const TotalLine = ({ row, view }: { row: CollectionRow; view: View }) => {
  const d = row.delivered;
  const cell: React.CSSProperties = { padding: '6px 10px', fontWeight: 700 };
  return (
    <tr style={{ borderTop: '2px solid var(--c-ink, #221f20)' }}>
      <td style={cell}>Total</td>
      {view === 'deposit' ? (
        <>
          <td style={{ ...cell, ...num }}>{row.orders}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(row.totalSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(row.depositSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtPct(row.depositPct)}</td>
          <td style={{ ...cell, ...num }}>{row.belowCount}</td>
        </>
      ) : (
        <>
          <td style={{ ...cell, ...num }}>{d.orders}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(d.totalSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(d.depositSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(d.balanceDueSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(d.balancePaidSen)}</td>
          <td style={{ ...cell, ...num }}>{fmtPct(d.balancePct)}</td>
          <td style={{ ...cell, ...num }}>{fmtRm(d.outstandingSen)}</td>
        </>
      )}
    </tr>
  );
};
