// ----------------------------------------------------------------------------
// Acquirer settlement reconciliation (accounting phase 2B; brief §3.5 layer 3).
//
// "对账 ＝ 把「在途结算款」这个科目清干净的过程" — this screen exists to empty
// 320-0000. Upload the acquirer's statement, sort its lines into FOUR piles,
// and confirm. Confirming posts the FEE immediately (Dr merchant charges / Cr
// in-transit) — the single thing 系统3 never did, so its card fees never reached
// the P&L.
//
// STEP ONE OF TWO, and only step one. The money itself arrives days later and
// is recorded on its own screen, /scm/settlement-bank (SettlementBank.tsx) —
// the owner asked for the split in these words: "就一页对卡机报告，对了没有问题
// 就去对bank statement 或daily transaction report". Nothing here books the bank.
//
// The screen deliberately keeps 系统3's skeleton — four piles, bulk-confirm the
// auto-matched, a candidate list with clues, two standing watchlists, an export
// — and adds what it lacked: per-acquirer CONFIG instead of hardcoded quirks,
// no auto-confirm without a unique reference, and a loud refusal for a file it
// cannot read.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCheck, Download, Upload } from 'lucide-react';
import {
  useAcquirerSetup, useSaveAcquirerSetup, useSettlementBatches, useSettlementBatch,
  useUploadStatement, useConfirmSettlementRow, useConfirmMatched, useIgnoreSettlementRow,
  useSettlementWatchlist,
  type AcquirerSetup, type SettlementRow, type SettlementBucket, type SettlementBatch,
} from './settlement-queries';
import {
  ICON, fmt, btn, cell, num, table, headRow, rowLine, softText, danger, good, panel,
  BUCKET_LABEL, refusalText, payableOf,
} from './settlement-ui';
import { downloadCSV, toCSV } from '../../lib/csv';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

/* The server sends the four piles as a plain tally; a bucket with nothing in it
   is simply absent, so read it as a lookup rather than a guaranteed key. */
const bucketCount = (buckets: Record<string, number>, key: SettlementBucket): number =>
  Number(buckets[key] ?? 0);

