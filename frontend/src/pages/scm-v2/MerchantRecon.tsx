// ----------------------------------------------------------------------------
// MERCHANT RECONCILIATION — the merchant (card machine) statement against what
// the ERP recorded. Accounting phase 2B, brief §3.5 layer 3.
//
// The owner named the two halves of this work himself: "就不能分成 merchant
// reconciliation, bank statement reconciliation 吗？" So:
//
//   here (/scm/merchant-recon)  — the MERCHANT statement vs the ERP's payments
//   /scm/bank-recon             — the BANK statement vs what the merchants owe
//
// This screen books FEES and nothing else (Dr merchant charges / Cr settlement-
// in-transit, the moment a line is confirmed) — the single thing 系统3 never did,
// so its card fees never reached the P&L. It never books the bank: the money
// arrives days later and that is the other screen's job.
//
// "对账 ＝ 把「在途结算款」这个科目清干净的过程" — between the two screens,
// 320-0000 empties.
//
// ONE THING AT A TIME. Working a statement replaces the list rather than piling
// under it; the version that piled drew this: "就感觉很多东西挤在一页".
//
// 系统3's skeleton is kept where it was right — four piles, bulk-confirm the
// auto-matched, candidates with clues — and given what it lacked: per-acquirer
// CONFIG instead of hardcoded quirks, no auto-confirm without a unique
// reference, and a loud refusal for a file it cannot read.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCheck, Download, Upload } from 'lucide-react';
import {
  useAcquirerSetup, useSaveAcquirerSetup, useSettlementBatches, useSettlementBatch,
  useUploadStatement, useConfirmSettlementRow, useConfirmMatched, useIgnoreSettlementRow,
  useSettlementWatchlist,
  type AcquirerSetup, type SettlementRow, type SettlementBucket, type SettlementBatch, type BankAccount,
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

export const MerchantRecon = () => {
  const [tab, setTab] = useState<'work' | 'setup'>('work');
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · step 1 of 2" title="Merchant reconciliation" />
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" style={btn(tab === 'work')} onClick={() => setTab('work')}>To reconcile</button>
        <button type="button" style={btn(tab === 'setup')} onClick={() => setTab('setup')}>Merchant setup</button>
        <span style={{ flex: 1 }} />
        {/* Step two is its own screen; the link is here so the next job is one
            click away, not a hunt through the menu. */}
        <Link to="/scm/bank-recon" style={{ ...btn(), textDecoration: 'none' }}>
          Bank statement reconciliation <ArrowRight {...ICON} />
        </Link>
      </div>
      {tab === 'work' && <ReconcileTab />}
      {tab === 'setup' && <SetupTab />}
    </div>
  );
};

/* ── The work queue: ONLY what is not matched yet ─────────────────────────────
   The owner, asked what this screen should open on: "应该就只会显示还没对上的
   transaction 吧". So it shows exactly that, from both sides at once:

     • statements with lines still to decide — the merchant says it, and either
       nobody in the ERP recorded it or a human has to choose which payment;
     • card money the sales team DID record that no statement has reported yet.

   A statement whose lines are all decided leaves this screen entirely. Where it
   goes is the bank statement reconciliation, and it can only go there once it
   is clean — his rule: 核对完了没有问题才会显示去 bank statement 的
   reconciliation. */

