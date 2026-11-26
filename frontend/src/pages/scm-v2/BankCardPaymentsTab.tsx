// ----------------------------------------------------------------------------
// BankCardPaymentsTab — Bank Recon's "Card payments" tab: the card payments no
// merchant report has carried (the list Merchant Recon shows), to tick with the
// movement that paid them in.
//
// Owner 2026-11-17, on Houzs's RM 26,308.81 for 2990's swipes on its AEON
// terminal: 「我在bank recon时可以选刷卡的transaction，然后差额就直接去terminal
// charges」. Tick the movement under To choose / No entry found, its transfers
// under Not on the bank yet and the swipes here; the bar at the foot then names
// the difference and where it goes (bank-card-pick).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { cardPaymentKey, type BankCardPayment } from './bank-queries';
import { useReconcilePick } from './bank-reconcile-pick';
import { EntryDocument } from './bank-entry-doc';
import { fmt } from './settlement-ui';
import { fmtDateOrDash } from '../../vendor/shared/format';
import look from './BankStatements.module.css';
import grid from './MerchantRecon.module.css';

const matches = (p: BankCardPayment, needle: string): boolean =>
  [p.docNo, p.customerName, p.approvalCode, p.acquirerCode, (p.amountSen / 100).toFixed(2)]
    .some((v) => String(v ?? '').toLowerCase().includes(needle));

export function BankCardPaymentsTab({ cards }: { cards: BankCardPayment[] }) {
  const pick = useReconcilePick();
  const [find, setFind] = useState('');
  const needle = find.trim().toLowerCase();
  const shown = needle === '' ? cards : cards.filter((p) => matches(p, needle) || pick.pickedCards.includes(cardPaymentKey(p)));
  return (
    <div className={look.section}>
      <input type="search" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a card payment"
        placeholder="Find by document, customer, approval code or amount"
        style={{ maxWidth: 360, padding: '4px 8px', border: '1px solid var(--hz-c-border, #d9d6cf)', borderRadius: 6, fontSize: 13 }} />
      <table className={grid.grid}>
        <thead>
          <tr>
            <th /><th>Paid on</th><th>Document</th><th>Customer</th><th>Merchant</th><th>Approval</th>
            <th className={grid.num}>Amount</th><th className={grid.num}>Days</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => {
            const key = cardPaymentKey(p);
            const on = pick.pickedCards.includes(key);
            return (
              <tr key={key} className={on ? look.picked : undefined}>
                <td><input type="checkbox" checked={on} onChange={() => pick.toggleCard(key)} aria-label={`Card payment ${p.docNo} for the picked movement`} /></td>
                <td className={look.dateCell}>{fmtDateOrDash(p.paidOn)}</td>
                <td><b><EntryDocument text={p.docNo} /></b></td>
                <td>{p.customerName ?? '—'}</td>
                <td>{p.acquirerCode ?? 'Untagged'}</td>
                <td>{p.approvalCode ?? '—'}</td>
                <td className={grid.num}>{fmt(p.amountSen)}</td>
                <td className={grid.num}>{p.ageDays}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shown.length === 0 && <div className={look.emptyTab}>No card payment matches “{find}”.</div>}
    </div>
  );
}