export const SettlementRecon = () => {
  const [tab, setTab] = useState<'reconcile' | 'watchlists' | 'setup'>('reconcile');
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Card settlement reconciliation" />
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" style={btn(tab === 'reconcile')} onClick={() => setTab('reconcile')}>Reconcile</button>
        <button type="button" style={btn(tab === 'watchlists')} onClick={() => setTab('watchlists')}>Watchlists</button>
        <button type="button" style={btn(tab === 'setup')} onClick={() => setTab('setup')}>Acquirer setup</button>
        <span style={{ flex: 1 }} />
        {/* Step two lives on its own screen. The link is here so the next job
            is one click away, not a hunt through the menu. */}
        <Link to="/scm/settlement-bank" style={{ ...btn(), textDecoration: 'none' }}>
          Money into the bank <ArrowRight {...ICON} />
        </Link>
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
  const [files, setFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [summaryFee, setSummaryFee] = useState('');
  /* Some terminal statements date a line "05-Jun" with no year anywhere in the
     file. The operator answers that; the system never guesses which year money
     belongs to. */
  const [statementMonth, setStatementMonth] = useState('');
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
    /* A file that was REFUSED stays selected. Half of these refusals end with
       "…and upload it again" — and clearing the picker made that impossible:
       the operator answered the question the message asked, pressed Upload, and
       found the button dead because the file it was talking about had been
       thrown away. Only the ones that got through are cleared. */
    const rejected: Array<{ name: string; content: string }> = [];
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
        rejected.push(f);
        done.push({ name: f.name, ok: false, text: refusalText(err, 'The statement could not be read.') });
      }
      setResults([...done]);
    }
    setBusy(false);
    setFiles(rejected);
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
            <Upload {...ICON} /> {busy ? 'Reading…'
              : results.some((r) => !r.ok) && files.length > 0 ? `Try again (${files.length})`
              : `Upload${files.length > 1 ? ` ${files.length} files` : ''}`}
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
        <div style={softText}>
          You can pick several files at once — they go up one after another, and each one answers for itself.
        </div>
        {/* Nothing here asks when the money arrived, on purpose. Uploading is
            the moment the operator has the CARD MACHINE report and nothing
            else; the payout comes days later and the bank statement is what
            tells him. That step is on the statement itself, once its lines are
            reconciled. (Owner, 2026-08-17: 全部卡机都是隔几天收到的。) */}
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
              <th style={num}>Lines</th><th style={num}>Gross</th><th style={num}>Fee</th><th style={num}>Net</th>
              <th style={cell}>Reconciled</th><th style={cell} />
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
                {/* How far THIS screen's job has got. Whether the money came
                   is the other screen's question, deliberately not answered
                   twice in two places. */}
                <td style={{ ...cell, color: (b.open_count ?? 0) === 0 ? good : danger }}>
                  {(b.open_count ?? 0) === 0
                    ? 'all lines done'
                    : `${b.open_count} of ${b.row_count} still open`}
                </td>
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
          <b>Merchant charge on the statement, not on any transaction: {fmt(Math.abs(batch.adjustment_sen))}</b>
          <div style={softText}>
            The lines come to {fmt(batch.net_sen)}, and {batch.acquirer_code} says it is paying {fmt(batch.stated_net_sen ?? 0)}.
            {batch.adjustment_je_no
              ? ` Booked as ${batch.adjustment_je_no}: into merchant charges, out of what ${batch.acquirer_code} still owes.`
              : ` Not booked yet — confirm the batch and it posts into merchant charges, out of what ${batch.acquirer_code} still owes, because that money is never coming.`}
          </div>
        </div>
      )}

      {batch && <HandOff batch={batch} openLines={rows.filter((r) => !r.confirmed_at && r.bucket !== 'IGNORED').length} />}

      {confirmAll.data && (
        <div style={{ fontSize: 'var(--fs-13)', color: confirmAll.data.failed.length ? danger : good }}>
          Posted {confirmAll.data.confirmed} of {confirmAll.data.attempted}.
          {confirmAll.data.statementCharge?.jeNo && ` Statement charge booked as ${confirmAll.data.statementCharge.jeNo}.`}
          {confirmAll.data.failed.map((f) => <div key={f.rowId}>{f.rowId ? `Line ${f.rowId}: ` : ''}{f.reason}</div>)}
        </div>
      )}

      <div style={softText}>
        Confirming a line posts its FEE straight away — into merchant charges, out of what the acquirer owes you.
        The rest stays owed until the money actually reaches the bank, which is the step above. Nothing is left
        &ldquo;for next period&rdquo;.
      </div>

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading the statement…</div>}
      {!q.isLoading && shown.length === 0 && <div style={softText}>This pile is empty.</div>}
      {shown.map((r) => <SettlementLine key={r.id} row={r} />)}
    </section>
  );
};

/* ── Where this statement goes next ───────────────────────────────────────────
   The hand-off between the two screens, and the whole reason they are two: this
   one is finished when the card machine's lines are reconciled. Whether the
   money came is a different question asked on a different day, and the answer
   is not repeated here — one fact, one place. */

const HandOff = ({ batch, openLines }: { batch: SettlementBatch; openLines: number }) => {
  const payable = payableOf(batch);
  const outstanding = batch.outstanding_sen ?? payable - (batch.received_sen ?? 0);

  if (openLines > 0) {
    return (
      <div style={softText}>
        {openLines} line(s) still need a decision. Once they are done, {batch.acquirer_code} owes {fmt(payable)} —
        record it on <Link to="/scm/settlement-bank">Money into the bank</Link> when it arrives.
      </div>
    );
  }
  return (
    <div style={{ ...panel(outstanding === 0 ? 'good' : 'plain'), display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
      <b>
        {outstanding === 0
          ? `Done, both sides: every line reconciled and ${fmt(payable)} is in the bank.`
          : `Every line is reconciled. ${batch.acquirer_code} owes ${fmt(outstanding)}.`}
      </b>
      {outstanding !== 0 && (
        <Link to="/scm/settlement-bank" style={{ ...btn(true), textDecoration: 'none' }}>
          Record the money <ArrowRight {...ICON} />
        </Link>
      )}
    </div>
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
