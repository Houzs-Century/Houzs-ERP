// The reads and the verdicts behind check-so-amendment-bound-po-reads.mjs.
//
// WHAT IS MEASURED. GET /so-amendments (backend/src/scm/routes/so-amendments.ts)
// fills every row's `bound_pos` from three PostgREST reads over the newest
// LIST_WINDOW amendments of the active company:
//
//   A  mfg_sales_order_items  select id, doc_no                   doc_no     in (the page's SO numbers)
//   B  purchase_order_items   select purchase_order_id, so_item_id so_item_id in (every line id A returned)
//   C  purchase_orders        select id, po_number, status         id         in (every PO id B returned)
//
// As written on 2026-09-15 none of the three binds `error`, none pages, and none
// carries a company predicate — and both PO Amendments queues keep an SO
// amendment only when its `bound_pos` is non-empty. Three production facts decide
// whether "From SO amendment" rows can go missing:
//
//   - the request line each read sends: the id list rides in the URL, and ~19.5KB
//     of uuids was REFUSED at the gateway on 2026-08-17/18 (docs/bugs/0317);
//   - the rows each read must return: a response ceiling drops the rest with no
//     error, and its production value is still UNKNOWN (docs/bugs/0447);
//   - whether the chain crosses companies: a line or a PO of the other company
//     would surface in this company's queue.
//
// The SQL lives here so tests-pg/soAmendmentBoundPoReadsSql.pg.test.ts can EXECUTE
// it against real Postgres before the first dispatch (a workflow_dispatch check
// cannot run until it is on main). The sentences live here so
// tests/soAmendmentBoundPoReads.test.mjs can pin what each measured shape is
// CALLED: "within limits" printed for a company with no amendments would read as
// a pass that nothing measured.

import { createClient } from '@supabase/supabase-js';

/** The handler's `.limit(500)` on the amendment list. */
export const LIST_WINDOW = 500;

/** `PAGE` in backend/src/scm/lib/paginate-all.ts — the response ceiling this tree
 *  ASSUMES. Its production value is unmeasured (docs/bugs/0447), so every
 *  sentence that leans on it says "assumed". The light test pins it to PAGE. */
export const ASSUMED_ROW_CEILING = 1000;

/** `URL_QUERY_BUDGET` in paginate-all.ts: the most one batched request is allowed
 *  to carry anywhere else in this tree. Pinned to the source by the light test. */
export const URL_BUDGET_BYTES = 4000;

/** The one hard datum for URI length: ~19.5KB of `in.(…)` uuids was refused at the
 *  gateway (paginate-all.ts header, docs/bugs/0317). */
export const REFUSED_URI_BYTES = 19500;

/** Statuses OUTSIDE the queue's Requested chip — `amendmentBucketOf` in
 *  frontend/src/vendor/scm/lib/status-pill.ts folds everything else into it. */
export const CLOSED_STATUSES = ['REJECTED', 'SO_APPROVED', 'PO_APPROVED', 'SENT', 'APPROVED'];

const n = (v) => (v == null ? 0 : Number(v));

/**
 * The request target (path + query) the Worker's SCM client sends for one read —
 * built by the REAL supabase-js client, configured the way `getSupabaseService`
 * (backend/src/db/supabase.ts) configures it, with a fetch that never leaves the
 * process. Measuring the client's own output rather than a model of its
 * serializer means quoting, percent-encoding and the select list are all counted
 * the way they are sent.
 *
 * `build` receives the client and returns the query; null when it sent nothing.
 */
