/* Where a delivery return's credit note stands (backlog A1) — the server works
   it out from the notes actually linked (backend scm/lib/cn-from-return.ts);
   desktop and phone read the same words from here. */

export type ReturnCreditState = 'NOT_INVOICED' | 'AWAITING' | 'DRAFTED' | 'ISSUED' | 'UNKNOWN';

export const RETURN_CREDIT_LABEL: Record<ReturnCreditState, string> = {
  NOT_INVOICED: 'No credit note needed — never invoiced',
  AWAITING: 'Awaiting credit note',
  DRAFTED: 'Credit note drafted',
  ISSUED: 'Credit note issued',
  UNKNOWN: 'Credit note status could not be read',
};

/** The badge tone each state shows in. */
export const RETURN_CREDIT_TONE: Record<ReturnCreditState, 'warning' | 'success' | 'neutral' | 'error'> = {
  NOT_INVOICED: 'neutral', AWAITING: 'warning', DRAFTED: 'neutral', ISSUED: 'success', UNKNOWN: 'error',
};

export const returnCreditLabel = (state: unknown): string =>
  typeof state === 'string' && Object.prototype.hasOwnProperty.call(RETURN_CREDIT_LABEL, state) ? RETURN_CREDIT_LABEL[state as ReturnCreditState] : '';
