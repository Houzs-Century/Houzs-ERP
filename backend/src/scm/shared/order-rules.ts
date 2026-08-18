// Order-state pure functions. Lifted from prototype per PORT_DESIGN.md §11.2.
// Implementations TODO — port during Phase 3 (order lifecycle).

export interface LaneCondition { lane: string; require: ('paid_full' | 'slip_verified' | 'driver_assigned' | 'do_signed')[] }

/** True if the order satisfies all conditions to enter the target lane. */
export const checkConditions = (_order: unknown, _conditions: LaneCondition): boolean => {
  throw new Error('checkConditions: not yet implemented (Phase 3)');
};

/** 0..100 — what fraction of total has been paid across all payments. */
export const paidPct = (paid: number, total: number): number => {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((paid / total) * 100));
};

/** 2990's deposit fraction. NOT a second gate — it is one branch of
 *  processingDateThresholdFor, which is the only thing that reads it. The name
 *  is the fossil of the era when Proceed and the Processing Date were two rules
 *  with two thresholds; they are one rule now (meetsDepositGate). */
export const PROCEED_PAID_THRESHOLD = 0.5;

/** Houzs's deposit fraction (owner 2026-07-14), and the fallback for any company
 *  code we do not recognise. Same note as above: read through
 *  processingDateThresholdFor, never directly. */
export const PROCESSING_DATE_PAID_THRESHOLD = 0.30;

/** Inputs to the Processing-Date gate. `paid` / `total` must share a unit
 *  (whole-MYR on the POS, centi on the server) — only their ratio is used, so
 *  either side may pass its own representation. */
export interface ProceedGateInput {
  hasCustomerName: boolean;
  /** Delivery address line 1 present. A "Fill in later" handover leaves this
   *  (and the postcode) blank, so the gate fails — exactly the case that must
   *  keep an order in Order Placed. */
  hasAddress: boolean;
  hasPostcode: boolean;
  hasDeliveryDate: boolean;
  paid: number;
  total: number;
  /** Active company ('HOUZS' | '2990') — picks the deposit fraction. */
  companyCode?: CompanyCode | string | null;
}

/** THE gate. One rule, one name — owner 2026-07-31, verbatim: *"不要又 Processing
 *  Date,又 Proceed,全系统直接统一一个叫 Processing Date... Processing Date 就是当天
 *  Proceed 的意思。如果分两个的话,会不会很乱?"*
 *
 *  It answers ONE question — may this order start production? — and every path
 *  that used to ask its own version now asks this: setting `processing_date`
 *  (the date the user picks) and the two manual proceed paths.
 *
 *  ONE RULE AND ONE STORAGE (owner, 2026-08-18, naming the scope: frontend,
 *  backend AND database). This docblock used to end: *"`proceeded_at` remains a
 *  separate COLUMN because it is a timestamp the system writes, not a date the
 *  user picks; what is unified is the RULE, not the storage."* That argument is
 *  coherent — an audit stamp and a planned date really are different kinds of
 *  fact — and the owner has OVERRULED it for the purpose of DECISIONS. His
 *  reason is the one the bug record supports: every Processing-Date bug this
 *  repo has had came from there being more than one of them.
 *
 *  So no decision anywhere may branch on a second column. What survives is the
 *  question "WHEN did someone press Proceed", and that has no consumer: the
 *  desktop Proceed Date field was deleted on 2026-06-05, the dashboard hook that
 *  carried the value has zero callers, and no export, PDF or AutoCount payload
 *  names it. Where the fact IS still wanted it belongs in scm.mfg_so_audit_log,
 *  which nothing gates on.
 *
 *  Retirement state and the remaining step are in shared/so-processing-date.ts
 *  under "RETIRING THE SECOND STORAGE".
 *
 *  WHAT CHANGED, and why each way:
 *   - **Threshold is per company** (HOUZS 30% / 2990 50%). Previously two
 *     constants, both applied to everyone; see processingDateThresholdFor.
 *   - **Email is NO LONGER required** (owner 2026-07-31: "不需要email"). It was
 *     the ONLY completeness condition anything was actually missing —
 *     check-processing-date-gate-impact.mjs on prod: of 63 live SOs carrying a
 *     Processing Date, 12 lack an email and ZERO lack a name, address, postcode
 *     or delivery date. Dropping it is what makes unification cost nothing.
 *   - **Name / address / postcode / delivery date are now required to set a
 *     Processing Date**, which they were not before (that gate was money-only).
 *     Free by the same measurement: all 63 already have them.
 *
 *  This LOOSENS the two proceed paths by one condition (an emailless order can
 *  now proceed) and TIGHTENS the processing-date path by four. Both are the
 *  owner's stated intent, both measured before shipping. */
