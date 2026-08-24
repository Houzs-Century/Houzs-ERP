/* The SQL behind `scripts/probe-undated-demand.mjs`, in ONE home so a test can
   EXECUTE it rather than a copy of it.

   WHY THIS FILE EXISTS. The probe shipped with its SQL unexecuted — there is no
   local database and no dispatch is possible until a workflow_dispatch file is
   on the default branch, so "it parses" was the only check it had. On its first
   production dispatch (run 31962771658, 2026-08-16) it died mid-run:

     FAIL subquery uses ungrouped column "h.created_at" from outer query

   That cost the whole answer for company 2, which had not been reached yet, and
   a second dispatch of the owner's time. `node --check` cannot see it: the SQL
   is a string until Postgres parses it, so the only honest gate is running it
   against a real Postgres. CI already has one — the `backend-postgres` job's
   postgres:16 service — and `tests-pg/probeUndatedDemandSql.pg.test.ts` now runs
   EVERY query below against it.

   NO SHEBANG, and it lives in scripts/lib/, because a test imports it: on
   Windows vitest inlines a test-imported module and wraps the source before
   `vm.runInThisContext`, so a `#!` no longer at byte 0 is a SyntaxError at LOAD
   (CLAUDE.md, #2062).

   Every function here takes the `sql` tag as its first argument and returns the
   driver's promise. They are SELECTs, all of them: no DDL, no writes, no
   transaction. */
import { SO_TERMINAL_STATES } from "./so-terminal-states.mjs";

/* LIVE = not in the shared terminal set. `UPPER(COALESCE(status::text,''))` is
   this repo's established idiom (audit-mrp-pairing.mjs, check-so-completeness.mjs):
   it keeps a NULL-status header in the live set as '' rather than dropping it,
   because a row nobody can classify is a row somebody should look at. */

export function hasColumn(sql, schema, table, column) {
  return sql`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table} AND column_name = ${column}`;
}

/** A. The demand set MRP actually walks: a line is undated iff BOTH its own
    date and its header's are null — the same coalesce `mrp.ts` reads. */
export function liveLines(sql, companyId) {
  return sql`
    SELECT count(*)::int AS live,
           count(*) FILTER (WHERE i.line_delivery_date IS NULL
                              AND h.customer_delivery_date IS NULL)::int AS undated
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${companyId}
       AND i.cancelled = false
       AND i.qty > 0
       AND UPPER(COALESCE(h.status::text,'')) <> ALL(${SO_TERMINAL_STATES})`;
}

/** B. Header-level, the shape the owner measured by hand. */
export function liveHeaders(sql, companyId) {
  return sql`
    SELECT count(*)::int AS live,
           count(*) FILTER (WHERE customer_delivery_date IS NULL)::int AS undated
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})`;
}

/** C(a). The pair `so-save-problems.ts` refuses: processing date, no delivery. */
export function undatedXor(sql, companyId) {
  return sql`
    SELECT count(*) FILTER (WHERE processing_date IS NOT NULL)::int AS with_proc,
           count(*) FILTER (WHERE processing_date IS NULL)::int     AS no_proc
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND customer_delivery_date IS NULL`;
}

/** C(a2). NAME them. `hasAc` false still returns the column, as NULL, so the
    caller's printing code has one shape to handle instead of two. */
export function refusedPairRows(sql, companyId, hasAc) {
  return hasAc
    ? sql`
      SELECT doc_no, status::text AS status, processing_date::text AS processing_date,
             created_at::date::text AS created, linked_ac_docno,
             updated_at::date::text AS updated
        FROM scm.mfg_sales_orders
       WHERE company_id = ${companyId}
         AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
         AND customer_delivery_date IS NULL AND processing_date IS NOT NULL
       ORDER BY created_at DESC LIMIT 50`
    : sql`
      SELECT doc_no, status::text AS status, processing_date::text AS processing_date,
             created_at::date::text AS created, NULL::text AS linked_ac_docno,
             updated_at::date::text AS updated
        FROM scm.mfg_sales_orders
       WHERE company_id = ${companyId}
         AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
         AND customer_delivery_date IS NULL AND processing_date IS NOT NULL
       ORDER BY created_at DESC LIMIT 50`;
}

/** C(c). Missing vs misplaced. Production answered 0 for HOUZS, which rules out
    a whole family of wrong fixes — so the query stays. */
export function lineVsHeader(sql, companyId) {
  return sql`
    SELECT count(*) FILTER (WHERE k.dated_lines > 0)::int AS some_line_dated,
           count(*) FILTER (WHERE k.dated_lines = 0)::int AS no_line_dated
      FROM scm.mfg_sales_orders h
      JOIN LATERAL (
        SELECT count(*) FILTER (WHERE i.line_delivery_date IS NOT NULL)::int AS dated_lines
          FROM scm.mfg_sales_order_items i
         WHERE i.doc_no = h.doc_no AND i.cancelled = false
      ) k ON true
     WHERE h.company_id = ${companyId}
       AND UPPER(COALESCE(h.status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND h.customer_delivery_date IS NULL`;
}

export function byStatus(sql, companyId) {
  return sql`
    SELECT coalesce(status::text, '(null)') AS status,
           count(*)::int AS n,
           min(created_at)::date::text AS first_seen,
           max(created_at)::date::text AS last_seen
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND customer_delivery_date IS NULL
     GROUP BY 1 ORDER BY n DESC`;
}

/** D. The import test. `linked_ac_docno` (mig 0271) is the authority; the 'HC-'
    doc_no prefix is the same import's second fingerprint. Both are returned so
    a DISAGREEMENT between them is visible rather than averaged away. */
