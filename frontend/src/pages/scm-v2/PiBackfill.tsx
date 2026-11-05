// ----------------------------------------------------------------------------
// PiBackfillCard — "Purchase invoices in the ledger", the owner's own door onto
// POST /accounting/backfill/pi-periodic (GL redesign item 3), in the owner's
// Claude Design redesign (Finance-1a-Setup, batch 6 §6.2). The endpoint shipped
// in #2974; this card is the handle: Dry run shows the list (invoice, state,
// amount) and NOTHING writes until he presses Write himself — the button IS the
// nod the flow always required (dry-run 给我过目,点头才写入).
//
// The write pass loops the batched endpoint (25/call, Workers budget) until
// `remaining` is 0, and STOPS the moment a pass completes nothing — an
// unbound group surfaces as its own failure row, never as an infinite loop.
// Runs on the ACTIVE company only; 2990 and HOUZS are two visits.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { fmtSen, fmtSenPlain } from '../../vendor/shared/format';
import { useToastOptional } from '../../hooks/useToast';
import { DataTable, type Column } from '../../components/DataTable';
import { Tag } from './finance/SetupParts';
import sp from './finance/SetupParts.module.css';
import css from './ItemGroups.module.css';

type Item = { invoiceNumber: string; totalSen: number; kind: 'missing' | 'reshape' };
type DryRun = { dryRun: true; missing: Item[]; reshape: Item[]; current: number };
type Outcome = { invoiceNumber: string; kind: string; outcome: string; jeNo?: string; reason?: string };
type WritePass = { dryRun: false; processed: Outcome[]; remaining: number; summary: { attempted: number; done: number; failed: number } };

/** One invoice in the table: what the dry run found, then what the write did. */
type Row = Item & { written: boolean; note: string };

const sum = (items: Item[]): number => items.reduce((s, i) => s + i.totalSen, 0);
const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);

const COLUMNS: Column<Row>[] = [
  { key: 'invoice', label: 'Invoice', render: (r) => <span className={sp.strong}>{r.invoiceNumber}</span>, getValue: (r) => r.invoiceNumber },
  {
    key: 'state', label: 'State',
    render: (r) => (r.written
      ? <Tag tone="info">Written</Tag>
      : r.kind === 'missing' ? <Tag tone="warn">Missing</Tag> : <Tag tone="calm">Reshape</Tag>),
    getValue: (r) => (r.written ? 'Written' : r.kind === 'missing' ? 'Missing' : 'Reshape'),
  },
  {
    key: 'amount', label: 'Amount', align: 'right',
    render: (r) => <span className={sp.num}>{fmtSenPlain(r.totalSen)}</span>,
    getValue: (r) => r.totalSen, exportValue: (r) => r.totalSen / 100, exportFormat: 'money',
    total: (rs) => <span className={sp.num}>{fmtSenPlain(rs.reduce((s, r) => s + r.totalSen, 0))}</span>,
  },
  { key: 'note', label: 'Note', render: (r) => <span className={sp.muted}>{r.note}</span>, getValue: (r) => r.note },
];

