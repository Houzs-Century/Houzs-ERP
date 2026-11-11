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
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { fmtDate, fmtSen } from '@2990s/shared';
import { useAuth } from '../../auth/AuthContext';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { useThreePLCompanies } from '../../vendor/scm/lib/threepl-companies-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { DateField } from '../../vendor/scm/components/DateField';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { ThreePLFromAp, toSen } from './ThreePLFromAp';
import { BillsFromAp, type BillSummary } from './ThreePLBillLines';
import { BTN_PRI, BTN_QUIET, CARD, DiffPill, FilterBar, INPUT, Kpi, KpiStrip, LABEL, TableCard, diffTone } from './carriers/ui';
import { chargeTotals } from './carriers/reconcile';

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

/** The 409 PUT answers when the DO already has a row for this 3PL. */
const alreadyKeyed = (e: unknown): { billedSen: number; invoiceNo: string | null } | null => {
  const err = e as { status?: number; body?: string } | null;
  if (err?.status !== 409 || !err.body) return null;
  try {
    const b = JSON.parse(err.body) as { error?: string; existing?: { billedSen: number; invoiceNo: string | null } };
    return b.error === 'already_keyed' && b.existing ? b.existing : null;
  } catch { return null; }
};
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
/** Billed less the rate card, as a coloured pill (carriers/ui.tsx DiffPill). */
export const variance = (v: number | null) => <DiffPill v={v} />;
const money = { align: 'right' as const, exportFormat: 'money' as const };

const TOTAL_COLUMNS: Column<InvoiceTotal>[] = [
  { key: 'carrier', label: '3PL', render: (r) => r.carrierName ?? '—', getValue: (r) => r.carrierName ?? '' },
  { key: 'inv', label: 'Invoice no', render: (r) => r.invoiceNo ?? '—', getValue: (r) => r.invoiceNo ?? '' },
  { key: 'dos', label: 'DOs', align: 'right', render: (r) => r.dos, getValue: (r) => r.dos },
  { key: 'billed', label: 'Billed', ...money, render: (r) => <span className="tabular-nums">{fmtSen(r.billedSen)}</span>, getValue: (r) => r.billedSen, exportValue: (r) => r.billedSen / 100 },
  { key: 'expected', label: 'Rate card', ...money, render: (r) => (r.expectedSen == null ? '—' : <span className="tabular-nums">{fmtSen(r.expectedSen)}</span>), getValue: (r) => r.expectedSen, exportValue: (r) => (r.expectedSen == null ? null : r.expectedSen / 100) },
  { key: 'var', label: 'Difference', ...money, render: (r) => variance(r.varianceSen), getValue: (r) => r.varianceSen, exportValue: (r) => (r.varianceSen == null ? null : r.varianceSen / 100) },
];

/** The DO charges keyed in or read off 3PL bills, by invoice date. Also what the
 *  Reconciliation tab compares against the rate cards. */
export function useThreePLDoCharges(range: { from: string; to: string }) {
  const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  return useQuery({
    queryKey: ['threepl-do-charges', range.from, range.to],
    queryFn: () => authedFetch<{ rows: ChargeRow[]; invoices: InvoiceTotal[]; bills?: BillSummary[] }>(`/threepl-do-charges${qs ? `?${qs}` : ''}`),
  });
}

