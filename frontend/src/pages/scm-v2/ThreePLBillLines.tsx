// ----------------------------------------------------------------------------
// The bills read off AP invoices, kept line by line (owner 2026-10-24: 「当这些
// 对不上的我认为我想要assign 看这个是去哪里，可能是service, 可能是setup dismantle，
// 可能不算」). A bill attached to an AP invoice from a 3PL supplier is read by
// itself every half hour; the lines naming a DO are kept on that DO.
//
//   To check   every line still waiting for a person: a number not in the
//              system, no number, a setup / dismantle with no fair
//   Per bill   each bill split into DOs / Service / Setup · Dismantle / Not
//              counted / To check — adding up to the AP invoice
//
// Any line can be put somewhere else; the bill's DO charges follow its DO lines.
// Nothing posts to the ledger: the AP invoice already booked the cost.
// Route: backend/src/scm/routes/threepl-from-ap.ts (/bill-lines).
// ----------------------------------------------------------------------------
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@2990s/design-system';
import { fmtDate, fmtSen } from '@2990s/shared';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { useAllFairOptions, type FairOption } from '../../vendor/scm/lib/fair-options-queries';
import { allBoothChoices } from '../../vendor/scm/lib/fair-booth-choices';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { DataTable, type Column } from '../../components/DataTable';
import styles from './Suppliers.module.css';

export type LineAssign = 'do' | 'service' | 'event' | 'none';
export interface BillLine {
  id: string; apInvoiceId: string; invoiceNumber: string | null; supplierName: string | null;
  lineNo: number; text: string; date: string | null; kind: string; amountSen: number | null; printed: string[];
  readStatus: string; assign: LineAssign | null; doIds: string[]; doNumbers: string[];
  serviceRef: string | null; projectId: number | null; assignedBy: string | null; assignedAt: string | null; open: boolean;
}
export interface BillSummary {
  apInvoiceId: string; invoiceNumber: string; supplierRef: string | null; invoiceDate: string | null; totalSen: number;
  supplierName: string; carrierId: string | null; carrierName: string | null;
  readBy: string; readAt: string | null; error: string | null; lines: number;
  doSen: number; serviceSen: number; eventSen: number; noneSen: number; openSen: number; openLines: number;
}

export const ASSIGN_LABEL: Record<LineAssign, string> = { do: 'DO', service: 'Service', event: 'Setup / Dismantle', none: 'Not counted' };
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const muted = { color: 'var(--fg-muted)' };
const money = { align: 'right' as const, exportFormat: 'money' as const };
const sen = (v: number | null) => (v == null ? '—' : fmtSen(v));
/** What the bill's lines do not account for: the AP invoice less every part. */
export const notReadSen = (b: BillSummary) => b.totalSen - (b.doSen + b.serviceSen + b.eventSen + b.noneSen + b.openSen);
const LINES_KEY = ['threepl-bill-lines'];

/** Where one line goes, and Save. A DO line takes its DO numbers (a trip line
 *  names several); Service its ASSR number if there is one; Setup / Dismantle
 *  its fair — the fairs nearest the line's date first. */
