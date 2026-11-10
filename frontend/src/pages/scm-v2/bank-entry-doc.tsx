// ----------------------------------------------------------------------------
// bank-entry-doc — an entry's document on the bank reconciliation, its orders one
// click away (owner 2026-11-10, 2990 October, Not on the bank yet: 我希望这里也可以
// 点开so, 点开后也可以返回这里). The text is the server's (acc/journal-refs: a
// customer's payment reads "OR · SO", money moved off a cancelled order "SO ← SO");
// each order number in it is a FinanceDocLink — its own tab of the in-app strip,
// the order's Back returning here — as Merchant Recon's are. A plain click notes
// where the page was scrolled and what it had ticked, so the way back lands on
// the page as it was. The receipt, the voucher and anything else stay text.
// ----------------------------------------------------------------------------

import { Fragment, useContext } from 'react';
import { rememberReturnScroll } from '../../lib/returnScroll';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { ReconcilePickContext } from './bank-reconcile-pick';
import type { LedgerEntry } from './bank-queries';

/** A sales order number: HC-SO-2608-001, 2990-SO-2609-016, HC-SO-013512. */
const ORDER_NO = /^[A-Z0-9]+-SO-\d[\d-]*$/;

/** The document text, cut where the server joined its parts, each part saying whether it is an order. */
export const orderLinkParts = (text: string): Array<{ text: string; order: boolean }> =>
  text.split(/( · | ← )/).filter((t) => t !== '').map((t) => ({ text: t, order: ORDER_NO.test(t) }));

/** What the entry is, in the words a person holds: its reference, else its source and document. */
export const entryDocText = (e: Pick<LedgerEntry, 'sourceType' | 'sourceDocNo'> & { reference?: string | null }): string =>
  e.reference ?? ([e.sourceType, e.sourceDocNo].filter(Boolean).join(' · ') || '—');

export function EntryDocument({ text }: { text: string }) {
  const pick = useContext(ReconcilePickContext);
  const onOpen = () => {
    rememberReturnScroll();
    pick?.keepForReturn();
  };
  return (
    <>
      {orderLinkParts(text).map((p, i) => (p.order
        ? <FinanceDocLink key={i} to={`/scm/sales-orders/${encodeURIComponent(p.text)}`} onOpen={onOpen}>{p.text}</FinanceDocLink>
        : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  );
}
