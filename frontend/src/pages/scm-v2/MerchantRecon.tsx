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

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · step 1 of 2" title="Merchant reconciliation" />
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <span style={{ flex: 1 }} />
        <Link to="/scm/settlement-setup" style={{ ...btn(), textDecoration: 'none' }}>Setup</Link>
        {/* Step two is its own screen; the link is here so the next job is one
            click away, not a hunt through the menu. */}
        <Link to="/scm/bank-recon" style={{ ...btn(), textDecoration: 'none' }}>
          Bank statement reconciliation <ArrowRight {...ICON} />
        </Link>
      </div>
      <ReconcileTab />
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
  /* The batches the last upload created — the summary screen it lands on. */
  const [justUploaded, setJustUploaded] = useState<number[] | null>(null);
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
    /* EVERY batch this upload created, not just the last: the owner uploads a
       month of reports in one go and wants one answer for the lot — 当我上传完全
       部文件后…让我知道我 upload 的文件有哪里几笔是 match 的… */
    const made: number[] = [];
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
        made.push(r.batchId);
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
    if (made.length > 0) setJustUploaded(made);
  };

  /* ONE THING AT A TIME. Working a statement replaces everything else. */
  if (batchId != null) return <BatchView batchId={batchId} onBack={() => setBatchId(null)} />;
  if (justUploaded != null) {
    return (
      <UploadSummary batchIds={justUploaded} refusals={results.filter((r) => !r.ok)}
        onOpen={setBatchId} onDone={() => setJustUploaded(null)} />
    );
  }

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
        {/* Every line still to do, with the sale it matched — the same two
            columns as the upload summary, for the same reason: a file name is
            not a transaction (owner: 显示 transaction detail 和 sales order
            detail, 而不是 document 罢了). */}
        {open.length > 0 && <LinesTable batches={open} openOnly onOpen={setBatchId} />}
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

/* ── What the upload found ────────────────────────────────────────────────────
   The owner uploads a month of reports in one go, and asked for one answer for
   the lot rather than being dropped into the last file (2026-08-18): 当我上传完
   全部文件后…让我知道我 upload 的文件有哪里几笔是 match 的，有哪里几笔是我要
   manual check 或 verify 的，有哪里几笔会是 merchant 收到但完全 match 不上的.

   Those are exactly three numbers, and they are three different jobs:
     matched by reference — a button;
     to check by hand     — candidates found, a person must choose;
     no sale in the ERP   — the merchant reported money nobody recorded. */