function AssignEditor({ line, fairs, onSaved }: { line: BillLine; fairs: readonly FairOption[]; onSaved: (said: string | null) => void }) {
  const [assign, setAssign] = useState<LineAssign | ''>(line.assign ?? '');
  const [doNumber, setDoNumber] = useState(line.doNumbers.join(', '));
  const [serviceRef, setServiceRef] = useState(line.serviceRef ?? '');
  const [projectId, setProjectId] = useState(line.projectId ? String(line.projectId) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fairChoices = useMemo(
    () => (assign === 'event'
      ? allBoothChoices(fairs, { venue: null, branding: null, so_date: line.date }).map((ch) => ({ value: String(ch.projectId), label: ch.label }))
      : []),
    [assign, fairs, line.date],
  );
  const what = `line ${line.lineNo}${line.invoiceNumber ? ` of ${line.invoiceNumber}` : ''}`;
  const unchanged = assign === (line.assign ?? '')
    && (assign !== 'do' || doNumber.trim() === line.doNumbers.join(', '))
    && (assign !== 'service' || serviceRef.trim() === (line.serviceRef ?? ''))
    && (assign !== 'event' || projectId === (line.projectId ? String(line.projectId) : ''));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await authedFetch<{ ok: true; open: boolean; skipped: Array<{ doId: string; invoiceNo: string | null }> }>(`/threepl-do-charges/bill-lines/${line.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          assign: assign || null,
          doNumber: assign === 'do' ? doNumber : null,
          serviceRef: assign === 'service' ? serviceRef : null,
          projectId: assign === 'event' && projectId ? Number(projectId) : null,
        }),
      });
      onSaved(r.skipped.length
        ? `${r.skipped.map((s) => s.invoiceNo ?? 'a hand entry').join(', ')} already charge${r.skipped.length === 1 ? 's' : ''} ${r.skipped.length === 1 ? 'that DO' : `${r.skipped.length} of those DOs`} — left as ${r.skipped.length === 1 ? 'it was' : 'they were'}.`
        : null);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 260 }}>
      <select className={styles.fieldInput} style={{ width: 150 }} aria-label={`Where ${what} goes`} value={assign} onChange={(e) => setAssign(e.target.value as LineAssign | '')}>
        <option value="">To check</option>
        {(Object.keys(ASSIGN_LABEL) as LineAssign[]).map((k) => <option key={k} value={k}>{ASSIGN_LABEL[k]}</option>)}
      </select>
      {assign === 'do' && (
        <input className={styles.fieldInput} style={{ width: 170 }} aria-label={`DO numbers for ${what}`} placeholder="DO number(s)" value={doNumber} onChange={(e) => setDoNumber(e.target.value)} />
      )}
      {assign === 'service' && (
        <input className={styles.fieldInput} style={{ width: 150 }} aria-label={`ASSR number for ${what}`} placeholder="ASSR no. (if any)" value={serviceRef} onChange={(e) => setServiceRef(e.target.value)} />
      )}
      {assign === 'event' && (
        <div style={{ width: 280 }}>
          <SearchableSelect
            ariaLabel={`Fair for ${what}`} value={projectId} options={fairChoices} onChange={setProjectId}
            placeholder={fairs.length ? '— choose the fair — (type to search)' : 'Loading the fairs…'}
            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-[13px]"
          />
        </div>
      )}
      <Button variant="secondary" size="sm" disabled={busy || unchanged || (assign === 'event' && !projectId) || (assign === 'do' && !doNumber.trim())} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
      {err && <span role="alert" style={{ color: 'var(--c-danger, #dc2626)', fontSize: 'var(--fs-12)' }}>{err}</span>}
    </div>
  );
}

function lineColumns(fairs: readonly FairOption[], onSaved: (said: string | null) => void, withBill: boolean): Column<BillLine>[] {
  return [
    ...(withBill ? [
      { key: 'inv', label: 'AP invoice', render: (r: BillLine) => r.invoiceNumber ?? '—', getValue: (r: BillLine) => r.invoiceNumber ?? '' },
      { key: 'sup', label: 'Supplier', render: (r: BillLine) => r.supplierName ?? '—', getValue: (r: BillLine) => r.supplierName ?? '' },
    ] : [
      { key: 'no', label: '#', align: 'right' as const, render: (r: BillLine) => r.lineNo, getValue: (r: BillLine) => r.lineNo },
    ]),
    { key: 'date', label: 'Date', render: (r) => (r.date ? fmtDate(r.date) : '—'), getValue: (r) => r.date, exportFormat: 'date' },
    { key: 'text', label: 'Line on the bill', render: (r) => r.text || '—', getValue: (r) => r.text },
    { key: 'nos', label: 'Numbers', render: (r) => r.printed.join(', ') || '—', getValue: (r) => r.printed.join(', ') },
    { key: 'amt', label: 'Amount', ...money, render: (r) => sen(r.amountSen), getValue: (r) => r.amountSen, exportValue: (r) => (r.amountSen == null ? null : r.amountSen / 100) },
    {
      key: 'where', label: 'Where it goes', disableSort: true,
      getValue: (r) => (r.assign ? ASSIGN_LABEL[r.assign] : 'To check'),
      render: (r) => <AssignEditor key={`${r.id}|${r.assign ?? ''}|${r.doIds.join(',')}|${r.projectId ?? ''}|${r.serviceRef ?? ''}`} line={r} fairs={fairs} onSaved={onSaved} />,
    },
    ...(withBill ? [] : [{
      key: 'by', label: 'By', render: (r: BillLine) => <span style={{ ...muted, fontSize: 'var(--fs-12)' }}>{r.assignedBy === 'auto' ? 'Read by itself' : r.assignedBy ?? ''}</span>,
      getValue: (r: BillLine) => r.assignedBy ?? '',
    }]),
  ];
}

const readCell = (b: BillSummary) => {
  if (b.error) return <span style={{ color: 'var(--c-danger, #dc2626)', fontSize: 'var(--fs-12)' }}>Not read: {b.error}</span>;
  const when = b.readAt ? fmtDate(b.readAt.slice(0, 10)) : '';
  return <span style={{ ...muted, fontSize: 'var(--fs-12)' }}>{b.readBy === 'auto' ? 'By itself' : 'By hand'}{when ? ` · ${when}` : ''}</span>;
};

/** To check + Per bill, for Finance (the AP invoice is theirs). */
export function BillsFromAp({ bills }: { bills: BillSummary[] }) {
  const qc = useQueryClient();
  const [opened, setOpened] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const open = useQuery({
    queryKey: [...LINES_KEY, 'open'],
    queryFn: () => authedFetch<{ lines: BillLine[] }>('/threepl-do-charges/bill-lines?open=1').then((r) => r.lines),
  });
  const one = useQuery({
    queryKey: [...LINES_KEY, opened],
    queryFn: () => authedFetch<{ lines: BillLine[] }>(`/threepl-do-charges/bill-lines?apInvoiceId=${encodeURIComponent(opened ?? '')}`).then((r) => r.lines),
    enabled: opened != null,
  });
  const fairs = useAllFairOptions((open.data?.length ?? 0) > 0 || opened != null);
  const fairList = fairs.data ?? [];
  const onSaved = (m: string | null) => {
    setSaid(m);
    void qc.invalidateQueries({ queryKey: LINES_KEY });
    void qc.invalidateQueries({ queryKey: ['threepl-do-charges'] });
    void qc.invalidateQueries({ queryKey: ['threepl-from-ap'] });
  };
  const openedBill = bills.find((b) => b.apInvoiceId === opened) ?? null;
  const waiting = open.data ?? [];
  const waitingSen = waiting.reduce((s, l) => s + (l.amountSen ?? 0), 0);

  const billColumns: Column<BillSummary>[] = [
    { key: 'inv', label: 'AP invoice', render: (r) => r.invoiceNumber, getValue: (r) => r.invoiceNumber },
    { key: 'sup', label: 'Supplier', render: (r) => r.supplierName, getValue: (r) => r.supplierName },
    { key: 'ref', label: 'Bill no.', render: (r) => r.supplierRef ?? '—', getValue: (r) => r.supplierRef ?? '' },
    { key: 'date', label: 'Date', render: (r) => (r.invoiceDate ? fmtDate(r.invoiceDate) : '—'), getValue: (r) => r.invoiceDate, exportFormat: 'date' },
    { key: 'total', label: 'AP invoice amount', ...money, render: (r) => fmtSen(r.totalSen), getValue: (r) => r.totalSen, exportValue: (r) => r.totalSen / 100 },
    { key: 'do', label: 'DOs', ...money, render: (r) => fmtSen(r.doSen), getValue: (r) => r.doSen, exportValue: (r) => r.doSen / 100 },
    { key: 'svc', label: 'Service', ...money, render: (r) => fmtSen(r.serviceSen), getValue: (r) => r.serviceSen, exportValue: (r) => r.serviceSen / 100 },
    { key: 'event', label: 'Setup / Dismantle', ...money, render: (r) => fmtSen(r.eventSen), getValue: (r) => r.eventSen, exportValue: (r) => r.eventSen / 100 },
    { key: 'none', label: 'Not counted', ...money, render: (r) => fmtSen(r.noneSen), getValue: (r) => r.noneSen, exportValue: (r) => r.noneSen / 100 },
    {
      key: 'open', label: 'To check', ...money, getValue: (r) => r.openSen, exportValue: (r) => r.openSen / 100,
      render: (r) => (r.openLines
        ? <span style={{ color: 'var(--c-warning, #b45309)', fontWeight: 600 }}>{fmtSen(r.openSen)} · {r.openLines} line{r.openLines === 1 ? '' : 's'}</span>
        : fmtSen(0)),
    },
    {
      key: 'rest', label: 'Not on the reading', ...money, getValue: (r) => notReadSen(r), exportValue: (r) => notReadSen(r) / 100,
      render: (r) => { const v = notReadSen(r); return v === 0 ? <span style={muted}>—</span> : <span style={{ color: 'var(--c-warning, #b45309)' }}>{fmtSen(v)}</span>; },
    },
    { key: 'read', label: 'Read', render: readCell, getValue: (r) => r.error ?? r.readBy },
    {
      key: 'go', label: '', disableSort: true, render: (r) => (
        <Button variant="secondary" size="sm" onClick={() => setOpened(opened === r.apInvoiceId ? null : r.apInvoiceId)}>
          {opened === r.apInvoiceId ? 'Hide lines' : 'Lines'}
        </Button>
      ),
    },
  ];

  return (
    <section aria-label="Bills from AP invoices" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: '8px 0 0', fontSize: 'var(--fs-13)' }}>
        To check {waiting.length ? `(${waiting.length} line${waiting.length === 1 ? '' : 's'} · ${fmtSen(waitingSen)})` : ''}
      </h3>
      <p style={{ margin: 0, fontSize: 'var(--fs-12)', ...muted }}>
        Lines read off a bill that are not on a DO yet. Say where each goes: a DO (its number), Service (an ASSR number if there is one), Setup / Dismantle (the fair) or Not counted (storage, handling, dispose).
      </p>
      {said && <p role="status" style={{ margin: 0, fontSize: 'var(--fs-12)' }}>{said}</p>}
      <DataTable<BillLine>
        tableId="threepl-bill-lines-open" columns={lineColumns(fairList, onSaved, true)} rows={open.data ?? null} loading={open.isLoading}
        error={open.isError ? errText(open.error) : null} emptyLabel="Nothing to check — every line read off a bill has a place."
        getRowKey={(r) => r.id}
      />

      <h3 style={{ margin: '8px 0 0', fontSize: 'var(--fs-13)' }}>Per bill</h3>
      <p style={{ margin: 0, fontSize: 'var(--fs-12)', ...muted }}>
        Each bill read off its AP invoice, split by where its lines went. The parts add up to the AP invoice; “Not on the reading” is what no line accounts for.
      </p>
      <DataTable<BillSummary>
        tableId="threepl-bills" exportName="3pl-bills" exportXlsx columns={billColumns} rows={bills}
        emptyLabel="No bill read yet." getRowKey={(r) => r.apInvoiceId}
      />
      {openedBill && (
        <>
          <h4 style={{ margin: '4px 0 0', fontSize: 'var(--fs-13)' }}>
            Lines of {openedBill.invoiceNumber} · {openedBill.supplierName}{openedBill.supplierRef ? ` · bill ${openedBill.supplierRef}` : ''}
          </h4>
          <DataTable<BillLine>
            tableId="threepl-bill-lines-one" columns={lineColumns(fairList, onSaved, false)} rows={one.data ?? null} loading={one.isLoading}
            error={one.isError ? errText(one.error) : null} emptyLabel="No line was read off this bill."
            getRowKey={(r) => r.id}
          />
        </>
      )}
    </section>
  );
}
