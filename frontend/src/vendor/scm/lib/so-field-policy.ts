
export type SoFieldClass = 'FREE' | 'CONTROLLED' | 'DERIVED';

export type SoHeaderFieldPolicy = {
  column: string;
  payloadKey: string;
  label: string;
  cls: SoFieldClass;
  reason: string;
};

export const SO_HEADER_FIELD_POLICY: readonly SoHeaderFieldPolicy[] = [
  {
    column: 'processing_date',
    payloadKey: 'processingDate',
    label: 'Processing Date',
    cls: 'CONTROLLED',
    reason: 'The lock boundary itself, and the date the supplier works to.',
  },
  {
    column: 'customer_delivery_date',
    payloadKey: 'customerDeliveryDate',
    label: 'Delivery Date',
    cls: 'CONTROLLED',
    reason: 'What the customer was promised and what the supplier schedules to.',
  },
  {
    column: 'customer_state',
    payloadKey: 'customerState',
    label: 'State',
    cls: 'CONTROLLED',
    reason: 'Resolves each line\'s warehouse and the delivery region. The PO ships from it.',
  },
  {
    column: 'sales_location',
    payloadKey: 'salesLocation',
    label: 'Sales Location',
    cls: 'DERIVED',
    reason: 'Derived from State; re-derived server-side. Callers must omit it.',
  },
  {
    column: 'postcode',
    payloadKey: 'postcode',
    label: 'Postcode',
    cls: 'CONTROLLED',
    reason: 'Printed on the supplier PO as the delivery destination. Resolves nothing.',
  },
  {
    column: 'city',
    payloadKey: 'city',
    label: 'City',
    cls: 'CONTROLLED',
    reason: 'Same as Postcode: part of the PO delivery destination.',
  },
  /* Two-lane rework phase 2 (owner 2026-07-27): the delivery-address block +
     disposal note are Logistics-approved amendment fields (DELIVERY lane). */
  {
    column: 'address1',
    payloadKey: 'address1',
    label: 'Address line 1',
    cls: 'CONTROLLED',
    reason: 'The delivery address the trip is planned to — moves by Logistics-approved amendment.',
  },
  {
    column: 'address2',
    payloadKey: 'address2',
    label: 'Address line 2',
    cls: 'CONTROLLED',
    reason: 'Same as Address line 1 — one address, one rule.',
  },
  {
    column: 'address3',
    payloadKey: 'address3',
    label: 'Address line 3',
    cls: 'CONTROLLED',
    reason: 'Same as Address line 1 — one address, one rule.',
  },
  {
    column: 'address4',
    payloadKey: 'address4',
    label: 'Address line 4',
    cls: 'CONTROLLED',
    reason: 'Same as Address line 1 — and legacy rows double it as the postcode.',
  },
  {
    column: 'ship_to_address',
    payloadKey: 'shipToAddress',
    label: 'Ship-to address',
    cls: 'CONTROLLED',
    reason: 'Free-text destination on supplier-facing paperwork — the Postcode rationale.',
  },
  {
    column: 'bill_to_address',
    payloadKey: 'billToAddress',
    label: 'Bill-to address',
    cls: 'CONTROLLED',
    reason: 'Moves with its sibling ship/install addresses through one channel.',
  },
  {
    column: 'install_to_address',
    payloadKey: 'installToAddress',
    label: 'Install-to address',
    cls: 'CONTROLLED',
    reason: 'Same as Ship-to address — where the crew actually goes.',
  },
  {
    column: 'replacement_disposal',
    payloadKey: 'replacementDisposal',
    label: 'Replacement / disposal',
    cls: 'CONTROLLED',
    reason: 'The disposal add-on — changes the delivery job. Logistics\' own Delivery Planning drawer still writes it directly (they are the lane approver).',
  },
  /* Customer info (owner 2026-08-21) — name / phone / email join CONTROLLED and
     ride the DELIVERY lane. Partial reversal of the 2026-07-17 "contact details
     stay free" ruling; emergency contacts / customer type / note remain FREE. */
  {
    column: 'debtor_name',
    payloadKey: 'debtorName',
    label: 'Customer name',
    cls: 'CONTROLLED',
    reason: 'Owner 2026-08-21: customer-info changes on a locked SO are a Logistics-approved amendment. NOT NULL — the create route refuses a blank requested name.',
  },
  {
    column: 'phone',
    payloadKey: 'phone',
    label: 'Phone',
    cls: 'CONTROLLED',
    reason: 'Owner 2026-08-21: rides the DELIVERY-lane amendment with Customer name.',
  },
  {
    column: 'email',
    payloadKey: 'email',
    label: 'Email',
    cls: 'CONTROLLED',
    reason: 'Owner 2026-08-21: completes the customer-contact block — one channel once locked.',
  },
];

/** payloadKeys an amendment may carry, in table order. */
export const soAmendableHeaderKeys = (): string[] =>
  SO_HEADER_FIELD_POLICY.filter((f) => f.cls === 'CONTROLLED').map((f) => f.payloadKey);

/** Columns the server freezes on a processing-locked header PATCH. */
export const soProcessingLockColumns = (): Set<string> =>
  new Set(SO_HEADER_FIELD_POLICY.map((f) => f.column));

