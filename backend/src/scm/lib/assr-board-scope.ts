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

/** The board's Service-Case (ASSR) union — OPEN cases carrying a driving date
 *  (customer pickup, own-team inspection visit, or delivery-back), restricted to
 *  the caller's granted companies. */
export function assrBoardUnionSql(c: CompanyScopeCtx): string {
  return `SELECT id            AS id,
              assr_no       AS assr_no,
              company_id    AS company_id,
              status        AS status,
              customer_name AS customer_name,
              phone         AS phone,
              location      AS location,
              customer_pickup_at AS customer_pickup_at,
              inspection_visit_at AS inspection_visit_at,
              inspection_by AS inspection_by,
              do_date       AS do_date,
              addr1 AS addr1, addr2 AS addr2, addr3 AS addr3, addr4 AS addr4
         FROM assr_cases
        WHERE closed_at IS NULL
          AND archived_at IS NULL
          AND (customer_pickup_at IS NOT NULL OR do_date IS NOT NULL
               OR (inspection_visit_at IS NOT NULL AND inspection_by = 'own'))${assrCompanySql(c)}`;
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
