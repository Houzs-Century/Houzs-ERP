/* ── Service Cases on the Delivery Planning board are COMPANY-SCOPED ─────────
   Owner ruling 2026-08-21: 「这个也不可以啊」 — a Service Case belonging to a
   company the caller holds no grant for must not appear on the board. Until
   this module existed, the board's ASSR union read `public.assr_cases` through
   raw env.DB SQL with NO company predicate, while /api/assr scoped the SAME
   table with `assrCompanySql`. The two surfaces answered the same person
   differently, and the board was the one that leaked.

   WHY THE PREDICATE WENT MISSING, which is the reusable part: the ASSR rows
   come through `c.env.DB.prepare()` raw SQL, and the supabase-js scoping
   helpers (`scopeToAllowedCompanies`) cannot reach a query string. The raw-SQL
   caveat at the foot of `scm/lib/companyScope.ts` says a raw path must add the
   predicate BY HAND. Nobody did, and nothing could notice: the statement was an
   inline template literal in the middle of a 3,000-line request handler.

   THE RULE HAS ONE HOME — `assrCompanySql` (routes/assr.ts), the caller's
   GRANTED companies, WIDENED not isolated: Delivery Planning is a cross-company
   view module, so a caller granted both companies still sees the combined
   queue. Its three-state sentinel comes along for free: an unresolved company
   context degrades to no predicate (a legacy single-company install serves
   unchanged) and a caller granted no active company matches nothing.

   It is IMPORTED, never re-derived. routes/search.ts kept its own COPY of this
   rule and drifted — global search and /api/assr answered the same rep
   differently for three weeks — so a hand-written " AND company_id IN (...)"
   here would be that bug for a third time.

   THESE ARE FUNCTIONS RETURNING SQL, in their own module, so the predicate is
   assertable without a database, a Worker or a Hono request —
   `backend/tests/deliveryBoardAssrScope.test.ts`.

   NOT SCOPED HERE, deliberately: the row-level VISIBILITY rule
   (`assrVisibilityPredicateSql`, "which cases may THIS person see within the
   company"). The owner ruled on the COMPANY boundary; narrowing the fleet
   coordinator's board to only the cases they personally handled is a different
   decision nobody has made, and it would empty the board for dispatchers. */
import { assrCompanySql } from '../../routes/assr';
import { ASSR_TERMINAL_STAGES } from '../../services/assrStages';
import { PAST_PICKUP_STAGES } from '../../lib/delivery-sheet-assr-feed';
import type { CompanyScopeCtx } from './companyScope';
import { canonicalizeMyState, isCanonicalMyState } from './canonical-state';

/** The board's Service-Case (ASSR) union — cases carrying a driving date
 *  (customer pickup, own-team inspection visit, or delivery-back), restricted to
 *  the caller's granted companies. Two arms (owner 2026-10-21: the Delivered tab
 *  shows every job type, not only SO deliveries): every OPEN case, plus any case
 *  whose newest leg date is on/after `recentClosedSince`, so recently-done
 *  (closed) legs can land on Delivered without the whole closed history flooding
 *  the board. The date columns are TEXT ISO strings, so a lexicographic `>=` is a
 *  date comparison; `recentClosedSince` is a caller-computed YYYY-MM-DD, never
 *  user input. closed_at / archived_at are selected so the row builder can tell a
 *  done leg from a pending one. */
/** The legs a Service Case runs on the delivery board — one row each, keyed
 *  `<assr_no>#<leg>` — and the leg a crew completes through /delivery-jobs. */
export const ASSR_BOARD_LEGS = ['customer_pickup', 'delivery', 'inspection'] as const;

/** The trip stop type a Service Case leg rides -> that leg. */
export const ASSR_LEG_BY_STOP: Record<string, string> = {
  PICKUP: 'customer_pickup', INSPECTION: 'inspection', DELIVERY: 'delivery', SERVICE: 'delivery',
};

/** Stages whose leg the fleet must arrange even before Service gives a date. */
export const ASSR_AWAITING_DATE_STAGES = ['pending_supplier_pickup', 'pending_delivery_service'] as const;

/** The date Logistics CONFIRMS for each leg - written by the board ("Set job
 *  date"), shown back on the case. Service's own date on the case is the request. */