/** Classify a payload key. 'FREE' for anything absent from the table — the
    documented default, not a lookup miss. */
export const soHeaderFieldClass = (payloadKey: string): SoFieldClass => {
  const hit = SO_HEADER_FIELD_POLICY.find((f) => f.payloadKey === payloadKey);
  return hit ? hit.cls : 'FREE';
};

/* ── Payments ──────────────────────────────────────────────────────────────
   Owner 2026-07-17: ADDING a payment is FREE — money arrives over time and it
   must be recordable at any point, including after delivery.

   Owner 2026-07-19: a payment row may be EDITED or DELETED only on the day it
   was keyed in ("删除只有在当天才行 ... 当天都可以任意更改"). Same-day entries
   are still fluid because nothing has locked yet; from the next day, no.

   Owner + management 2026-09-10: FINANCE may correct one after that day, and
   the deferred bank-reconciliation condition has landed with it — a payment
   that has already been RECONCILED is closed to everybody, Finance included.
   The client cannot SEE a reconciliation (it lives in the settlement and bank
   tables), so it never passes one: it offers the control on the strength of
   the permission alone and the endpoint refuses if the books have closed.

   "Same day" keys off the row's CREATION time, not the payment date on the
   document — otherwise editing an old payment's date to today would unlock its
   own deletion. The boundary is MYT midnight; use isCreatedTodayMyt/todayMyt
   from vendor/scm/lib/dates, never a raw UTC date slice.

   The delete/edit CONTROLS must be genuinely ABSENT once the window closes,
   not disabled and not CSS-hidden ("off, not hide"). The server refuses too —
   the missing button is the courtesy, the endpoint is the control.

   Full rationale lives in the backend copy of this file. */

export type PaymentMutationKind = 'ADD' | 'EDIT' | 'DELETE';

export type PaymentRowMutability = {
  mutable: boolean;
  problem: string | null;
  via: PaymentChangeVia;
};

export type PaymentChangeVia = 'draft' | 'same_day' | 'amend' | null;

/** WHAT has already reconciled a payment, when something has. Three kinds,
    because there are three genuinely different places the books can have
    closed over it, and an operator told only "it is reconciled" cannot go and
    look at the one that did. */
export type PaymentReconciledBy =
  | { kind: 'merchant'; on: string }
  | { kind: 'bank'; jeNo: string }
  | { kind: 'month'; accountCode: string; month: string };

export type PaymentAmendContext = {
  mayAmend?: boolean;
  reconciled?: PaymentReconciledBy | null;
};

/** Why a reconciled payment is closed, naming the reconciliation so it can be
    found, and saying what to do instead. Same constraints as the message
    below: plain language, no braces, no error codes, short enough to survive
    the client's humanApiError sentence filter. */
export const paymentReconciledMessage = (by: PaymentReconciledBy): string => {
  /* UNDER 200 CHARACTERS WITH THE DATE, ENTRY OR ACCOUNT INSIDE — the client's
     sentence filter (authed-fetch.ts, isPlain) drops anything longer, and at
     209–219 all three of these were dropped and the operator saw the generic
     "That clashes with something already in the system" (docs/bugs/0821).
     Each names what to undo first, because that IS the way to change it. */
  const what =
    by.kind === 'merchant' ? `it was confirmed on a merchant settlement report on ${by.on}. Undo that confirmation first`
    : by.kind === 'bank' ? `its entry ${by.jeNo} is matched on a bank statement. Undo that bank match first`
    : `the ${by.month} bank reconciliation for ${by.accountCode} is closed. Reopen that month first`;
  return `This payment is locked: ${what}, or record a new payment.`;
};

/** Why the control is gone. Operators must be told, not left guessing. */
export const PAYMENT_WINDOW_CLOSED_MESSAGE =
  'This payment can only be changed or removed on the day it was keyed in. That day has passed, '
  + 'so it is now locked. Record a new payment instead, or ask Finance to adjust it.';

export const PAYMENT_WINDOW_CLOSED_ERROR = 'payment_edit_locked';

/**
 * The single predicate behind "may this recorded payment still be changed".
 * Server and both clients call this; nothing else decides.
 *
 * Both dates are required strings — no `?? ''` fallback, because an unreadable
 * created_at is an error to surface rather than a value to default into a
 * silent deny or a silent allow.
 *
 * `who` carries the two facts the dates cannot answer: whether the caller may
 * amend, and what has already reconciled the row. Order matters — see the
 * backend copy, which spells out why RECONCILED beats both the permission and
 * the same-day window.
 */
export const paymentRowMutable = (
  createdDateMyt: string,
  todayDateMyt: string,
  soIsDraft: boolean,
  who: PaymentAmendContext = {},
): PaymentRowMutability => {
  if (soIsDraft) return { mutable: true, problem: null, via: 'draft' };
  if (who.reconciled) return { mutable: false, problem: paymentReconciledMessage(who.reconciled), via: null };
  if (createdDateMyt === todayDateMyt) return { mutable: true, problem: null, via: 'same_day' };
  if (who.mayAmend === true) return { mutable: true, problem: null, via: 'amend' };
  return {
    mutable: false,
    problem: PAYMENT_WINDOW_CLOSED_MESSAGE,
    via: null,
  };
};