const UploadSummary = ({ batchIds, refusals, onOpen, onDone }: {
  batchIds: number[];
  refusals: Array<{ name: string; text: string }>;
  onOpen: (id: number) => void;
  onDone: () => void;
}) => {
  const batches = useSettlementBatches();
  const confirmAll = useConfirmMatched();
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<{ confirmed: number; failed: number } | null>(null);

  const mine = (batches.data?.batches ?? []).filter((b) => batchIds.includes(b.id));
  const sum = (pick: (b: SettlementBatch) => number) => mine.reduce((s, b) => s + pick(b), 0);
  const lines = sum((b) => b.row_count);
  const toConfirm = sum((b) => b.to_confirm_count ?? 0);
  const toCheck = sum((b) => b.to_choose_count ?? 0);
  const noRecord = sum((b) => b.no_record_count ?? 0);
  const done = sum((b) => b.confirmed_count ?? 0);

  /* One button for the whole upload: every report's reference matches, posted
     one report at a time so a refusal names its own file instead of failing
     the lot. */
  const confirmEverything = () => {
    setBusy(true);
    let confirmed = 0;
    let failed = 0;
    const next = (i: number) => {
      if (i >= mine.length) { setBusy(false); setPosted({ confirmed, failed }); return; }
      confirmAll.mutate(mine[i].id, {
        onSuccess: (r) => { confirmed += r.confirmed; failed += r.failed.length; next(i + 1); },
        onError: () => { failed += 1; next(i + 1); },
      });
    };
    next(0);
  };

  return (
    <div className="space-y-4">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button type="button" style={btn()} onClick={onDone}><ArrowLeft {...ICON} /> All reports</button>
        <b>{`${mine.length} report${mine.length === 1 ? '' : 's'} read · ${lines} line${lines === 1 ? '' : 's'}`}</b>
      </div>

      {/* The three numbers, largest first — each one a different job. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 'var(--space-3)' }}>
        <Tally n={toConfirm} label="matched by reference" note="ready to confirm" tone="good" />
        <Tally n={toCheck} label="to check by hand" note="candidates found — you choose" tone="plain" />
        <Tally n={noRecord} label="no sale in the ERP" note="the merchant reported it, nobody recorded it" tone="danger" />
      </div>

      {toConfirm > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={btn(true, busy)} disabled={busy} onClick={confirmEverything}>
            <CheckCheck {...ICON} /> {busy ? 'Posting…' : `Confirm all ${toConfirm} matched`}
          </button>
          <span style={softText}>Books each line&rsquo;s fee. The money itself is the next screen.</span>
        </div>
      )}
      {posted && (
        <div style={{ fontSize: 'var(--fs-13)', color: posted.failed ? danger : good }}>
          Posted {posted.confirmed}.{posted.failed > 0 ? ` ${posted.failed} could not be — open the report to see why.` : ''}
        </div>
      )}
      {done > 0 && !posted && <div style={softText}>{done} line(s) were already confirmed.</div>}

      {/* A file the server refused never became a report — it has no row below,
          so it says its own reason here or it says nothing anywhere. */}
      {refusals.map((r) => (
        <div key={r.name} style={{ fontSize: 'var(--fs-13)', color: danger, display: 'flex', gap: 6 }}>
          <AlertTriangle {...ICON} />
          <span><b>{r.name}</b> — {r.text}</span>
        </div>
      ))}

      {/* EVERY LINE the upload read, not a count per file — the operator is
          reconciling transactions, and a file name is not one (owner: 我希望他是
          显示 transaction detail 和 sales order detail, 而不是 document 罢了).
          Each row is the merchant's line beside the sale it matched. */}
      <LinesTable batches={mine} onOpen={onOpen} />
    </div>
  );
};

/* ── Every line, in ONE table ──────────────────────────────────────────────────
   The owner, looking at four reports each with its own repeated header: "这个可
   以做成一个table吗？就是有header的". One header, one table; each report is a
   tbody, and its name spans its own lines instead of being restated on each.

   `openOnly` is the difference between the two places this appears: the work
   list shows what is still to do, the upload summary shows everything that
   upload read. */

const LinesTable = ({ batches, onOpen, openOnly }: {
  batches: SettlementBatch[]; onOpen: (id: number) => void; openOnly?: boolean;
}) => (
  <table style={table}>
    <thead>
      <tr style={headRow}>
        <th style={cell}>Report</th>
        <th style={cell}>The merchant&rsquo;s line</th>
        <th style={num}>Gross</th><th style={num}>Fee</th><th style={num}>Net</th>
        <th style={cell}>The sale it matched</th>
        <th style={cell}>Status</th>
      </tr>
    </thead>
    {batches.map((b) => <BatchRows key={b.id} batch={b} onOpen={onOpen} openOnly={openOnly} />)}
  </table>
);

