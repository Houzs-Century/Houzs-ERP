/* ----------------------------------------------------------------------------
   document-hold-route — the ONE handler behind `PATCH .../:id/hold` on all five
   documents.

   FIVE ROUTERS SHARE THIS FUNCTION RATHER THAN FIVE COPIES OF IT. The hold is
   the same decision on a Sales Order, a Purchase Order, a GRN, a Purchase
   Invoice and a Delivery Order — put a marker on, take it off, never touch the
   status — and this repo has already paid for the alternative: `check-duplicated
   -decisions.mjs` exists because one rule with five homes has no referee, and
   `docs/bugs/0462-one-rule-two-homes-no-referee-the-class-the-owner-named-and.md`
   is the entry it was written from.

   WHAT IT DELIBERATELY DOES NOT DO:

   · IT NEVER WRITES `status`. Not on hold, not on release. The status column is
     the document's progress and the hold is a note stuck beside it. If a future
     edit adds a status write here, the change has been undone.
   · IT DOES NOT GATE ON STATUS. A cancelled document can be marked, and that is
     intentional rather than an oversight — the marker is information, and the
     screens that must refuse work on a held document do so by reading the flag
     (see the guard list in docs/modules/document-status-vocabulary.md). Adding a
     status gate here would re-couple the two things this change separates.
   · IT IS IDEMPOTENT. Holding a held document, or releasing a free one, writes
     the same shape again and answers 200. A retry after a dropped connection is
     therefore safe, which a 409-on-repeat would not be.

   COMPANY SCOPE IS STRICT, both halves. `requireActiveCompanyId` refuses when
   the active company is unresolved rather than degrading to every company, and
   the predicate is on the UPDATE as well as on the read — the standing rule in
   CLAUDE.md, because the SCM client is service-role and the `company_id`
   predicate is the entire tenant boundary.
   ---------------------------------------------------------------------------- */

import { NOT_THIS_COMPANY, requireActiveCompanyId, scopeToCompanyId } from './companyScope';
import { HOLD_COLUMNS, holdPatch, readHoldRequest } from './document-hold';

export type HoldRouteConfig = {
  /** The scm table the document lives in, e.g. `mfg_sales_orders`. */
  table: string;
  /** The column the URL parameter matches — `id` for four of them, `doc_no` for
   *  the Sales Order, whose route is keyed by document number. */
  keyColumn: string;
  /** The Hono route parameter name, e.g. `id` or `docNo`. */
  param: string;
  /** The key the document comes back under, e.g. `salesOrder`. */
  responseKey: string;
  /** Extra columns to return beside the marker, e.g. `doc_no, status`. */
  echoColumns: string;
};

/**
 * Build the `PATCH .../:id/hold` handler for one document type.
 *
 * The actor is read the same way the sibling documents read theirs on their own
 * write paths — `c.get('user').id`, the uuid every one of these five tables
 * already stores in `created_by` (verified against
 * backend/scripts/scm-schema/2990s-full-schema.sql, which types all five as
 * `"created_by" uuid`).
 */
export function makeHoldHandler(cfg: HoldRouteConfig) {
  return async (c: any) => {
    const sb = c.get('supabase');
    const key = c.req.param(cfg.param);

    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

    const req = readHoldRequest(body);
    if ('error' in req) return c.json(req, 400);

    const co = requireActiveCompanyId(c);
    if (!co.ok) return c.json(co.refusal, 409);

    /* Read first so a document in another company's books answers 404 rather
       than silently updating zero rows and reporting success. */
    const select = `${cfg.keyColumn}, ${cfg.echoColumns}, ${HOLD_COLUMNS}`;
    const { data: cur, error: readErr } = await scopeToCompanyId(
      sb.from(cfg.table).select(select).eq(cfg.keyColumn, key),
      co.companyId,
    ).maybeSingle();
    if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
    if (!cur) return c.json(NOT_THIS_COMPANY, 404);

    const actorId = (c.get('user')?.id ?? null) as string | null;
    const { data, error } = await scopeToCompanyId(
      sb.from(cfg.table).update(holdPatch(req, actorId)).eq(cfg.keyColumn, key),
      co.companyId,
    ).select(select).maybeSingle();
    if (error) return c.json({ error: 'hold_update_failed', reason: error.message }, 500);
    if (!data) return c.json(NOT_THIS_COMPANY, 404);

    return c.json({ [cfg.responseKey]: data });
  };
}
