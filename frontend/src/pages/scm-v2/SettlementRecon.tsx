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
  useSettlementWatchlist, useInTransit,
  type AgeBucket,
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

/**
 * The server's OWN sentence, not the humanised one.
 *
 * authedFetch runs every failure through the shared `humanApiError`, which
 * drops any message containing "column" / "relation" / "constraint" as a
 * suspected database internal — and this feature's whole contract is that a
 * statement it cannot read says WHY ("no Txn Date heading; the file has: …").
 * That message was being replaced with "some details weren't accepted", which
 * is precisely the silence §2.14 forbids. The raw body is preserved on the
 * error object, so read it there and fall back to the humanised text.
 */
export const refusalText = (err: unknown, fallback: string): string => {
  const e = err as { body?: string; message?: string } | null;
  try {
    const parsed = JSON.parse(e?.body ?? '') as { message?: string; reason?: string };
    const own = parsed.message ?? parsed.reason;
    if (typeof own === 'string' && own.trim()) return own;
  } catch { /* not JSON — fall through */ }
  /* An EMPTY message is silence too — fall through to the caller's sentence
     rather than render a blank red line. */
  return e?.message?.trim() ? e.message : fallback;
};

/* The server sends the four piles as a plain tally; a bucket with nothing in it
   is simply absent, so read it as a lookup rather than a guaranteed key. */
const bucketCount = (buckets: Record<string, number>, key: SettlementBucket): number =>
  Number(buckets[key] ?? 0);

const BUCKET_LABEL: Record<SettlementBucket, string> = {
  MATCHED: 'Matched',
  NEEDS_CONFIRM: 'Needs confirming',
  UNMATCHED: 'Not matched',
  IGNORED: 'Set aside',
};