export const ASSR_CONFIRMED_COL = {
  customer_pickup: 'sched_pickup_date', inspection: 'sched_inspection_date', delivery: 'sched_delivery_date',
} as const;

/** The date Logistics stamps when it marks a leg DELIVERED on the board (owner
 *  2026-11-06), independent of case closure — a board mark records THAT leg only
 *  and never closes the case. The pickup leg reuses the existing actual_pickup_at;
 *  inspection and delivery got their own columns (mig 20261105T0900). assrBoardLegs
 *  reads these so a marked leg shows DELIVERED while the case stays open. */
export const ASSR_ACTUAL_COL = {
  customer_pickup: 'actual_pickup_at', inspection: 'actual_inspection_at', delivery: 'actual_delivery_at',
} as const;

/** The date Logistics stamps when it CANCELS a leg on the board (owner 2026-11-06):
 *  that leg's trip was called off. A cancelled leg is DROPPED from the board
 *  (assrBoardLegs skips it) and recorded; like Delivered it is leg-only and never
 *  closes the case. */
export const ASSR_CANCELLED_COL = {
  customer_pickup: 'pickup_cancelled_at', inspection: 'inspection_cancelled_at', delivery: 'delivery_cancelled_at',
} as const;

/** The Time Slot a Service Case keeps per leg (HC-0194), typed on the board. */
export const ASSR_LEG_TIME_COL = {
  customer_pickup: 'pickup_time_range', inspection: 'inspection_time_range', delivery: 'delivery_time_range',
} as const;

/** The hand-set message status a Service Case keeps per leg (HC-0193). The
 *  delivery leg keeps the original case-level column. */
export const ASSR_LEG_MSG_COL = {
  customer_pickup: 'pickup_message_status', inspection: 'inspection_message_status', delivery: 'delivery_message_status',
} as const;

/** wa_message_log source of a staff pick in the board's Delivery Message Status.
 *  The leg's status is the newest event of send / tap / pick, and the leg columns
 *  hold no time, so the pick is logged beside them. */
export const ASSR_STATUS_PICK_SOURCE = 'board-status-pick';

/** The board Remarks a Service Case keeps per leg, like the Time Slot. */
export const ASSR_LEG_REMARK_COL = {
  customer_pickup: 'pickup_remark', inspection: 'inspection_remark', delivery: 'delivery_remark',
} as const;

/* Stages AFTER each leg's own step (the HC sheet feed's rule): that leg is done. */
const PAST_PICKUP = PAST_PICKUP_STAGES;
const PAST_INSPECTION = new Set(['pending_supplier_pickup', ...PAST_PICKUP_STAGES]);

/** A leg still has an upcoming visit: a scheduled date (confirmed, else requested)
 *  of today or later with no actual completion yet. Such a leg is NOT done however
 *  far the case stage has moved, so the stage-past-this-leg shortcuts below must not
 *  mark it Delivered or lock its writes (owner 2026-11-10: a re-inspection booked
 *  after the case reached Pending Delivery/Service showed Delivered and could not be
 *  given a driver). Dates are 'YYYY-MM-DD' (or a timestamp whose first 10 chars are),
 *  compared lexically to todayMyt(); an empty `today` disables the check (a caller
 *  without board time keeps the legacy stage-only behaviour). */
function legUpcoming(effectiveDate: string | null | undefined, actualAt: string | null | undefined, today: string): boolean {
  return !actualAt && today !== '' && effectiveDate != null && effectiveDate.slice(0, 10) >= today;
}

/** A case is done when it carries a closed / archived stamp, a terminal stage,
 *  or (cases from before the stamp existed) the status "Closed". Only the stamps
 *  were read until 2026-10-26, so 56 old Closed cases showed as pending jobs. */
export function assrCaseClosed(a: { closed_at: string | null; archived_at: string | null; stage: string | null; status: string | null }): boolean {
  return Boolean(a.closed_at) || Boolean(a.archived_at)
    || (ASSR_TERMINAL_STAGES as readonly string[]).includes(a.stage ?? '')
    || String(a.status ?? '').trim().toLowerCase() === 'closed';
}

