// ----------------------------------------------------------------------------
// Acquirer settlement reconciliation (accounting phase 2B; brief §3.5 layer 3).
//
// "对账 ＝ 把「在途结算款」这个科目清干净的过程" — this screen exists to empty
// 320-0000. Upload the acquirer's statement, sort its lines into FOUR piles,
// and confirm: confirming posts Dr bank + Dr fee / Cr in-transit immediately,
// which is the single thing 系统3 never did (its card fees never reached the
// P&L and its bank never agreed with its books).
//
// The screen deliberately keeps 系统3's skeleton — four piles, bulk-confirm the
// auto-matched, a candidate list with clues, two standing watchlists, an export
// — and adds what it lacked: per-acquirer CONFIG instead of hardcoded quirks,
// no auto-confirm without a unique reference, and a loud refusal for a file it
// cannot read.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCheck, Download, Upload } from 'lucide-react';
import {
  useAcquirerSetup, useSaveAcquirerSetup, useSettlementBatches, useSettlementBatch,
  useUploadStatement, useConfirmSettlementRow, useConfirmMatched, useIgnoreSettlementRow,
  useSettlementWatchlist,
  type AcquirerSetup, type SettlementRow, type SettlementBucket,
} from './settlement-queries';
import { fmtCenti } from '../../vendor/shared/format';
import { downloadCSV, toCSV } from '../../lib/csv';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const fmt = (sen: number | null | undefined) => fmtCenti(sen ?? 0);

const btn = (primary?: boolean, disabled?: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 14px',
  border: '1px solid var(--c-ink)',
  borderRadius: 'var(--radius-md)',
  background: primary ? 'var(--c-ink)' : 'transparent',
  color: primary ? 'var(--c-cream)' : 'var(--c-ink)',
  fontSize: 'var(--fs-13)', fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});

const cell: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'top' };
const num: React.CSSProperties = { ...cell, textAlign: 'right', whiteSpace: 'nowrap' };
const table: React.CSSProperties = { width: '100%', fontSize: 'var(--fs-13)', borderCollapse: 'collapse' };
const headRow: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.12))' };
const softText: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #777)' };
const danger = 'var(--c-festive-b, #B8331F)';
const good = 'var(--c-secondary-a, #2F5D4F)';

const BUCKET_LABEL: Record<SettlementBucket, string> = {
  MATCHED: 'Matched',
  NEEDS_CONFIRM: 'Needs confirming',
  UNMATCHED: 'Not matched',
  IGNORED: 'Set aside',
};

export const SettlementRecon = () => {
  const [tab, setTab] = useState<'reconcile' | 'watchlists' | 'setup'>('reconcile');
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Card settlement reconciliation" />
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" style={btn(tab === 'reconcile')} onClick={() => setTab('reconcile')}>Reconcile</button>
        <button type="button" style={btn(tab === 'watchlists')} onClick={() => setTab('watchlists')}>Watchlists</button>
        <button type="button" style={btn(tab === 'setup')} onClick={() => setTab('setup')}>Acquirer setup</button>
      </div>
      {tab === 'reconcile' && <ReconcileTab />}
      {tab === 'watchlists' && <WatchlistTab />}
      {tab === 'setup' && <SetupTab />}
    </div>
  );
};

/* ── Reconcile: upload a statement, then work its four piles ───────────────── */

