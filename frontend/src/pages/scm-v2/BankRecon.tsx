// ----------------------------------------------------------------------------
// BANK STATEMENT RECONCILIATION — what the BANK actually received against what
// the merchants owe. Step two of settlement (brief §3.5 layer 3).
//
// Its own screen because it is its own job, on its own day, and the owner named
// it himself: "就不能分成 merchant reconciliation, bank statement reconciliation
// 吗？"
//
//   /scm/merchant-recon — the MERCHANT statement vs the ERP's payments (fees)
//   here                — the BANK statement vs what those merchants owe
//
// Nothing on this screen touches the card-machine side, and nothing on that one
// touches the bank. What links them is settlement-in-transit: reconciling takes
// the fee out of it, and each credit recorded here takes the payout out of it.
// One statement can be paid in several credits (owner: 我实际收到的钱可能是多笔
// 的哦), so each credit is recorded on its own — date, amount, and its own entry.
//
// When layer 4 (bank reconciliation) lands, this is the screen the bank
// statement feeds: the same rows, read from the file instead of typed.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Download, Landmark, Undo2 } from 'lucide-react';
import {
  useSettlementBatches, useSettlementBatch, useMarkBatchReceived, useUndoReceipt, useInTransit,
  type AgeBucket, type SettlementBatch,
} from './settlement-queries';
import {
  ICON, fmt, btn, cell, num, table, headRow, rowLine, softText, danger, good, panel,
  refusalText, payableOf,
} from './settlement-ui';
import { BankStatementTab } from './BankStatementTab';
import { PayoutAdviceTab } from './PayoutAdviceTab';
import { DateField } from '../../vendor/scm/components/DateField';
import grid from './MerchantRecon.module.css';
import { downloadCSV, toCSV } from '../../lib/csv';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

/* Three views of the same money, and the FILE comes first now (layer 4).
   Owner, 2026-08-19: 我不是应该upload bank statement 或 daily transaction report
   然后你也自动核对吗 — so the default way in is the statement itself, and typing
   a credit by hand is the fallback for the day there is no file, not the job. */

export const BankRecon = () => {
  const [tab, setTab] = useState<'statement' | 'advice' | 'money' | 'transit'>('statement');
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · step 2 of 2" title="Bank statement reconciliation" />
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" style={btn(tab === 'statement')} onClick={() => setTab('statement')}>Bank statement</button>
        {/* Public Bank's IBG advice — the payer's own list of which reports one
            credit pays, and what lets the statement above match a payout
            spanning more reports than any search would try. The merchant screen
            carries the same tab (owner, 2026-08-24: 毕竟它属于card merchant
            那边); this door stays because the credit lands on THIS side. */}
        <button type="button" style={btn(tab === 'advice')} onClick={() => setTab('advice')}>Payment advice</button>
        <button type="button" style={btn(tab === 'money')} onClick={() => setTab('money')}>Money to come in</button>
        <button type="button" style={btn(tab === 'transit')} onClick={() => setTab('transit')}>Still with the merchants</button>
        <span style={{ flex: 1 }} />
        <Link to="/scm/merchant-recon" style={{ ...btn(), textDecoration: 'none' }}>
          <ArrowLeft {...ICON} /> Merchant reconciliation
        </Link>
      </div>
      {tab === 'statement' && <BankStatementTab />}
      {tab === 'advice' && <PayoutAdviceTab />}
      {tab === 'money' && <WaitingForMoney />}
      {tab === 'transit' && <InTransitTab />}
    </div>
  );
};

/* ── The statements that are still owed money ─────────────────────────────── */

