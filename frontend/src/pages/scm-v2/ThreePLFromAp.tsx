// ----------------------------------------------------------------------------
// From an AP invoice (owner 2026-10-23: 「先做」) — the 3PL invoices tab filled
// from the AP invoice Finance already keyed. Its attached bill (MSJ's
// handwritten sheet, NEST LIVING's list, EU LOGISTICS' slips) is read, every
// line matched to a delivery order and priced on the 3PL's rate card, and the
// result shown for a person to check — handwriting can be misread — before
// Save. Storage, handling, setup, dismantle and dispose are listed beside the
// DOs and never counted into one (「仓储，搬运不算」). A 2990 DO shows its
// company: Houzs delivers for 2990 and bills it back.
//
// The same reading runs by itself every half hour (owner 2026-10-24: 「手动还是要
// 保留」 — this panel is the manual one). Save keeps every line with where it
// goes; what is not on a DO is listed under To check (ThreePLBillLines.tsx).
// Route: backend/src/scm/routes/threepl-from-ap.ts.
// ----------------------------------------------------------------------------
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@2990s/design-system';
import { fmtDate, fmtSen } from '@2990s/shared';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { DataTable, type Column } from '../../components/DataTable';
import { ASSIGN_LABEL, type LineAssign } from './ThreePLBillLines';
import styles from './Suppliers.module.css';