export type AssrBoardCase = {
  stage: string | null;
  pickup_by: string | null; pickup_pic: string | null; customer_pickup_at: string | null; actual_pickup_at: string | null; sched_pickup_date: string | null; pickup_cancelled_at: string | null;
  inspection_by: string | null; inspection_visit_at: string | null; sched_inspection_date: string | null; actual_inspection_at: string | null; inspection_cancelled_at: string | null;
  delivery_by: string | null; do_date: string | null; sched_delivery_date: string | null; actual_delivery_at: string | null; delivery_cancelled_at: string | null;
};
export type AssrBoardLeg = {
  jobKind: 'customer_pickup' | 'delivery' | 'inspection';
  requested: string | null; confirmed: string | null;
  state: 'PENDING_SCHEDULE' | 'PENDING_DELIVERY' | 'DELIVERED';
};

/** A Service Case's fleet legs on Delivery Planning (owner 2026-10-26):
 *  - only OWN-TEAM legs (Own team pickup / Own team delivery / own inspection);
 *    a supplier leg never reaches the board. A blank choice counts as own only
 *    when a date was already keyed (cases older than the choice).
 *  - Service's date is a REQUEST -> Pending Schedule; Logistics confirms a date
 *    -> Pending Delivery, and that date shows back on the case.
 *  - a leg the case has moved past (picked up, inspected, case closed) is done:
 *    Delivered, never left in Pending Delivery. */
export function assrBoardLegs(a: AssrBoardCase, caseClosed: boolean, today = ''): AssrBoardLeg[] {
  const legs: AssrBoardLeg[] = [];
  // `cancelled` drops the leg off the board entirely (owner 2026-11-06): a cancelled
  // trip is called off, so it is not shown at all — never left as a pending row.
  const add = (jobKind: AssrBoardLeg['jobKind'], req: string | null | undefined, conf: string | null | undefined, done: boolean, cancelled: boolean) => {
    if (cancelled) return;
    const requested = req ?? null; const confirmed = conf ?? null;
    if (done) { if (requested || confirmed) legs.push({ jobKind, requested, confirmed, state: 'DELIVERED' }); return; }
    legs.push({ jobKind, requested, confirmed, state: confirmed ? 'PENDING_DELIVERY' : 'PENDING_SCHEDULE' });
  };
  const pickupDated = Boolean(a.customer_pickup_at || a.sched_pickup_date);
  const pickupOwn = a.pickup_by === 'customer' || (a.pickup_by == null && (pickupDated || a.pickup_pic === 'Logistic'));
  if (pickupOwn && (pickupDated || a.stage === 'pending_supplier_pickup')) {
    add('customer_pickup', a.customer_pickup_at, a.sched_pickup_date, caseClosed || Boolean(a.actual_pickup_at) || PAST_PICKUP.has(a.stage ?? ''), Boolean(a.pickup_cancelled_at));
  }
  if (a.inspection_by === 'own' && (a.inspection_visit_at || a.sched_inspection_date)) {
    // An inspection still scheduled for today or later (no actual visit yet) stays a
    // live PENDING leg even past the inspection stage — else a re-inspection booked
    // after the case moved to Pending Delivery/Service shows Delivered (owner 2026-11-10).
    const inspUpcoming = legUpcoming(a.sched_inspection_date ?? a.inspection_visit_at, a.actual_inspection_at, today);
    add('inspection', a.inspection_visit_at, a.sched_inspection_date, caseClosed || Boolean(a.actual_inspection_at) || (PAST_INSPECTION.has(a.stage ?? '') && !inspUpcoming), Boolean(a.inspection_cancelled_at));
  }
  const deliveryDated = Boolean(a.do_date || a.sched_delivery_date);
  const deliveryOwn = a.delivery_by === 'own' || (a.delivery_by == null && deliveryDated);
  if (deliveryOwn && (deliveryDated || a.stage === 'pending_delivery_service')) {
    // Delivered once the case closes OR Logistics marked it Delivered on the board
    // (actual_delivery_at); a board mark does NOT close the case (owner 2026-11-05).
    add('delivery', a.do_date, a.sched_delivery_date, caseClosed || Boolean(a.actual_delivery_at), Boolean(a.delivery_cancelled_at));
  }
  return legs;
}