export const SettlementRecon = () => {
  const [tab, setTab] = useState<'reconcile' | 'transit' | 'watchlists' | 'setup'>('reconcile');
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Card settlement reconciliation" />
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" style={btn(tab === 'reconcile')} onClick={() => setTab('reconcile')}>Reconcile</button>
        <button type="button" style={btn(tab === 'transit')} onClick={() => setTab('transit')}>Paid, not yet in the bank</button>
        <button type="button" style={btn(tab === 'watchlists')} onClick={() => setTab('watchlists')}>Watchlists</button>
        <button type="button" style={btn(tab === 'setup')} onClick={() => setTab('setup')}>Acquirer setup</button>
      </div>
      {tab === 'reconcile' && <ReconcileTab />}
      {tab === 'transit' && <InTransitTab />}
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
  const [files, setFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [summaryFee, setSummaryFee] = useState('');
  /* Some terminal statements date a line "05-Jun" with no year anywhere in the
     file. The operator answers that; the system never guesses which year money
     belongs to. */
  const [statementMonth, setStatementMonth] = useState('');
  /* The day the acquirer's money actually reached the bank, off its payment
     advice. Public Bank's advice of 10 Aug paid for trading on the 7th, 8th and
     9th, so dating the bank leg by the swipe would show money in the account
     days before it was there — and across a month end, in a month that never
     received it. Left blank, the entry keeps the statement line's own date,
     which is right for an acquirer that pays same-day. */
  const [paidOn, setPaidOn] = useState('');
  /* One result line per file — a month's statements go up in one go and each
     one answers for itself, so a single bad file never hides four good ones. */
  const [results, setResults] = useState<Array<{ name: string; ok: boolean; text: string }>>([]);
  const [busy, setBusy] = useState(false);
  const chosen = acquirers.find((a) => a.code === code) ?? null;

  /**
   * Read each file to CSV text.
   *
   * AEON sends .xlsx and the reader on the server speaks CSV, so the sheet is
   * flattened HERE — the app already ships SheetJS for its other exports, so
   * this costs no new dependency and no new parser. Loaded on demand so the
   * library stays out of the page's initial bundle.
   */
  const readFiles = (picked: FileList | null) => {
    setResults([]);
    if (!picked || picked.length === 0) { setFiles([]); return; }
    void Promise.all([...picked].map(async (f) => {
      if (!/\.xlsx?$/i.test(f.name)) return { name: f.name, content: await f.text() };
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      /* First sheet only — every acquirer export seen so far is one sheet, and
         a workbook with none reaches the server as an empty file, which it
         already refuses by name rather than accepting as an empty batch. */
      const first: string | undefined = wb.SheetNames[0];
      return { name: f.name, content: first ? XLSX.utils.sheet_to_csv(wb.Sheets[first]) : '' };
    })).then(setFiles);
  };

  const send = async () => {
    if (!code || files.length === 0) return;
    setBusy(true);
    setResults([]);
    const done: Array<{ name: string; ok: boolean; text: string }> = [];
    let lastBatch: number | null = null;
    /* Sequential, not parallel: each upload's matching must see the payments
       the previous one already claimed, or two statements could both take the
       same money and only the database's unique index would catch it. */
    for (const f of files) {
      try {
        const r = await upload.mutateAsync({
          acquirerCode: code,
          fileName: f.name,
          content: f.content,
          summaryFeeSen: summaryFee.trim() ? Math.round(Number(summaryFee) * 100) : null,
          statementMonth: statementMonth || null,
          paidOn: paidOn || null,
        });
        lastBatch = r.batchId;
        done.push({
          name: f.name,
          ok: true,
          text: `${r.rows} line${r.rows === 1 ? '' : 's'} (${r.periodFrom} → ${r.periodTo}), gross ${fmt(r.grossSen)}, fee ${fmt(r.feeSen)}`
            + (r.skippedLines > 0 ? ` · ${r.skippedLines} summary line(s) left out` : '')
            + ` · matched ${bucketCount(r.buckets, 'MATCHED')}, to confirm ${bucketCount(r.buckets, 'NEEDS_CONFIRM')}, not matched ${bucketCount(r.buckets, 'UNMATCHED')}`,
        });
      } catch (err) {
        done.push({ name: f.name, ok: false, text: refusalText(err, 'The statement could not be read.') });
      }
      setResults([...done]);
    }
    setBusy(false);
    setFiles([]);
    if (lastBatch != null) setBatchId(lastBatch);
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
          <input type="file" accept=".csv,.xls,.xlsx,text/csv" multiple aria-label="Statement files"
            onChange={(e) => readFiles(e.target.files)} style={{ fontSize: 'var(--fs-13)' }} />
          {chosen?.fee_method === 'prorated-summary' && (
            <input value={summaryFee} onChange={(e) => setSummaryFee(e.target.value)}
              placeholder="Statement fee total (RM)" aria-label="Statement fee total"
              style={{ padding: '6px 10px', fontSize: 'var(--fs-13)', width: 180 }} />
          )}
          <button type="button" style={btn(true, !code || files.length === 0 || busy)}
            disabled={!code || files.length === 0 || busy} onClick={() => { void send(); }}>
            <Upload {...ICON} /> {busy ? 'Reading…' : `Upload${files.length > 1 ? ` ${files.length} files` : ''}`}
          </button>
        </div>
        {/* Asked ONLY of the acquirer whose file needs it. Hong Leong dates a
            line "16-Aug" with no year anywhere in the statement, so somebody
            has to say which year that is — and nothing here guesses. Every
            other acquirer dates its lines in full, and putting a field in
            front of people who do not need it is how a screen teaches them to
            ignore the fields that matter. */}
        {chosen?.dates_have_no_year === true && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 'var(--fs-13)', fontWeight: 600 }} htmlFor="settlement-month">
              Which month does this statement cover?
            </label>
            <input id="settlement-month" type="month" value={statementMonth} aria-label="Statement month"
              onChange={(e) => setStatementMonth(e.target.value)}
              style={{ padding: '5px 8px', fontSize: 'var(--fs-13)' }} />
            <span style={softText}>
              {chosen.display_name} dates its lines like &ldquo;16-Aug&rdquo; with no year, so it has to be told.
            </span>
          </div>
        )}
        {/* The acquirer does not pay on the day the card is swiped. Public Bank's
            advice of 10 Aug paid for trading on the 7th, 8th and 9th — so the
            bank leg is dated by the PAYOUT, and the days in between sit in
            settlement-in-transit where they belong. Left blank for an acquirer
            that pays same-day, the entry keeps the statement's own date. */}
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 'var(--fs-13)', fontWeight: 600 }} htmlFor="settlement-paid-on">
            Money reached the bank on
          </label>
          <input id="settlement-paid-on" type="date" value={paidOn} aria-label="Money reached the bank on"
            onChange={(e) => setPaidOn(e.target.value)}
            style={{ padding: '5px 8px', fontSize: 'var(--fs-13)' }} />
          <span style={softText}>
            From the acquirer&rsquo;s payment advice. The bank entry is dated by this, so the books agree with the
            bank statement — leave it blank if this acquirer pays the same day.
          </span>
        </div>
        <div style={softText}>
          You can pick several files at once — they go up one after another, and each one answers for itself.
        </div>
        {chosen && !chosen.autoMatchable && (
          <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
            {chosen.display_name} sends no unique transaction reference — every line will wait for you to confirm it.
            Nothing here can auto-match on amount and date alone.
          </div>
        )}
        {results.map((r) => (
          <div key={r.name} style={{ fontSize: 'var(--fs-13)', color: r.ok ? good : danger, display: 'flex', gap: 6 }}>
            {!r.ok && <AlertTriangle {...ICON} />}
            <span><b>{r.name}</b> — {r.text}</span>
          </div>
        ))}
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
  const batch = q.data?.batch ?? null;
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

      {/* The charge the STATEMENT makes that no transaction on it explains —
          AEON's subvention fee. Shown whether or not it is booked yet, because
          an unbooked one means the bank balance in the books is wrong by
          exactly this much. */}
      {batch && batch.adjustment_sen !== 0 && (
        <div style={{
          padding: 'var(--space-3)', borderRadius: 'var(--radius-md)',
          border: `1px solid ${batch.adjustment_je_no ? good : danger}`,
          background: batch.adjustment_je_no ? 'rgba(47,93,79,0.08)' : 'rgba(184,51,31,0.08)',
          fontSize: 'var(--fs-13)',
        }}>
          <b>Charge on the statement, not on any transaction: {fmt(Math.abs(batch.adjustment_sen))}</b>
          <div style={softText}>
            The lines come to {fmt(batch.net_sen)}, and {batch.acquirer_code} says it is paying {fmt(batch.stated_net_sen ?? 0)}.
            {batch.adjustment_je_no
              ? ` Booked as ${batch.adjustment_je_no} — merchant charges up, bank down.`
              : ' Not booked yet — confirm the batch and it posts against the bank, because that money never arrived.'}
          </div>
        </div>
      )}

      {confirmAll.data && (
        <div style={{ fontSize: 'var(--fs-13)', color: confirmAll.data.failed.length ? danger : good }}>
          Posted {confirmAll.data.confirmed} of {confirmAll.data.attempted}.
          {confirmAll.data.statementCharge?.jeNo && ` Statement charge booked as ${confirmAll.data.statementCharge.jeNo}.`}
          {confirmAll.data.failed.map((f) => <div key={f.rowId}>{f.rowId ? `Line ${f.rowId}: ` : ''}{f.reason}</div>)}
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

      {!row.confirmed_at && (
        <div style={softText}>
          &ldquo;Set aside&rdquo; just moves this line out of the working list — it books nothing and the
          money stays in settlement-in-transit. Use it for a line you have looked at and decided to
          deal with another way; you can put it back at any time.
        </div>
      )}

      {confirm.isError && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
          {(confirm.error as { message?: string } | null)?.message ?? 'The line was not confirmed.'}
        </div>
      )}
    </div>
  );
};

