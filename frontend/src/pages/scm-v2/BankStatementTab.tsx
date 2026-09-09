// ----------------------------------------------------------------------------
// THE BANK'S OWN STATEMENT — upload it, and let the system do the matching
// (brief §3.5 layer 4).
//
// Owner, 2026-08-19, on a screen that asked him to type every payout's date and
// amount by hand: 我不是应该upload bank statement 或 daily transaction report
// 然后你也自动核对吗. He was right, and asked for the whole job when asked how
// far it should go: 整张月结单全部对.
//
// So this screen is the bank statement, all of it — not only the card credits.
// Three things a person has to be able to see, and they are the three sections
// below in that order:
//
//   1. does it agree?      the reconciliation, with the difference broken into
//                          the two sides that make it up;
//   2. what is left to do? the movements still undecided, most consequential
//                          first;
//   3. what did it do?     everything already dealt with, out of the way but
//                          not thrown away.
//
// The same shape as the merchant screen, deliberately: he learnt that one, and
// this is the same job on the other side of the money.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCheck, Landmark, Link2, Undo2, Upload } from 'lucide-react';
import {
  useBankSetup, useBankStatements, useBankStatement, useUploadBankStatement,
  useBookBankReceipt, useMatchBankLine, useIgnoreBankLine, useUndoBankLine,
  type BankLine, type BankStatement, type Reconciliation,
} from './bank-queries';
import { ICON, fmt, btn, softText, danger, good, panel, refusalText } from './settlement-ui';
import styles from './Suppliers.module.css';
import grid from './MerchantRecon.module.css';

export const BankStatementTab = () => {
  const [statementId, setStatementId] = useState<number | null>(null);
  if (statementId != null) return <StatementView id={statementId} onBack={() => setStatementId(null)} />;
  return <UploadAndList onOpen={setStatementId} />;
};

/* ── Upload, and the statements already read ──────────────────────────────── */