const ReconcileTab = () => {
  const setup = useAcquirerSetup();
  const batches = useSettlementBatches();
  const upload = useUploadStatement();
  const [batchId, setBatchId] = useState<number | null>(null);

  const acquirers = setup.data?.acquirers ?? [];
  const [code, setCode] = useState('');
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [summaryFee, setSummaryFee] = useState('');
  const chosen = acquirers.find((a) => a.code === code) ?? null;

  const readFile = (file: File | null) => {
    if (!file) { setFileName(''); setContent(''); return; }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setContent(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const send = () => {
    if (!code || !content) return;
    upload.mutate(
      {
        acquirerCode: code,
        fileName: fileName || 'statement.csv',
        content,
        summaryFeeSen: summaryFee.trim() ? Math.round(Number(summaryFee) * 100) : null,
      },
      { onSuccess: (r) => { setBatchId(r.batchId); setContent(''); setFileName(''); } },
    );
  };

  return (
    <div className="space-y-4">
      <section className="space-y-2" style={{
        padding: 'var(--space-4)', border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
        borderRadius: 'var(--radius-md)',
      }}>
        <b>Upload a settlement statement</b>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="Acquirer"
            style={{ padding: '6px 10px', fontSize: 'var(--fs-13)' }}>
            <option value="">Which acquirer?</option>
            {acquirers.filter((a) => a.is_active).map((a) => (
              <option key={a.code} value={a.code} disabled={!a.ready}>
                {a.display_name}{a.ready ? '' : ' — not set up yet'}
              </option>
            ))}
          </select>
          <input type="file" accept=".csv,text/csv" aria-label="Statement file"
            onChange={(e) => readFile(e.target.files?.[0] ?? null)} style={{ fontSize: 'var(--fs-13)' }} />
          {chosen?.fee_method === 'prorated-summary' && (
            <input value={summaryFee} onChange={(e) => setSummaryFee(e.target.value)}
              placeholder="Statement fee total (RM)" aria-label="Statement fee total"
              style={{ padding: '6px 10px', fontSize: 'var(--fs-13)', width: 180 }} />
          )}
          <button type="button" style={btn(true, !code || !content || upload.isPending)}
            disabled={!code || !content || upload.isPending} onClick={send}>
            <Upload {...ICON} /> {upload.isPending ? 'Reading…' : 'Upload'}
          </button>
        </div>
        {chosen && !chosen.autoMatchable && (
          <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
            {chosen.display_name} sends no unique transaction reference — every line will wait for you to confirm it.
            Nothing here can auto-match on amount and date alone.
          </div>
        )}
        {upload.isError && (
          <div style={{ fontSize: 'var(--fs-13)', color: danger, display: 'flex', gap: 6 }}>
            <AlertTriangle {...ICON} />
            <span>{(upload.error as { message?: string })?.message ?? 'The statement could not be read.'}</span>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <b>Statements</b>
        {(batches.data?.batches ?? []).length === 0 && <div style={softText}>Nothing uploaded yet.</div>}
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Acquirer</th><th style={cell}>File</th><th style={cell}>Period</th>
              <th style={num}>Lines</th><th style={num}>Gross</th><th style={num}>Fee</th><th style={num}>Net</th><th style={cell} />
            </tr>
          </thead>
          <tbody>
            {(batches.data?.batches ?? []).map((b) => (
              <tr key={b.id} style={{ borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' }}>
                <td style={cell}><span className={styles.codeChip}>{b.acquirer_code}</span></td>
                <td style={cell}>{b.file_name}</td>
                <td style={cell}>{b.period_from} → {b.period_to}</td>
                <td style={num}>{b.row_count}</td>
                <td style={num}>{fmt(b.gross_sen)}</td>
                <td style={num}>{fmt(b.fee_sen)}</td>
                <td style={num}>{fmt(b.net_sen)}</td>
                <td style={cell}>
                  <button type="button" style={btn(batchId === b.id)} onClick={() => setBatchId(b.id)}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {batchId != null && <BatchView batchId={batchId} />}
    </div>
  );
};

/* ── One statement, four piles ────────────────────────────────────────────── */

const BatchView = ({ batchId }: { batchId: number }) => {
  const q = useSettlementBatch(batchId);
  const confirmAll = useConfirmMatched();
  const [pile, setPile] = useState<SettlementBucket>('NEEDS_CONFIRM');

  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const buckets = q.data?.buckets ?? {};
  const shown = rows.filter((r) => r.bucket === pile);
  const unconfirmedMatched = rows.filter((r) => r.bucket === 'MATCHED' && !r.confirmed_at).length;

  const exportCsv = () => {
    downloadCSV(`settlement-batch-${batchId}.csv`, toCSV(rows, [
      { key: 'line', label: 'Line', getValue: (r) => r.line_no },
      { key: 'date', label: 'Date', getValue: (r) => r.txn_date },
      { key: 'ref', label: 'Reference', getValue: (r) => r.ref ?? '' },
      { key: 'gross', label: 'Gross', getValue: (r) => (r.gross_sen / 100).toFixed(2) },
      { key: 'fee', label: 'Fee', getValue: (r) => (r.fee_sen / 100).toFixed(2) },
      { key: 'net', label: 'Net', getValue: (r) => (r.net_sen / 100).toFixed(2) },
      { key: 'bucket', label: 'Bucket', getValue: (r) => BUCKET_LABEL[r.bucket] },
      { key: 'je', label: 'Journal', getValue: (r) => r.posted_je_no ?? '' },
      { key: 'note', label: 'Note', getValue: (r) => r.clue ?? r.notes ?? '' },
    ]));
  };

  return (
    <section className="space-y-3" style={{
      padding: 'var(--space-4)', border: '1px solid var(--c-ink)', borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {(['MATCHED', 'NEEDS_CONFIRM', 'UNMATCHED', 'IGNORED'] as SettlementBucket[]).map((b) => (
          <button key={b} type="button" style={btn(pile === b)} onClick={() => setPile(b)}>
            {BUCKET_LABEL[b]} ({buckets[b] ?? 0})
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" style={btn(true, unconfirmedMatched === 0 || confirmAll.isPending)}
          disabled={unconfirmedMatched === 0 || confirmAll.isPending}
          onClick={() => confirmAll.mutate(batchId)}>
          <CheckCheck {...ICON} /> Confirm all matched ({unconfirmedMatched})
        </button>
        <button type="button" style={btn()} onClick={exportCsv}><Download {...ICON} /> Export</button>
      </div>

      {confirmAll.data && (
        <div style={{ fontSize: 'var(--fs-13)', color: confirmAll.data.failed.length ? danger : good }}>
          Posted {confirmAll.data.confirmed} of {confirmAll.data.attempted}.
          {confirmAll.data.failed.map((f) => <div key={f.rowId}>Line {f.rowId}: {f.reason}</div>)}
        </div>
      )}

      <div style={softText}>
        Confirming a line posts it straight away: the net into the bank, the fee into merchant charges, and the
        gross out of settlement-in-transit. Nothing is left "for next period".
      </div>

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading the statement…</div>}
      {!q.isLoading && shown.length === 0 && <div style={softText}>This pile is empty.</div>}
      {shown.map((r) => <SettlementLine key={r.id} row={r} />)}
    </section>
  );
};

/* ── One statement line, with its candidates ──────────────────────────────── */

const SettlementLine = ({ row }: { row: SettlementRow }) => {
  const confirm = useConfirmSettlementRow();
  const ignore = useIgnoreSettlementRow();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const key = (p: { source: string; id: string }) => `${p.source}:${p.id}`;

  const chosen = row.candidates.filter((p) => picked.has(key(p)));
  const chosenSen = chosen.reduce((s, p) => s + p.amountSen, 0);
  const balanced = chosen.length > 0 && chosenSen === row.gross_sen;
  const hinted = new Set(row.comboHints.flat());

  const toggle = (p: { source: string; id: string }) => {
    setPicked((prev) => {
      const next = new Set(prev);
      const k = key(p);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  return (
    <div style={{
      padding: 'var(--space-3)', border: '1px solid var(--c-line, rgba(34,31,32,0.15))',
      borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-2)',
    }} className="space-y-2">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className={styles.codeChip}>Line {row.line_no}</span>
        <span>{row.txn_date}</span>
        {row.ref && <span>ref <b>{row.ref}</b></span>}
        <span style={{ flex: 1 }} />
        <span><b>{fmt(row.gross_sen)}</b> gross</span>
        <span style={softText}>− {fmt(row.fee_sen)} fee = {fmt(row.net_sen)} net</span>
      </div>

      {row.clue && <div style={softText}>{row.clue}</div>}

      {row.posted_je_no && (
        <div style={{ fontSize: 'var(--fs-13)', color: good }}>
          Posted as <span className={styles.codeChip}>{row.posted_je_no}</span>
          {row.linked.length > 0 && ` — ${row.linked.map((l) => l.doc_no ?? l.payment_id).join(', ')}`}
        </div>
      )}

      {!row.confirmed_at && row.linked.length > 0 && (
        <div style={{ fontSize: 'var(--fs-13)' }}>
          Matched to {row.linked.map((l) => l.doc_no ?? l.payment_id).join(', ')} — not posted yet.
        </div>
      )}

      {!row.confirmed_at && row.candidates.length > 0 && (
        <div className="space-y-1">
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell} />
                <th style={cell}>Document</th><th style={cell}>Paid</th>
                <th style={cell}>Approval</th><th style={num}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {row.candidates.map((p) => (
                <tr key={key(p)} style={hinted.has(p.id) ? { background: 'rgba(47, 93, 79, 0.08)' } : undefined}>
                  <td style={cell}>
                    <input type="checkbox" checked={picked.has(key(p))} onChange={() => toggle(p)}
                      aria-label={`Select ${p.docNo}`} />
                  </td>
                  <td style={cell}>{p.docNo}</td>
                  <td style={cell}>{p.paidOn}</td>
                  <td style={cell}>{p.approvalCode ?? '—'}</td>
                  <td style={num}>{fmt(p.amountSen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-13)', color: balanced ? good : danger }}>
              Selected {fmt(chosenSen)} of {fmt(row.gross_sen)}
              {chosen.length > 0 && !balanced && ` — ${fmt(chosenSen - row.gross_sen)} out`}
            </span>
            <button type="button" style={btn(true, !balanced || confirm.isPending)}
              disabled={!balanced || confirm.isPending}
              onClick={() => confirm.mutate({
                rowId: row.id,
                matchReason: 'manual',
                payments: chosen.map((p) => ({ source: p.source, id: p.id, docNo: p.docNo, amountSen: p.amountSen })),
              })}>
              Confirm and post
            </button>
            <button type="button" style={btn()} onClick={() => ignore.mutate({ rowId: row.id, restore: row.bucket === 'IGNORED' })}>
              {row.bucket === 'IGNORED' ? 'Put back' : 'Set aside'}
            </button>
          </div>
        </div>
      )}

      {!row.confirmed_at && row.candidates.length === 0 && row.linked.length === 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--fs-13)', color: danger }}>
            No payment in the ERP explains this money. Record the sale first — it must not be cleared out of
            in-transit without one.
          </span>
          <button type="button" style={btn()} onClick={() => ignore.mutate({ rowId: row.id, restore: row.bucket === 'IGNORED' })}>
            {row.bucket === 'IGNORED' ? 'Put back' : 'Set aside'}
          </button>
        </div>
      )}

      {confirm.isError && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
          {(confirm.error as { message?: string })?.message ?? 'The line was not confirmed.'}
        </div>
      )}
    </div>
  );
};

/* ── The two standing watchlists ──────────────────────────────────────────── */

const WatchlistTab = () => {
  const q = useSettlementWatchlist();
  const w = q.data;
  return (
    <div className="space-y-4">
      <div style={softText}>
        These two lists are what bank reconciliation (phase 4) will refuse to open until they are empty.
      </div>
      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
      {w?.clean && <div style={{ fontSize: 'var(--fs-13)', color: good }}>Nothing outstanding between {w.from} and {w.to}.</div>}

      <section className="space-y-1">
        <b>Recorded, not arrived</b>
        <div style={softText}>Card money the ERP recorded that no statement has settled yet.</div>
        <table style={table}>
          <thead><tr style={headRow}>
            <th style={cell}>Acquirer</th><th style={cell}>Document</th><th style={cell}>Paid</th>
            <th style={num}>Age (days)</th><th style={num}>Amount</th>
          </tr></thead>
          <tbody>
            {(w?.recordedNotArrived ?? []).map((p) => (
              <tr key={`${p.source}:${p.id}`}>
                <td style={cell}><span className={styles.codeChip}>{p.acquirerCode}</span></td>
                <td style={cell}>{p.docNo}</td>
                <td style={cell}>{p.paidOn}</td>
                <td style={{ ...num, color: p.ageDays > 14 ? danger : undefined }}>{p.ageDays}</td>
                <td style={num}>{fmt(p.amountSen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-1">
        <b>Arrived, not recorded</b>
        <div style={softText}>Money the acquirer says it sent that has no sale behind it in the ERP.</div>
        <table style={table}>
          <thead><tr style={headRow}>
            <th style={cell}>Acquirer</th><th style={cell}>Date</th><th style={cell}>Reference</th>
            <th style={num}>Amount</th><th style={cell}>Note</th>
          </tr></thead>
          <tbody>
            {(w?.arrivedNotRecorded ?? []).map((r) => (
              <tr key={r.id}>
                <td style={cell}><span className={styles.codeChip}>{r.acquirer_code}</span></td>
                <td style={cell}>{String(r.txn_date).slice(0, 10)}</td>
                <td style={cell}>{r.ref ?? '—'}</td>
                <td style={num}>{fmt(r.gross_sen)}</td>
                <td style={cell}>{r.notes ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
};

/* ── Acquirer setup (决定4) — asked once, shared by every company ──────────── */

const SetupTab = () => {
  const q = useAcquirerSetup();
  return (
    <div className="space-y-3">
      <div style={softText}>
        The statement shape below is taught ONCE and every company uses it. Only the bank account the money lands
        in is per company. An acquirer that is not fully set up cannot have a statement uploaded against it.
      </div>
      {(q.data?.acquirers ?? []).map((a) => <AcquirerCard key={a.code} acquirer={a} />)}
    </div>
  );
};

const AcquirerCard = ({ acquirer }: { acquirer: AcquirerSetup }) => {
  const save = useSaveAcquirerSetup();
  const [form, setForm] = useState({
    statementFormat: acquirer.statement_format ?? '',
    hasUniqueRef: acquirer.has_unique_ref == null ? '' : String(acquirer.has_unique_ref),
    feeMethod: acquirer.fee_method ?? '',
    dateToleranceDays: String(acquirer.date_tolerance_days ?? 3),
    bankAccountCode: acquirer.bank_account_code ?? '',
    columnMap: JSON.stringify(acquirer.column_map ?? { date: '', ref: '', gross: '', fee: '', net: '' }, null, 0),
  });
  const [mapError, setMapError] = useState('');

  const submit = () => {
    let columnMap: Record<string, string> | null = null;
    try {
      const parsed = JSON.parse(form.columnMap || '{}') as Record<string, string>;
      columnMap = Object.fromEntries(Object.entries(parsed).filter(([, v]) => String(v ?? '').trim() !== ''));
    } catch {
      setMapError('The column names must be valid JSON, e.g. {"date":"Txn Date","gross":"Amount"}');
      return;
    }
    setMapError('');
    save.mutate({
      code: acquirer.code,
      statementFormat: form.statementFormat || null,
      hasUniqueRef: form.hasUniqueRef === '' ? null : form.hasUniqueRef === 'true',
      feeMethod: form.feeMethod || null,
      dateToleranceDays: Number(form.dateToleranceDays) || 0,
      columnMap,
      bankAccountCode: form.bankAccountCode || null,
    });
  };

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--fs-12)' }}>
      <span style={{ color: 'var(--c-ink-soft, #777)' }}>{label}</span>
      {node}
    </label>
  );
  const input: React.CSSProperties = { padding: '5px 8px', fontSize: 'var(--fs-13)', minWidth: 150 };

  return (
    <section className="space-y-2" style={{
      padding: 'var(--space-3)', border: '1px solid var(--c-line, rgba(34,31,32,0.2))', borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}>
        <b>{acquirer.display_name}</b>
        <span className={styles.codeChip}>{acquirer.code}</span>
        <span style={{ fontSize: 'var(--fs-12)', color: acquirer.ready ? good : danger }}>
          {acquirer.ready ? 'ready' : 'not set up'}
        </span>
        <span style={softText}>transit {acquirer.transit_account_code} · fee {acquirer.fee_account_code}</span>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        {field('Statement format', (
          <select style={input} value={form.statementFormat} aria-label={`${acquirer.code} statement format`}
            onChange={(e) => setForm({ ...form, statementFormat: e.target.value })}>
            <option value="">not known</option><option value="CSV">CSV</option>
            <option value="XLSX">XLSX</option><option value="PDF">PDF</option>
          </select>
        ))}
        {field('Unique transaction reference?', (
          <select style={input} value={form.hasUniqueRef} aria-label={`${acquirer.code} unique reference`}
            onChange={(e) => setForm({ ...form, hasUniqueRef: e.target.value })}>
            <option value="">not known</option><option value="true">yes</option><option value="false">no</option>
          </select>
        ))}
        {field('Fee shown as', (
          <select style={input} value={form.feeMethod} aria-label={`${acquirer.code} fee method`}
            onChange={(e) => setForm({ ...form, feeMethod: e.target.value })}>
            <option value="">not known</option>
            <option value="stated">a column on each line</option>
            <option value="gross-minus-net">gross minus net</option>
            <option value="prorated-summary">one total for the statement</option>
          </select>
        ))}
        {field('Date tolerance (days)', (
          <input style={{ ...input, minWidth: 80 }} value={form.dateToleranceDays} aria-label={`${acquirer.code} date tolerance`}
            onChange={(e) => setForm({ ...form, dateToleranceDays: e.target.value })} />
        ))}
        {field('Money lands in account', (
          <input style={input} value={form.bankAccountCode} placeholder="e.g. 331-0000" aria-label={`${acquirer.code} bank account`}
            onChange={(e) => setForm({ ...form, bankAccountCode: e.target.value })} />
        ))}
      </div>
      {field('Column names in the file', (
        <input style={{ ...input, minWidth: 420 }} value={form.columnMap} aria-label={`${acquirer.code} column names`}
          onChange={(e) => setForm({ ...form, columnMap: e.target.value })} />
      ))}
      {mapError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{mapError}</div>}
      {form.hasUniqueRef === 'false' && (
        <div style={{ fontSize: 'var(--fs-12)', color: danger }}>
          Without a unique reference nothing from {acquirer.code} can be confirmed automatically — every line
          will be matched by hand.
        </div>
      )}
      <button type="button" style={btn(true, save.isPending)} disabled={save.isPending} onClick={submit}>
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
    </section>
  );
};

export default SettlementRecon;
