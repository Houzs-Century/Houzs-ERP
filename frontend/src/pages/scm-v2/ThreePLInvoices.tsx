// ----------------------------------------------------------------------------
// 3PL invoices (HC-0031): key in what a transporter billed for each delivery
// order AFTER delivery, and see it beside what its rate card says it should
// cost. Route: backend/src/scm/routes/threepl-do-charges.ts.
//
// Per DO, not per trip: 3PL work is not planned as trips (prod had 0 trips on
// 14 Oct), so the Reconciliation tab next door stays empty for them.
//
// From an AP invoice (owner 2026-10-23): the rows can come from the bill
// attached to the AP invoice Finance keyed (ThreePLFromAp.tsx) instead of
// being typed; the By company line shows what 2990's deliveries cost, which
// Houzs bills back. Since 2026-10-24 such a bill is read by itself every half
// hour; what is not on a DO waits under To check (ThreePLBillLines.tsx).
// ----------------------------------------------------------------------------
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { fmtDate, fmtSen } from '@2990s/shared';
import { useAuth } from '../../auth/AuthContext';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { useThreePLCompanies } from '../../vendor/scm/lib/threepl-companies-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { DateField } from '../../vendor/scm/components/DateField';
import { ThreePLFromAp, toSen } from './ThreePLFromAp';
import { BillsFromAp, type BillSummary } from './ThreePLBillLines';
import styles from './Suppliers.module.css';

export { toSen };

export interface ChargeRow {
  id: string; doNumber: string | null; doDate: string | null; doStatus: string | null;
  customer: string | null; doCompanyCode: string | null; carrierId: string; carrierName: string | null;
  cardName: string | null; invoiceNo: string | null; invoiceDate: string | null;
  billedSen: number; expectedSen: number | null; varianceSen: number | null; note: string | null;
  /** The AP invoice the row was brought in from; null when keyed by hand. */
  apInvoiceId?: string | null;
}
interface InvoiceTotal {
  carrierId: string; carrierName: string | null; invoiceNo: string | null; dos: number;
  billedSen: number; expectedSen: number | null; varianceSen: number | null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const variance = (v: number | null) => (v == null
  ? <span style={{ color: 'var(--fg-muted)' }}>no rate card</span>
  : <span style={{ color: v === 0 ? 'var(--c-secondary-a, #16a34a)' : 'var(--c-danger, #dc2626)', fontWeight: v === 0 ? 400 : 600 }}>
      {v === 0 ? 'matches' : `${v > 0 ? '+' : '−'}${fmtSen(Math.abs(v))}`}
    </span>);
const money = { align: 'right' as const, exportFormat: 'money' as const };

const TOTAL_COLUMNS: Column<InvoiceTotal>[] = [
  { key: 'carrier', label: '3PL', render: (r) => r.carrierName ?? '—', getValue: (r) => r.carrierName ?? '' },
  { key: 'inv', label: 'Invoice no', render: (r) => r.invoiceNo ?? '—', getValue: (r) => r.invoiceNo ?? '' },
  { key: 'dos', label: 'DOs', align: 'right', render: (r) => r.dos, getValue: (r) => r.dos },
  { key: 'billed', label: 'Billed', ...money, render: (r) => fmtSen(r.billedSen), getValue: (r) => r.billedSen, exportValue: (r) => r.billedSen / 100 },
  { key: 'expected', label: 'Rate card', ...money, render: (r) => (r.expectedSen == null ? '—' : fmtSen(r.expectedSen)), getValue: (r) => r.expectedSen, exportValue: (r) => (r.expectedSen == null ? null : r.expectedSen / 100) },
  { key: 'var', label: 'Difference', ...money, render: (r) => variance(r.varianceSen), getValue: (r) => r.varianceSen, exportValue: (r) => (r.varianceSen == null ? null : r.varianceSen / 100) },
];

export const ThreePLInvoices = () => {
  const qc = useQueryClient();
  const carriers = useThreePLCompanies();
  const [range, setRange] = useState({ from: '', to: '' });
  const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const list = useQuery({
    queryKey: ['threepl-do-charges', range.from, range.to],
    queryFn: () => authedFetch<{ rows: ChargeRow[]; invoices: InvoiceTotal[]; bills?: BillSummary[] }>(`/threepl-do-charges${qs ? `?${qs}` : ''}`),
  });
  const blank = { doNumber: '', threeplCompanyId: '', invoiceNo: '', invoiceDate: '', billed: '', note: '' };
  const [form, setForm] = useState(blank);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromAp, setFromAp] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  /* The AP invoice is Finance's — the API refuses anyone else (threepl-from-ap.ts). */
  const mayBringIn = useAuth().can('scm.finance.accounting');
  const set = (k: keyof typeof blank) => (v: string) => setForm((s) => ({ ...s, [k]: v }));
  const refresh = () => qc.invalidateQueries({ queryKey: ['threepl-do-charges'] });
  /* What each company's deliveries cost on this list — 2990's are Houzs's to
     bill back (owner 2026-10-23). Shown only when more than one company. */
  const byCompany = Object.entries((list.data?.rows ?? []).reduce<Record<string, { dos: number; sen: number }>>((m, r) => {
    const k = r.doCompanyCode ?? '—';
    const t = m[k] ?? { dos: 0, sen: 0 };
    t.dos += 1; t.sen += r.billedSen;
    m[k] = t;
    return m;
  }, {}));