export function assrBoardUnionSql(c: CompanyScopeCtx, recentClosedSince: string): string {
  // The State / Postcode columns (and the region bucket) come from the LINKED
  // Sales Order's real customer address, NOT from `location` (the branch/
  // warehouse the case was raised at) — same source the delivery-sheet ASSR feed
  // uses (lib/delivery-sheet-assr-feed.ts). Before this, customer_state was set
  // to `location`, so a Kuching case showed "SRW" in State and fell into the KL
  // bucket. doc_no matches first, then the AutoCount number; an old case whose
  // order predates the ERP has no match and leaves these null (blank, not wrong).
  return `SELECT assr_cases.id            AS id,
              assr_cases.assr_no       AS assr_no,
              assr_cases.company_id    AS company_id,
              assr_cases.status        AS status,
              assr_cases.stage         AS stage,
              assr_cases.customer_name AS customer_name,
              assr_cases.phone         AS phone,
              assr_cases.location      AS location,
              assr_cases.customer_pickup_at AS customer_pickup_at,
              assr_cases.inspection_visit_at AS inspection_visit_at,
              assr_cases.inspection_by AS inspection_by,
              assr_cases.do_date       AS do_date,
              assr_cases.delivery_by   AS delivery_by,
              assr_cases.pickup_by     AS pickup_by,
              assr_cases.pickup_pic    AS pickup_pic,
              assr_cases.actual_pickup_at AS actual_pickup_at,
              assr_cases.actual_inspection_at AS actual_inspection_at,
              assr_cases.actual_delivery_at AS actual_delivery_at,
              assr_cases.pickup_cancelled_at AS pickup_cancelled_at,
              assr_cases.inspection_cancelled_at AS inspection_cancelled_at,
              assr_cases.delivery_cancelled_at AS delivery_cancelled_at,
              assr_cases.sched_pickup_date AS sched_pickup_date,
              assr_cases.sched_inspection_date AS sched_inspection_date,
              assr_cases.sched_delivery_date AS sched_delivery_date,
              assr_cases.pickup_time_range AS pickup_time_range,
              assr_cases.inspection_time_range AS inspection_time_range,
              assr_cases.delivery_time_range AS delivery_time_range,
              assr_cases.pickup_remark AS pickup_remark,
              assr_cases.inspection_remark AS inspection_remark,
              assr_cases.delivery_remark AS delivery_remark,
              assr_cases.closed_at     AS closed_at,
              assr_cases.archived_at   AS archived_at,
              assr_cases.delivery_message_status AS delivery_message_status,
              assr_cases.pickup_message_status AS pickup_message_status,
              assr_cases.inspection_message_status AS inspection_message_status,
              assr_cases.addr1 AS addr1, assr_cases.addr2 AS addr2, assr_cases.addr3 AS addr3, assr_cases.addr4 AS addr4,
              -- Ref No. + the DO No. column are back-filled from the ORIGINAL order (owner
              -- 2026-11-11). Ref is the case's OWN ref_no (the HC##### customer docket it was
              -- raised with), the same value the case detail shows; the order's ref is only a
              -- fallback. The DO numbers are NOT resolved here — the row builder runs the case
              -- through attachDeliveryOrders (services/assr.ts), the one resolver the detail
              -- page uses, so a HOUZS case on an AutoCount-numbered order (its DOs live in the
              -- AutoCount mirror, matched by ref_no) resolves the same on the board as in detail.
              assr_cases.ref_no AS ref_no, assr_cases.delivery_order AS delivery_order,
              so.customer_state AS so_state, so.postcode AS so_postcode, so.customer_country AS so_country,
              so.ref AS so_ref_src, so.customer_so_no AS so_custso_src
         FROM assr_cases
         LEFT JOIN LATERAL (
              SELECT o.customer_state, o.postcode, o.customer_country, o.ref, o.customer_so_no
                FROM scm.mfg_sales_orders o
               WHERE o.doc_no = assr_cases.doc_no OR o.linked_ac_docno = assr_cases.doc_no
               ORDER BY (o.doc_no = assr_cases.doc_no) DESC
               LIMIT 1) so ON TRUE
        WHERE (assr_cases.customer_pickup_at IS NOT NULL OR assr_cases.do_date IS NOT NULL
               OR assr_cases.sched_pickup_date IS NOT NULL OR assr_cases.sched_delivery_date IS NOT NULL
               OR (assr_cases.inspection_visit_at IS NOT NULL AND assr_cases.inspection_by = 'own')
               OR assr_cases.stage IN (${ASSR_AWAITING_DATE_STAGES.map((s) => `'${s}'`).join(', ')}))
          AND ((assr_cases.closed_at IS NULL AND assr_cases.archived_at IS NULL)
               OR GREATEST(COALESCE(assr_cases.customer_pickup_at, ''), COALESCE(assr_cases.do_date, ''),
                           COALESCE(CASE WHEN assr_cases.inspection_by = 'own' THEN assr_cases.inspection_visit_at END, '')) >= '${recentClosedSince}')${assrCompanySql(c)}`;
}

