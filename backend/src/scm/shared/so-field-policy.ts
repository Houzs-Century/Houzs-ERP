// ----------------------------------------------------------------------------
// so-field-policy — THE single source of truth for "what can be edited on a
// processing-locked Sales Order, and does Save write it or raise an amendment".
//
// WHY THIS FILE EXISTS (Owner 2026-07-17)
// ---------------------------------------
// The owner's ruling: fields split into two classes.
//   * FREE      — pressing Save writes straight to the database. No gate.
//   * CONTROLLED— pressing Save raises an AMENDMENT for approval instead.
// His test for which is which: "does this change what gets DELIVERED or what
// gets CHARGED?" Contact details are not that — forcing them through an
// approval queue means people stop updating them, and then the delivery driver
// has a phone number that does not work.
//
// The split ALREADY existed before this file, but as THREE hand-maintained
// literals that only prose kept in step:
//   * backend  SO_PROCESSING_LOCK_COLS  (what the header PATCH rejects)
//   * backend  AMENDABLE_HEADER_FIELDS  (what an amendment may carry)
//   * frontend AMENDABLE_HEADER_KEYS    (what the forms route to the amendment)
// They had already drifted: `city` was disabled by the mobile UI and named in
// its lock copy, but was in NEITHER backend set — so a City change on a locked
// SO wrote straight through if posted, and could not be requested by amendment
// either. This table is now the origin of all three, and a drift test asserts
// the frontend vendored copy still matches it.
//
// CLASSES
// -------
//   FREE       Writable at any point in the SO's life. Save writes it directly.
//              Audited (entity-audit) — a freely editable field is exactly the
//              one nobody approves, so the audit trail is its only control.
//   CONTROLLED Frozen on the header PATCH once the SO is processing-locked; the
//              amendment workflow is the sanctioned channel to change it.
//   DERIVED    Frozen like CONTROLLED, but NOT directly requestable: the server
//              recomputes it from another CONTROLLED field. Callers must omit
//              it rather than send it, or the lock diff 409s on it.
//
// NOT IN THIS TABLE
// -----------------
// LINE-level fields (item, spec/variants, qty, unit price, FOC, per-line
// warehouse_id) are CONTROLLED wholesale by the per-route processing lock
// (soProcessingLockBlocked) — every line mutation 409s once locked, and the
// amendment carries item / variants / qty / unit price. Warehouse binding has
// NO direct amendment path by design: it is re-derived from an approved State
// change. See the WAREHOUSE note below.
//
// WAREHOUSE / POSTCODE — a correction to a widely-held belief
// ----------------------------------------------------------
// Postcode does NOT determine the warehouse. `deriveWarehouseIdFromState`
// (mfg-sales-orders.ts) resolves warehouse from customer_state ONLY, via
// scm.state_warehouse_mappings — a table that has no postcode column. Delivery
// region / TMS routing is likewise state-keyed (delivery_planning_regions).
// Postcode is frozen for a DIFFERENT and independently valid reason: it is
// printed on the supplier PO as the delivery destination, so it must not drift
// after the SO is PO'd. City freezes for that same reason, and only that reason.
// ----------------------------------------------------------------------------

export type SoFieldClass = 'FREE' | 'CONTROLLED' | 'DERIVED';

export type SoHeaderFieldPolicy = {
  /** DB column on mfg_sales_orders. */
  column: string;
  /** camelCase key the header PATCH / amendment payloads use. */
  payloadKey: string;
  /** Human label — rendered in amendment before/after diffs and lock copy. */
  label: string;
  cls: SoFieldClass;
  /** Why it sits in that class. Read this before moving a row. */
  reason: string;
};

/* The CONTROLLED + DERIVED rows. Every other patchable header column is FREE by
   omission — see SO_FREE_HEADER_NOTE below for why that default is deliberate. */
