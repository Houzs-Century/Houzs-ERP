/* ----------------------------------------------------------------------------
   new-so-backdate — a payment keyed on the NEW Sales Order screen whose slip is
   more than 14 days old (owner 2026-10-01: 「开新SO的付款也改成可以申请」).

   Until now such a row blocked the save outright. Now it rides the order to the
   same place the payments panel sends it: the order is created, then the row is
   posted to POST /:docNo/payment-backdate-requests instead of /payments, with
   ONE reason asked before the save. It is not booked and not counted toward the
   create-time deposit gate — an admin's approval books it later.

   ONE module for both surfaces (desktop SalesOrderNew, phone MobileNewSO): the
   selector, the ask, the post and the notice live here, so the two cannot
   disagree about which rows go where. A receipt-backed deposit (a scanned card
   receipt, carried in the create body) is not requestable and keeps its refusal.
   ---------------------------------------------------------------------------- */
import { authedFetch } from './authed-fetch';
import { todayMyt } from './dates';
import { BACKDATE_REASON_ASK, slipDateNeedsRequest } from './payment-backdate-queries';
import { CONVERT_LABEL } from './so-money-queries';
import { draftMethodFields, labelToApi, type PaymentDraft } from '../components/PaymentsTable';

export { REQUEST_HINT } from './payment-backdate-queries';

/** True for a payment row the new-order screens send as a request. */
export function isBackdateRequestRow(
  row: { paidAt: string | null | undefined; methodLabel: string; receiptBacked: boolean },
  mayBackdate: boolean,
): boolean {
  if (row.receiptBacked || row.methodLabel === CONVERT_LABEL) return false;
  return slipDateNeedsRequest(row.paidAt, todayMyt(), mayBackdate);
}

type PromptFn = (opts: typeof BACKDATE_REASON_ASK) => Promise<string | null>;

/** Ask the one reason before the save. '' when no row needs it; null when the
 *  operator dismissed the ask — the caller then does not save. */
export async function askNewSoBackdateReason(prompt: PromptFn, requestCount: number): Promise<string | null> {
  if (requestCount === 0) return '';
  const answer = await prompt({
    ...BACKDATE_REASON_ASK,
    body: `${requestCount} payment${requestCount === 1 ? ' has a slip' : 's have slips'} older than 14 days. `
      + 'The order is saved now; an admin has to approve before the payment is recorded.',
    confirmLabel: 'Save & send request',
  });
  return answer ? answer : null;
}

/** The desktop draft row as the payments route's body (the request route takes the same). */
export function draftRequestBody(d: PaymentDraft): Record<string, unknown> {
  const { method } = labelToApi(d.methodLabel);
  return {
    paidAt: d.paidAt,
    method,
    amountSen: d.amountSen,
    accountSheet: d.accountSheet || null,
    approvalCode: d.approvalCode || null,
    collectedBy: d.collectedBy || null,
    uploadSessionId: d.slipUploadSessionId,
    ...draftMethodFields(method, d),
  };
}

type NotifyFn = (opts: { title: string; body?: string; tone?: 'info' | 'error' }) => unknown;

/** Post each row as a backdate request on the created order and say what happened. */
export async function sendNewSoBackdateRequests(
  docNo: string,
  bodies: Array<Record<string, unknown>>,
  reason: string,
  notify: NotifyFn,
): Promise<void> {
  if (bodies.length === 0) return;
  let failed = 0;
  let firstError = '';
  for (const body of bodies) {
    try {
      await authedFetch(`/mfg-sales-orders/${encodeURIComponent(docNo)}/payment-backdate-requests`, {
        method: 'POST', body: JSON.stringify({ ...body, reason }),
      });
    } catch (e) {
      failed += 1;
      if (!firstError && e instanceof Error && e.message) firstError = e.message;
    }
  }
  const sent = bodies.length - failed;
  await notify(failed === 0
    ? { title: `${sent} payment${sent === 1 ? '' : 's'} sent for admin approval`, body: `${docNo} is saved. The payment is recorded once an admin approves it.` }
    : { title: `${failed} of ${bodies.length} approval request${bodies.length === 1 ? '' : 's'} not sent`, body: `${firstError ? `${firstError} ` : ''}Key the payment again on ${docNo} and press Request approval.`, tone: 'error' });
}
