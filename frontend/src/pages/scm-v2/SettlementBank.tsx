// ----------------------------------------------------------------------------
// Card payouts into the bank — STEP TWO of settlement (brief §3.5 layer 3).
//
// Its own screen because it is its own job, on its own day. The owner, looking
// at the one page that carried both: "怎么说呢，就感觉很多东西挤在一页…就一页对
// 卡机报告，对了没有问题就去对bank statement 或daily transaction report."
//
//   /scm/settlement-recon  — reconcile the CARD MACHINE report (fees post there)
//   here                   — record the money the BANK actually received
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
import { AlertTriangle, Download, Landmark, Undo2 } from 'lucide-react';
import {
  useSettlementBatches, useSettlementBatch, useMarkBatchReceived, useUndoReceipt, useInTransit,
  type AgeBucket, type SettlementBatch,
} from './settlement-queries';
import {
  ICON, fmt, btn, cell, num, table, headRow, rowLine, softText, danger, good, panel,
  refusalText, payableOf,
} from './settlement-ui';
import { downloadCSV, toCSV } from '../../lib/csv';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

export const SettlementBank = () => {
  const [tab, setTab] = useState<'money' | 'transit'>('money');
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Card money into the bank" />
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" style={btn(tab === 'money')} onClick={() => setTab('money')}>Waiting for money</button>
        <button type="button" style={btn(tab === 'transit')} onClick={() => setTab('transit')}>Paid, not yet in the bank</button>
        <span style={{ flex: 1 }} />
        <Link to="/scm/settlement-recon" style={{ ...btn(), textDecoration: 'none' }}>
          ← Card machine reconciliation
        </Link>
      </div>
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
  const owed = all.filter((b) => outstandingOf(b) !== 0);
  const settled = all.filter((b) => outstandingOf(b) === 0);
  const shown = showSettled ? [...owed, ...settled] : owed;
  const total = owed.reduce((s, b) => s + outstandingOf(b), 0);

  return (
    <div className="space-y-3">
      <div style={softText}>
        Each statement below has been read off the card machine and is waiting for the money. Take the date and the
        amount off the BANK statement (or the daily transaction report) and record each credit as it lands — one
        statement is often paid in several.
      </div>

      <div style={{
        padding: 'var(--space-4)', borderRadius: 'var(--radius-md)',
        background: 'rgba(47, 93, 79, 0.10)', border: `1px solid ${good}`,
        display: 'flex', gap: 'var(--space-5)', alignItems: 'baseline', flexWrap: 'wrap',
      }}>
        <div>
          <div style={softText}>Still owed on statements you have already read</div>
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
      {!batches.isLoading && owed.length === 0 && !showSettled && (
        <div style={{ fontSize: 'var(--fs-13)', color: good }}>
          Every statement you have reconciled has been paid in full. Nothing to record here.
        </div>
      )}

      {shown.length > 0 && (
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Acquirer</th><th style={cell}>Statement</th><th style={cell}>Period</th>
              <th style={num}>It should pay</th><th style={num}>Received</th><th style={num}>Still owed</th>
              <th style={cell}>Card machine</th><th style={cell} />
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => {
              const left = outstandingOf(b);
              /* A statement whose lines are not all reconciled can still be
                 paid — the money is the money — but the screen says so, because
                 its fees are not in the books yet and this acquirer will not
                 come to zero until they are. */
              const open = b.open_count ?? 0;
              return (
                <tr key={b.id} style={rowLine}>
                  <td style={cell}><span className={styles.codeChip}>{b.acquirer_code}</span></td>
                  <td style={cell}>{b.file_name}</td>
                  <td style={cell}>{b.period_from} → {b.period_to}</td>
                  <td style={num}>{fmt(payableOf(b))}</td>
                  <td style={num}>{(b.received_sen ?? 0) === 0 ? '—' : fmt(b.received_sen)}</td>
                  <td style={{ ...num, fontWeight: left === 0 ? undefined : 700, color: left === 0 ? good : undefined }}>
                    {left === 0 ? 'all in' : fmt(left)}
                  </td>
                  <td style={{ ...cell, color: open > 0 ? danger : undefined }}>
                    {open > 0 ? `${open} line(s) still open` : `${b.confirmed_count ?? 0} line(s) reconciled`}
                  </td>
                  <td style={cell}>
                    <button type="button" style={btn(batchId === b.id)} onClick={() => setBatchId(b.id)}>Open</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {batchId != null && <BatchReceipts batchId={batchId} />}
    </div>
  );
};

/* ── One statement: the credits banked against it, and the next one ───────── */

const BatchReceipts = ({ batchId }: { batchId: number }) => {
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
      <b>
        {batch.acquirer_code} · {batch.file_name}
        {' — '}
        {done
          ? `${fmt(payable)} is all in${receipts.length > 1 ? `, across ${receipts.length} credits` : ''}.`
          : `${fmt(outstanding)} still to come${received !== 0 ? ` of ${fmt(payable)}` : ''}.`}
      </b>

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

      {!done && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor={`recv-${batchId}`} style={{ fontWeight: 600 }}>Money arrived in the bank on</label>
          <input id={`recv-${batchId}`} type="date" value={on} aria-label="Money arrived in the bank on"
            onChange={(e) => setOn(e.target.value)} style={{ padding: '5px 8px', fontSize: 'var(--fs-13)' }} />
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

      {openLines > 0 && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
          {openLines} line(s) on this statement are still unconfirmed, so their fees are not in the books yet.
          The money can still be recorded, but{' '}
          <Link to="/scm/settlement-recon">finish the card machine side</Link> or this acquirer will not come to zero.
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
        The customer has paid and the money has not reached the bank yet. This is the same money as the
        settlement-in-transit balance on the trial balance — here it is named to the document, so you can see
        WHOSE it is rather than just how much.
      </div>

      <div style={{
        padding: 'var(--space-4)', borderRadius: 'var(--radius-md)',
        background: 'rgba(47, 93, 79, 0.10)', border: `1px solid ${good}`,
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