const WaitingForMoney = () => {
  const batches = useSettlementBatches();
  const [batchId, setBatchId] = useState<number | null>(null);
  const [showSettled, setShowSettled] = useState(false);

  const all = batches.data?.batches ?? [];
  const outstandingOf = (b: SettlementBatch) => b.outstanding_sen ?? payableOf(b) - (b.received_sen ?? 0);
  /* THE GATE (owner: 核对完了没有问题才会显示去 bank statement 的
     reconciliation). A merchant report whose lines are not all decided does not
     appear here at all — its fees are not in the books, so its net is not yet
     the truth. It is counted, and named, so nothing disappears silently. */
  const ready = all.filter((b) => (b.open_count ?? 0) === 0);
  const notReady = all.filter((b) => (b.open_count ?? 0) > 0);
  const owed = ready.filter((b) => outstandingOf(b) !== 0);
  const settled = ready.filter((b) => outstandingOf(b) === 0);
  const shown = showSettled ? [...owed, ...settled] : owed;
  const total = owed.reduce((s, b) => s + outstandingOf(b), 0);

  /* ONE THING AT A TIME: working a statement replaces the list. */
  if (batchId != null) return <BatchReceipts batchId={batchId} onBack={() => setBatchId(null)} />;

  return (
    <div className="space-y-3">
      <div style={softText}>
        Take the date and the amount off the BANK statement or the daily transaction report. One merchant report is
        often paid in several credits — record each as it lands.
      </div>
      {notReady.length > 0 && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
          {notReady.length} merchant report{notReady.length === 1 ? ' is' : 's are'} not here yet — finish{' '}
          <Link to="/scm/merchant-recon">merchant reconciliation</Link> first ({notReady.map((b) => b.acquirer_code).join(', ')}).
        </div>
      )}

      <div style={{
        padding: 'var(--space-4)', borderRadius: 'var(--radius-md)',
        background: 'rgba(47, 93, 79, 0.10)', border: `1px solid ${good}`,
        display: 'flex', gap: 'var(--space-5)', alignItems: 'baseline', flexWrap: 'wrap',
      }}>
        <div>
          <div style={softText}>Owed by the merchants on statements already reconciled</div>
          <div style={{ fontSize: 'var(--fs-24, 22px)', fontWeight: 700 }}>{fmt(total)}</div>
        </div>
        <div style={softText}>{owed.length} statement{owed.length === 1 ? '' : 's'}</div>
        <span style={{ flex: 1 }} />
        <label style={{ ...softText, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showSettled} aria-label="Show statements already settled"
            onChange={(e) => setShowSettled(e.target.checked)} />
          Show settled statements ({settled.length})
        </label>
      </div>

      {batches.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
      {/* Spoken only over statements that were READ and summed: the list came
          back, at least one reconciled statement is in it, and every one of
          them reached zero outstanding. An empty or failed read renders
          nothing — an absence is never evidence (owner 2026-08-17, the
          empty-state rule). */}
      {batches.data && ready.length > 0 && owed.length === 0 && !showSettled && (
        <div style={{ fontSize: 'var(--fs-13)', color: good }}>
          Every merchant statement you have reconciled has been paid in full.
        </div>
      )}

      {/* ONE ROW PER STATEMENT, and the transactions folded away.
          The owner, twice: 不需要看那么多资料了吧。感觉重复很乱 — and then, on
          what he actually does here: 从卡机那边 recon 完了，我应该是需要核对 net
          的数据罢了哦.

          That is the job in one sentence. He has a bank statement in his hand
          showing a credit, and he is looking for the report whose NET is that
          number. The transactions inside it were agreed at step 1 and are only
          wanted when the number does NOT match — so they are one press away
          rather than spread across the screen, and their query does not even
          run until he asks. */}
      {shown.length > 0 && (
        <table className={grid.grid}>
          <thead>
            <tr>
              <th>Acquirer</th>
              <th>Statement</th>
              <th>Period</th>
              <th className={grid.num}>Net it should pay</th>
              <th className={grid.num}>Received</th>
              <th className={grid.num}>Still owed</th>
              <th />
            </tr>
          </thead>
          {shown.map((b) => (
            <StatementRow key={b.id} batch={b} owed={outstandingOf(b)} onOpen={() => setBatchId(b.id)} />
          ))}
        </table>
      )}
    </div>
  );
};


/* ── One statement, one row ─────────────────────────────────────────────────
   The owner asked for the transactions here (这里 pending bank statement
   matching 的也显示 detail 哦), saw them, and then said what he actually does
   with this screen: 从卡机那边 recon 完了，我应该是需要核对 net 的数据罢了哦.

   Both are true, and they are not in conflict. He is holding a bank statement
   and looking for the report whose NET is the credit he can see — that is a
   money question, one row per report. The transactions behind it were agreed
   at step 1 and are wanted only when the number does NOT match. So they are
   folded away, and `useSettlementBatch(null)` means the query for them does
   not run at all until he opens one. */

const StatementRow = ({ batch, owed, onOpen }: {
  batch: SettlementBatch; owed: number; onOpen: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const q = useSettlementBatch(open ? batch.id : null);
  const rows = q.data?.rows ?? [];
  const received = batch.received_sen ?? 0;

  return (
    <tbody>
      <tr>
        <td><span className={styles.codeChip}>{batch.acquirer_code}</span></td>
        <td>
          <b style={{ wordBreak: 'break-all' }}>{batch.file_name}</b>
          <div>
            <button type="button" style={{ ...btn(), padding: '2px 8px', marginTop: 4 }}
              aria-label={`Transactions in ${batch.file_name}`} onClick={() => setOpen(!open)}>
              {open ? 'Hide' : 'Show'} its {batch.row_count} transaction{batch.row_count === 1 ? '' : 's'}
            </button>
          </div>
        </td>
        <td>{batch.period_from} → {batch.period_to}</td>
        <td className={grid.num}>{fmt(payableOf(batch))}</td>
        <td className={grid.num}>{received === 0 ? '—' : fmt(received)}</td>
        <td className={grid.num}
          style={{ fontWeight: owed === 0 ? undefined : 700, color: owed === 0 ? good : undefined }}>
          {owed === 0 ? 'all in' : fmt(owed)}
        </td>
        <td>
          <button type="button" style={btn(owed !== 0)} onClick={onOpen}>
            {owed === 0 ? 'Open' : 'Record the money'}
          </button>
        </td>
      </tr>

      {open && (
        <tr>
          {/* Indented under its own statement rather than given the top-level
              columns, because these are a different kind of row — the parts of
              the number above, not another number to compare against it. */}
          <td />
          <td colSpan={6} style={{ background: 'var(--c-paper)' }}>
            {q.isLoading && <span style={softText}>Reading its transactions…</span>}
            {!q.isLoading && rows.length === 0 && <span style={softText}>This statement has no lines.</span>}
            {rows.length > 0 && (
              <table className={grid.grid} style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th>Date</th><th>Reference</th><th>Document</th><th>Customer</th>
                    <th className={grid.num}>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    /* One line settling several orders stacks inside its cell —
                       the rare case, and the only honest shape for it. */
                    const links = r.linked;
                    const stack = (pick: (l: typeof links[number]) => React.ReactNode) => (
                      links.length === 0
                        ? <span className={grid.sub}>no sale linked</span>
                        : links.map((l) => <div key={l.payment_id}>{pick(l) ?? '—'}</div>)
                    );
                    return (
                      <tr key={r.id}>
                        <td>{r.txn_date}</td>
                        <td>{r.ref ? <b>{r.ref}</b> : <span className={grid.sub}>—</span>}</td>
                        <td>{stack((l) => <b>{l.doc_no ?? l.payment_id}</b>)}</td>
                        <td>{stack((l) => l.customer_name)}</td>
                        <td className={grid.num}>{fmt(r.net_sen)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </tbody>
  );
};

/* ── One statement: the credits banked against it, and the next one ───────── */

const BatchReceipts = ({ batchId, onBack }: { batchId: number; onBack: () => void }) => {
  const q = useSettlementBatch(batchId);
  const receive = useMarkBatchReceived();
  const undo = useUndoReceipt();
  const [on, setOn] = useState('');
  const [amount, setAmount] = useState('');

  const batch = q.data?.batch ?? null;
  if (q.isLoading || !batch) return <div style={{ fontSize: 'var(--fs-13)' }}>Loading the statement…</div>;

  const payable = payableOf(batch);
  const receipts = batch.receipts ?? [];
  const received = batch.received_sen ?? receipts.reduce((s, r) => s + r.amount_sen, 0);
  const outstanding = batch.outstanding_sen ?? payable - received;
  const done = outstanding === 0 && payable !== 0;
  const openLines = (q.data?.rows ?? []).filter((r) => !r.confirmed_at && r.bucket !== 'IGNORED').length;
  const bank = batch.receiving_bank ?? null;

  const send = () => {
    /* Blank = the rest of it. The ordinary payout is one credit for the whole
       statement, and nobody should retype a number the statement knows. */
    const typed = amount.trim() ? Math.round(Number(amount) * 100) : null;
    receive.mutate({ batchId, receivedOn: on, amountSen: typed }, {
      onSuccess: () => { setOn(''); setAmount(''); },
    });
  };

  return (
    <section className="space-y-3" style={{ ...panel(done ? 'good' : 'plain'), border: '1px solid var(--c-ink)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button type="button" style={btn()} onClick={onBack}><ArrowLeft {...ICON} /> All statements</button>
        <b>{batch.acquirer_code} · {batch.file_name}</b>
        <span>
          {done
            ? `${fmt(payable)} is all in${receipts.length > 1 ? `, across ${receipts.length} credits` : ''}.`
            : `${fmt(outstanding)} still to come${received !== 0 ? ` of ${fmt(payable)}` : ''}.`}
        </span>
      </div>

      {receipts.length > 0 && (
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Arrived in the bank</th><th style={num}>Amount</th>
              <th style={cell}>Journal</th><th style={cell}>Recorded by</th><th style={cell} />
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => (
              <tr key={r.id} style={rowLine}>
                <td style={cell}>{r.received_on}</td>
                <td style={num}>{fmt(r.amount_sen)}</td>
                <td style={cell}>{r.je_no ?? '—'}</td>
                <td style={cell}>{r.created_by ?? '—'}</td>
                <td style={cell}>
                  <button type="button" style={btn(false, undo.isPending)} disabled={undo.isPending}
                    onClick={() => undo.mutate(r.id)}
                    title="Take this credit back off the statement — its entry is reversed">
                    <Undo2 {...ICON} /> Undo
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* WHICH BANK, named. The same merchant pays different companies into
          different banks (owner: 例如pbb，在houzs 可能是maybank 收钱，但是在2990
          是hong leong bank 收钱), and a wrong one is invisible until the bank
          statement disagrees — so it is stated here, before the money is
          recorded, not buried in a setup screen. */}
      {!done && bank && (
        <div style={{ fontSize: 'var(--fs-13)', color: bank.configured ? undefined : danger }}>
          {bank.configured
            ? <>Books into <b>{bank.name ?? bank.code}</b> ({bank.code}).</>
            : <>
                No receiving bank is set for {batch.acquirer_code} in this company — it will book into{' '}
                <b>{bank.name ?? bank.code}</b> ({bank.code}), the company default.{' '}
                <Link to="/scm/merchant-recon">Set it in Merchant setup</Link>.
              </>}
        </div>
      )}

      {!done && openLines === 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor={`recv-${batchId}`} style={{ fontWeight: 600 }}>Money arrived in the bank on</label>
          <DateField id={`recv-${batchId}`} value={on} aria-label="Money arrived in the bank on"
            onChange={(iso) => setOn(iso)} style={{ padding: '5px 8px', fontSize: 'var(--fs-13)' }} />
          <input id={`amt-${batchId}`} value={amount} aria-label="Amount of this credit"
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`Amount (blank = ${fmt(outstanding)})`}
            style={{ padding: '5px 8px', fontSize: 'var(--fs-13)', width: 200 }} />
          <button type="button" style={btn(true, !on || receive.isPending)} disabled={!on || receive.isPending}
            onClick={send}>
            <Landmark {...ICON} /> {receive.isPending ? 'Posting…' : 'Money received'}
          </button>
        </div>
      )}

      {/* The list already refuses to show an unreconciled report; this is the
          same rule at the second gate, for a report that was opened and then
          re-opened for edits on the other screen. */}
      {openLines > 0 && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
          {openLines} line(s) on this report are back to undecided. Finish{' '}
          <Link to="/scm/merchant-recon">merchant reconciliation</Link> before recording money against it.
        </div>
      )}

      {receive.isError && (
        <div style={{ color: danger, display: 'flex', gap: 6 }}>
          <AlertTriangle {...ICON} />
          <span>{refusalText(receive.error, 'The credit was not posted.')}</span>
        </div>
      )}
    </section>
  );
};

/* ── Paid by the customer, not yet in the bank ─────────────────────────────
   The owner asked for this in these words: he needs to see that a customer HAS
   paid while the money has not arrived or been reconciled, in DETAIL, not as a
   balance. It is the brief's 在途结算款账龄 (§3.7) and it is the readable form
   of the 320-0000 balance — same money, named to the document. */

/* Three states, because each one is somebody else's job: chase the acquirer,
   finish the reconciling, or wait for the payout. */
const IN_TRANSIT_STATE: Record<string, string> = {
  NOT_ON_A_STATEMENT: 'The acquirer has not reported it yet',
  MATCHED_NOT_POSTED: 'On a statement, waiting to be confirmed',
  RECONCILED_NOT_PAID: 'Reconciled — the payout has not arrived',
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
        The customer has paid and the money has not reached the bank yet — the same money as the
        settlement-in-transit balance, named to the document so you can see WHOSE it is.
      </div>

      <div style={{
        padding: 'var(--space-4)', borderRadius: 'var(--radius-md)',
        background: 'rgba(47, 93, 79, 0.10)', border: `1px solid ${good}`,
        display: 'flex', gap: 'var(--space-5)', alignItems: 'baseline', flexWrap: 'wrap',
      }}>
        <div>
          <div style={softText}>Sitting with the merchants right now</div>
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
                <tr key={acq} style={rowLine}>
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
              <tr key={`${l.source}:${l.paymentId}`} style={rowLine}>
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
