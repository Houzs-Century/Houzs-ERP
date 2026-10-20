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
import type { CompanyScopeCtx } from './companyScope';
import { canonicalizeMyState, isCanonicalMyState } from './canonical-state';

/** The board's Service-Case (ASSR) union — OPEN cases carrying a driving date
 *  (customer pickup, own-team inspection visit, or delivery-back), restricted to
 *  the caller's granted companies. */
/** The legs a Service Case runs on the delivery board — one row each, keyed
 *  `<assr_no>#<leg>` — and the leg a crew completes through /delivery-jobs. */
export const ASSR_BOARD_LEGS = ['customer_pickup', 'delivery', 'inspection'] as const;

/** The trip stop type a Service Case leg rides -> that leg. */
export const ASSR_LEG_BY_STOP: Record<string, string> = {
  PICKUP: 'customer_pickup', INSPECTION: 'inspection', DELIVERY: 'delivery', SERVICE: 'delivery',
};

export function assrBoardUnionSql(c: CompanyScopeCtx): string {
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
              assr_cases.customer_name AS customer_name,
              assr_cases.phone         AS phone,
              assr_cases.location      AS location,
              assr_cases.customer_pickup_at AS customer_pickup_at,
              assr_cases.inspection_visit_at AS inspection_visit_at,
              assr_cases.inspection_by AS inspection_by,
              assr_cases.do_date       AS do_date,
              assr_cases.addr1 AS addr1, assr_cases.addr2 AS addr2, assr_cases.addr3 AS addr3, assr_cases.addr4 AS addr4,
              so.customer_state AS so_state, so.postcode AS so_postcode, so.customer_country AS so_country
         FROM assr_cases
         LEFT JOIN LATERAL (
              SELECT o.customer_state, o.postcode, o.customer_country
                FROM scm.mfg_sales_orders o
               WHERE o.doc_no = assr_cases.doc_no OR o.linked_ac_docno = assr_cases.doc_no
               ORDER BY (o.doc_no = assr_cases.doc_no) DESC
               LIMIT 1) so ON TRUE
        WHERE assr_cases.closed_at IS NULL
          AND assr_cases.archived_at IS NULL
          AND (assr_cases.customer_pickup_at IS NOT NULL OR assr_cases.do_date IS NOT NULL
               OR (assr_cases.inspection_visit_at IS NOT NULL AND assr_cases.inspection_by = 'own'))${assrCompanySql(c)}`;
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

/** The open-case guard the ASSR schedule write runs before it touches anything.
 *  Carries the SAME company predicate as the read: a case the caller cannot see
 *  on the board is a case they cannot schedule onto a lorry either, and it 404s
 *  exactly as /api/assr's own `caseInCallerScope` does. Without this the board
 *  read would be scoped while the write beside it stayed open — and the write is
 *  the half that consumes real fleet capacity. */
export function assrOpenCaseGuardSql(c: CompanyScopeCtx): string {
  return `SELECT id FROM assr_cases
        WHERE id = ? AND closed_at IS NULL AND archived_at IS NULL${assrCompanySql(c)}`;
}