export const PiBackfillCard = () => {
  const toast = useToastOptional();
  const [preview, setPreview] = useState<DryRun | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [busy, setBusy] = useState<'dry' | 'write' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dryRun = async () => {
    setBusy('dry'); setError(null); setOutcomes(null);
    try {
      const d = await authedFetch<DryRun>('/accounting/backfill/pi-periodic?dryRun=1', { method: 'POST', body: '{}' });
      setPreview(d);
      setRows([...d.missing, ...d.reshape].map((i) => ({ ...i, written: false, note: '' })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dry run failed.');
    } finally {
      setBusy(null);
    }
  };

  const write = async () => {
    setBusy('write'); setError(null);
    const all: Outcome[] = [];
    const mark = (done: Outcome[]) => setRows((prev) => (prev ?? []).map((r) => {
      const o = done.find((x) => x.invoiceNumber === r.invoiceNumber);
      if (!o) return r;
      return o.outcome === 'failed'
        ? { ...r, written: false, note: o.reason ?? o.outcome }
        : { ...r, written: true, note: o.jeNo ?? '' };
    }));
    try {
      /* Loop the batch until nothing is left — but bail when a pass gets
         NOTHING done, so a wall of unbound-group failures shows itself once
         instead of spinning. */
      for (;;) {
        const pass = await authedFetch<WritePass>('/accounting/backfill/pi-periodic?limit=25', { method: 'POST', body: '{}' });
        all.push(...pass.processed);
        setOutcomes([...all]);
        mark(pass.processed);
        if (pass.remaining === 0 || pass.summary.done === 0) break;
      }
      const failed = all.filter((o) => o.outcome === 'failed').length;
      toast?.success(`Purchase invoices written · ${all.length - failed} done${failed > 0 ? `, ${failed} failed` : ''}`);
      /* Re-classify so the card's counts tell the after-state truth. */
      setPreview(await authedFetch<DryRun>('/accounting/backfill/pi-periodic?dryRun=1', { method: 'POST', body: '{}' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The write pass stopped.');
    } finally {
      setBusy(null);
    }
  };

  const pendingCount = preview ? preview.missing.length + preview.reshape.length : 0;
  const failed = useMemo(() => (outcomes ?? []).filter((o) => o.outcome === 'failed'), [outcomes]);

  /* The result line under the head: what the dry run found, or what the
     write did — and, after it, what the re-check says is left. */
  let result: { tone: 'calm' | 'info' | 'warn'; text: string } | null = null;
  if (outcomes) {
    const done = outcomes.length - failed.length;
    result = failed.length > 0
      ? { tone: 'warn', text: `${done} done · ${failed.length} failed: ${failed[0]!.reason ?? failed[0]!.outcome}` }
      : {
        tone: 'info',
        text: `${done} done${preview && pendingCount === 0
          ? ' · every purchase invoice is current now'
          : preview ? ` · ${plural(pendingCount, 'invoice', 'invoices')} still to write` : ''}`,
      };
  } else if (preview) {
    result = {
      tone: 'calm',
      text: `${preview.missing.length} missing (${fmtSen(sum(preview.missing))}) · ${preview.reshape.length} to reshape (${fmtSen(sum(preview.reshape))}) · ${preview.current} already current.${pendingCount > 0 ? ' Nothing is written until you press Write.' : ''}`,
    };
  }
  const ResultIcon = result?.tone === 'info' ? CheckCircle2 : result?.tone === 'warn' ? AlertTriangle : Info;
  const noteTone = result?.tone === 'warn' ? sp.noteWarn : result?.tone === 'calm' ? sp.noteCalm : '';

  return (
    <section className={css.piCard} aria-label="Purchase invoices in the ledger">
      <div className={css.piHead}>
        <span className={css.piTitle}>Purchase invoices in the ledger</span>
        <span className={css.piSub}>Dr each group’s purchase account, Cr Trade creditors. Dry run first; the write is yours.</span>
        <span className={sp.grow} />
        <button type="button" className={sp.btn} disabled={busy != null} onClick={() => void dryRun()}>
          {busy === 'dry' ? 'Checking…' : preview ? 'Dry run again' : 'Dry run'}
        </button>
        {preview && pendingCount > 0 && (
          <button type="button" className={sp.btnSolid} disabled={busy != null} onClick={() => void write()}>
            {busy === 'write' ? 'Writing…' : `Write ${pendingCount}`}
          </button>
        )}
      </div>
      <div className={css.piBody}>
        <div className={sp.hint}>
          Each invoice posts through the normal engine on its own invoice date — an old 330 entry is reversed first, then
          posted again; running it twice changes nothing. This company only.
        </div>
        {error && <div className={sp.problem}>{error}</div>}
        {result && (
          <div className={`${sp.note} ${noteTone}`}>
            <ResultIcon size={14} />
            <span>{result.text}</span>
          </div>
        )}
        {rows && rows.length > 0 && (
          <DataTable<Row>
            tableId="pi-backfill"
            exportName="pi-backfill"
            columns={COLUMNS}
            rows={rows}
            getRowKey={(r) => r.invoiceNumber}
            emptyLabel="No invoice in this list."
            freezeHeight="off"
          />
        )}
      </div>
    </section>
  );
};