  const save = async () => {
    const billedSen = toSen(form.billed);
    if (!form.doNumber.trim() || !form.threeplCompanyId || billedSen == null) {
      setErr('Enter the DO number, the 3PL and the billed amount.'); return;
    }
    setBusy(true); setErr(null);
    try {
      await authedFetch('/threepl-do-charges', {
        method: 'PUT',
        body: JSON.stringify({ ...form, billedSen, invoiceDate: form.invoiceDate || null }),
      });
      // Keep the 3PL, invoice no and date: one invoice usually covers many DOs.
      setForm((s) => ({ ...s, doNumber: '', billed: '', note: '' }));
      await refresh();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setErr(null);
    try { await authedFetch(`/threepl-do-charges/${id}`, { method: 'DELETE' }); await refresh(); } catch (e) { setErr(errText(e)); }
  };

  const columns: Column<ChargeRow>[] = [
    { key: 'do', label: 'DO', render: (r) => r.doNumber ?? '—', getValue: (r) => r.doNumber ?? '' },
    { key: 'co', label: 'Co.', render: (r) => r.doCompanyCode ?? '—', getValue: (r) => r.doCompanyCode ?? '' },
    { key: 'date', label: 'DO date', render: (r) => (r.doDate ? fmtDate(r.doDate) : '—'), getValue: (r) => r.doDate, exportFormat: 'date' },
    { key: 'cust', label: 'Customer', render: (r) => r.customer ?? '—', getValue: (r) => r.customer ?? '' },
    { key: 'carrier', label: '3PL', render: (r) => r.carrierName ?? '—', getValue: (r) => r.carrierName ?? '' },
    { key: 'inv', label: 'Invoice', render: (r) => [r.invoiceNo, r.invoiceDate && fmtDate(r.invoiceDate)].filter(Boolean).join(' · ') || '—', getValue: (r) => r.invoiceNo ?? '' },
    { key: 'billed', label: 'Billed', ...money, render: (r) => fmtSen(r.billedSen), getValue: (r) => r.billedSen, exportValue: (r) => r.billedSen / 100 },
    { key: 'expected', label: 'Rate card', ...money, render: (r) => (r.expectedSen == null ? '—' : fmtSen(r.expectedSen)), getValue: (r) => r.expectedSen, exportValue: (r) => (r.expectedSen == null ? null : r.expectedSen / 100) },
    { key: 'var', label: 'Difference', ...money, render: (r) => variance(r.varianceSen), getValue: (r) => r.varianceSen, exportValue: (r) => (r.varianceSen == null ? null : r.varianceSen / 100) },
    { key: 'note', label: 'Note', render: (r) => r.note ?? '', getValue: (r) => r.note ?? '' },
    {
      key: 'x', label: '', render: (r) => (
        <button type="button" aria-label={`Remove ${r.doNumber ?? 'row'}`} onClick={() => void remove(r.id)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)' }}>
          <Trash2 size={14} />
        </button>
      ),
    },
  ];

  const field = (label: string, k: keyof typeof blank, width = 150) => (
    <label className={styles.field} style={{ maxWidth: width }}>
      <span className={styles.fieldLabel}>{label}</span>
      <input className={styles.fieldInput} aria-label={label} value={form[k]} onChange={(e) => set(k)(e.target.value)} />
    </label>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        When a transporter's bill is attached to its AP invoice, it is read by itself within half an hour: the lines naming a DO are kept on that DO, and the rest wait under To check for you to say where they go. You can also read a bill yourself (From AP invoice) or key in what was billed for each delivery order. The rate card amount is worked out from the DO's sets / items and delivery zone; extras (setup, dismantle, disposal) and the per-trip outstation fee are not on the DO, so they show as a difference to check.
      </p>
      {mayBringIn && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="primary" size="sm" onClick={() => { setFromAp(true); setSaid(null); }} disabled={fromAp}>From AP invoice</Button>
          {said && <span role="status" style={{ fontSize: 'var(--fs-12)' }}>{said}</span>}
        </div>
      )}
      {fromAp && (
        <ThreePLFromAp
          onClose={() => setFromAp(false)}
          onSaved={(m) => {
            setFromAp(false); setSaid(m);
            void refresh();
            void qc.invalidateQueries({ queryKey: ['threepl-from-ap'] });
          }}
        />
      )}
      {mayBringIn && (list.data?.bills?.length ?? 0) > 0 && <BillsFromAp bills={list.data?.bills ?? []} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {field('DO number', 'doNumber')}
        <label className={styles.field} style={{ maxWidth: 220 }}>
          <span className={styles.fieldLabel}>3PL</span>
          <select className={styles.fieldInput} aria-label="3PL" value={form.threeplCompanyId} onChange={(e) => set('threeplCompanyId')(e.target.value)}>
            <option value="">Choose…</option>
            {(carriers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {field('Invoice no', 'invoiceNo')}
        <label className={styles.field} style={{ maxWidth: 150 }}>
          <span className={styles.fieldLabel}>Invoice date</span>
          <DateField className={styles.fieldInput} value={form.invoiceDate} onChange={set('invoiceDate')} fullWidth />
        </label>
        {field('Billed (RM)', 'billed', 120)}
        {field('Note', 'note', 220)}
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>Save</Button>
      </div>
      {err && <p role="alert" style={{ margin: 0, color: 'var(--c-danger, #dc2626)', fontSize: 'var(--fs-12)' }}>{err}</p>}

      <h3 style={{ margin: '8px 0 0', fontSize: 'var(--fs-13)' }}>Per invoice</h3>
      <DataTable<InvoiceTotal>
        tableId="threepl-invoice-totals" exportName="3pl-invoice-totals" exportXlsx
        columns={TOTAL_COLUMNS} rows={list.data?.invoices ?? null} loading={list.isLoading}
        error={list.isError ? errText(list.error) : null} emptyLabel="No 3PL invoices keyed in yet."
        getRowKey={(r) => `${r.carrierId}|${r.invoiceNo ?? ''}`}
      />
      <h3 style={{ margin: '8px 0 0', fontSize: 'var(--fs-13)' }}>Per delivery order</h3>
      {byCompany.length > 1 && (
        <p style={{ margin: 0, fontSize: 'var(--fs-12)' }}>
          By company: {byCompany.map(([code, t]) => `${code} ${t.dos} DO${t.dos === 1 ? '' : 's'} · ${fmtSen(t.sen)}`).join('  ·  ')}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        {(['from', 'to'] as const).map((k) => (
          <label key={k} className={styles.field} style={{ maxWidth: 150 }}>
            <span className={styles.fieldLabel}>{k === 'from' ? 'Invoice date from' : 'To'}</span>
            <DateField className={styles.fieldInput} value={range[k]} onChange={(v) => setRange((s) => ({ ...s, [k]: v }))} fullWidth />
          </label>
        ))}
      </div>
      <DataTable<ChargeRow>
        tableId="threepl-do-charges" exportName="3pl-do-charges" exportXlsx
        columns={columns} rows={list.data?.rows ?? null} loading={list.isLoading}
        error={list.isError ? errText(list.error) : null} emptyLabel="No DOs keyed in for this range."
        getRowKey={(r) => r.id}
        getRowStyle={(r) => (r.varianceSen ? { background: 'rgba(220,38,38,0.06)' } : undefined)}
      />
    </div>
  );
};