/** "1,234.50" / "RM 80" -> sen; null when it is not a non-negative amount. */
export const toSen = (v: string): number | null => {
  const n = Number(v.replace(/rm|,|\s/gi, ''));
  return v.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

export interface ApBill {
  id: string; invoiceNumber: string; supplierRef: string | null; invoiceDate: string | null; totalSen: number;
  status: string; supplierId: string; supplierName: string; files: number;
  broughtInDos: number; broughtInSen: number; carrierId: string | null;
  /** Lines kept off this bill still waiting for a person (To check). */
  waitingLines?: number;
}
interface Carrier { id: string; name: string }
export interface ReadDo {
  doId: string; doNumber: string; doDate: string | null; soDocNo: string | null; customer: string | null;
  companyCode: string | null; billedSen: number; expectedSen: number | null; varianceSen: number | null;
  split: boolean; lines: string[]; note: string; alreadyOn: { invoiceNo: string | null; billedSen: number } | null;
}
export interface ReadLine {
  index: number; text: string; date: string | null; kind: string; amountSen: number | null;
  printed: string[]; status: 'matched' | 'not_found' | 'no_number' | 'service_case' | 'not_delivery'; dos: string[];
  /** Where the line goes as the reader sees it; null waits under To check. */
  doIds?: string[]; assign?: LineAssign | null; serviceRef?: string | null; projectId?: number | null;
}
interface ReadResult {
  invoice: { id: string; invoiceNumber: string; supplierRef: string | null; invoiceDate: string | null; totalSen: number; supplierName: string };
  carrierId: string | null; carriers: Carrier[]; dos: ReadDo[]; lines: ReadLine[];
  totals: Record<'all' | ReadLine['status'], number>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const money = { align: 'right' as const, exportFormat: 'money' as const };
const muted = { color: 'var(--fg-muted)' };
const KIND: Record<string, string> = { setup: 'Setup', dismantle: 'Dismantle', dispose: 'Dispose', storage: 'Storage', handling: 'Handling', other: 'Other', delivery: 'Delivery' };
const WHY: Record<Exclude<ReadLine['status'], 'matched'>, string> = {
  not_found: 'Number not in the system',
  no_number: 'No order number on the line',
  service_case: 'Service case (ASSR), not a DO',
  not_delivery: 'Not a delivery, not counted',
};
const diff = (billed: number | null, expected: number | null) => {
  if (billed == null || expected == null) return <span style={muted}>{expected == null ? 'no rate card' : '—'}</span>;
  const v = billed - expected;
  return (
    <span style={{ color: v === 0 ? 'var(--c-secondary-a, #16a34a)' : 'var(--c-danger, #dc2626)', fontWeight: v === 0 ? 400 : 600 }}>
      {v === 0 ? 'matches' : `${v > 0 ? '+' : '−'}${fmtSen(Math.abs(v))}`}
    </span>
  );
};

export function ThreePLFromAp({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const [q, setQ] = useState('');
  const [only3pl, setOnly3pl] = useState(true);
  const [picked, setPicked] = useState<ApBill | null>(null);
  const [result, setResult] = useState<ReadResult | null>(null);
  const [carrierId, setCarrierId] = useState('');
  /* The 3PL the Rate card amounts were priced on; another one needs a re-read. */
  const [pricedFor, setPricedFor] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [billed, setBilled] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'reading' | 'saving' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bills = useQuery({
    queryKey: ['threepl-from-ap', 'invoices'],
    queryFn: () => authedFetch<{ invoices: ApBill[]; carriers: Carrier[] }>('/threepl-do-charges/from-ap/invoices'),
  });

  const read = async (bill: ApBill, carrier?: string) => {
    setPicked(bill); setResult(null); setBusy('reading'); setErr(null);
    try {
      const r = await authedFetch<ReadResult>(`/threepl-do-charges/from-ap/${bill.id}/read`, {
        method: 'POST', body: JSON.stringify(carrier ? { carrierId: carrier } : {}),
      });
      setResult(r);
      setCarrierId(r.carrierId ?? '');
      setPricedFor(r.carrierId ?? '');
      setTicked(new Set(r.dos.filter((d) => !d.alreadyOn).map((d) => d.doId)));
      setBilled(Object.fromEntries(r.dos.map((d) => [d.doId, (d.billedSen / 100).toFixed(2)])));
    } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };

  const save = async () => {
    if (!picked || !result) return;
    if (!carrierId) { setErr('Choose the 3PL this bill is from.'); return; }
    const rows = result.dos.filter((d) => ticked.has(d.doId)).map((d) => ({ doId: d.doId, billedSen: toSen(billed[d.doId] ?? ''), note: d.note }));
    if (rows.some((r) => r.billedSen == null)) { setErr('Enter each kept DO’s amount in RM.'); return; }
    /* Every line is kept with where it goes; a DO line keeps only the ticked DOs. */
    const lines = result.lines.map((l) => ({
      text: l.text, date: l.date, kind: l.kind, amountSen: l.amountSen, printed: l.printed, status: l.status,
      doIds: l.doIds ?? [], assign: l.assign ?? null, serviceRef: l.serviceRef ?? null, projectId: l.projectId ?? null,
    }));
    setBusy('saving'); setErr(null);
    try {
      const res = await authedFetch<{ saved: number; skipped: Array<{ doId: string; invoiceNo: string | null }> }>(
        `/threepl-do-charges/from-ap/${picked.id}/confirm`, { method: 'POST', body: JSON.stringify({ carrierId, rows, lines }) },
      );
      const left = res.skipped.length ? ` ${res.skipped.length} already on another bill, left as they were.` : '';
      const waiting = lines.filter((l) => !l.assign || (l.assign === 'do' && !l.doIds.some((id) => ticked.has(id))) || (l.assign === 'event' && !l.projectId)).length;
      const check = waiting ? ` ${waiting} line${waiting === 1 ? '' : 's'} wait${waiting === 1 ? 's' : ''} under To check.` : '';
      onSaved(`Saved ${res.saved} DO${res.saved === 1 ? '' : 's'} from ${picked.invoiceNumber}.${left}${check}`);
    } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };

  const shown = (bills.data?.invoices ?? []).filter((b) => {
    if (only3pl && !b.carrierId) return false;
    const s = q.trim().toLowerCase();
    return !s || [b.invoiceNumber, b.supplierName, b.supplierRef ?? ''].some((v) => v.toLowerCase().includes(s));
  });
  const billColumns: Column<ApBill>[] = [
    { key: 'inv', label: 'AP invoice', render: (r) => r.invoiceNumber, getValue: (r) => r.invoiceNumber },
    { key: 'sup', label: 'Supplier', render: (r) => r.supplierName, getValue: (r) => r.supplierName },
    { key: 'ref', label: 'Bill no.', render: (r) => r.supplierRef ?? '—', getValue: (r) => r.supplierRef ?? '' },
    { key: 'date', label: 'Date', render: (r) => (r.invoiceDate ? fmtDate(r.invoiceDate) : '—'), getValue: (r) => r.invoiceDate, exportFormat: 'date' },
    { key: 'total', label: 'Amount', ...money, render: (r) => fmtSen(r.totalSen), getValue: (r) => r.totalSen },
    {
      key: 'in', label: 'Brought in', getValue: (r) => r.broughtInDos,
      render: (r) => [
        r.broughtInDos ? `${r.broughtInDos} DO${r.broughtInDos === 1 ? '' : 's'} · ${fmtSen(r.broughtInSen)}` : '',
        r.waitingLines ? `${r.waitingLines} to check` : '',
      ].filter(Boolean).join(' · ') || '—',
    },
    {
      key: 'go', label: '', render: (r) => (
        <Button variant="secondary" size="sm" disabled={busy != null} onClick={() => void read(r)}>
          {r.broughtInDos || r.waitingLines ? 'Read again' : 'Read the bill'}
        </Button>
      ),
    },
  ];

  const doColumns: Column<ReadDo>[] = [
    { key: 'do', label: 'DO', render: (r) => r.doNumber, getValue: (r) => r.doNumber },
    { key: 'co', label: 'Co.', render: (r) => r.companyCode ?? '—', getValue: (r) => r.companyCode ?? '' },
    { key: 'cust', label: 'Customer', render: (r) => r.customer ?? '—', getValue: (r) => r.customer ?? '' },
    { key: 'bill', label: 'On the bill', render: (r) => <span style={{ fontSize: 'var(--fs-12)' }}>{r.lines.join(' / ')}{r.split ? ' (one price for a trip, shared by the rate card)' : ''}</span>, getValue: (r) => r.lines.join(' / ') },
    {
      key: 'billed', label: 'Billed (RM)', align: 'right', getValue: (r) => toSen(billed[r.doId] ?? '') ?? 0,
      render: (r) => (
        <input
          className={styles.fieldInput} aria-label={`Billed for ${r.doNumber}`} style={{ width: 96, textAlign: 'right' }}
          value={billed[r.doId] ?? ''} onChange={(e) => setBilled((s) => ({ ...s, [r.doId]: e.target.value }))}
        />
      ),
    },
    { key: 'card', label: 'Rate card', ...money, render: (r) => (r.expectedSen == null ? '—' : fmtSen(r.expectedSen)), getValue: (r) => r.expectedSen },
    { key: 'var', label: 'Difference', align: 'right', render: (r) => diff(toSen(billed[r.doId] ?? ''), r.expectedSen), getValue: (r) => r.varianceSen },
    { key: 'on', label: 'Already on', render: (r) => (r.alreadyOn ? `${r.alreadyOn.invoiceNo ?? 'a hand entry'} · ${fmtSen(r.alreadyOn.billedSen)}` : ''), getValue: (r) => r.alreadyOn?.invoiceNo ?? '' },
  ];
  const lineColumns: Column<ReadLine>[] = [
    { key: 'text', label: 'Line on the bill', render: (r) => r.text || '—', getValue: (r) => r.text },
    { key: 'nos', label: 'Numbers', render: (r) => r.printed.join(', ') || '—', getValue: (r) => r.printed.join(', ') },
    { key: 'amt', label: 'Amount', ...money, render: (r) => (r.amountSen == null ? '—' : fmtSen(r.amountSen)), getValue: (r) => r.amountSen },
    {
      key: 'why', label: 'What happened', getValue: (r) => r.status,
      render: (r) => (r.status === 'matched' ? '' : r.status === 'not_delivery' ? `${KIND[r.kind] ?? 'Other'}: not a delivery` : WHY[r.status]),
    },
    {
      key: 'goes', label: 'Goes to', getValue: (r) => (r.assign ? ASSIGN_LABEL[r.assign] : 'To check'),
      render: (r) => (r.assign
        ? `${ASSIGN_LABEL[r.assign]}${r.assign === 'service' && r.serviceRef ? ` · ${r.serviceRef}` : ''}${r.assign === 'event' && r.projectId ? ' · the AP invoice line’s fair' : ''}`
        : <span style={{ color: 'var(--c-warning, #b45309)' }}>To check</span>),
    },
  ];

  const t = result?.totals;
  const keptSen = result ? result.dos.filter((d) => ticked.has(d.doId)).reduce((s, d) => s + (toSen(billed[d.doId] ?? '') ?? 0), 0) : 0;
  return (
    <section aria-label="From an AP invoice" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 'var(--fs-13)' }}>From an AP invoice</h3>
        <span style={{ ...muted, fontSize: 'var(--fs-12)' }}>Reads the transport company’s bill attached to the AP invoice; nothing is saved until you press Save.</span>
        <span style={{ flex: 1 }} />
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      </div>
      {err && <p role="alert" style={{ margin: 0, color: 'var(--c-danger, #dc2626)', fontSize: 'var(--fs-12)' }}>{err}</p>}

      {!picked && (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className={styles.field} style={{ maxWidth: 260 }}>
              <span className={styles.fieldLabel}>Search</span>
              <input className={styles.fieldInput} aria-label="Search AP invoices" placeholder="Supplier, AP invoice or bill no." value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-12)' }}>
              <input type="checkbox" checked={only3pl} onChange={(e) => setOnly3pl(e.target.checked)} />
              Only suppliers that are a 3PL
            </label>
          </div>
          <DataTable<ApBill>
            tableId="threepl-from-ap-bills" columns={billColumns} rows={bills.data ? shown : null} loading={bills.isLoading}
            error={bills.isError ? errText(bills.error) : null}
            emptyLabel={only3pl ? 'No AP invoice from a 3PL supplier has a bill attached. Untick the box to see every supplier.' : 'No AP invoice has a bill attached.'}
            getRowKey={(r) => r.id}
          />
        </>
      )}

      {picked && busy === 'reading' && (
        <p role="status" style={{ margin: 0, fontSize: 'var(--fs-13)' }}>Reading the bill on {picked.invoiceNumber}… this can take up to a minute.</p>
      )}

      {picked && result && (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 'var(--fs-13)' }}>
              <strong>{result.invoice.invoiceNumber}</strong> · {result.invoice.supplierName}
              {result.invoice.supplierRef ? ` · bill ${result.invoice.supplierRef}` : ''}
              {result.invoice.invoiceDate ? ` · ${fmtDate(result.invoice.invoiceDate)}` : ''} · {fmtSen(result.invoice.totalSen)}
            </div>
            <label className={styles.field} style={{ maxWidth: 240 }}>
              <span className={styles.fieldLabel}>3PL</span>
              <select className={styles.fieldInput} aria-label="3PL for this bill" value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
                <option value="">Choose…</option>
                {result.carriers.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </label>
            {carrierId && carrierId !== pricedFor && (
              <span style={{ fontSize: 'var(--fs-12)' }}>
                The Rate card column is still the first 3PL’s.{' '}
                <Button variant="secondary" size="sm" disabled={busy != null} onClick={() => void read(picked, carrierId)}>Read again with this 3PL</Button>
              </span>
            )}
          </div>
          {t && (
            <p style={{ margin: 0, fontSize: 'var(--fs-12)' }}>
              The bill reads {fmtSen(t.all)}: matched to a DO {fmtSen(t.matched)} · number not in the system {fmtSen(t.not_found)} · no number {fmtSen(t.no_number)}
              {t.service_case ? ` · service cases ${fmtSen(t.service_case)}` : ''} · not a delivery {fmtSen(t.not_delivery)}.
            </p>
          )}
          <p style={{ margin: 0, fontSize: 'var(--fs-12)', color: 'var(--c-warning, #b45309)' }}>
            A handwritten bill can be misread (an “SO” read as “80”). Check each DO and its amount before saving.
          </p>
          <h4 style={{ margin: '4px 0 0', fontSize: 'var(--fs-13)' }}>Matched to a delivery order ({result.dos.length})</h4>
          <DataTable<ReadDo>
            tableId="threepl-from-ap-dos" columns={doColumns} rows={result.dos} emptyLabel="No line on the bill matched a delivery order."
            getRowKey={(r) => r.doId}
            selection={{
              selectedIds: ticked,
              onToggle: (id) => setTicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
              onToggleAll: (keys, all) => setTicked(all ? new Set() : new Set(keys.filter((k) => !result.dos.find((d) => d.doId === k)?.alreadyOn))),
              isDisabled: (id) => !!result.dos.find((d) => d.doId === id)?.alreadyOn,
              rowLabel: (r) => `Keep ${r.doNumber}`,
            }}
          />
          {result.lines.some((l) => l.status !== 'matched') && (
            <>
              <h4 style={{ margin: '4px 0 0', fontSize: 'var(--fs-13)' }}>Not on a DO</h4>
              <p style={{ margin: 0, fontSize: 'var(--fs-12)', ...muted }}>
                Saved with the bill. A line marked To check waits under To check, where you say where it goes — it can be changed there later too.
              </p>
              <DataTable<ReadLine>
                tableId="threepl-from-ap-lines" columns={lineColumns} rows={result.lines.filter((l) => l.status !== 'matched')}
                getRowKey={(r) => String(r.index)}
              />
            </>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="primary" size="sm" disabled={busy != null || (ticked.size === 0 && result.lines.length === 0) || !carrierId} onClick={() => void save()}>
              {ticked.size ? `Save ${ticked.size} DO${ticked.size === 1 ? '' : 's'} · ${fmtSen(keptSen)}` : 'Save the bill’s lines'}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy != null} onClick={() => { setPicked(null); setResult(null); setErr(null); }}>Back to the list</Button>
          </div>
        </>
      )}

      {picked && !result && busy == null && (
        <Button variant="secondary" size="sm" onClick={() => { setPicked(null); setErr(null); }}>Back to the list</Button>
      )}
    </section>
  );
}