export function importedVsErpBorn(sql, companyId) {
  return sql`
    SELECT count(*)::int AS undated,
           count(*) FILTER (WHERE linked_ac_docno IS NOT NULL)::int AS by_ac_col,
           count(*) FILTER (WHERE doc_no LIKE 'HC-%')::int          AS by_docno,
           count(*) FILTER (WHERE linked_ac_docno IS NULL AND doc_no NOT LIKE 'HC-%')::int AS erp_born
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND customer_delivery_date IS NULL`;
}

export function allLiveByOrigin(sql, companyId) {
  return sql`
    SELECT count(*) FILTER (WHERE linked_ac_docno IS NOT NULL)::int AS imported,
           count(*) FILTER (WHERE linked_ac_docno IS NULL)::int     AS erp_born
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})`;
}

/** The sharpest single number: among orders the import did NOT write, how many
    lack a date? That is the rate a required-field rule would actually bite. */
export function erpBornRate(sql, companyId) {
  return sql`
    SELECT count(*)::int AS erp_live,
           count(*) FILTER (WHERE customer_delivery_date IS NULL)::int AS erp_undated
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND linked_ac_docno IS NULL AND doc_no NOT LIKE 'HC-%'`;
}

/** C(b)-1. THE QUERY THAT CRASHED PRODUCTION, rewritten.
    The old form put a correlated subquery beside a GROUP BY and referenced the
    raw `h.created_at` that the grouping had already collapsed into
    `date_trunc('month', ...)`. Postgres refuses that, and only Postgres can say
    so. A CTE computes the bucket once: one pass, one grouping, no correlation. */
export function byMonth(sql, companyId) {
  return sql`
    WITH live AS (
      SELECT date_trunc('month', created_at) AS m, customer_delivery_date
        FROM scm.mfg_sales_orders
       WHERE company_id = ${companyId}
         AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
    )
    SELECT to_char(m, 'YYYY-MM') AS mon,
           count(*) FILTER (WHERE customer_delivery_date IS NULL)::int AS undated,
           count(*)::int AS live_that_month
      FROM live GROUP BY m ORDER BY m DESC LIMIT 18`;
}

/** C(b)-2. A five-day bulk write is invisible in monthly buckets. */
export function byDay(sql, companyId) {
  return sql`
    WITH live AS (
      SELECT created_at::date::text AS d, customer_delivery_date
        FROM scm.mfg_sales_orders
       WHERE company_id = ${companyId}
         AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
    )
    SELECT d, count(*) FILTER (WHERE customer_delivery_date IS NULL)::int AS undated,
           count(*)::int AS live_that_day
      FROM live GROUP BY d
      HAVING count(*) FILTER (WHERE customer_delivery_date IS NULL) > 0
      ORDER BY undated DESC, d DESC LIMIT 20`;
}

/** C(b)-3. A script insert leaves created_by NULL; a person leaves their id. */
export function byCreator(sql, companyId, named) {
  return named
    ? sql`
      SELECT coalesce(u.email, h.created_by::text, '(null — no creator recorded)') AS who,
             count(*)::int AS undated,
             min(h.created_at)::date::text AS first_seen,
             max(h.created_at)::date::text AS last_seen
        FROM scm.mfg_sales_orders h
        -- ::text on BOTH sides: a uuid-vs-text mismatch would fail the whole
        -- dispatch for a diagnostic join. Text compares either way.
        LEFT JOIN public.users u ON u.id::text = h.created_by::text
       WHERE h.company_id = ${companyId}
         AND UPPER(COALESCE(h.status::text,'')) <> ALL(${SO_TERMINAL_STATES})
         AND h.customer_delivery_date IS NULL
       GROUP BY 1 ORDER BY undated DESC LIMIT 15`
    : sql`
      SELECT coalesce(h.created_by::text, '(null — no creator recorded)') AS who,
             count(*)::int AS undated,
             min(h.created_at)::date::text AS first_seen,
             max(h.created_at)::date::text AS last_seen
        FROM scm.mfg_sales_orders h
       WHERE h.company_id = ${companyId}
         AND UPPER(COALESCE(h.status::text,'')) <> ALL(${SO_TERMINAL_STATES})
         AND h.customer_delivery_date IS NULL
       GROUP BY 1 ORDER BY undated DESC LIMIT 15`;
}

/** E. The required-field decision input, split by origin: only the ERP-BORN
    column can refuse live work. */
export function stillProduced(sql, companyId, hasAc) {
  return hasAc
    ? sql`
      SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days')::int  AS d7,
             count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS d30,
             count(*) FILTER (WHERE created_at > now() - interval '7 days'
                                AND linked_ac_docno IS NULL AND doc_no NOT LIKE 'HC-%')::int  AS d7_erp,
             count(*) FILTER (WHERE created_at > now() - interval '30 days'
                                AND linked_ac_docno IS NULL AND doc_no NOT LIKE 'HC-%')::int AS d30_erp
        FROM scm.mfg_sales_orders
       WHERE company_id = ${companyId}
         AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
         AND customer_delivery_date IS NULL`
    : sql`
      SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days')::int  AS d7,
             count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS d30,
             NULL::int AS d7_erp, NULL::int AS d30_erp
        FROM scm.mfg_sales_orders
       WHERE company_id = ${companyId}
         AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
         AND customer_delivery_date IS NULL`;
}

export function newestUndated(sql, companyId) {
  return sql`
    SELECT doc_no, status::text AS status, processing_date::text AS processing_date,
           created_at::date::text AS created
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND customer_delivery_date IS NULL
     ORDER BY created_at DESC LIMIT 10`;
}