/** The State + Postcode a Service-Case board row shows, and the value its region
 *  bucket is classified by: the case's OWN address first — `addr4` is the state,
 *  `addr3` leads with the postcode — then the linked Sales Order. NEVER
 *  `location` (the branch the case was raised at), which showed "SRW" in the
 *  State column and dropped a Sarawak case into the KL bucket. Same "case
 *  address, then linked order" rule the delivery-sheet ASSR feed follows
 *  (lib/delivery-sheet-assr-feed.ts), so the board and the sheet agree.
 *  Pure, so it is unit-tested without a Worker or a database. */
export function assrBoardLocation(
  addr3: string | null,
  addr4: string | null,
  soState: string | null,
  soPostcode: string | null,
): { state: string | null; postcode: string | null } {
  const addrState = canonicalizeMyState(addr4);
  const state = addrState && isCanonicalMyState(addrState) ? addrState : (soState ?? null);
  const addrPostcode = (addr3 ?? '').match(/\b\d{5,6}\b/)?.[0] ?? null;
  return { state, postcode: addrPostcode ?? soPostcode ?? null };
}

/** The guard every ASSR board write runs before it touches anything, PER JOB
 *  (HC-0193 re-test). One board row is one job of a case, keyed case id + job
 *  kind; a sibling job's POD closes the whole case but must not lock this one.
 *  It selects the case (company predicate included: a case the caller cannot see
 *  on the board is one they cannot write to, and it 404s) and `assrLegOpen`
 *  then asks only about the named job. Archived cases stay locked. */
export function assrLegGuardSql(c: CompanyScopeCtx): string {
  return `SELECT id, assr_no, company_id, stage, actual_pickup_at, closed_at, status, sched_inspection_date, inspection_visit_at, actual_inspection_at FROM assr_cases
        WHERE id = ? AND archived_at IS NULL${assrCompanySql(c)}`;
}

/** True while THIS job is not done. Each job is judged by its own record, never
 *  by the case-level closed stamp a sibling job's POD sets: pickup is done once
 *  it has an actual pickup time; inspection once the case moved past it (not by
 *  the terminal stage, which any job can set); delivery is the job whose POD
 *  closes the case. */
export function assrLegOpen(
  a: { stage: string | null; actual_pickup_at: string | null; closed_at: string | null; status: string | null;
       sched_inspection_date?: string | null; inspection_visit_at?: string | null; actual_inspection_at?: string | null },
  jobKind: AssrBoardLeg['jobKind'],
  today = '',
): boolean {
  const stage = a.stage ?? '';
  if (jobKind === 'customer_pickup') return !a.actual_pickup_at;
  if (jobKind === 'inspection') {
    // An inspection still scheduled for today or later stays writable even past its
    // stage, so a re-inspection can still be given a date / driver (owner 2026-11-10).
    if (legUpcoming(a.sched_inspection_date ?? a.inspection_visit_at, a.actual_inspection_at, today)) return true;
    return !(PAST_INSPECTION.has(stage) && !(ASSR_TERMINAL_STAGES as readonly string[]).includes(stage));
  }
  return !assrCaseClosed({ closed_at: a.closed_at, archived_at: null, stage, status: a.status });
}