const BatchRows = ({ batch, onOpen, openOnly }: {
  batch: SettlementBatch; onOpen: (id: number) => void; openOnly?: boolean;
}) => {
  const q = useSettlementBatch(batch.id);
  const all = q.data?.rows ?? [];
  /* On the work list, only what is still to do — a line already decided is not
     work. On the upload summary, everything the file contained. */
  const rows = openOnly ? all.filter((r) => !r.confirmed_at && r.bucket !== 'IGNORED') : all;

  /* The report names itself once, down the side of its own lines. */
  const reportCell = (span: number) => (
    <td style={{ ...cell, borderTop: '2px solid var(--c-line, rgba(34,31,32,0.12))', minWidth: 230 }} rowSpan={span}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className={styles.codeChip}>{batch.acquirer_code}</span>
        <b style={{ wordBreak: 'break-all' }}>{batch.file_name}</b>
      </div>
      <div style={softText}>{batch.period_from} → {batch.period_to} · net {fmt(batch.net_sen)}</div>
      <button type="button" style={{ ...btn(openOnly === true), marginTop: 6 }} onClick={() => onOpen(batch.id)}>
        {openOnly ? 'Reconcile' : 'Open'}
      </button>
    </td>
  );

  if (rows.length === 0) {
    return (
      <tbody>
        <tr>
          {reportCell(1)}
          <td style={{ ...cell, borderTop: '2px solid var(--c-line, rgba(34,31,32,0.12))' }} colSpan={6}>
            <span style={softText}>{q.isLoading ? 'Reading its lines…' : 'Nothing left on this report.'}</span>
          </td>
        </tr>
      </tbody>
    );
  }

  const top = { borderTop: '2px solid var(--c-line, rgba(34,31,32,0.12))' };
  return (
    <tbody>
      {rows.map((r, i) => {
        /* Linked = it claimed a payment. Suggested = the system's answer,
           pre-ticked but not taken. Neither = a human's job. */
        const sale = r.linked.length > 0 ? r.linked : null;
        const guess = r.suggested ?? [];
        const edge = i === 0 ? top : undefined;
        return (
          <tr key={r.id} style={rowLine}>
            {i === 0 && reportCell(rows.length)}
            <td style={{ ...cell, ...edge }}>
              <div>{r.txn_date}{r.ref ? <> · ref <b>{r.ref}</b></> : null}</div>
              <div style={softText}>line {r.line_no}</div>
            </td>
            <td style={{ ...num, ...edge }}>{fmt(r.gross_sen)}</td>
            <td style={{ ...num, ...edge }}>{fmt(r.fee_sen)}</td>
            <td style={{ ...num, ...edge }}>{fmt(r.net_sen)}</td>
            <td style={{ ...cell, ...edge }}>
              {sale && sale.map((l) => (
                <div key={l.payment_id}>
                  <b>{l.doc_no ?? l.payment_id}</b>
                  {l.customer_name ? ` · ${l.customer_name}` : ''}
                  <div style={softText}>
                    {[l.paid_on ? `paid ${l.paid_on}` : null,
                      l.approval_code ? `code ${l.approval_code}` : null,
                      fmt(l.amount_sen)].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ))}
              {!sale && guess.length > 0 && guess.map((p) => (
                <div key={p.id}>
                  <b>{p.docNo}</b>{p.customerName ? ` · ${p.customerName}` : ''}
                  <div style={softText}>
                    {[`paid ${p.paidOn}`, p.approvalCode ? `code ${p.approvalCode}` : null, fmt(p.amountSen)]
                      .filter(Boolean).join(' · ')}
                  </div>
                </div>
              ))}
              {!sale && guess.length === 0 && (
                <span style={softText}>{r.candidates.length > 0 ? `${r.candidates.length} possible` : '—'}</span>
              )}
            </td>
            <td style={{ ...cell, ...edge }}>
              {r.confirmed_at
                ? <span style={{ color: good }}>done{r.posted_je_no ? ` · ${r.posted_je_no}` : ''}</span>
                : sale
                  ? <span style={{ color: good }}>matched by reference</span>
                  : guess.length > 0
                    ? <span>the system&rsquo;s guess — check it</span>
                    : r.bucket === 'UNMATCHED'
                      ? <span style={{ color: danger }}>no sale in the ERP</span>
                      : <span>you choose</span>}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
};

const Tally = ({ n, label, note, tone }: {
  n: number; label: string; note: string; tone: 'good' | 'danger' | 'plain';
}) => (
  <div style={{ ...panel(n === 0 ? 'plain' : tone), display: 'flex', flexDirection: 'column', gap: 2 }}>
    <div style={{ fontSize: 'var(--fs-24, 22px)', fontWeight: 700 }}>{n}</div>
    <div style={{ fontWeight: 600 }}>{label}</div>
    <div style={softText}>{note}</div>
  </div>
);

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
  /* A line that already claimed its payment needs a button; one that has not
     needs a person. The screen must not call them the same thing. */
  const toConfirm = openRows.filter((r) => r.linked.length > 0).length;
  const toDecide = openRows.length - toConfirm;
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
          {openRows.length === 0 ? 'Every line is decided.' : [
            /* Matched by reference is NOT a decision — it is one button. Saying
               "still to decide" about it is what made an auto-matched line read
               as a problem (owner: 出现的这个是什么？). */
            toConfirm > 0 ? `${toConfirm} matched, waiting for you to confirm` : null,
            toDecide > 0 ? `${toDecide} still to decide` : null,
          ].filter(Boolean).join(' · ')}
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

      {batch && <HandOff batch={batch} toConfirm={toConfirm} toDecide={toDecide} />}

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading the report…</div>}
      {shown.map((r) => <SettlementLine key={r.id} row={r} />)}
    </section>
  );
};

/* ── Where this report goes next ──────────────────────────────────────────────
   The hand-off, and the owner's rule about it: 核对完了没有问题才会显示去 bank
   statement 的 reconciliation. Until every line is decided, this says what is
   left; after that, it says what the merchant owes and offers the next step. */

const HandOff = ({ batch, toConfirm, toDecide }: { batch: SettlementBatch; toConfirm: number; toDecide: number }) => {
  const payable = payableOf(batch);
  const outstanding = batch.outstanding_sen ?? payable - (batch.received_sen ?? 0);

  /* The counts are stated once, at the top. This line says only what happens
     next — repeating "1 to confirm" two inches below "1 to confirm" is the
     duplication the owner was looking at. */
  if (toConfirm > 0 || toDecide > 0) {
    return (
      <div style={softText}>
        Bank statement reconciliation opens for this report once every line is done.
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
  const key = (p: { source: string; id: string }) => `${p.source}:${p.id}`;
  /* Start on the system's own answer when it has one — the operator confirms
     instead of repeating the search (owner: 尽量根据日期金额去尝试自动匹配后让我
     知道，我 final confirm). Seeded once, so a refetch never undoes his ticks. */
  const [picked, setPicked] = useState<Set<string>>(() => new Set((row.suggested ?? []).map(key)));

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
    /* A section, not a div: each line is its own piece of the report, and the
       element says so — to a screen reader and to a test scoping one line's
       buttons away from the next line's. */
    <section style={{
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

      {/* A matched line says it ONCE. The clue ("Reference 969745 matches
          SO-2608-043") and the line below it ("Matched to SO-2608-043") were
          the same sentence twice — which is what still looked wrong after the
          contradiction was fixed. */}
      {row.clue && row.linked.length === 0 && <div style={softText}>{row.clue}</div>}

      {row.posted_je_no && (
        <div style={{ fontSize: 'var(--fs-13)', color: good }}>
          Posted as <span className={styles.codeChip}>{row.posted_je_no}</span>
          {row.linked.length > 0 && ` — ${row.linked.map((l) => l.doc_no ?? l.payment_id).join(', ')}`}
        </div>
      )}

      {!row.confirmed_at && row.linked.length > 0 && (
        <div style={{ fontSize: 'var(--fs-13)' }}>
          Matched to <b>{row.linked.map((l) => l.doc_no ?? l.payment_id).join(', ')}</b>
          {row.ref ? ' by its reference' : ''} — press <b>Confirm</b> to book its fee.
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
    </section>
  );
};

export default MerchantRecon;