const ReconcileTab = () => {
  const setup = useAcquirerSetup();
  const batches = useSettlementBatches();
  const watchlist = useSettlementWatchlist();
  const upload = useUploadStatement();
  const [batchId, setBatchId] = useState<number | null>(null);
  const [showDone, setShowDone] = useState(false);

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

  /* ONE THING AT A TIME. Working a statement replaces everything else. */
  if (batchId != null) return <BatchView batchId={batchId} onBack={() => setBatchId(null)} />;

  const all = batches.data?.batches ?? [];
  const open = all.filter((b) => (b.open_count ?? 0) > 0);
  const cleared = all.filter((b) => (b.open_count ?? 0) === 0);
  /* Card money the sales team recorded that no statement has reported. Held
     back until the watchlist has answered, so an empty list never reads as
     "nothing outstanding" when it means "not loaded". */
  const waiting = watchlist.data?.recordedNotArrived ?? [];
  const waitingSen = waiting.reduce((s, p) => s + p.amountSen, 0);

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="Acquirer"
            style={{ padding: '6px 10px', fontSize: 'var(--fs-13)' }}>
            <option value="">Which merchant?</option>
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
              : `Upload merchant report${files.length > 1 ? ` (${files.length} files)` : ''}`}
          </button>
        </div>
        {/* Asked ONLY of the merchant whose file needs it. Hong Leong dates a
            line "16-Aug" with no year anywhere in the statement, so somebody
            has to say which year that is — and nothing here guesses. */}
        {chosen?.dates_have_no_year === true && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 'var(--fs-13)', fontWeight: 600 }} htmlFor="settlement-month">Statement month</label>
            <input id="settlement-month" type="month" value={statementMonth} aria-label="Statement month"
              onChange={(e) => setStatementMonth(e.target.value)}
              style={{ padding: '5px 8px', fontSize: 'var(--fs-13)' }} />
            <span style={softText}>{chosen.display_name} dates its lines like &ldquo;16-Aug&rdquo;, with no year.</span>
          </div>
        )}
        {chosen && !chosen.autoMatchable && (
          <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
            {chosen.display_name} sends no unique reference — every line waits for you to confirm it.
          </div>
        )}
        {results.map((r) => (
          <div key={r.name} style={{ fontSize: 'var(--fs-13)', color: r.ok ? good : danger, display: 'flex', gap: 6 }}>
            {!r.ok && <AlertTriangle {...ICON} />}
            <span><b>{r.name}</b> — {r.text}</span>
          </div>
        ))}
      </section>

      {/* 1. The reports that still need decisions. */}
      <section className="space-y-2">
        <b>Merchant reports still to reconcile</b>
        {open.length === 0 && !batches.isLoading && (
          <div style={{ fontSize: 'var(--fs-13)', color: good }}>
            Nothing to reconcile — every merchant report you have uploaded is done.
          </div>
        )}
        {open.length > 0 && (
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Merchant</th><th style={cell}>Report</th><th style={cell}>Period</th>
                <th style={num}>Lines</th><th style={cell}>What is left</th><th style={cell} />
              </tr>
            </thead>
            <tbody>
              {open.map((b) => (
                <tr key={b.id} style={rowLine}>
                  <td style={cell}><span className={styles.codeChip}>{b.acquirer_code}</span></td>
                  <td style={cell}>{b.file_name}</td>
                  <td style={cell}>{b.period_from} → {b.period_to}</td>
                  <td style={num}>{b.row_count}</td>
                  {/* The two kinds of "not matched yet", named: one is a choice
                      he can make, the other is a payment nobody recorded. */}
                  <td style={{ ...cell, color: danger }}>
                    {[(b.to_choose_count ?? 0) > 0 ? `${b.to_choose_count} to choose` : null,
                      (b.no_record_count ?? 0) > 0 ? `${b.no_record_count} with no sale in the ERP` : null]
                      .filter(Boolean).join(' · ') || `${b.open_count} to decide`}
                  </td>
                  <td style={cell}>
                    <button type="button" style={btn(true)} onClick={() => setBatchId(b.id)}>Reconcile</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Done, and therefore not on this screen's list — but say so, and say
            where they went, so "it disappeared" never has to be a question. */}
        {cleared.length > 0 && (
          <div style={softText}>
            {cleared.length} report{cleared.length === 1 ? '' : 's'} fully reconciled —{' '}
            <Link to="/scm/bank-recon">bank statement reconciliation</Link> carries them now.{' '}
            <button type="button" style={{ ...btn(), padding: '2px 8px' }} onClick={() => setShowDone(!showDone)}>
              {showDone ? 'Hide' : 'Show'}
            </button>
          </div>
        )}
        {showDone && cleared.length > 0 && (
          <table style={table}>
            <tbody>
              {cleared.map((b) => (
                <tr key={b.id} style={rowLine}>
                  <td style={cell}><span className={styles.codeChip}>{b.acquirer_code}</span></td>
                  <td style={cell}>{b.file_name}</td>
                  <td style={cell}>{b.period_from} → {b.period_to}</td>
                  <td style={num}>{fmt(b.net_sen)}</td>
                  <td style={{ ...cell, color: good }}>{b.confirmed_count} line(s) done</td>
                  <td style={cell}>
                    <button type="button" style={btn()} onClick={() => setBatchId(b.id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 2. The other side of "not matched yet": the ERP has it, no report does.
             His words: 我还没收到钱的是那几笔. */}
      <section className="space-y-2">
        <b>{`Card payments no merchant report has reported yet (${waiting.length})`}</b>
        <div style={softText}>
          Keyed in by the sales team; the merchant has not put them on a report. {fmt(waitingSen)} in total.
        </div>
        {watchlist.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
        {!watchlist.isLoading && waiting.length === 0 && (
          <div style={{ fontSize: 'var(--fs-13)', color: good }}>
            Every card payment recorded is on a merchant report.
          </div>
        )}
        {waiting.length > 0 && (
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell}>Merchant</th><th style={cell}>Document</th><th style={cell}>Customer paid on</th>
                <th style={num}>Days</th><th style={num}>Amount</th><th style={cell}>Approval</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((p) => (
                <tr key={`${p.source}:${p.id}`} style={rowLine}>
                  <td style={cell}><span className={styles.codeChip}>{p.acquirerCode}</span></td>
                  <td style={cell}>{p.docNo}</td>
                  <td style={cell}>{p.paidOn}</td>
                  <td style={{ ...num, color: p.ageDays > 14 ? danger : undefined, fontWeight: p.ageDays > 14 ? 700 : undefined }}>{p.ageDays}</td>
                  <td style={num}>{fmt(p.amountSen)}</td>
                  <td style={cell}>{p.approvalCode ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};

/* ── One statement: the lines still to decide ─────────────────────────────────
   Lines already decided are OFF this screen by default — "只会显示还没对上的".
   The counts stay in view so nothing is hidden, and one checkbox brings the
   finished lines back for a look. */

const BatchView = ({ batchId, onBack }: { batchId: number; onBack: () => void }) => {
  const q = useSettlementBatch(batchId);
  const confirmAll = useConfirmMatched();
  const [showDone, setShowDone] = useState(false);

  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const batch = q.data?.batch ?? null;
  const openRows = rows.filter((r) => !r.confirmed_at && r.bucket !== 'IGNORED');
  const doneRows = rows.filter((r) => r.confirmed_at || r.bucket === 'IGNORED');
  const unconfirmedMatched = rows.filter((r) => r.bucket === 'MATCHED' && !r.confirmed_at).length;
  const shown = showDone ? [...openRows, ...doneRows] : openRows;

  const exportCsv = () => {
    downloadCSV(`merchant-report-${batchId}.csv`, toCSV(rows, [
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
    <section className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button type="button" style={btn()} onClick={onBack}><ArrowLeft {...ICON} /> All reports</button>
        <b>{batch ? `${batch.acquirer_code} · ${batch.file_name}` : 'Loading…'}</b>
        {batch && <span style={softText}>{batch.period_from} → {batch.period_to} · net {fmt(batch.net_sen)}</span>}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 'var(--fs-13)' }}>
          {openRows.length === 0 ? 'Every line is decided.' : `${openRows.length} line(s) still to decide`}
        </b>
        <span style={softText}>
          {`${rows.filter((r) => r.confirmed_at).length} done · ${rows.filter((r) => r.bucket === 'IGNORED').length} set aside`}
        </span>
        <span style={{ flex: 1 }} />
        {unconfirmedMatched > 0 && (
          <button type="button" style={btn(true, confirmAll.isPending)} disabled={confirmAll.isPending}
            onClick={() => confirmAll.mutate(batchId)}>
            <CheckCheck {...ICON} /> Confirm the {unconfirmedMatched} matched by reference
          </button>
        )}
        {doneRows.length > 0 && (
          <label style={{ ...softText, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={showDone} aria-label="Show lines already decided"
              onChange={(e) => setShowDone(e.target.checked)} />
            Show the {doneRows.length} already decided
          </label>
        )}
        <button type="button" style={btn()} onClick={exportCsv}><Download {...ICON} /> Export</button>
      </div>

      {/* The charge the STATEMENT makes that no transaction on it explains —
          AEON's subvention fee. Shown whether or not it is booked yet, because
          an unbooked one means in-transit is holding money that is never coming. */}
      {batch && batch.adjustment_sen !== 0 && (
        <div style={panel(batch.adjustment_je_no ? 'good' : 'danger')}>
          <b>Merchant charge on no transaction: {fmt(Math.abs(batch.adjustment_sen))}</b>
          <div style={softText}>
            Lines come to {fmt(batch.net_sen)}; {batch.acquirer_code} says it is paying {fmt(batch.stated_net_sen ?? 0)}.
            {batch.adjustment_je_no ? ` Booked as ${batch.adjustment_je_no}.` : ' Confirm the report and it books.'}
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

      {batch && <HandOff batch={batch} openLines={openRows.length} />}

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading the report…</div>}
      {shown.map((r) => <SettlementLine key={r.id} row={r} />)}
    </section>
  );
};

/* ── Where this report goes next ──────────────────────────────────────────────
   The hand-off, and the owner's rule about it: 核对完了没有问题才会显示去 bank
   statement 的 reconciliation. Until every line is decided, this says what is
   left; after that, it says what the merchant owes and offers the next step. */

const HandOff = ({ batch, openLines }: { batch: SettlementBatch; openLines: number }) => {
  const payable = payableOf(batch);
  const outstanding = batch.outstanding_sen ?? payable - (batch.received_sen ?? 0);

  if (openLines > 0) {
    return (
      <div style={softText}>
        {openLines} line(s) still need a decision. Bank statement reconciliation opens for this report once they
        are done.
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
        <Link to="/scm/bank-recon" style={{ ...btn(true), textDecoration: 'none' }}>
          Match the bank statement <ArrowRight {...ICON} />
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

/* ── Merchant setup (决定4) ────────────────────────────────────────────────────
   Config, read far more often than it is changed — so it reads as a TABLE of
   what is set, and only the merchant being changed opens into a form. Five
   merchants each showing a wall of eleven fields was the version the owner
   looked at and asked "这个界面可以做好看一点吗？". */

const SetupTab = () => {
  const q = useAcquirerSetup();
  const [editing, setEditing] = useState<string | null>(null);
  const acquirers = q.data?.acquirers ?? [];
  const banks = q.data?.bankAccounts ?? [];

  const FEE_LABEL: Record<string, string> = {
    stated: 'a column on each line',
    'gross-minus-net': 'gross minus net',
    'prorated-summary': 'one total for the statement',
  };

  /* ONE THING AT A TIME here too: changing a merchant replaces the table. It
     also keeps the editor out of a table cell, where an auto-fill grid has no
     width to divide and stacks every field into one tall column. */
  const open = acquirers.find((a) => a.code === editing);
  if (open) {
    return (
      <div className="space-y-3">
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <button type="button" style={btn()} onClick={() => setEditing(null)}>
            <ArrowLeft {...ICON} /> All merchants
          </button>
          <b>{open.display_name}</b>
        </div>
        <AcquirerEditor acquirer={open} bankAccounts={banks} onDone={() => setEditing(null)} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div style={softText}>
        Taught once and shared by every company — except <b>Money lands in</b>, which is this company&rsquo;s own:
        the same merchant pays different companies into different banks.
      </div>

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}

      <table style={table}>
        <thead>
          <tr style={headRow}>
            <th style={cell}>Merchant</th>
            <th style={cell}>File</th>
            <th style={cell}>Auto-match</th>
            <th style={cell}>Fee</th>
            <th style={cell}>Money lands in — this company</th>
            <th style={cell} />
          </tr>
        </thead>
        <tbody>
          {acquirers.map((a) => {
            const bank = banks.find((b) => b.account_code === a.bank_account_code);
            return (
              <tr key={a.code} style={rowLine}>
                  <td style={cell}>
                    <b>{a.display_name}</b>{' '}
                    {/* The code is only worth showing when it is not simply the
                        name again — "AEON AEON" is noise, not information. */}
                    {a.code !== a.display_name && <span className={styles.codeChip}>{a.code}</span>}{' '}
                    {!a.ready && <span style={{ color: danger, fontSize: 'var(--fs-12)' }}>not set up</span>}
                  </td>
                  <td style={cell}>{a.statement_format ?? <span style={{ color: danger }}>—</span>}</td>
                  <td style={cell}>
                    {a.has_unique_ref === true ? 'by reference'
                      : a.has_unique_ref === false ? <span style={{ color: danger }}>by hand, always</span>
                      : <span style={{ color: danger }}>—</span>}
                  </td>
                  <td style={cell}>{a.fee_method ? FEE_LABEL[a.fee_method] : <span style={{ color: danger }}>—</span>}</td>
                  <td style={cell}>
                    {bank ? bank.account_name
                      : <span style={{ color: danger }}>not set — will use the company default</span>}
                  </td>
                  <td style={cell}>
                    <button type="button" style={btn()} onClick={() => setEditing(a.code)}>Change</button>
                  </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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

const AcquirerEditor = ({ acquirer, bankAccounts, onDone }: {
  acquirer: AcquirerSetup; bankAccounts: BankAccount[]; onDone: () => void;
}) => {
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
    }, { onSuccess: onDone });
  };

  /* `key` matters for the heading fields below, which are rendered from a list —
     without it React cannot tell one input from the next and reuses the wrong
     DOM node when the required-field marks change. */
  const field = (label: string, node: React.ReactNode, key?: string) => (
    <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 'var(--fs-12)' }}>
      <span style={{ color: 'var(--c-ink-soft, #777)' }}>{label}</span>
      {node}
    </label>
  );
  /* One grid, one column width — the old flex-wrap put a 3-character tolerance
     box next to a 30-character heading and let the rows land wherever. */
  const grid: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
    gap: 'var(--space-3)',
  };
  const input: React.CSSProperties = { padding: '6px 8px', fontSize: 'var(--fs-13)', width: '100%', boxSizing: 'border-box' };
  const legend: React.CSSProperties = { fontSize: 'var(--fs-12)', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--c-ink-soft, #777)' };

  return (
    <section className="space-y-3" style={{
      padding: 'var(--space-4)', borderRadius: 'var(--radius-md)',
      background: 'var(--c-line, rgba(34,31,32,0.04))',
    }}>
      <div className="space-y-2">
        <div style={legend}>This company only</div>
        <div style={grid}>
          {/* THE ONE FIELD THAT IS NOT SHARED. The same merchant pays different
              companies into different banks — the owner's case: PBB pays Houzs
              into Maybank and 2990 into Hong Leong. */}
          {field('Money lands in', (
            <select style={input} value={form.bankAccountCode} aria-label={`${acquirer.code} bank account`}
              onChange={(e) => setForm({ ...form, bankAccountCode: e.target.value })}>
              <option value="">not set</option>
              {bankAccounts.map((b) => (
                <option key={b.account_code} value={b.account_code}>
                  {b.account_name} ({b.account_code})
                </option>
              ))}
            </select>
          ))}
        </div>
        <div style={softText}>
          Card money sits in {acquirer.transit_account_code} until it arrives; the fee goes to{' '}
          {acquirer.fee_account_code}.
        </div>
      </div>

      <div className="space-y-2">
        <div style={legend}>How {acquirer.display_name}&rsquo;s report reads — every company shares this</div>
        <div style={grid}>
          {field('File format', (
            <select style={input} value={form.statementFormat} aria-label={`${acquirer.code} statement format`}
              onChange={(e) => setForm({ ...form, statementFormat: e.target.value })}>
              <option value="">not known</option><option value="CSV">CSV</option>
              <option value="XLSX">XLSX</option><option value="PDF">PDF</option>
            </select>
          ))}
          {field('Has a unique reference?', (
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
          {field('Days it may drift', (
            <input style={input} value={form.dateToleranceDays} aria-label={`${acquirer.code} date tolerance`}
              onChange={(e) => setForm({ ...form, dateToleranceDays: e.target.value })} />
          ))}
        </div>
        {form.hasUniqueRef === 'false' && (
          <div style={{ fontSize: 'var(--fs-12)', color: danger }}>
            Without a unique reference nothing from {acquirer.code} can be confirmed automatically — every line
            will be matched by hand.
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div style={legend}>Column headings, exactly as they appear in the file</div>
        <div style={grid}>
          {HEADING_FIELDS.map((f) => {
            const required = requiredHeadings.includes(f.key);
            return field(`${f.label}${required ? ' *' : ''}`, (
              <input
                style={{ ...input, borderColor: required && !headings[f.key] ? danger : undefined }}
                value={headings[f.key] ?? ''} placeholder={f.hint}
                aria-label={`${acquirer.code} ${f.label}`}
                onChange={(e) => setHeadings({ ...headings, [f.key]: e.target.value })}
              />
            ), f.key);
          })}
        </div>
      </div>

      {mapError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{mapError}</div>}

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button type="button" style={btn(true, save.isPending)} disabled={save.isPending} onClick={submit}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" style={btn()} onClick={onDone}>Cancel</button>
      </div>
    </section>
  );
};

export default MerchantRecon;
