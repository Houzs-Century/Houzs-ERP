import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// siPaymentIntent — the URL contract that carries "open the payment editor"
// from the Sales Invoice LIST to the Sales Invoice DETAIL screen.
//
// WHY A SHARED MODULE FOR ONE QUERY PARAM. Because the last one was written on
// only one side and nobody could tell. The list navigated to
// `?tab=payments&record=1` and NOTHING in the app ever read `tab` or `record` on
// a sales invoice — `SalesInvoiceDetailV2` calls `useSearchParams()` and never
// calls `.get()` at all. So "Record payment" on the list opened the invoice and
// then sat there: the button did nothing, which is the single worst shape a bug
// takes here (CLAUDE.md: a failure that reaches nobody). A param written by one
// file and read by another, with no shared definition, is unfalsifiable — there
// is nothing a test can hold. This module IS the thing a test can hold.
//
// WHY THE LIST DELEGATES AT ALL. The amount has to be decided on the screen
// that can tell "the order collected nothing" from "we could not read the
// order". `GET /sales-invoices/:id` answers that with `orderDepositUnavailable`;
// the LIST rows carry only `so_deposit_applied_sen`, and
// `siDepositAppliedSen` reads absent/null as 0 — deliberately, because for a
// DISPLAYED figure over-stating what is owed is the safe direction. For a figure
// that is about to be BOOKED AS CASH it is the dangerous one: the outstanding
// would fall back to the full total and Mark paid would record the customer's
// deposit a second time. So the list never computes a receipt; it hands the
// intent to the detail screen and the detail screen computes it (markPaidPlan).

/**
 * `open`    — show the payments editor as it is (the list's "Record payment").
 * `balance` — show it with one row pre-filled at the outstanding balance
 *             (the list's "Mark paid"). The AMOUNT is not carried in the URL:
 *             a figure in a link is a figure nobody re-checks, and this one is
 *             money. The detail screen recomputes it.
 */
export type SiPaymentIntent = 'open' | 'balance';

const PARAM = 'pay';

const VALUES: Record<string, SiPaymentIntent> = { open: 'open', balance: 'balance' };

/** The search string to navigate WITH, including the leading `?`. */
export function siPaymentIntentSearch(intent: SiPaymentIntent): string {
  const p = new URLSearchParams();
  p.set(PARAM, intent);
  return `?${p.toString()}`;
}

/** What the detail screen should do, or `null` for an ordinary visit. */
export function readSiPaymentIntent(search: string): SiPaymentIntent | null {
  const raw = new URLSearchParams(search).get(PARAM);
  return raw ? (VALUES[raw] ?? null) : null;
}

/**
 * The same search string with the intent removed, for the `replace` navigation
 * that consumes it.
 *
 * An intent is an ACTION, not a view — leaving it in the address bar means a
 * refresh (or a back-button) re-opens the editor and re-seeds a payment row the
 * operator may already have decided against. Every other query param on the URL
 * survives.
 */
export function stripSiPaymentIntent(search: string): string {
  const p = new URLSearchParams(search);
  p.delete(PARAM);
  const rest = p.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Act on the intent in the URL, exactly once per invoice, then strip it.
 *
 * Lives here rather than in the page for two reasons: `SalesInvoiceDetailV2` is
 * a few lines under the 2,000-line cap and may not grow into it, and — the one
 * that matters — the WRITER and the READER of this param are now the same
 * module, so a test can hold both ends. The param this replaces was written in
 * one file, read in none, and no test could have noticed.
 *
 * `ready` gates on the payments query, because both callbacks seed the editor
 * from the persisted rows: firing before they land would open an editor missing
 * the payments already on the invoice.
 */
export function useSiPaymentIntent(args: {
  invoiceId: string | null;
  ready: boolean;
  onOpen: () => void;
  onBalance: () => void;
}): void {
  const navigate = useNavigate();
  const location = useLocation();
  const doneFor = useRef<string | null>(null);
  /* The callbacks are re-created every render and are deliberately NOT in a
     dependency array; `doneFor` is what makes this run once. */
  useEffect(() => {
    const { invoiceId, ready, onOpen, onBalance } = args;
    if (!invoiceId || !ready || doneFor.current === invoiceId) return;
    const intent = readSiPaymentIntent(location.search);
    if (!intent) return;
    doneFor.current = invoiceId;
    navigate(
      { pathname: location.pathname, search: stripSiPaymentIntent(location.search), hash: location.hash },
      { replace: true, state: location.state },
    );
    if (intent === 'balance') onBalance();
    else onOpen();
  });
}