export const SO_HEADER_FIELD_POLICY: readonly SoHeaderFieldPolicy[] = [
  {
    column: 'internal_expected_dd',
    payloadKey: 'internalExpectedDd',
    label: 'Processing Date',
    cls: 'CONTROLLED',
    reason:
      'The processing date IS the lock boundary and the date the supplier works to. '
      + 'Moving it re-times production.',
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
    reason:
      'State resolves each line\'s warehouse_id (deriveWarehouseIdFromState) and the '
      + 'delivery region. That warehouse is what the PO ships from — changing State '
      + 'after the PO silently desyncs warehouse, PO and routing.',
  },
  {
    column: 'sales_location',
    payloadKey: 'salesLocation',
    label: 'Sales Location',
    cls: 'DERIVED',
    reason:
      'Derived from customer_state. Re-derived server-side when a State amendment '
      + 'applies, exactly as the header PATCH does — so callers must OMIT it, not send it.',
  },
  {
    column: 'postcode',
    payloadKey: 'postcode',
    label: 'Postcode',
    cls: 'CONTROLLED',
    reason:
      'Part of the delivery destination printed on the supplier PO. NOTE: postcode does '
      + 'NOT resolve the warehouse — State does. Postcode freezes because the supplier '
      + 'ships to it, not because it computes anything.',
  },
  {
    column: 'city',
    payloadKey: 'city',
    label: 'City',
    cls: 'CONTROLLED',
    reason:
      'Same rationale as Postcode: part of the PO delivery destination. Added 2026-07-17 — '
      + 'the mobile UI already disabled City and named it in its lock copy, but no backend '
      + 'set contained it, so a posted City change wrote through on a locked SO and no '
      + 'amendment could carry it. Desktop did not lock it at all.',
  },
  /* Two-lane rework phase 2 (owner 2026-07-27): the DELIVERY ADDRESS block and
     the disposal note join the CONTROLLED set — the owner's category-2 spec
     names "delivery address" and "disposal add on" as Logistics-approved
     changes, which reverses the earlier "address lines save straight away"
     ruling this table used to flag. All classify to the DELIVERY lane
     (amendment-lane.ts). */
  {
    column: 'address1',
    payloadKey: 'address1',
    label: 'Address line 1',
    cls: 'CONTROLLED',
    reason:
      'The delivery address the trip is planned to and the paperwork prints. '
      + 'Owner 2026-07-27 (two-lane spec): address changes on a locked SO are '
      + 'a Logistics-approved amendment, no longer a direct save.',
  },
  {
    column: 'address2',
    payloadKey: 'address2',
    label: 'Address line 2',
    cls: 'CONTROLLED',
    reason: 'Same rationale as Address line 1 — one address, one rule.',
  },
  {
    column: 'address3',
    payloadKey: 'address3',
    label: 'Address line 3',
    cls: 'CONTROLLED',
    reason: 'Same rationale as Address line 1 — one address, one rule.',
  },
  {
    column: 'address4',
    payloadKey: 'address4',
    label: 'Address line 4',
    cls: 'CONTROLLED',
    reason:
      'Same rationale as Address line 1 — and legacy rows double this line as '
      + 'the postcode (the editor falls back postcode ?? address4), so it '
      + 'freezes with Postcode too.',
  },
  {
    column: 'ship_to_address',
    payloadKey: 'shipToAddress',
    label: 'Ship-to address',
    cls: 'CONTROLLED',
    reason:
      'Free-text delivery destination rendered on supplier-facing paperwork — '
      + 'the exact rationale that froze Postcode and City. No editor field '
      + 'writes it after create; controlling it closes the direct-API hole.',
  },
  {
    column: 'bill_to_address',
    payloadKey: 'billToAddress',
    label: 'Bill-to address',
    cls: 'CONTROLLED',
    reason:
      'Kept with its sibling address fields so the whole ship/bill/install '
      + 'block moves through one channel once the SO is committed.',
  },
  {
    column: 'install_to_address',
    payloadKey: 'installToAddress',
    label: 'Install-to address',
    cls: 'CONTROLLED',
    reason: 'Same rationale as Ship-to address — where the crew actually goes.',
  },
  {
    column: 'replacement_disposal',
    payloadKey: 'replacementDisposal',
    label: 'Replacement / disposal',
    cls: 'CONTROLLED',
    reason:
      'The owner\'s "disposal add on" — what the crew hauls away, which changes '
      + 'the delivery job itself. NOTE: the Delivery Planning fields drawer '
      + '(delivery-planning.ts /:type/:id/fields) still writes it DIRECTLY — '
      + 'that surface is page-guarded to Logistics, who are this lane\'s own '
      + 'approvers, so their direct edit is the approved change. This row gates '
      + 'the sales-reachable header PATCH and lets an amendment carry it.',
  },
];

