// ----------------------------------------------------------------------------
// ReceiptsCheck — the month's official receipts against its customer payments,
// above the Receipts list while a month is picked (owner 2026-09-16: or 我如何
// 查看 amount 是对的; restyled to the owner's Claude Design, batch 5 §2.1): the
// payments, minus the receipts, equals the difference — green when clean — and
// every row behind a difference with its step: a payment without a receipt
// (Issue receipt), a receipt whose amount is not its payment's, a receipt whose
// payment is gone (Open).
// ----------------------------------------------------------------------------

import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import type { ReceiptsCheck as Check } from './moneyInDocQueries';
import { methodWord } from './moneyInStatus';
import { monthName } from './receiptsModel';
import ui from '../MoneyIn.module.css';

export function ReceiptsCheck({ month, check, loading, error, issuing, onIssue, openOf, onOpen }: {
  month: string;
  check: Check | undefined;
  loading: boolean;
  error: string | null;
  /** The payment whose receipt is being issued. */
  issuing: string | null;
  onIssue: (p: Check['missing'][number]) => void;
  /** The receipt's id by its number — null when it is not on the list. */
  openOf: (orNumber: string) => string | null;
  onOpen: (id: string) => void;
}) {
  const title = `${monthName(month)} · official receipts`;
  if (loading) return <section className={ui.check} aria-label="Receipts check"><span className={ui.checkTitle}>{title}</span><span className={ui.hint}>Checking the month…</span></section>;
  if (error || !check) {
    return (
      <section className={ui.check} aria-label="Receipts check">
        <span className={ui.checkTitle}>{title}</span>
        <span className={`${ui.hint} ${ui.checkBad}`} role="alert">The check did not load{error ? ` — ${error}` : ''}.</span>
      </section>
    );
  }
  const toFix = check.missing.length + check.mismatched.length + check.orphans.length;
  const clean = toFix === 0 && check.diffSen === 0;
  const tone = clean ? ui.checkGood : ui.checkBad;
  const openButton = (orNumber: string) => {
    const id = openOf(orNumber);
    return id ? <button type="button" className={ui.checkAct} onClick={() => onOpen(id)}>Open ›</button> : null;
  };
  return (
    <section className={ui.check} aria-label="Receipts check">
      <div className={ui.checkHead}>
        <span className={ui.checkTitle}>{title}</span>
        <div className={ui.checkFig}>
          <div><div className={ui.checkLabel}>Customer payments · {check.payments.count}</div><div className={ui.checkValue}>{fmtSen(check.payments.totalSen)}</div></div>
        </div>
        <div className={ui.checkFig}>
          <span className={ui.checkOp}>−</span>
          <div><div className={ui.checkLabel}>Official receipts · {check.receipts.count}</div><div className={ui.checkValue}>{fmtSen(check.receipts.totalSen)}</div></div>
        </div>
        <div className={ui.checkFig}>
          <span className={ui.checkOp}>=</span>
          <div><div className={ui.checkLabel}>Difference</div><div className={`${ui.checkValue} ${tone}`}>{fmtSen(check.diffSen)}</div></div>
        </div>
        <span className={ui.grow} />
        <span className={`${ui.checkState} ${tone}`}>
          {clean ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          {clean ? 'Every payment has its receipt, for its own amount' : `${toFix} to fix`}
        </span>
      </div>
      {check.missing.length > 0 && (
        <div className={ui.checkGroup}>
          <div className={ui.checkGroupTitle}>Payments without a receipt ({check.missing.length})</div>
          {check.missing.map((p) => (
            <div key={`${p.source}:${p.paymentId}`} className={ui.checkRow}>
              <span className={ui.checkRowText}>{fmtDate(p.paidAt)} · {p.docNo ?? p.paymentId} · {methodWord(p.method)} · {fmtSen(p.amountSen)}</span>
              <button type="button" className={ui.checkAct} disabled={issuing != null} onClick={() => onIssue(p)}>
                {issuing === `${p.source}:${p.paymentId}` ? 'Issuing…' : 'Issue receipt ›'}
              </button>
            </div>
          ))}
        </div>
      )}
      {check.mismatched.length > 0 && (
        <div className={ui.checkGroup}>
          <div className={ui.checkGroupTitle}>Receipts whose amount is not the payment’s ({check.mismatched.length})</div>
          {check.mismatched.map((m) => (
            <div key={m.orNumber} className={ui.checkRow}>
              <span className={ui.checkRowText}>{m.orNumber} · {m.docNo ?? m.paymentId} · receipt {fmtSen(m.receiptSen)} · payment {fmtSen(m.paymentSen)}</span>
              {openButton(m.orNumber)}
            </div>
          ))}
        </div>
      )}
      {check.orphans.length > 0 && (
        <div className={ui.checkGroup}>
          <div className={ui.checkGroupTitle}>Receipts whose payment is gone ({check.orphans.length})</div>
          {check.orphans.map((o) => (
            <div key={o.orNumber} className={ui.checkRow}>
              <span className={ui.checkRowText}>{o.orNumber} · {o.docNo ?? '—'} · {fmtDate(o.paidAt)} · {fmtSen(o.amountSen)}</span>
              {openButton(o.orNumber)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