const UploadAndList = ({ onOpen }: { onOpen: (id: number) => void }) => {
  const setup = useBankSetup();
  const statements = useBankStatements();
  const upload = useUploadBankStatement();
  const [accountCode, setAccountCode] = useState('');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  /* Which year and month, for a file whose dates carry no year — the same
     answer the merchant screen asks for, and the same narrow meaning. It is NOT
     what files the statement into a month: a movement is put in the month its
     own date falls in, so a label here could never move it. Saying so is the
     whole point of the sentence under the field. */
  const [statementMonth, setStatementMonth] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const accounts = setup.data?.accounts ?? [];
  const chosen = accounts.find((a) => a.account_code === accountCode) ?? null;
  const rows = statements.data?.statements ?? [];

  const readFile = (picked: FileList | null) => {
    setResult(null);
    const f = picked?.[0];
    if (!f) { setFile(null); return; }
    void f.text().then((content) => setFile({ name: f.name, content }));
  };

  const send = () => {
    if (!accountCode || !file) return;
    setResult(null);
    upload.mutate({
      accountCode, fileName: file.name, content: file.content,
      statementMonth: statementMonth || null,
    }, {
      onSuccess: (r) => {
        setFile(null);
        setResult({
          ok: true,
          text: `${r.lines} movement(s) over ${r.periodFrom} → ${r.periodTo}`
            + `, ${fmt(r.inSen)} in and ${fmt(r.outSen)} out`
            /* Say what was JOINED and what was LEFT OUT. Both are places a
               reader could otherwise think the file was misread. */
            + (r.joinedPairs > 0 ? ` · ${r.joinedPairs} credit(s) had their charge taken back separately and were joined` : '')
            + (r.skippedLines > 0 ? ` · ${r.skippedLines} row(s) carried no transaction` : '')
            /* A re-upload settling half its own lines is a surprise even when
               every one of them is right, so it is said here and not only
               findable inside the statement. */
            + (r.alreadyRecorded > 0 ? ` · ${r.alreadyRecorded} were already recorded and have been left out` : ''),
        });
        onOpen(r.statementId);
      },
      onError: (err) => setResult({ ok: false, text: refusalText(err, 'The statement could not be read.') }),
    });
  };

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={accountCode} onChange={(e) => { setAccountCode(e.target.value); setResult(null); }}
            aria-label="Bank account" style={{ padding: '6px 10px', fontSize: 'var(--fs-13)' }}>
            <option value="">Which bank account?</option>
            {accounts.filter((a) => a.is_active).map((a) => (
              <option key={a.account_code} value={a.account_code}>
                {a.bank_code} · {a.account_code}{a.account_no ? ` · ${a.account_no}` : ''}
              </option>
            ))}
          </select>
          <input type="file" accept=".csv,.txt" aria-label="Bank statement file"
            onChange={(e) => readFile(e.target.files)} style={{ fontSize: 'var(--fs-13)' }} />
          <button type="button" style={btn(true, !accountCode || !file || upload.isPending)}
            disabled={!accountCode || !file || upload.isPending} onClick={send}>
            <Upload {...ICON} /> {upload.isPending ? 'Reading…' : 'Upload bank statement'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 'var(--fs-13)', fontWeight: 600 }} htmlFor="bank-statement-month">
            Year and month
          </label>
          <input id="bank-statement-month" type="month" value={statementMonth} aria-label="Statement month"
            onChange={(e) => setStatementMonth(e.target.value)}
            style={{ padding: '5px 8px', fontSize: 'var(--fs-13)' }} />
          {/* Said plainly, because the field could otherwise be read as filing
              the whole file into a month. It does not: every movement lands in
              the month its own date falls in, and the month view is built from
              those dates. This only supplies a year the file left out. */}
          <span style={softText}>
            Only for a file whose dates carry no year. Where the file prints full dates this changes nothing —
            each movement belongs to the month of its own date.
          </span>
        </div>

        {/* A config that cannot read anything must say so BEFORE an upload, not
            as a refusal after one. */}
        {chosen && !chosen.ready && (
          <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
            {chosen.bank_code} has no statement columns set up, so nothing can be read from its file yet.
          </div>
        )}
        {setup.data && setup.data.recognises.length > 0 && (
          <div style={softText}>
            Card money is recognised for {setup.data.recognises.join(', ')}. Anything else is listed for you to match by hand.
          </div>
        )}
        {accounts.length === 0 && !setup.isLoading && (
          <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
            No bank account is set up to take a statement in this company yet — add one under Reconciliation setup → Bank statements.
          </div>
        )}
        {result && (
          <div style={{ fontSize: 'var(--fs-13)', color: result.ok ? good : danger, display: 'flex', gap: 6 }}>
            {!result.ok && <AlertTriangle {...ICON} />}
            <span>{result.text}</span>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <b>Bank statements read</b>
        {rows.length === 0 && !statements.isLoading && (
          <div style={softText}>None yet. Upload one above and it will be matched against the books.</div>
        )}
        {rows.length > 0 && (
          <table className={grid.grid}>
            <thead>
              <tr>
                <th>Account</th><th>File</th><th>Period</th>
                <th className={grid.num}>In</th><th className={grid.num}>Out</th>
                <th>Still to decide</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td><span className={styles.codeChip}>{s.account_code}</span></td>
                  <td style={{ wordBreak: 'break-all' }}>{s.file_name}</td>
                  <td>{s.period_from} → {s.period_to}</td>
                  <td className={grid.num}>{fmt(s.in_sen)}</td>
                  <td className={grid.num}>{fmt(s.out_sen)}</td>
                  <td className={(s.open_count ?? 0) === 0 ? grid.good : undefined}>
                    {(s.open_count ?? 0) === 0
                      ? 'nothing'
                      : `${s.open_count} of ${s.line_count}`
                        + ((s.open_payout_count ?? 0) > 0 ? ` · ${s.open_payout_count} card payout(s)` : '')}
                  </td>
                  <td>
                    <button type="button" style={btn((s.open_count ?? 0) > 0)} onClick={() => onOpen(s.id)}>
                      {(s.open_count ?? 0) > 0 ? 'Reconcile' : 'Open'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};

/* ── One statement ────────────────────────────────────────────────────────── */

const StatementView = ({ id, onBack }: { id: number; onBack: () => void }) => {
  const q = useBankStatement(id);
  const [showDone, setShowDone] = useState(false);

  const statement = q.data?.statement ?? null;
  const lines = q.data?.lines ?? [];
  const open = lines.filter((l) => l.state === 'OPEN');
  const done = lines.filter((l) => l.state !== 'OPEN');
  /* Most consequential first: a card payout books money, a plain movement is
     bookkeeping. Within each, biggest first. */
  const ordered = [...open].sort((a, b) => {
    const rank = (l: BankLine) => (l.kind === 'PAYOUT' ? 0 : l.kind === 'PAYOUT_SPLIT' ? 1 : l.kind === 'PAYOUT_UNSURE' ? 2 : l.kind === 'PAYOUT_NO_BATCH' ? 3 : 4);
    return rank(a) - rank(b) || Math.abs(b.amount_sen) - Math.abs(a.amount_sen);
  });

  return (
    <section className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button type="button" style={btn()} onClick={onBack}><ArrowLeft {...ICON} /> All statements</button>
        {statement && <b>{statement.account_code} · {statement.file_name}</b>}
        {statement && <span style={softText}>{statement.period_from} → {statement.period_to}</span>}
      </div>

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Reading the statement…</div>}
      {q.data && <ReconciliationPanel r={q.data.reconciliation} />}
      {statement && <WhereItIsSaved statement={statement} openCount={open.length} lineCount={lines.length} />}

      {open.length > 0 && (
        <section className="space-y-2">
          <b>{`Still to decide (${open.length})`}</b>
          <table className={grid.grid}>
            <thead>
              <tr>
                <th>On the bank statement</th>
                <th className={grid.num}>Amount</th>
                <th>What it looks like</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((l) => <OpenLine key={l.id} line={l} />)}
            </tbody>
          </table>
        </section>
      )}

      {done.length > 0 && (
        <div style={softText}>
          {done.length} movement{done.length === 1 ? '' : 's'} already dealt with.{' '}
          <button type="button" style={{ ...btn(), padding: '2px 8px' }} onClick={() => setShowDone(!showDone)}>
            {showDone ? 'Hide' : 'Show'}
          </button>
        </div>
      )}
      {showDone && done.length > 0 && (
        <table className={grid.grid}>
          <thead>
            <tr>
              <th>On the bank statement</th><th className={grid.num}>Amount</th><th>What happened</th><th />
            </tr>
          </thead>
          <tbody>
            {done.map((l) => <DoneLine key={l.id} line={l} />)}
          </tbody>
        </table>
      )}

      {q.data && q.data.unmatchedEntries.length > 0 && (
        <section className="space-y-2">
          <b>{`In the books, not on this statement (${q.data.unmatchedEntries.length})`}</b>
          <div style={softText}>
            Posted in this period and the bank has not shown it: an uncleared cheque, a deposit still on its way,
            or an entry belonging to a statement not uploaded yet.
          </div>
          <table className={grid.grid}>
            <thead>
              <tr><th>Entry</th><th>Date</th><th>Source</th><th className={grid.num}>Amount</th></tr>
            </thead>
            <tbody>
              {q.data.unmatchedEntries.map((e) => (
                <tr key={e.jeNo}>
                  <td>{e.jeNo}</td>
                  <td>{e.entryDate}</td>
                  <td>{[e.sourceType, e.sourceDocNo].filter(Boolean).join(' · ') || '—'}</td>
                  <td className={grid.num}>{fmt(e.debitSen - e.creditSen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
};

/* ── Where a reconciliation is saved ──────────────────────────────────────────
   Owner, 2026-09-09: 我也没有看到哪里可以save 这个recon.

   There is no Save because there is no draft: every decision on this screen
   writes when it is pressed, and the reconciliation itself is recomputed from
   the ledger each time it is asked for, never stored. A Save button would have
   nothing to do, and the honest answer to a person looking for one is to say
   that and then point at the thing he is actually looking for.

   Which is CLOSING THE MONTH. A file is not the unit a reconciliation is
   recorded at — the month is (a bank can export a file a day), so the screen
   that records and locks one is the month view. Saying so here, on the file, is
   the difference between a person finding that and a person hunting for it. */

const WhereItIsSaved = ({ statement, openCount, lineCount }: {
  statement: BankStatement;
  openCount: number;
  /** How many movements were actually READ. A failed read gives an empty list,
     which is indistinguishable from a finished statement — so the completion
     sentence below is spoken over counted rows, never over an absence. */
  lineCount: number;
}) => {
  /* The month this file's own dates put it in. Where it straddles a month end
     both are named, because closing one of them does not close the other. */
  const months = [...new Set(
    [statement.period_from, statement.period_to]
      .filter((d): d is string => typeof d === 'string' && d.length >= 7)
      .map((d) => `${d.slice(5, 7)}/${d.slice(0, 4)}`),
  )];
  const which = months.length === 0 ? null : months.join(' and ');

  return (
    <div style={{ ...softText, display: 'grid', gap: 2 }}>
      <span>
        Nothing here needs saving — every decision is written the moment you press it, and the
        reconciliation above is recomputed from the ledger each time it is read.
      </span>
      <span>
        {/* The completion half is spoken ONLY over movements that were read and
            counted. A failed read hands back an empty list, which is
            indistinguishable from a finished statement — so lineCount === 0
            falls to the neutral sentence rather than claiming the work is
            done. */}
        {openCount > 0 || lineCount === 0
          ? <>A reconciliation is <b>recorded</b> by closing its month, on the <b>By month</b> tab.</>
          : <>
              {lineCount} of {lineCount} movements read on this file are decided. A reconciliation is{' '}
              <b>recorded</b> by closing its month{which ? <> — open <b>By month</b> and close {which}</> : null}.
            </>}
      </span>
    </div>
  );
};

/* ── Does it agree? ───────────────────────────────────────────────────────── */

const Figure = ({ label, sen, tone }: { label: string; sen: number | null; tone?: 'good' | 'bad' }) => (
  <div>
    <div style={softText}>{label}</div>
    <div style={{
      fontSize: 'var(--fs-18, 17px)', fontWeight: 700,
      color: tone === 'good' ? good : tone === 'bad' ? danger : undefined,
    }}>
      {sen == null ? '—' : fmt(sen)}
    </div>
  </div>
);

export const ReconciliationPanel = ({ r }: { r: Reconciliation }) => {
  /* The inconsistency comes FIRST and replaces the verdict. Publishing a
     difference the numbers cannot account for is worse than publishing
     nothing: it looks like work has been done. */
  if (!r.consistent) {
    return (
      <div style={{ ...panel('plain'), border: `1px solid ${danger}` }}>
        <b style={{ color: danger, display: 'flex', gap: 6, alignItems: 'center' }}>
          <AlertTriangle {...ICON} /> These numbers do not add up
        </b>
        <div style={{ fontSize: 'var(--fs-13)', marginTop: 6 }}>{r.inconsistency}</div>
      </div>
    );
  }

  return (
    <div style={{ ...panel(r.reconciled ? 'good' : 'plain'), display: 'grid', gap: 'var(--space-3)' }}>
      <b>
        {r.reconciled
          ? 'Reconciled — the bank and the books agree, with nothing outstanding on either side.'
          : r.differenceSen == null
            ? 'This file prints no balances, so there is nothing to compare against — only the movements below.'
            : `The bank and the books differ by ${fmt(r.differenceSen)}.`}
      </b>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)' }}>
        <Figure label="Closing — bank statement" sen={r.closingStatementSen} />
        <Figure label="Closing — the books" sen={r.closingLedgerSen} />
        <Figure label="Difference" sen={r.differenceSen}
          tone={r.differenceSen == null ? undefined : r.differenceSen === 0 ? 'good' : 'bad'} />
      </div>

      {!r.reconciled && (
        <div style={{ fontSize: 'var(--fs-13)' }}>
          <div>Made up of:</div>
          <ul style={{ margin: '4px 0 0 0', paddingLeft: 18 }}>
            <li>
              <b>{fmt(r.bankNotInBooks.sen)}</b> on the bank and not in the books —{' '}
              {r.bankNotInBooks.count} movement(s) still to decide, below.
            </li>
            <li>
              <b>{fmt(r.booksNotOnBank.sen)}</b> in the books and not on the bank —{' '}
              {r.booksNotOnBank.count} entr{r.booksNotOnBank.count === 1 ? 'y' : 'ies'}.
            </li>
            {r.broughtForwardSen != null && r.broughtForwardSen !== 0 && (
              <li>
                {/* Its own line, because this period's work cannot close it. */}
                <b>{fmt(r.broughtForwardSen)}</b> brought forward — the two sides already
                disagreed by this much before {r.periodFrom}.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
};

/* ── One movement still to decide ─────────────────────────────────────────── */

const KIND_LABEL: Record<BankLine['kind'], string> = {
  PAYOUT: 'a card payout, matched',
  PAYOUT_SPLIT: 'one payout for several reports',
  PAYOUT_UNSURE: 'a card payout — check which',
  PAYOUT_NO_BATCH: 'a card payout with no report waiting',
  DUPLICATE: 'already recorded from an earlier upload',
  OTHER: 'not card money',
};

export const OpenLine = ({ line }: { line: BankLine }) => {
  const book = useBookBankReceipt();
  const match = useMatchBankLine();
  const ignore = useIgnoreBankLine();
  /* Seeded from what the MATCHER decided, never from "the first candidate" —
     the two are different answers, and the wrong one books money against the
     wrong statement while looking exactly as confident.
     ONE CREDIT CAN PAY SEVERAL statements (owner, on the merchant side of the
     same shape: 顾客可能刷一次卡，但是还两个单), so this is a set, and a split the
     matcher worked out arrives pre-ticked. Anything less certain starts empty. */
  const [picked, setPicked] = useState<number[]>(
    line.kind === 'PAYOUT' && line.matched_batch_id != null ? [line.matched_batch_id]
      : line.kind === 'PAYOUT_SPLIT' ? (line.split ?? []).map((s) => s.batchId)
        : [],
  );
  const toggle = (id: number) =>
    setPicked((was) => (was.includes(id) ? was.filter((x) => x !== id) : [...was, id]));

  /* Did the matcher settle this one? Then the other reports are noise until
     asked for — and "asked for" has to stay possible, because the matcher is
     sometimes wrong and that is the whole reason a person is here. */
  const decided = line.kind === 'PAYOUT' || line.kind === 'PAYOUT_SPLIT';
  const [showAll, setShowAll] = useState(false);

  /* Each statement takes what it is still owed. The shares must add up to the
     credit to the sen — the same rule the merchant side applies to a swipe
     covering two orders — so the button says the difference rather than
     letting a leftover through. */
  const chosen = line.candidates.filter((b) => picked.includes(b.id));
  const allocatedSen = chosen.reduce((s, b) => s + b.outstandingSen, 0);
  const shortSen = line.amount_sen - allocatedSen;
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  /* Which ledger entry the operator says this movement is. Nothing is
     pre-selected: he is agreeing that two records are one fact, and a
     pre-ticked answer to that is a decision made for him. */
  const [entry, setEntry] = useState<string | null>(null);
  const failed = book.isError ? book.error
    : match.isError ? match.error
      : ignore.isError ? ignore.error : null;

  return (
    <tr>
      <td>
        <div>{line.booked_on}{line.reference ? <> · ref <b>{line.reference}</b></> : null}</div>
        <div className={grid.sub} style={{ wordBreak: 'break-word' }}>{line.description}</div>
        <div className={grid.sub}>line {line.line_no}</div>
      </td>
      <td className={grid.num}>
        <div className={line.amount_sen < 0 ? grid.bad : undefined}>{fmt(line.amount_sen)}</div>
        {/* The gross the bank actually credited, when it split the payout —
            otherwise the number here matches no line on his page. */}
        {line.charge_sen > 0 && (
          <div className={grid.sub}>{fmt(line.amount_sen + line.charge_sen)} less {fmt(line.charge_sen)} charge</div>
        )}
      </td>
      <td>
        <div>{KIND_LABEL[line.kind]}</div>
        {line.acquirer_code && (
          <div className={grid.sub}>
            <span className={styles.codeChip}>{line.acquirer_code}</span>
            {line.trading_date ? ` trading ${line.trading_date}` : ''}
            {line.merchant_no ? ` · merchant ${line.merchant_no}` : ''}
          </div>
        )}
        {line.note && <div className={grid.sub}>{line.note}</div>}
      </td>
      <td>
        {line.amount_sen > 0 && line.candidates.length > 0 && (
          <div style={{ display: 'grid', gap: 4 }}>
            {/* ONLY THE ANSWER, when there is one. The owner, on a month with
                four reports outstanding and 286 movements: 如果他很多，那么他会
                显示很多比哦？

                Yes it did — every outstanding report of that acquirer, on every
                row, whether or not the matcher had already worked out which one
                it was. With ten reports open that is ten tick boxes a row, and
                the one that matters is buried among nine that do not.

                So a decided line shows its decision and nothing else. The rest
                are one press away, for the times the matcher is wrong. */}
            {(decided && !showAll ? line.candidates.filter((b) => picked.includes(b.id)) : line.candidates)
              .map((b) => (
                <label key={b.id} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 'var(--fs-12)' }}>
                  <input type="checkbox" checked={picked.includes(b.id)} onChange={() => toggle(b.id)}
                    aria-label={`Report ${b.fileName ?? b.id} for line ${line.line_no}`} />
                  <span>{b.fileName ?? `report ${b.id}`} · owed <b>{fmt(b.outstandingSen)}</b></span>
                </label>
              ))}
            {decided && line.candidates.length > picked.length && (
              <button type="button" style={{ ...btn(), padding: '2px 8px', justifySelf: 'start' }}
                aria-label={`Other reports for line ${line.line_no}`}
                onClick={() => setShowAll(!showAll)}>
                {showAll
                  ? 'Just the match'
                  : `Not this one? ${line.candidates.length - picked.length} other report(s)`}
              </button>
            )}
            {/* Only when it does NOT add up — a running total nobody needs is
                one more number in the way. */}
            {picked.length > 0 && shortSen !== 0 && (
              <span className={grid.sub}>
                Selected {fmt(allocatedSen)} of {fmt(line.amount_sen)} —{' '}
                <b className={grid.bad}>{fmt(Math.abs(shortSen))} {shortSen > 0 ? 'short' : 'too much'}</b>
              </span>
            )}
            <button type="button" style={btn(true, picked.length === 0 || shortSen !== 0 || book.isPending)}
              disabled={picked.length === 0 || shortSen !== 0 || book.isPending}
              onClick={() => book.mutate({
                lineId: line.id,
                allocations: chosen.map((b) => ({ batchId: b.id, amountSen: b.outstandingSen })),
              })}>
              <Landmark {...ICON} />{' '}
              {book.isPending ? 'Posting…' : picked.length > 1 ? `Money received — ${picked.length} reports` : 'Money received'}
            </button>
          </div>
        )}
        {/* THIS MOVEMENT IS ALREADY IN THE BOOKS.
            Owner, 2026-09-09, on a RM 3,000 transfer sitting beside the RM 3,000
            receipt that posted it: the only button was "Not ours to reconcile",
            which is not true — it IS ours, it is simply already booked. Saying
            which entry it is has always been possible on the server and never
            had a way to choose.

            Offered for the whole statement, not only the parts that are not card
            money: a payout the matcher could not place may still have been
            booked by hand, and refusing to show the entry because of what the
            movement LOOKS like would be the screen second-guessing the person
            holding the statement. */}
        {line.entryCandidates.length > 0 && !asking && (
          <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
            {line.entryCandidates.map((e) => (
              <label key={e.jeNo} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 'var(--fs-12)' }}>
                <input type="radio" name={`entry-${line.id}`} checked={entry === e.jeNo}
                  onChange={() => setEntry(e.jeNo)}
                  aria-label={`Entry ${e.jeNo} for line ${line.line_no}`} />
                <span>
                  <b>{e.jeNo}</b> · {e.entryDate}
                  {e.daysApart > 0 && <span className={grid.sub}> ({e.daysApart}d apart)</span>}
                  {(e.sourceType ?? e.sourceDocNo) && (
                    <div className={grid.sub}>{[e.sourceType, e.sourceDocNo].filter(Boolean).join(' · ')}</div>
                  )}
                </span>
              </label>
            ))}
            <button type="button" style={btn(true, entry === null || match.isPending)}
              disabled={entry === null || match.isPending}
              onClick={() => { if (entry) match.mutate({ lineId: line.id, jeNo: entry }); }}>
              <Link2 {...ICON} /> {match.isPending ? 'Matching…' : 'This is that entry'}
            </button>
          </div>
        )}

        {!asking && (
          <button type="button" style={{ ...btn(), marginTop: 4, padding: '2px 8px' }} onClick={() => setAsking(true)}>
            Not ours to reconcile
          </button>
        )}
        {asking && (
          <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
            {/* A reason, required — an ignored movement leaves the difference
                for ever and this sentence is all the next person will have. */}
            <input value={note} onChange={(e) => setNote(e.target.value)}
              aria-label={`Why line ${line.line_no} is not ours`} placeholder="Why? e.g. own transfer, booked from the other side"
              style={{ padding: '4px 6px', fontSize: 'var(--fs-12)', minWidth: 220 }} />
            <button type="button" style={btn(false, !note.trim() || ignore.isPending)}
              disabled={!note.trim() || ignore.isPending}
              onClick={() => ignore.mutate({ lineId: line.id, note: note.trim() })}>
              <CheckCheck {...ICON} /> Leave it out
            </button>
          </div>
        )}
        {failed != null && (
          <div style={{ fontSize: 'var(--fs-12)', color: danger, marginTop: 4 }}>
            {refusalText(failed, 'That was not accepted.')}
          </div>
        )}
      </td>
    </tr>
  );
};

export const DoneLine = ({ line }: { line: BankLine }) => {
  const undo = useUndoBankLine();
  return (
    <tr>
      <td>
        <div>{line.booked_on}{line.reference ? <> · ref <b>{line.reference}</b></> : null}</div>
        <div className={grid.sub} style={{ wordBreak: 'break-word' }}>{line.description}</div>
      </td>
      <td className={grid.num}>{fmt(line.amount_sen)}</td>
      <td>
        {line.state === 'IGNORED'
          ? <span style={softText}>left out — {line.note ?? 'no reason given'}</span>
          : <span className={grid.good}>
              posted{line.posted_je_no ? ` · ${line.posted_je_no}` : ''}
              {line.matches.length > 0 ? ` · ${line.matches.map((m) => m.je_no).join(', ')}` : ''}
            </span>}
      </td>
      <td>
        <button type="button" style={btn(false, undo.isPending)} disabled={undo.isPending}
          onClick={() => undo.mutate(line.id)}
          title="Put this movement back. Any entry behind it is reversed, never deleted.">
          <Undo2 {...ICON} /> Undo
        </button>
      </td>
    </tr>
  );
};

export type { BankStatement };
