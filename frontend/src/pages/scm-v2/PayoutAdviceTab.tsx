// ----------------------------------------------------------------------------
// THE PAYMENT ADVICE — the acquirer's own answer to "which reports does one
// bank credit pay". Accounting phase 4, the owner's words: for pbb 就是几份
// excel 对一份 pdf.
//
// Public Bank sends a transaction file per settlement date (merchant
// reconciliation reads those) and, when it pays, ONE IBG advice covering
// several of them. The bank statement then shows one credit for the advice's
// total. Upload the advice here and each day it names is checked against the
// merchant report already in — a difference is the finding — and once every
// day agrees, the bank matcher reads the advice instead of guessing: the
// credit on the bank statement allocates itself across however many reports
// the advice names. Without it the matcher searches for a combination and
// stops at four, which is the very limit the advice exists to remove.
//
// Everything that decides anything lives on the server (acc/pbb-advice reads
// the PDF, acc/payout-advice compares); this screen uploads and repeats what
// the server said, refusals verbatim (§2.14).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { AlertTriangle, Upload } from 'lucide-react';
import {
  usePayouts, useUploadPayoutAdvice, usePostPayoutCharge, useUndoPayoutCharge,
  type Payout, type PayoutDay, type ChargeAccount,
} from './settlement-queries';
import {
  ICON, fmt, btn, cell, num, table, headRow, rowLine, softText, danger, good, panel, refusalText,
} from './settlement-ui';
import styles from './Suppliers.module.css';
import grid from './MerchantRecon.module.css';