/* WHY FREE IS THE DEFAULT, AND WHAT THAT COSTS
   -------------------------------------------
   The free bucket is "every patchable column not named above": customer name,
   phone, email, customer type, customer SO ref, salesperson, building type,
   venue, branding, note, emergency contact + relationship, and the payments
   collection. That matches the owner's ruling and matches how the header PATCH
   has always behaved.

   It is a RESIDUE, not a per-field decision. One entry still deserves the
   owner's eye rather than my silence:
     * A delivery-address change on an SO with an already-SCHEDULED delivery
       trip does not re-plan that trip. The address now moves by amendment
       (rows above, 2026-07-27), so Logistics signs it — but the trip still
       needs re-planning by hand after the amendment applies. */
export const SO_FREE_HEADER_NOTE =
  'Header columns absent from SO_HEADER_FIELD_POLICY are FREE: Save writes them directly, '
  + 'audited via entity-audit.';

/** Columns the header PATCH must reject a genuine change to while the SO is
    processing-locked. CONTROLLED + DERIVED. */
export const soProcessingLockColumns = (): Set<string> =>
  new Set(SO_HEADER_FIELD_POLICY.map((f) => f.column));

/** The amendment allow-list: payloadKey -> column, CONTROLLED only.
    This is the trust boundary — an amendment's header_changes jsonb is
    client-authored, so any key not produced here is REJECTED at create rather
    than written through to the SO on approve. DERIVED rows are excluded because
    the server recomputes them. */
export const soAmendableHeaderFields = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of SO_HEADER_FIELD_POLICY) {
    if (f.cls === 'CONTROLLED') out[f.payloadKey] = f.column;
  }
  return out;
};

/** payloadKeys an amendment may carry, in table order. */
export const soAmendableHeaderKeys = (): string[] =>
  SO_HEADER_FIELD_POLICY.filter((f) => f.cls === 'CONTROLLED').map((f) => f.payloadKey);

/** Classify a payload key. Returns 'FREE' for anything not in the table —
    which is the documented default, not a lookup miss. */
export const soHeaderFieldClass = (payloadKey: string): SoFieldClass => {
  const hit = SO_HEADER_FIELD_POLICY.find((f) => f.payloadKey === payloadKey);
  return hit ? hit.cls : 'FREE';
};

/* ── The enforcement predicate ─────────────────────────────────────────────
   THE server-side control. A client that posts a CONTROLLED field directly on
   a processing-locked SO must be REJECTED — the UI disabling the input is a
   courtesy, this is the thing that actually holds.

   Extracted from the PATCH handler so it can be tested directly rather than by
   a copy that could drift from what ships. */

/** Loose equality mirroring the route's `norm()` — null / undefined / '' all
    collapse, so a form re-sending a blank field as '' does not read as a
    change from null. */
const normValue = (v: unknown): string =>
  v === null || v === undefined ? '' : String(v);

export type LockedChangeOptions = {
  /** Remove-Processing-Date (Owner 2026-07-09, port of 2990 #717) — an admin
      CLEARING the Processing Date is the one sanctioned way to pull a locked SO
      back, so that clear (and the paired Delivery Date clear the set-together
      rule forces with it) passes the lock. Any OTHER schedule change — including
      the same admin MOVING the date rather than clearing it — still 409s. */
  superAdminClearsProcessingDate?: boolean;
};

/**
 * The CONTROLLED/DERIVED columns this patch would genuinely change on a
 * processing-locked SO. Empty array = the patch is all FREE fields and may be
 * written directly.
 *
 * Note the `col in updates` semantics: a column that is never SENT cannot trip
 * the lock. That is deliberate and load-bearing — it is what lets the clients
 * send an amendment's direct-save half with the frozen columns reverted or
 * omitted, rather than having to split the request.
 */
export const lockedColumnsChanged = (
  updates: Record<string, unknown>,
  before: Record<string, unknown>,
  opts: LockedChangeOptions = {},
): string[] =>
  [...soProcessingLockColumns()]
    .filter((col) => col in updates && normValue(updates[col]) !== normValue(before[col]))
    .filter((col) => !(
      opts.superAdminClearsProcessingDate === true
      && (col === 'internal_expected_dd' || col === 'customer_delivery_date')
      && normValue(updates[col]) === ''
    ));