export const ThreePLInvoices = () => {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const carriers = useThreePLCompanies();
  const [range, setRange] = useState({ from: '', to: '' });
  const list = useThreePLDoCharges(range);
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
    const put = (replace: boolean) => authedFetch('/threepl-do-charges', {
      method: 'PUT',
      body: JSON.stringify({ ...form, billedSen, invoiceDate: form.invoiceDate || null, replace }),
    });
    try {
      try {
        await put(false);
      } catch (e) {
        /* The DO already has a row for this 3PL: say what is there and replace
           it only on a yes — a second key-in used to overwrite it in silence. */
        const was = alreadyKeyed(e);
        if (!was) throw e;
        const yes = await askConfirm({
          title: `Replace ${form.doNumber.trim()}?`,
          body: `It is already keyed in for this 3PL at ${fmtSen(was.billedSen)}${was.invoiceNo ? ` on invoice ${was.invoiceNo}` : ''}. Replace it with ${fmtSen(billedSen)}?`,
          confirmLabel: 'Replace',
          danger: true,
        });
        if (!yes) return;
        await put(true);
      }
      // Keep the 3PL, invoice no and date: one invoice usually covers many DOs.
      setForm((s) => ({ ...s, doNumber: '', billed: '', note: '' }));
      await refresh();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const remove = async (r: ChargeRow) => {
    setErr(null);
    const yes = await askConfirm({
      title: `Remove ${r.doNumber ?? 'this DO'}?`,
      body: `What ${r.carrierName ?? 'the 3PL'} billed for it (${fmtSen(r.billedSen)}) is removed from this list. This cannot be undone.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!yes) return;
    try { await authedFetch(`/threepl-do-charges/${r.id}`, { method: 'DELETE' }); await refresh(); } catch (e) { setErr(errText(e)); }
  };

  const columns: Column<ChargeRow>[] = [
    { key: 'do', label: 'DO', render: (r) => r.doNumber ?? '—', getValue: (r) => r.doNumber ?? '' },
    { key: 'co', label: 'Co.', render: (r) => r.doCompanyCode ?? '—', getValue: (r) => r.doCompanyCode ?? '' },
    { key: 'date', label: 'DO date', render: (r) => (r.doDate ? fmtDate(r.doDate) : '—'), getValue: (r) => r.doDate, exportFormat: 'date' },
    { key: 'cust', label: 'Customer', render: (r) => r.customer ?? '—', getValue: (r) => r.customer ?? '' },
    { key: 'carrier', label: '3PL', render: (r) => r.carrierName ?? '—', getValue: (r) => r.carrierName ?? '' },
    { key: 'inv', label: 'Invoice', render: (r) => [r.invoiceNo, r.invoiceDate && fmtDate(r.invoiceDate)].filter(Boolean).join(' · ') || '—', getValue: (r) => r.invoiceNo ?? '' },
    { key: 'billed', label: 'Billed', ...money, render: (r) => <span className="tabular-nums">{fmtSen(r.billedSen)}</span>, getValue: (r) => r.billedSen, exportValue: (r) => r.billedSen / 100 },
    { key: 'expected', label: 'Rate card', ...money, render: (r) => (r.expectedSen == null ? '—' : <span className="tabular-nums">{fmtSen(r.expectedSen)}</span>), getValue: (r) => r.expectedSen, exportValue: (r) => (r.expectedSen == null ? null : r.expectedSen / 100) },
    { key: 'var', label: 'Difference', ...money, render: (r) => variance(r.varianceSen), getValue: (r) => r.varianceSen, exportValue: (r) => (r.varianceSen == null ? null : r.varianceSen / 100) },
    { key: 'note', label: 'Note', render: (r) => r.note ?? '', getValue: (r) => r.note ?? '' },
    {
      key: 'x', label: '', render: (r) => (
        <button type="button" aria-label={`Remove ${r.doNumber ?? 'row'}`} onClick={() => void remove(r)}
          className="grid h-8 w-8 place-items-center rounded-lg text-ink-muted hover:bg-surface-2 hover:text-[color:var(--hz-dk-err,#8a2c2c)]">
          <Trash2 size={14} />
        </button>
      ),
    },
  ];

  const field = (label: string, k: keyof typeof blank, width = 150) => (
    <label className="flex min-w-0 flex-col gap-1.5" style={{ flex: `1 1 ${width}px` }}>
      <span className={LABEL}>{label}</span>
      <input className={INPUT} aria-label={label} value={form[k]} onChange={(e) => set(k)(e.target.value)} />
    </label>
  );

  const t = useMemo(() => chargeTotals(list.data?.rows ?? []), [list.data?.rows]);
  const invoiceCount = list.data?.invoices.length ?? 0;
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtSen(Math.abs(v))}`;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[900px] text-[13px] text-ink-muted">
        When a transporter's bill is attached to its AP invoice, it is read by itself within half an hour: the lines naming a DO are kept on that DO, and the rest wait under To check for you to say where they go. You can also read a bill yourself (From AP invoice) or key in what was billed for each delivery order. The rate card amount is worked out from the DO's sets / items and delivery zone; extras (setup, dismantle, disposal) and the per-trip outstation fee are not on the DO, so they show as a difference to check.
      </p>

      <FilterBar>
        {(['from', 'to'] as const).map((k) => (
          <label key={k} className="flex min-w-[140px] flex-1 flex-col gap-1.5 sm:w-[170px] sm:flex-none">
            <span className={LABEL}>{k === 'from' ? 'Invoice date from' : 'To'}</span>
            <DateField className={INPUT} value={range[k]} onChange={(v) => setRange((s) => ({ ...s, [k]: v }))} fullWidth />
          </label>
        ))}
        {(range.from || range.to) && (
          <button type="button" className="min-h-[40px] text-[13px] font-semibold text-primary" onClick={() => setRange({ from: '', to: '' })}>Clear dates</button>
        )}
        {mayBringIn && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2.5">
            {said && <span role="status" className="text-[13px] text-ink">{said}</span>}
            <button type="button" className={BTN_QUIET} onClick={() => { setFromAp(true); setSaid(null); }} disabled={fromAp}>From AP invoice</button>
          </div>
        )}
      </FilterBar>

      {list.data && (
        <KpiStrip>
          <Kpi label="Billed" value={fmtSen(t.billedSen)} sub={`${t.dos} ${t.dos === 1 ? 'DO' : 'DOs'} on ${invoiceCount} ${invoiceCount === 1 ? 'invoice' : 'invoices'}`} tone={null} />
          <Kpi label="Rate card" value={t.priced ? fmtSen(t.expectedSen) : '—'} sub={`${t.priced} of ${t.dos} DOs priced`} tone={null} />
          <Kpi label="Difference" value={t.diffSen == null ? '—' : signed(t.diffSen)} sub="Billed less rate card, priced DOs" tone={t.diffSen == null ? null : diffTone(t.diffSen)} />
          <Kpi label="Off the card" value={t.over + t.under} sub={`${t.over} over · ${t.under} under · ${t.noCard} no card`} tone={t.over + t.under ? 'red' : 'green'} />
        </KpiStrip>
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

      <section aria-label="Key in a 3PL bill" className={`${CARD} flex flex-col gap-3.5 px-5 py-[18px]`}>
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[16px] font-bold text-ink">Key in a 3PL bill</h3>
          <p className="text-[12px] text-ink-muted">One DO at a time. The 3PL, invoice no and date stay filled for the next DO on the same invoice.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {field('DO number', 'doNumber')}
          <label className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
            <span className={LABEL}>3PL</span>
            <select className={INPUT} aria-label="3PL" value={form.threeplCompanyId} onChange={(e) => set('threeplCompanyId')(e.target.value)}>
              <option value="">Choose…</option>
              {(carriers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {field('Invoice no', 'invoiceNo')}
          <label className="flex min-w-0 flex-[1_1_150px] flex-col gap-1.5">
            <span className={LABEL}>Invoice date</span>
            <DateField className={INPUT} value={form.invoiceDate} onChange={set('invoiceDate')} fullWidth />
          </label>
          {field('Billed (RM)', 'billed', 120)}
          {field('Note', 'note', 220)}
          <button type="button" className={BTN_PRI} onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
        {err && <p role="alert" className="text-[13px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]">{err}</p>}
      </section>

      <TableCard title="Per invoice" count={list.data ? `(${invoiceCount})` : null} label={null} actions={null}
        hint="Each 3PL invoice: how many DOs it bills, and what their rate cards add up to.">
        <DataTable<InvoiceTotal>
          tableId="threepl-invoice-totals" exportName="3pl-invoice-totals" exportXlsx
          columns={TOTAL_COLUMNS} rows={list.data?.invoices ?? null} loading={list.isLoading}
          error={list.isError ? errText(list.error) : null} emptyLabel="No 3PL invoices keyed in yet."
          getRowKey={(r) => `${r.carrierId}|${r.invoiceNo ?? ''}`}
        />
      </TableCard>

      <TableCard title="Per delivery order" count={list.data ? `(${t.dos})` : null} label={null} actions={null}
        hint={byCompany.length > 1
          ? <span>By company: {byCompany.map(([code, c]) => `${code} ${c.dos} DO${c.dos === 1 ? '' : 's'} · ${fmtSen(c.sen)}`).join('  ·  ')}</span>
          : 'Red rows are billed off the card. Remove a row that was keyed in by mistake.'}>
        <DataTable<ChargeRow>
          tableId="threepl-do-charges" exportName="3pl-do-charges" exportXlsx
          columns={columns} rows={list.data?.rows ?? null} loading={list.isLoading}
          error={list.isError ? errText(list.error) : null} emptyLabel="No DOs keyed in for this range."
          getRowKey={(r) => r.id}
          getRowStyle={(r) => (r.varianceSen ? { background: 'rgba(163,38,27,0.05)' } : undefined)}
        />
      </TableCard>
    </div>
  );
};