/* ── Paid by the customer, not yet in the bank ─────────────────────────────
   The owner asked for this in these words: he needs to see that a customer HAS
   paid while the money has not arrived or been reconciled, in DETAIL, not as a
   balance. It is the brief's 在途结算款账龄 (§3.7) and it is the readable form
   of the 320-0000 balance — same money, named to the document. */

const IN_TRANSIT_STATE: Record<string, string> = {
  NOT_ON_A_STATEMENT: 'The acquirer has not reported it yet',
  MATCHED_NOT_POSTED: 'On a statement, waiting to be confirmed',
};

const AGE_BUCKETS: AgeBucket[] = ['0-7', '8-14', '15-30', 'over-30'];

const InTransitTab = () => {
  const q = useInTransit();
  const data = q.data;
  const lines = data?.lines ?? [];

  const exportCsv = () => {
    downloadCSV('paid-not-yet-in-the-bank.csv', toCSV(lines, [
      { key: 'acq', label: 'Acquirer', getValue: (l) => l.acquirerCode },
      { key: 'doc', label: 'Document', getValue: (l) => l.docNo },
      { key: 'paid', label: 'Customer paid on', getValue: (l) => l.paidOn },
      { key: 'age', label: 'Days', getValue: (l) => l.ageDays },
      { key: 'amt', label: 'Amount', getValue: (l) => (l.amountSen / 100).toFixed(2) },
      { key: 'auth', label: 'Approval', getValue: (l) => l.approvalCode ?? '' },
      { key: 'who', label: 'Recorded by', getValue: (l) => l.recordedBy ?? '' },
      { key: 'state', label: 'Status', getValue: (l) => IN_TRANSIT_STATE[l.state] ?? l.state },
    ]));
  };

  return (
    <div className="space-y-3">
      <div style={softText}>
        The customer has paid and the money has not reached the bank yet. This is the same money as the
        settlement-in-transit balance on the trial balance — here it is named to the document, so you can see
        WHOSE it is rather than just how much.
      </div>

      <div style={{
        padding: 'var(--space-4)', borderRadius: 'var(--radius-md)',
        background: 'rgba(47, 93, 79, 0.10)', border: '1px solid var(--c-secondary-a, #2F5D4F)',
        display: 'flex', gap: 'var(--space-5)', alignItems: 'baseline', flexWrap: 'wrap',
      }}>
        <div>
          <div style={softText}>Sitting with the acquirers right now</div>
          <div style={{ fontSize: 'var(--fs-24, 22px)', fontWeight: 700 }}>{fmt(data?.totalSen)}</div>
        </div>
        <div style={softText}>{lines.length} payment{lines.length === 1 ? '' : 's'}</div>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn()} onClick={exportCsv} disabled={lines.length === 0}>
          <Download {...ICON} /> Export
        </button>
      </div>

      {/* Ageing by acquirer — how long each one has been holding the money. */}
      {data && Object.keys(data.ageing).length > 0 && (
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Acquirer</th>
              {AGE_BUCKETS.map((b) => <th key={b} style={num}>{b === 'over-30' ? 'over 30 days' : `${b} days`}</th>)}
              <th style={num}>Total</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.ageing).map(([acq, buckets]) => {
              const total = Object.values(buckets).reduce((s, b) => s + b.sen, 0);
              return (
                <tr key={acq} style={{ borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' }}>
                  <td style={cell}><span className={styles.codeChip}>{acq}</span></td>
                  {AGE_BUCKETS.map((b) => {
                    /* A bucket with nothing in it is simply absent from the
                       server's tally, so this is a lookup, not a guaranteed key. */
                    const inBucket = buckets[b];
                    return (
                      <td key={b} style={{ ...num, color: b === 'over-30' && inBucket ? danger : undefined }}>
                        {inBucket ? fmt(inBucket.sen) : '—'}
                      </td>
                    );
                  })}
                  <td style={{ ...num, fontWeight: 700 }}>{fmt(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
      {!q.isLoading && lines.length === 0 && (
        <div style={{ fontSize: 'var(--fs-13)', color: good }}>
          Nothing outstanding — every card payment recorded has reached the bank.
        </div>
      )}

      {lines.length > 0 && (
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Acquirer</th><th style={cell}>Document</th>
              <th style={cell}>Customer paid on</th><th style={num}>Days</th>
              <th style={num}>Amount</th><th style={cell}>Approval</th>
              <th style={cell}>Recorded by</th><th style={cell}>Where it is</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={`${l.source}:${l.paymentId}`} style={{ borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' }}>
                <td style={cell}><span className={styles.codeChip}>{l.acquirerCode}</span></td>
                <td style={cell}>{l.docNo}</td>
                <td style={cell}>{l.paidOn}</td>
                <td style={{ ...num, color: l.ageDays > 14 ? danger : undefined, fontWeight: l.ageDays > 14 ? 700 : undefined }}>{l.ageDays}</td>
                <td style={num}>{fmt(l.amountSen)}</td>
                <td style={cell}>{l.approvalCode ?? '—'}</td>
                <td style={cell}>{l.recordedBy ?? '—'}</td>
                <td style={cell}>{IN_TRANSIT_STATE[l.state] ?? l.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

/* The five headings a statement can carry. Which of them are REQUIRED depends
   on the fee method, so the form says so instead of letting the upload be the
   place where the operator finds out. */
const HEADING_FIELDS = [
  { key: 'date', label: 'Date heading', hint: 'e.g. Txn Date' },
  { key: 'ref', label: 'Reference heading', hint: 'e.g. Approval Code' },
  { key: 'gross', label: 'Amount heading', hint: 'e.g. Gross' },
  { key: 'fee', label: 'Fee heading', hint: 'e.g. MDR' },
  { key: 'net', label: 'Net heading', hint: 'e.g. Net Credited' },
] as const;

const AcquirerCard = ({ acquirer }: { acquirer: AcquirerSetup }) => {
  const save = useSaveAcquirerSetup();
  const [form, setForm] = useState({
    statementFormat: acquirer.statement_format ?? '',
    hasUniqueRef: acquirer.has_unique_ref == null ? '' : String(acquirer.has_unique_ref),
    feeMethod: acquirer.fee_method ?? '',
    dateToleranceDays: String(acquirer.date_tolerance_days),
    bankAccountCode: acquirer.bank_account_code ?? '',
  });
  const [headings, setHeadings] = useState<Record<string, string>>(() => {
    const m = acquirer.column_map ?? {};
    return Object.fromEntries(HEADING_FIELDS.map((f) => [f.key, m[f.key] ?? '']));
  });
  const [mapError, setMapError] = useState('');

  const requiredHeadings = ['date', 'gross',
    ...(form.feeMethod === 'stated' ? ['fee'] : []),
    ...(form.feeMethod === 'gross-minus-net' ? ['net'] : []),
    ...(form.hasUniqueRef === 'true' ? ['ref'] : []),
  ];

  const submit = () => {
    const missing = requiredHeadings.filter((k) => !String(headings[k] ?? '').trim());
    if (missing.length > 0) {
      setMapError(`Fill in the ${missing.map((k) => HEADING_FIELDS.find((f) => f.key === k)?.label.replace(' heading', '')).join(', ')} heading${missing.length > 1 ? 's' : ''} — a statement cannot be read without ${missing.length > 1 ? 'them' : 'it'}.`);
      return;
    }
    setMapError('');
    save.mutate({
      code: acquirer.code,
      statementFormat: form.statementFormat || null,
      hasUniqueRef: form.hasUniqueRef === '' ? null : form.hasUniqueRef === 'true',
      feeMethod: form.feeMethod || null,
      dateToleranceDays: Number(form.dateToleranceDays) || 0,
      columnMap: Object.fromEntries(
        Object.entries(headings).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v !== ''),
      ),
      bankAccountCode: form.bankAccountCode || null,
    });
  };

  /* `key` matters for the heading fields below, which are rendered from a list —
     without it React cannot tell one input from the next and reuses the wrong
     DOM node when the required-field marks change. */
  const field = (label: string, node: React.ReactNode, key?: string) => (
    <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--fs-12)' }}>
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
      <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #777)', marginTop: 4 }}>
        Type each heading exactly as it appears in the first row of {acquirer.display_name}'s file.
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        {HEADING_FIELDS.map((f) => {
          const required = requiredHeadings.includes(f.key);
          return field(`${f.label}${required ? ' *' : ''}`, (
            <input
              style={{ ...input, minWidth: 170, borderColor: required && !headings[f.key] ? danger : undefined }}
              value={headings[f.key] ?? ''} placeholder={f.hint}
              aria-label={`${acquirer.code} ${f.label}`}
              onChange={(e) => setHeadings({ ...headings, [f.key]: e.target.value })}
            />
          ), f.key);
        })}
      </div>
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