export const PayoutAdviceTab = () => {
  const q = usePayouts();
  const upload = useUploadPayoutAdvice();
  const [file, setFile] = useState<{ name: string; contentBase64: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const payouts = q.data?.payouts ?? [];
  /* What the bank-charge dialog needs (docs/bugs/0787): the accounts it may
     offer, and each acquirer's fee account to start on. */
  const chargeAccounts = q.data?.chargeAccounts ?? [];
  const feeAccountByAcquirer = q.data?.feeAccountByAcquirer ?? {};

  /* The PDF goes up as base64, not text — a PDF read as text is mangled before
     the server ever sees it. readAsDataURL's prefix is fine; the server strips
     everything up to the comma. */
  const readFile = (picked: FileList | null) => {
    setResult(null);
    const f = picked?.[0];
    if (!f) { setFile(null); return; }
    const reader = new FileReader();
    reader.onload = () => setFile({ name: f.name, contentBase64: String(reader.result ?? '') });
    reader.readAsDataURL(f);
  };

  const send = () => {
    if (!file) return;
    setResult(null);
    /* Only Public Bank sends an advice this system can read, so nobody is asked
       which acquirer — the server refuses any other by name. */
    upload.mutate({ acquirerCode: 'PBB', fileName: file.name, contentBase64: file.contentBase64 }, {
      onSuccess: (r) => {
        setFile(null);
        setResult({
          ok: true,
          text: `Read: ${fmt(r.status.netSen)} across ${r.status.days.length} settlement day(s).`
            + (r.status.readyToReceive
              ? ' Every day agrees — the bank credit will match itself.'
              : ` ${r.status.blockedBy ?? ''}`),
        });
      },
      onError: (err) => setResult({ ok: false, text: refusalText(err, 'The advice could not be read.') }),
    });
  };

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <div style={softText}>
          When Public Bank pays, it sends ONE payment advice (HOUZSCENTURY_IBG_&lt;date&gt;.pdf) covering
          several settlement days, and the bank statement shows one credit for its total. Upload the advice
          and each day is checked against the merchant report already here; once every day agrees, that
          credit books itself against those reports on the bank statement screen.
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept=".pdf" aria-label="Payment advice PDF"
            onChange={(e) => readFile(e.target.files)} style={{ fontSize: 'var(--fs-13)' }} />
          <button type="button" style={btn(true, !file || upload.isPending)}
            disabled={!file || upload.isPending} onClick={send}>
            <Upload {...ICON} /> {upload.isPending ? 'Reading…' : 'Upload payment advice'}
          </button>
        </div>
        {result && (
          <div style={{ fontSize: 'var(--fs-13)', color: result.ok ? good : danger, display: 'flex', gap: 6 }}>
            {!result.ok && <AlertTriangle {...ICON} />}
            <span>{result.text}</span>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <b>Advices received</b>
        {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
        {!q.isLoading && payouts.length === 0 && (
          <div style={softText}>
            None yet. Upload the advice that comes with Public Bank&apos;s payout and every settlement day
            it names is checked against the reports already reconciled.
          </div>
        )}
        {payouts.map((p) => (
          <AdviceCard key={p.id} payout={p} chargeAccounts={chargeAccounts}
            defaultAccount={Object.hasOwn(feeAccountByAcquirer, p.acquirer_code) ? feeAccountByAcquirer[p.acquirer_code] : null} />
        ))}
      </section>
    </div>
  );
};

/* ── One advice, and where each of its days stands ────────────────────────────
   Re-checked by the server on every read, not read back from upload time: a
   report uploaded since must count, and one re-opened since must block. */

const AdviceCard = ({ payout, chargeAccounts, defaultAccount }: {
  payout: Payout; chargeAccounts: ChargeAccount[]; defaultAccount: string | null;
}) => {
  const s = payout.status;
  const reportCount = new Set(s.days.map((d) => d.batchId).filter((id) => id != null)).size;

  return (
    <section style={panel(s.readyToReceive ? 'good' : 'plain')} className="space-y-2">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className={styles.codeChip}>{payout.acquirer_code}</span>
        <b style={{ wordBreak: 'break-all' }}>{payout.file_name}</b>
        <span>{payout.advice_date ?? 'no date on the advice'}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--fs-16, 15px)', fontWeight: 700 }}>{fmt(payout.net_sen)}</span>
      </div>

      {/* WHERE THE MONEY WENT, off the advice itself — a credit hunted for in
          the wrong bank account is invisible until the statement disagrees. */}
      <div style={softText}>
        Pays into {payout.payee_bank ?? 'a bank the advice does not name'}
        {payout.payee_account_no ? ` · account ${payout.payee_account_no}` : ''}
        {payout.uploaded_by ? ` · uploaded by ${payout.uploaded_by}` : ''}
      </div>

      {s.readyToReceive ? (
        <div style={{ fontSize: 'var(--fs-13)', color: good, fontWeight: 600 }}>
          Ready — when the bank statement shows this {fmt(s.netSen)} credit, it books against{' '}
          {reportCount} report{reportCount === 1 ? '' : 's'}.
        </div>
      ) : (
        /* ONE sentence, the server's own, naming the first thing in the way. */
        <div style={{ fontSize: 'var(--fs-13)', color: danger, display: 'flex', gap: 6 }}>
          <AlertTriangle {...ICON} />
          <span>{s.blockedBy ?? 'This advice names no settlement days.'}</span>
        </div>
      )}

      <table style={table}>
        <thead>
          <tr style={headRow}>
            <th style={cell}>Settled on</th>
            <th style={num}>Advice says</th>
            <th style={cell}>Merchant report</th>
            <th style={num}>Report nets</th>
            <th style={cell}>Standing</th>
          </tr>
        </thead>
        <tbody>
          {s.days.map((d) => (
            <tr key={d.settledOn} style={rowLine}>
              <td style={cell}>{d.settledOn}</td>
              <td style={num}>{fmt(d.adviceNetSen)}</td>
              <td style={cell}>{d.fileName ?? <span className={grid.sub}>—</span>}</td>
              <td style={num}>{d.reportNetSen == null ? '—' : fmt(d.reportNetSen)}</td>
              <td style={cell}>
                <DayStanding day={d} payoutId={payout.id} chargeAccounts={chargeAccounts} defaultAccount={defaultAccount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

const DayStanding = ({ day, payoutId, chargeAccounts, defaultAccount }: {
  day: PayoutDay; payoutId: number; chargeAccounts: ChargeAccount[]; defaultAccount: string | null;
}) => {
  const undo = useUndoPayoutCharge();
  const [asking, setAsking] = useState(false);
  switch (day.state) {
    case 'AGREES':
      /* A day that agrees BECAUSE a charge was booked says so, with the money
         and where it went — and can be undone from here (docs/bugs/0787). */
      return day.chargeSen > 0 ? (
        <span className={grid.good}>
          agrees · bank charge {fmt(day.chargeSen)} → {day.chargeAccountCode ?? '?'}
          {day.chargeNote ? <span className={grid.sub}> ({day.chargeNote})</span> : null}
          {' '}
          <button type="button" style={linkBtn} disabled={undo.isPending}
            onClick={() => undo.mutate({ payoutId, settledOn: day.settledOn })}>
            {undo.isPending ? 'Undoing…' : 'Undo'}
          </button>
        </span>
      ) : <span className={grid.good}>agrees</span>;
    case 'DIFFERS': {
      /* BOTH numbers are already on the row; the finding is their distance.
         When the bank paid LESS than the report, that distance may be a charge
         it deducted — offered here, on the day, booked to the account Finance
         picks (owner 2026-09-10: 可以让我点了后选这笔进什么户口吗). */
      const short = day.differenceSen != null && day.differenceSen > 0 && day.chargeSen === 0;
      return (
        <span>
          <span className={grid.bad}>differs by {fmt(Math.abs(day.differenceSen ?? 0))}</span>
          {short && !asking && (
            <button type="button" style={linkBtn} onClick={() => setAsking(true)}>Bank deducted a charge</button>
          )}
          {short && asking && (
            <ChargeForm payoutId={payoutId} day={day} chargeAccounts={chargeAccounts}
              defaultAccount={defaultAccount} onClose={() => setAsking(false)} />
          )}
        </span>
      );
    }
    case 'REPORT_MISSING':
      return <span style={{ color: danger }}>no report uploaded for this day</span>;
    case 'REPORT_NOT_RECONCILED':
      return (
        <span style={{ color: danger }}>
          {day.reportOpenLines ?? '?'} line(s) still to decide
        </span>
      );
  }
};

const linkBtn: React.CSSProperties = {
  marginLeft: 8, border: '1px solid var(--c-line, rgba(34,31,32,0.3))', background: 'none',
  borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 'var(--fs-12)', fontWeight: 600,
};

/* The ask: how much the bank deducted (the whole difference unless told
   otherwise), which account it goes to (Finance's choice, starting on the
   acquirer's fee account), and what it was for (required — the corrections
   report prints it). Every refusal is the server's own sentence. */
const ChargeForm = ({ payoutId, day, chargeAccounts, defaultAccount, onClose }: {
  payoutId: number; day: PayoutDay; chargeAccounts: ChargeAccount[]; defaultAccount: string | null; onClose: () => void;
}) => {
  const post = usePostPayoutCharge();
  const difference = Math.max(0, day.differenceSen ?? 0);
  const [amount, setAmount] = useState((difference / 100).toFixed(2));
  const [account, setAccount] = useState(defaultAccount ?? (chargeAccounts.length > 0 ? chargeAccounts[0].accountCode : ''));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const amountSen = Math.round(Number(amount) * 100);
  const ready = Number.isFinite(amountSen) && amountSen > 0 && account !== '' && note.trim() !== '';
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginLeft: 8 }}>
      <input aria-label="Charge amount" value={amount} onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal" style={{ width: 90, fontSize: 'var(--fs-12)', padding: '2px 6px' }} />
      <select aria-label="Charge account" value={account} onChange={(e) => setAccount(e.target.value)}
        style={{ fontSize: 'var(--fs-12)', padding: '2px 6px', maxWidth: 220 }}>
        {chargeAccounts.map((a) => <option key={a.accountCode} value={a.accountCode}>{a.accountCode} · {a.accountName}</option>)}
      </select>
      <input aria-label="What the bank deducted this for" value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="PBB card-terminal application fee" style={{ width: 220, fontSize: 'var(--fs-12)', padding: '2px 6px' }} />
      <button type="button" style={btn(true, !ready || post.isPending)} disabled={!ready || post.isPending}
        onClick={() => post.mutate(
          { payoutId, settledOn: day.settledOn, amountSen, accountCode: account, note: note.trim() },
          { onSuccess: onClose, onError: (e) => setError(refusalText(e, 'The charge could not be booked.')) },
        )}>
        {post.isPending ? 'Booking…' : 'Book charge'}
      </button>
      <button type="button" style={linkBtn} onClick={onClose}>Cancel</button>
      {error && <span style={{ color: danger, fontSize: 'var(--fs-12)' }}>{error}</span>}
    </span>
  );
};