/* ── Payments ──────────────────────────────────────────────────────────────
   Owner 2026-07-17: "如果是一些好像 payment 我都可以直接 add，它可以直接给我
   create" — ADDING a payment is FREE at any point in the order's life,
   including after delivery. Money arrives over time. That is unchanged.

   Owner 2026-07-19, on EDIT and DELETE: "删除只有在当天才行。正常情况下，他当天
   key in 的时候，因为还没有 lock 下来，所以当天都可以任意更改。" — a payment row
   may be edited or deleted ONLY on the day it was keyed in. Same-day entries
   are still fluid because nothing has locked yet, so anything goes; from the
   next day, no. This supersedes the earlier "mandatory typed reason" default:
   the owner ruled the same-day window IS the control, and 任意更改 means a
   same-day correction is not interrogated.

   TWO DETAILS THAT ARE EXPLOITABLE IF READ LOOSELY:

   1. "Same day" = the day the ROW WAS CREATED (created_at), NOT the payment
      date on the document (paid_at). Keying off paid_at would let anyone
      unlock a months-old payment for deletion just by editing its date to
      today — the edit and the delete would authorise each other.

   2. The day boundary is MALAYSIA (UTC+8, no DST), closing at MYT midnight.
      Workers run in UTC; computing this in UTC would either hold the window
      open 8h into the next business day or slam it shut at 16:00 UTC (=
      midnight MYT) — depending on direction, and both are wrong. Use the
      house helpers (scm/lib/my-time.ts `mytDateOf` / `todayMyt` on the server,
      vendor/scm/lib/dates.ts `isCreatedTodayMyt` on the client). Do not
      invent a new convention here.

   WHERE THE FUTURE CONDITION GOES. The owner has explicitly DEFERRED the
   bank-reconciliation rule — "如果他已经做完 bank record 并且 knock off 掉了，
   就不行了" — until reconciliation and knock-off exist. Nothing about that is
   built here, and there are no speculative hooks for it. When he defines it,
   it becomes one more `&&` inside paymentRowMutable() below: that predicate is
   the ONLY place either client or the server asks "may this row still change",
   so a knock-off check added there lands on every surface at once. */

export type PaymentMutationKind = 'ADD' | 'EDIT' | 'DELETE';

export type PaymentRowMutability = {
  /** May this payment row still be edited or deleted? */
  mutable: boolean;
  /** Plain-language reason when it may not — shown to the operator verbatim.
      null when it may. */
  problem: string | null;
};

/**
 * The single predicate behind "may this recorded payment still be changed".
 * Server and both clients call this; nothing else decides.
 *
 * @param createdDateMyt  the MY calendar date the row was CREATED (YYYY-MM-DD),
 *                        from mytDateOf(row.created_at) / isCreatedTodayMyt.
 * @param todayDateMyt    the current MY calendar date, from todayMyt().
 * @param soIsDraft       a DRAFT SO has nothing locked at all, so its payments
 *                        stay adjustable — this mirrors the exemption the
 *                        payment PATCH route has carried since 2026-07-13 (an
 *                        OCR-scanned draft whose payment was mis-read must be
 *                        fixable). Drafts are not the owner's case; he was
 *                        describing a confirmed order.
 *
 * Both dates are required strings. Deliberately no `?? ''` fallback: an
 * unreadable created_at is an error for the caller to surface, not a value to
 * default into "not today" (which would silently deny) or "today" (which would
 * silently allow).
 */
export const paymentRowMutable = (
  createdDateMyt: string,
  todayDateMyt: string,
  soIsDraft: boolean,
): PaymentRowMutability => {
  if (soIsDraft) return { mutable: true, problem: null };
  if (createdDateMyt === todayDateMyt) return { mutable: true, problem: null };
  return {
    mutable: false,
    problem: PAYMENT_WINDOW_CLOSED_MESSAGE,
  };
};

/** Why the control is gone. The operator must be told plainly, not just find
    the button missing. Kept under 200 chars with no braces and no bare
    error codes so it survives the client's humanApiError sentence filter. */
export const PAYMENT_WINDOW_CLOSED_MESSAGE =
  'This payment can only be changed or removed on the day it was keyed in. That day has passed, '
  + 'so it is now locked. Record a new payment instead, or ask the office to adjust it.';

/** Wire error code for the closed window. */
export const PAYMENT_WINDOW_CLOSED_ERROR = 'payment_edit_locked';