export const meetsProceedGate = (i: ProceedGateInput): boolean =>
  proceedGateFailures(i).length === 0;

/** The five conditions of the gate above, as stable KEYS. No sentences here:
 *  this module owns the rule; so-save-problems.ts owns the words. */
export type ProceedGateCondition =
  | 'customer_name'
  | 'address'
  | 'postcode'
  | 'delivery_date'
  | 'deposit';

/** Every condition of the proceed gate THIS order fails, in the reading order of
 *  the form: identity, then where it goes, then when, then the money. [] means
 *  the gate is met — which is literally what meetsProceedGate above asks.
 *
 *  WHY THE GATE IS DEFINED AS "THIS LIST IS EMPTY" rather than the list being a
 *  second reading of a separate boolean expression. Until 2026-08-18 the refusal
 *  was ONE stored sentence naming ALL FIVE conditions, returned whenever ANY ONE
 *  failed:
 *
 *      "A Processing Date can only be set once the order has a customer name, a
 *       full delivery address (line 1 and postcode), a delivery date, and the
 *       deposit its company requires (Houzs 30%, 2990 50%)."
 *
 *  On 2026-08-17 the owner hit it on a ZERO-TOTAL order, read the word
 *  "deposit", and spent a day chasing a money bug that did not exist — the
 *  deposit term had PASSED (meetsDepositGate is vacuously true at total <= 0,
 *  see its docblock), and what had actually failed was the postcode. Live
 *  population the same day: of 561 processing-dated SOs, 21 lack a postcode and
 *  8 lack a delivery date, so this is the common shape of the refusal, not a
 *  corner.
 *
 *  Writing the verdict and the reasons as two expressions is how a rule stated
 *  at N places ends up true at N-1 — this repo's repeat offender. One
 *  expression, read two ways: the caller who wants a boolean asks whether the
 *  list is empty, the caller who wants to explain itself reads the list.
 *
 *  The order above is stable, so the refusal reads the same way every time.
 *
 *  NOT a short-circuit, deliberately: every condition is evaluated so ALL
 *  failures are reported at once (owner 2026-07-18 — a surface renders every
 *  reason, not the one-at-a-time sequence the backend used to return). Safe to
 *  evaluate unconditionally because meetsDepositGate is pure and total-safe: its
 *  `total <= 0` branch runs first, so the division can never be 0/0. */
export const proceedGateFailures = (i: ProceedGateInput): ProceedGateCondition[] => {
  const out: ProceedGateCondition[] = [];
  if (!i.hasCustomerName) out.push('customer_name');
  if (!i.hasAddress) out.push('address');
  if (!i.hasPostcode) out.push('postcode');
  if (!i.hasDeliveryDate) out.push('delivery_date');
  /* Absent for a free order, and that absence is the whole point of this file
     changing. `paid` / `total` here are ratio-only (see ProceedGateInput); a
     caller that wants to PRINT the shortfall must hand centi to
     so-save-problems.ts, which fixes the unit because it formats currency. */
  if (!meetsDepositGate(i.paid, i.total, i.companyCode)) out.push('deposit');
  return out;
};

/** The money half of the gate above, on its own — for the aggregated save
 *  report, which names the deposit shortfall as its own fixable problem instead
 *  of failing the whole gate anonymously (so-save-problems).
 *
 *  THE ONE DEPOSIT RULE. It used to be two functions with two names
 *  (meetsProcessingDatePaymentGate for the date, the inline ratio above for
 *  Proceed) for one act, back when setting a date and proceeding were separate
 *  things. They are the same act — a Processing Date IS Proceed — so a second
 *  copy could only ever drift into a second threshold, which is exactly what
 *  happened before 2026-07-31.
 *
 *  `paid` / `total` must share a unit (whole-MYR on the POS, centi on the server)
 *  — only their ratio is used. Free order (total ≤ 0, e.g. a Free Item Campaign
 *  giveaway): nothing to collect, so the gate is vacuously met — and that shape
 *  also avoids the 0/0 = NaN a `total > 0` guard would need. */
export const meetsDepositGate = (
  paid: number,
  total: number,
  companyCode?: CompanyCode | string | null,
): boolean => total <= 0 || paid / total >= processingDateThresholdFor(companyCode);

/** Refusals for a proceed that carries no usable Processing Date. Owner, stated
 *  more than three times: *"只要有 Processing Date，就代表他 Proceed 了。没有
 *  processing date 就代表没有 proceed。"* Proceed is therefore not an event with a
 *  click time — it is the state of having a date — so a proceed with no date is
 *  not an order we can start: the factory queue is ordered BY that date.
 *
 *  Refusing beats defaulting to today. A guessed start date is a real order in
 *  the real queue on the wrong day, and nobody would ever see that it was
 *  guessed. A refusal costs the operator one field. */
