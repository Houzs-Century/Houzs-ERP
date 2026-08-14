// ----------------------------------------------------------------------------
// so-field-policy (frontend vendored copy) — THE single source of truth for
// "what can be edited on a processing-locked Sales Order, and does Save write
// it or raise an amendment".
//
// THIS FILE IS A VENDORED MIRROR of backend/src/scm/shared/so-field-policy.ts.
// The two builds are separate TypeScript projects with no shared import path
// (that is what frontend/src/vendor/scm IS — the vendoring boundary), so the
// table is physically duplicated. It is NOT duplicated in the sense that
// matters: so-field-policy.test.ts reads the backend file off disk and fails
// the frontend CI job if a single policy row differs. Edit the backend table,
// then mirror it here; the test tells you if you forgot.
//
// Read the backend file for the full rationale. The short version:
//   * FREE       — Save writes straight to the database, no gate. Audited.
//   * CONTROLLED — Save raises an AMENDMENT for approval instead.
//   * DERIVED    — frozen like CONTROLLED but recomputed server-side, so the
//                  client must OMIT it rather than send it.
//
// Owner's test for which is which: does the field change what gets DELIVERED or
// what gets CHARGED? Contact details are not that.
// ----------------------------------------------------------------------------

export type SoFieldClass = 'FREE' | 'CONTROLLED' | 'DERIVED';

export type SoHeaderFieldPolicy = {
  column: string;
  payloadKey: string;
  label: string;
  cls: SoFieldClass;
  reason: string;
};

/* MIRROR of the backend table — column / payloadKey / label / cls must match
   row-for-row and in order. `reason` is prose and is NOT drift-tested. */
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

   "Same day" keys off the row's CREATION time, not the payment date on the
   document — otherwise editing an old payment's date to today would unlock its
   own deletion. The boundary is MYT midnight; use isCreatedTodayMyt/todayMyt
   from vendor/scm/lib/dates, never a raw UTC date slice.

   The delete/edit CONTROLS must be genuinely ABSENT once the window closes,
   not disabled and not CSS-hidden ("off, not hide"). The server refuses too —
   the missing button is the courtesy, the endpoint is the control.

   Full rationale, and where the deferred bank-reconciliation condition will
   go, live in the backend copy of this file. */

export type PaymentMutationKind = 'ADD' | 'EDIT' | 'DELETE';

export type PaymentRowMutability = {
  mutable: boolean;
  /** Plain-language reason when it may not — shown verbatim. null when it may. */
  problem: string | null;
};

/** Why the control is gone. Operators must be told, not left guessing. */
export const PAYMENT_WINDOW_CLOSED_MESSAGE =
  'This payment can only be changed or removed on the day it was keyed in. That day has passed, '
  + 'so it is now locked. Record a new payment instead, or ask the office to adjust it.';

export const PAYMENT_WINDOW_CLOSED_ERROR = 'payment_edit_locked';

/**
 * The single predicate behind "may this recorded payment still be changed".
 * Server and both clients call this; nothing else decides.
 *
 * Both dates are required strings — no `?? ''` fallback, because an unreadable
 * created_at is an error to surface rather than a value to default into a
 * silent deny or a silent allow.
 */
export const paymentRowMutable = (
  createdDateMyt: string,
  todayDateMyt: string,
  soIsDraft: boolean,
): PaymentRowMutability => {
  if (soIsDraft) return { mutable: true, problem: null };
  if (createdDateMyt === todayDateMyt) return { mutable: true, problem: null };
  return { mutable: false, problem: PAYMENT_WINDOW_CLOSED_MESSAGE };
};

/* ── Delivery-address staleness — NARROWED 2026-07-27 ──────────────────────
   The address block (address1-4 + ship/bill/install-to) is now CONTROLLED
   (owner two-lane spec, rows above): a street/unit change on a locked SO moves
   by Logistics-approved amendment, so the person who plans trips is the person
   who signs the change. What this still does NOT do is re-plan an
   already-SCHEDULED trip when the amendment applies — the trip holds its own
   stop. The Logistics approver is at least now IN the loop by construction;
   re-planning after applying remains a by-hand step. Surfacing a
   scheduled-trip flag on the SO header (delivery-planning already knows; the
   SO does not ask) is still the proper close, reported for the owner. */