export async function requestTargetBytes(build) {
  let target = null;
  const sb = createClient('https://placeholder-project-ref.supabase.co', 'placeholder-key', {
    global: {
      fetch: async (input) => {
        const u = new URL(String(input instanceof Request ? input.url : input));
        target = u.pathname + u.search;
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
    db: { schema: 'scm' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await build(sb);
  return target == null ? null : Buffer.byteLength(target);
}

/**
 * The four request lines one GET /so-amendments sends over the page's lists —
 * A, B and C above, plus the Reference read (#3840), which shares A's SO-number
 * list and DOES fail the list on error. A read the handler skips (an empty list)
 * is null, never 0: it was not sent, so it has no size.
 */
export async function measureRequestTargets(company) {
  const docNos = company.doc_nos ?? [];
  const itemIds = company.item_ids ?? [];
  const poIds = company.po_ids ?? [];
  return {
    lines: docNos.length
      ? await requestTargetBytes((sb) => sb.from('mfg_sales_order_items').select('id, doc_no').in('doc_no', docNos))
      : null,
    poLines: itemIds.length
      ? await requestTargetBytes((sb) => sb.from('purchase_order_items').select('purchase_order_id, so_item_id').in('so_item_id', itemIds))
      : null,
    pos: poIds.length
      ? await requestTargetBytes((sb) => sb.from('purchase_orders').select('id, po_number, status').in('id', poIds))
      : null,
    reference: docNos.length
      ? await requestTargetBytes((sb) =>
        sb.from('mfg_sales_orders').select('doc_no, ref, customer_so_no').in('doc_no', docNos).eq('company_id', Number(company.company_id)))
      : null,
  };
}

const READ_LABEL = {
  lines: 'A (sales order lines by SO number)',
  poLines: 'B (purchase order lines by SO line id)',
  pos: 'C (purchase orders by id)',
  reference: 'the Reference read (SO numbers, fails the list on error)',
};

/**
 * Turn one company's measured row, and its request sizes, into facts and verdicts.
 *
 * Counts arrive from postgres as strings (bigint), so each is coerced once here.
 * The id lists are used for the sizes and then DROPPED: `facts` carries counts
 * only, because everything a run prints is public.
 */
export function assessCompany(row, targets) {
  const f = {
    companyId: n(row.company_id),
    companyCode: row.company_code ?? null,
    amendmentsTotal: n(row.amendments_total),
    createdLast30Days: n(row.created_last_30_days),
    pageRows: n(row.page_rows),
    pageFull: n(row.amendments_total) > LIST_WINDOW,
    pageDocs: n(row.page_docs),
    lineRows: n(row.line_rows),
    maxLinesOneOrder: n(row.max_lines_one_order),
    poLineRows: n(row.po_line_rows),
    poRows: n(row.po_rows),
    queueRows: n(row.queue_rows),
    queueRowsRequested: n(row.queue_rows_requested),
    linesOtherCompany: n(row.lines_other_company),
    posOtherCompany: n(row.pos_other_company),
    pageRowsWithForeignPo: n(row.page_rows_with_foreign_po),
    bytes: { ...targets },
    /* A proportional projection to a full page, for a company not there yet:
       same SO-per-amendment and lines-per-SO mix. Labelled as a projection
       wherever it is printed — it is arithmetic, not a measurement. */
    projectedFullPage: null,
  };
  if (!f.pageFull && f.pageRows > 0 && targets.poLines != null) {
    const scale = LIST_WINDOW / f.pageRows;
    f.projectedFullPage = {
      lineRows: Math.round(f.lineRows * scale),
      poLinesBytes: Math.round(targets.poLines * scale),
      daysToFull: f.createdLast30Days > 0
        ? Math.ceil((LIST_WINDOW - f.amendmentsTotal) / (f.createdLast30Days / 30))
        : null,
    };
  }

  const verdicts = [];
  if (f.pageRows === 0) {
    verdicts.push({ kind: 'EMPTY', text: 'no SO amendment in this company, so this run says nothing about the queue here' });
    return { facts: f, verdicts };
  }
  for (const read of ['lines', 'poLines', 'pos', 'reference']) {
    const b = f.bytes[read];
    if (b == null) continue;
    if (b >= REFUSED_URI_BYTES) {
      verdicts.push({ kind: 'URI_AT_REFUSED_SIZE', text: `read ${READ_LABEL[read]} sends a ${b}-byte request line, at or past the ~${REFUSED_URI_BYTES} bytes the gateway has refused` });
    } else if (b > URL_BUDGET_BYTES) {
      verdicts.push({ kind: 'URI_OVER_BUDGET', text: `read ${READ_LABEL[read]} sends a ${b}-byte request line, over the ${URL_BUDGET_BYTES}-byte budget every batched read in this tree keeps to (nothing between that and ~${REFUSED_URI_BYTES} has been measured)` });
    }
  }
  for (const [rows, read] of [[f.lineRows, 'lines'], [f.poLineRows, 'poLines'], [f.poRows, 'pos']]) {
    if (rows > ASSUMED_ROW_CEILING) {
      verdicts.push({ kind: 'ROW_CEILING_EXCEEDED', text: `read ${READ_LABEL[read]} must return ${rows} rows, above the assumed ${ASSUMED_ROW_CEILING}-row response ceiling, which drops the rest without an error` });
    }
  }
  if (f.linesOtherCompany > 0 || f.posOtherCompany > 0 || f.pageRowsWithForeignPo > 0) {
    verdicts.push({ kind: 'CROSS_COMPANY', text: `the unscoped chain reaches the other company: ${f.linesOtherCompany} line(s), ${f.posOtherCompany} purchase order(s), on ${f.pageRowsWithForeignPo} amendment row(s)` });
  }
  if (verdicts.length === 0) {
    verdicts.push({ kind: 'WITHIN_LIMITS', text: `all four request lines are within ${URL_BUDGET_BYTES} bytes, every read returns at most ${ASSUMED_ROW_CEILING} rows, and no line or purchase order belongs to another company` });
  }
  return { facts: f, verdicts };
}

/**
 * The measurement: two SELECTs over `sql`, a postgres.js client the CALLER opened
 * (the script inside a READ ONLY transaction over DATABASE_URL, the pg suite over
 * its disposable database).
 *
 * The page is replayed with the handler's own order, `created_at DESC` (NULLS
 * FIRST is Postgres's default for DESC and what PostgREST sends), plus `id` as a
 * tie-break so a run is deterministic. Rows with no company_id are left out of
 * the pages, as `scopeToCompany`'s `eq('company_id', …)` leaves them out, and
 * are counted on their own.
 *
 * The chain joins by the handler's keys ONLY — doc_no, then so_item_id, then
 * purchase_order_id — never by company, because the reads under test carry no
 * company predicate. The company columns are selected alongside to COUNT what
 * that costs, not to filter it away.
 */
export async function measureBoundPoReads(sql) {
  const companies = await sql`
    WITH ranked AS (
      SELECT a.id, a.company_id, a.so_doc_no, a.lane, a.status::text AS status, a.created_at,
             ROW_NUMBER() OVER (PARTITION BY a.company_id ORDER BY a.created_at DESC NULLS FIRST, a.id) AS rn
        FROM scm.so_amendments a
       WHERE a.company_id IS NOT NULL
    ),
    page AS (
      SELECT * FROM ranked WHERE rn <= ${LIST_WINDOW}::int
    ),
    docs AS (
      SELECT DISTINCT company_id, so_doc_no AS doc_no FROM page WHERE so_doc_no IS NOT NULL
    ),
    lines AS (
      SELECT d.company_id, i.id AS item_id, i.doc_no, i.company_id AS line_company
        FROM docs d
        JOIN scm.mfg_sales_order_items i ON i.doc_no = d.doc_no
    ),
    po_lines AS (
      SELECT l.company_id, l.doc_no, p.purchase_order_id
        FROM lines l
        JOIN scm.purchase_order_items p ON p.so_item_id = l.item_id
    ),
    po_list AS (
      -- read C's in-list: every PO id read B returned, whether or not the PO row exists
      SELECT DISTINCT company_id, purchase_order_id FROM po_lines WHERE purchase_order_id IS NOT NULL
    ),
    pos AS (
      -- read C's rows: the POs that do exist
      SELECT pl.company_id, po.id AS po_id, po.company_id AS po_company
        FROM po_list pl
        JOIN scm.purchase_orders po ON po.id = pl.purchase_order_id
    ),
    doc_pos AS (
      SELECT pl.company_id, pl.doc_no,
             bool_or(po.company_id IS DISTINCT FROM pl.company_id) AS has_foreign_po
        FROM po_lines pl
        JOIN scm.purchase_orders po ON po.id = pl.purchase_order_id
       GROUP BY pl.company_id, pl.doc_no
    ),
    totals AS (
      SELECT company_id,
             COUNT(*) AS amendments_total,
             COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS created_last_30_days
        FROM scm.so_amendments
       WHERE company_id IS NOT NULL
       GROUP BY company_id
    ),
    page_agg AS (
      SELECT p.company_id,
             COUNT(*)                   AS page_rows,
             COUNT(DISTINCT p.so_doc_no) AS page_docs,
             COUNT(*) FILTER (WHERE dp.doc_no IS NOT NULL AND p.lane IS DISTINCT FROM 'DELIVERY') AS queue_rows,
             COUNT(*) FILTER (
               WHERE dp.doc_no IS NOT NULL AND p.lane IS DISTINCT FROM 'DELIVERY'
                 AND p.status <> ALL (${CLOSED_STATUSES}::text[])
             )                                                                                  AS queue_rows_requested,
             COUNT(*) FILTER (WHERE dp.has_foreign_po)                                          AS page_rows_with_foreign_po
        FROM page p
        LEFT JOIN doc_pos dp ON dp.company_id = p.company_id AND dp.doc_no = p.so_doc_no
       GROUP BY p.company_id
    ),
    doc_agg AS (
      SELECT company_id, array_agg(doc_no ORDER BY doc_no) AS doc_nos FROM docs GROUP BY company_id
    ),
    line_agg AS (
      SELECT company_id,
             COUNT(*)                                                        AS line_rows,
             COUNT(*) FILTER (WHERE line_company IS DISTINCT FROM company_id) AS lines_other_company,
             array_agg(item_id::text ORDER BY item_id)                       AS item_ids
        FROM lines
       GROUP BY company_id
    ),
    per_order AS (
      SELECT company_id, doc_no, COUNT(*) AS lines FROM lines GROUP BY company_id, doc_no
    ),
    per_order_agg AS (
      SELECT company_id, MAX(lines) AS max_lines_one_order FROM per_order GROUP BY company_id
    ),
    po_line_agg AS (
      SELECT company_id, COUNT(*) AS po_line_rows FROM po_lines GROUP BY company_id
    ),
    po_agg AS (
      SELECT company_id,
             COUNT(*)                                                     AS po_rows,
             COUNT(*) FILTER (WHERE po_company IS DISTINCT FROM company_id) AS pos_other_company
        FROM pos
       GROUP BY company_id
    ),
    po_list_agg AS (
      SELECT company_id, array_agg(purchase_order_id::text ORDER BY purchase_order_id) AS po_ids
        FROM po_list
       GROUP BY company_id
    )
    SELECT t.company_id,
           c.code                                   AS company_code,
           t.amendments_total,
           t.created_last_30_days,
           COALESCE(pa.page_rows, 0)                AS page_rows,
           COALESCE(pa.page_docs, 0)                AS page_docs,
           COALESCE(pa.queue_rows, 0)               AS queue_rows,
           COALESCE(pa.queue_rows_requested, 0)     AS queue_rows_requested,
           COALESCE(pa.page_rows_with_foreign_po, 0) AS page_rows_with_foreign_po,
           COALESCE(la.line_rows, 0)                AS line_rows,
           COALESCE(la.lines_other_company, 0)      AS lines_other_company,
           COALESCE(poa.max_lines_one_order, 0)     AS max_lines_one_order,
           COALESCE(pla.po_line_rows, 0)            AS po_line_rows,
           COALESCE(pga.po_rows, 0)                 AS po_rows,
           COALESCE(pga.pos_other_company, 0)       AS pos_other_company,
           COALESCE(da.doc_nos, ARRAY[]::text[])    AS doc_nos,
           COALESCE(la.item_ids, ARRAY[]::text[])   AS item_ids,
           COALESCE(pli.po_ids, ARRAY[]::text[])    AS po_ids
      FROM totals t
      LEFT JOIN public.companies c ON c.id = t.company_id
      LEFT JOIN page_agg pa        ON pa.company_id  = t.company_id
      LEFT JOIN doc_agg da         ON da.company_id  = t.company_id
      LEFT JOIN line_agg la        ON la.company_id  = t.company_id
      LEFT JOIN per_order_agg poa  ON poa.company_id = t.company_id
      LEFT JOIN po_line_agg pla    ON pla.company_id = t.company_id
      LEFT JOIN po_agg pga         ON pga.company_id = t.company_id
      LEFT JOIN po_list_agg pli    ON pli.company_id = t.company_id
     ORDER BY t.company_id`;

  /* Whole-table facts a company predicate on the fix would lean on. Each is its
     own count, so "the index says unique" and "no duplicate exists" are two
     observations rather than one inferred from the other. */
  const [scope] = await sql`
    SELECT
      EXISTS (
        SELECT 1
          FROM pg_index ix
          JOIN pg_class t      ON t.oid = ix.indrelid
          JOIN pg_namespace ns ON ns.oid = t.relnamespace
          JOIN pg_attribute att ON att.attrelid = t.oid AND att.attnum = ix.indkey[0]
         WHERE ns.nspname = 'scm' AND t.relname = 'mfg_sales_orders'
           AND ix.indisunique AND ix.indnkeyatts = 1 AND ix.indpred IS NULL
           AND att.attname = 'doc_no'
      ) AS order_doc_no_unique_index,
      (SELECT COUNT(*) FROM (
         SELECT doc_no FROM scm.mfg_sales_orders GROUP BY doc_no HAVING COUNT(*) > 1
       ) d) AS order_doc_nos_duplicated,
      (SELECT COUNT(*) FROM (
         SELECT doc_no FROM scm.mfg_sales_order_items
          GROUP BY doc_no HAVING COUNT(DISTINCT COALESCE(company_id, -1)) > 1
       ) d) AS line_doc_nos_in_two_companies,
      (SELECT COUNT(*)
         FROM scm.mfg_sales_order_items i
         JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
        WHERE i.company_id IS DISTINCT FROM h.company_id) AS lines_company_not_order_company,
      (SELECT COUNT(*)
         FROM scm.purchase_order_items p
         JOIN scm.mfg_sales_order_items i ON i.id = p.so_item_id
         JOIN scm.purchase_orders po      ON po.id = p.purchase_order_id
        WHERE po.company_id IS DISTINCT FROM i.company_id) AS po_lines_bound_across_companies,
      (SELECT COUNT(*)
         FROM scm.so_amendments a
         JOIN scm.mfg_sales_orders h ON h.doc_no = a.so_doc_no
        WHERE a.company_id IS NOT NULL
          AND a.company_id IS DISTINCT FROM h.company_id) AS amendments_company_not_order_company,
      (SELECT COUNT(*) FROM scm.so_amendments WHERE company_id IS NULL) AS amendments_without_company`;

  return { companies, scope };
}

/** The whole-table company facts, as counts. */
export function assessScope(scope) {
  const f = {
    orderDocNoUniqueIndex: Boolean(scope.order_doc_no_unique_index),
    orderDocNosDuplicated: n(scope.order_doc_nos_duplicated),
    lineDocNosInTwoCompanies: n(scope.line_doc_nos_in_two_companies),
    linesCompanyNotOrderCompany: n(scope.lines_company_not_order_company),
    poLinesBoundAcrossCompanies: n(scope.po_lines_bound_across_companies),
    amendmentsCompanyNotOrderCompany: n(scope.amendments_company_not_order_company),
    amendmentsWithoutCompany: n(scope.amendments_without_company),
  };
  const verdicts = [];
  if (!f.orderDocNoUniqueIndex) {
    verdicts.push({ kind: 'DOC_NO_NOT_UNIQUE_BY_INDEX', text: 'no single-column unique index on scm.mfg_sales_orders.doc_no, so nothing stops two companies holding the same SO number' });
  }
  if (f.orderDocNosDuplicated > 0 || f.lineDocNosInTwoCompanies > 0) {
    verdicts.push({ kind: 'DOC_NO_COLLISION', text: `${f.orderDocNosDuplicated} SO number(s) on two order headers, ${f.lineDocNosInTwoCompanies} SO number(s) whose lines carry two companies` });
  }
  if (f.linesCompanyNotOrderCompany > 0 || f.poLinesBoundAcrossCompanies > 0 || f.amendmentsCompanyNotOrderCompany > 0) {
    verdicts.push({ kind: 'COMPANY_DRIFT', text: `${f.linesCompanyNotOrderCompany} SO line(s) carry a company other than their order's, ${f.poLinesBoundAcrossCompanies} PO line(s) are bound to another company's SO line, ${f.amendmentsCompanyNotOrderCompany} amendment(s) carry a company other than their order's` });
  }
  if (verdicts.length === 0) {
    verdicts.push({ kind: 'NO_COLLISION', text: 'SO numbers are unique by index with no duplicate, and no line, PO binding or amendment crosses companies' });
  }
  return { facts: f, verdicts };
}

const bytesText = (b) => (b == null ? 'not sent (empty list)' : `${b} bytes`);

/** The lines a run prints for one company — counts and sizes only, never an SO
 *  number, an id or a name: the repository is public and so is every Actions log. */
export function describeCompany({ facts: f }) {
  const who = f.companyCode ? `company ${f.companyId} (${f.companyCode})` : `company ${f.companyId}`;
  const out = [
    who,
    `  SO amendments (all time)                  : ${f.amendmentsTotal} (created in the last 30 days: ${f.createdLast30Days})`,
    `  rows on the list page (newest ${LIST_WINDOW})       : ${f.pageRows}${f.pageFull ? ' (page full)' : ''} over ${f.pageDocs} sales order(s)`,
    `  "From SO amendment" rows the PO queue shows: ${f.queueRows} (in the Requested chip: ${f.queueRowsRequested})`,
    `  read A rows (SO lines)                    : ${f.lineRows} (most lines on one order: ${f.maxLinesOneOrder})`,
    `  read B rows (PO lines bound to them)      : ${f.poLineRows}`,
    `  read C rows (purchase orders)             : ${f.poRows} (assumed row ceiling ${ASSUMED_ROW_CEILING}, unmeasured)`,
    `  request line A                            : ${bytesText(f.bytes.lines)}`,
    `  request line B                            : ${bytesText(f.bytes.poLines)}`,
    `  request line C                            : ${bytesText(f.bytes.pos)}`,
    `  request line, Reference read              : ${bytesText(f.bytes.reference)} (budget ${URL_BUDGET_BYTES}; ~${REFUSED_URI_BYTES} refused before)`,
    `  lines / POs of another company on the page: ${f.linesOtherCompany} / ${f.posOtherCompany} (amendment rows affected: ${f.pageRowsWithForeignPo})`,
  ];
  if (f.projectedFullPage) {
    const p = f.projectedFullPage;
    out.push(
      `  PROJECTION (not a measurement) at a full page with this mix: ~${p.lineRows} SO lines, request line B ~${p.poLinesBytes} bytes; page full in ${p.daysToFull == null ? 'unknown (no amendment in 30 days)' : `~${p.daysToFull} day(s) at the last 30 days' rate`}`,
    );
  }
  return out;
}

/** The whole-table company facts, as printed. */
export function describeScope({ facts: f }) {
  return [
    'company scope (whole tables)',
    `  unique index on mfg_sales_orders(doc_no)  : ${f.orderDocNoUniqueIndex ? 'yes' : 'NO'}`,
    `  SO numbers on two order headers           : ${f.orderDocNosDuplicated}`,
    `  SO numbers whose lines carry two companies: ${f.lineDocNosInTwoCompanies}`,
    `  SO lines whose company != their order's   : ${f.linesCompanyNotOrderCompany}`,
    `  PO lines bound to another company's SO line: ${f.poLinesBoundAcrossCompanies}`,
    `  amendments whose company != their order's : ${f.amendmentsCompanyNotOrderCompany}`,
    `  amendments with no company (never listed) : ${f.amendmentsWithoutCompany}`,
  ];
}