export const PROCEED_NEEDS_DATE = {
  error: 'proceed_needs_processing_date',
  reason: 'Proceeding an order means setting its Processing Date, and this order has none. Set the date the factory starts, then proceed.',
} as const;

export const PROCEED_DATE_UNREADABLE = {
  error: 'proceed_needs_processing_date',
  reason: 'The Processing Date sent with this proceed is not a calendar date (expected YYYY-MM-DD). A wrong start date is a wrong factory queue, so nothing was changed.',
} as const;

export type ProceedDateInput = {
  /** The date the CALLER is proceeding with, if this request carries one. */
  supplied?: string | null;
  /** internal_expected_dd as it stands on the order (date or timestamp). */
  stored?: string | null;
};

/** `write: true` means the caller must PERSIST `date` to internal_expected_dd —
 *  the proceed is what puts it there. `write: false` means the order already
 *  carries that date, so proceeding writes no date at all. */
export type ProceedDateResolution =
  | { ok: true; date: string; write: boolean }
  | { ok: false; refusal: typeof PROCEED_NEEDS_DATE | typeof PROCEED_DATE_UNREADABLE };

/** 'YYYY-MM-DD' out of a date or a timestamp column, else null. Mirrors how
 *  soProcessingLocked reads the same column — internal_expected_dd is a DATE in
 *  Postgres but reaches us as a string from several shapes of client. */
const ymdOrNull = (v?: string | null): string | null => {
  const ymd = String(v ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : null;
};

/** Which Processing Date a proceed proceeds WITH, or why it cannot.
 *
 *  A date already on the order WINS over one in the request, and is never
 *  rewritten: that order is already proceeded by the owner's rule, so moving its
 *  date is a reschedule — a different act, owned by the header PATCH because
 *  that is where the processing lock and the full save gate live. Proceeding
 *  must not become the road around them. */
export const resolveProceedProcessingDate = (i: ProceedDateInput): ProceedDateResolution => {
  const stored = ymdOrNull(i.stored);
  if (stored) return { ok: true, date: stored, write: false };
  const raw = String(i.supplied ?? '').trim();
  if (!raw) return { ok: false, refusal: PROCEED_NEEDS_DATE };
  const supplied = ymdOrNull(raw);
  return supplied
    ? { ok: true, date: supplied, write: true }
    : { ok: false, refusal: PROCEED_DATE_UNREADABLE };
};

/** The companies whose deposit rule differs. Mirrors companyContext's
 *  `c.get('companyCode')`, which is the only producer of these strings. */
export type CompanyCode = 'HOUZS' | '2990';

/** The deposit fraction THIS company requires before a Processing Date may be set.
 *
 *  Owner 2026-07-31, stated plainly: **Houzs 30%, 2990 50%** — and the Processing
 *  Date IS the Proceed signal, so one rule governs both.
 *
 *  Until now the split existed ONLY in prose. PROCESSING_DATE_PAID_THRESHOLD was
 *  documented as the Houzs number and PROCEED_PAID_THRESHOLD as "a 2990 rule",
 *  while `grep -c company` on this file returned ZERO: both constants were applied
 *  to every company, so a 2990 order was gated at the Houzs 30%. That is what the
 *  owner hit on 2026-07-31 — a 2990 SO refused with "Deposit RM 0 of RM 1,663
 *  needed (30%)" where the 2990 rule is 50%.
 *
 *  UNKNOWN COMPANY FALLS BACK TO THE LOOSER 30%, deliberately. A future company
 *  code, or a caller that has not been threaded through yet, must not silently
 *  start refusing orders — that failure is invisible until someone cannot save.
 *  Under-gating is recoverable (the money still has to be collected before
 *  delivery); over-gating blocks the shop floor with no signal.
 *
 *  MEASURED BEFORE SHIPPING (check-processing-date-gate-impact.mjs on prod,
 *  2026-07-31): of 63 live SOs carrying a Processing Date, 51 are 2990 and 12 are
 *  HOUZS, and moving 2990 to 50% newly refuses **ZERO** of them — no 2990 order
 *  sits in the 30-49% band. This change is a rule correction with no blast radius,
 *  which is exactly why it ships alone. */
export const processingDateThresholdFor = (companyCode?: CompanyCode | string | null): number =>
  String(companyCode ?? '').trim().toUpperCase() === '2990'
    ? PROCEED_PAID_THRESHOLD
    : PROCESSING_DATE_PAID_THRESHOLD;

/** Total physical pieces in an order (for delivery slot allocation). */
export const pieceCount = (_orderItems: unknown[]): number => {
  throw new Error('pieceCount: not yet implemented (Phase 3)');
};
