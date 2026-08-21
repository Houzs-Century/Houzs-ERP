// Read-only census: what is a delivery order left at DISPATCHED actually
// missing, compared with one that was closed?
//
// WHY THIS EXISTS
//
// 25 delivery orders have sat at DISPATCHED since 2026-07-02, and that was
// flagged as if it were a problem. The owner pushed back, correctly:
// 「出车也是要扣货啊 只是流程而已 什么影响呢？」 — the stock is already out at
// dispatch, and a dispatched DO is invoiceable. So the flag was an assertion
// nobody had evidence for.
//
// Reading the code answers "what COULD differ". It cannot answer "what IS
// different for these 25 rows" — whether they were invoiced anyway, whether
// their Sales Orders advanced, whether anything is actually waiting on them.
// That lives only in production, and the standing rule forbids putting the DSN
// in front of a human for a SELECT.
//
// It answers five questions, each chosen because a code reading produced a
// claim that this can confirm or refute:
//
//   1. THE POPULATION — every delivery order by company and status, with the
//      oldest and newest, so "25 since 2026-07-02" is a measured figure rather
//      than a remembered one.
//   2. INVOICED ANYWAY? — of the DISPATCHED ones, how many already have a Sales
//      Invoice line drawn from them. The code says a DISPATCHED DO is
//      invoiceable (`DO_NOT_INVOICEABLE_STATES` = DRAFT + CANCELLED only); if
//      the data shows them invoiced, that is settled rather than argued.
//   3. DID THE SALES ORDER ADVANCE? — the status of the SOs behind them.
//      `so-delivery-sync.ts` counts a DISPATCHED DO as delivered
//      (`DO_NOT_DELIVERED_STATES` = DRAFT + LOADED + CANCELLED), so the SO
//      should read DELIVERED. If it does not, the code reading is wrong.
//   4. WHAT THE CLOSED-ONLY MACHINERY SKIPS — how many carry no signature and
//      no photo. A DO at DISPATCHED is invisible to the POD chaser
//      (`delivery-agent.ts` filters `status IN ('DELIVERED','INVOICED')`) and to
//      the transit-days learner, so this is the size of what is not being
//      chased.
//   5. AUTOCOUNT — whether anything is queued in the outbox for them, since the
//      status PATCH has no enqueue call outside the CANCELLED branch.
//
// READING, NOT A SETTING. SELECTs only — no DDL, no writes, no transaction, one
// statement per question. Exits 0 for every legitimate answer: the ANSWER is the
// output, and a red job would read as "the check broke". Only an unreachable
// database or a query error exits non-zero.
//
// RE-RUN: safe and identical. It writes nothing.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // ── 1. THE POPULATION ────────────────────────────────────────────────────
  const pop = await pg`
    SELECT company_id,
           status::text          AS status,
           count(*)::int         AS rows,
           min(do_date)::text    AS oldest_do_date,
           max(do_date)::text    AS newest_do_date,
           count(*) FILTER (WHERE dispatched_at IS NOT NULL)::int AS has_dispatched_at,
           count(*) FILTER (WHERE delivered_at  IS NOT NULL)::int AS has_delivered_at
      FROM scm.delivery_orders
     GROUP BY company_id, status::text
     ORDER BY company_id, status::text
  `;
  console.log("── 1. every delivery order, by company and status ──");
  console.log("   company  status         rows  oldest DO   newest DO   dispatched_at  delivered_at");
  for (const r of pop) {
    console.log(
      `   ${String(r.company_id ?? "(null)").padEnd(8)} ${String(r.status).padEnd(13)}` +
        `${String(r.rows).padStart(5)}  ${String(r.oldest_do_date ?? "-").padEnd(11)}` +
        `${String(r.newest_do_date ?? "-").padEnd(11)} ${String(r.has_dispatched_at).padStart(13)}` +
        `${String(r.has_delivered_at).padStart(14)}`,
    );
  }
  const dispatched = pop
    .filter((r) => r.status === "DISPATCHED")
    .reduce((n, r) => n + Number(r.rows), 0);

  // ── 2. INVOICED ANYWAY? ──────────────────────────────────────────────────
  // A Sales Invoice line carries the DO it was drawn from. Whether the column
  // is `do_id` or something else is a schema fact, so ask information_schema
  // rather than assuming — a wrong column name here would report "0 invoiced"
  // and look like a finding.
  const siLinkCol = await pg`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'scm'
       AND table_name  IN ('sales_invoices', 'sales_invoice_items')
       AND column_name IN ('do_id', 'delivery_order_id', 'do_item_id')
     ORDER BY table_name, column_name
  `;
  console.log("");
  console.log("── 2. are the DISPATCHED ones already invoiced? ──");
  if (siLinkCol.length === 0) {
    console.log("   Neither scm.sales_invoices nor scm.sales_invoice_items carries a DO link column.");
    console.log("   Not answered here rather than guessed.");
  } else {
    for (const { table_name: tbl, column_name: col } of siLinkCol) {
      const inv = await pg.unsafe(
        `SELECT d.company_id,
                count(*)::int                        AS dispatched,
                count(*) FILTER (WHERE si.n > 0)::int AS with_invoice
           FROM scm.delivery_orders d
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS n
               FROM scm.${tbl} t
              WHERE t.${col} IS NOT NULL AND t.${col}::text = d.id::text
           ) si ON TRUE
          WHERE d.status::text = 'DISPATCHED'
          GROUP BY d.company_id
          ORDER BY d.company_id`,
      );
      if (inv.length === 0) {
        console.log(`   via scm.${tbl}.${col}: (no DISPATCHED delivery orders)`);
      }
      for (const r of inv) {
        console.log(
          `   via scm.${tbl}.${col} — company ${r.company_id}: ${r.dispatched} dispatched, ${r.with_invoice} already invoiced`,
        );
      }
    }
  }

  // ── 3. DID THE SALES ORDER ADVANCE? ──────────────────────────────────────
  console.log("");
  console.log("── 3. status of the Sales Orders behind the DISPATCHED DOs ──");
  const soStatus = await pg`
    SELECT so.status::text AS so_status, count(DISTINCT so.doc_no)::int AS sales_orders
      FROM scm.delivery_orders d
      JOIN scm.mfg_sales_orders so
        ON so.doc_no = d.so_doc_no AND so.company_id = d.company_id
     WHERE d.status::text = 'DISPATCHED'
     GROUP BY so.status::text
     ORDER BY count(*) DESC
  `;
  if (soStatus.length === 0) {
    console.log("   (none — no DISPATCHED delivery order resolves to a Sales Order)");
  }
  for (const r of soStatus) {
    console.log(`   SO status ${String(r.so_status).padEnd(14)} ${r.sales_orders}`);
  }
  const soNotDelivered = soStatus
    .filter((r) => String(r.so_status).toUpperCase() !== "DELIVERED")
    .reduce((n, r) => n + Number(r.sales_orders), 0);

  // ── 3b. WHY IS ANY OF THEM NOT DELIVERED? ────────────────────────────────
  // The first dispatch (run 32472511532) returned 15 SOs DELIVERED and 10 still
  // CONFIRMED, which CONTRADICTS the code reading — so-delivery-sync counts a
  // DISPATCHED DO as delivered. A contradiction is a finding, not something to
  // bridge, and there are two candidate explanations that lead to opposite
  // conclusions:
  //
  //   PARTIAL   — the delivery covered only part of the order. syncSoDelivered
  //               advances the SO only when EVERY deliverable line is fully
  //               covered, so a CONFIRMED SO here is the rule working. Nothing
  //               is wrong.
  //   FULL      — every line is covered and the SO still reads CONFIRMED. Then
  //               the sync did not run (or ran and did not stick) and there IS
  //               something behind these rows.
  //
  // So: for each Sales Order behind a DISPATCHED DO that is NOT yet DELIVERED,
  // compare ordered qty against delivered qty line by line. Cancelled SO lines
  // are excluded, matching every other coverage engine in the codebase.
  console.log("");
  console.log("── 3b. the not-yet-DELIVERED ones: partial delivery, or fully covered? ──");
  const coverage = await pg`
    WITH target_so AS (
      SELECT DISTINCT so.id, so.doc_no, so.company_id, so.status::text AS so_status
        FROM scm.delivery_orders d
        JOIN scm.mfg_sales_orders so
          ON so.doc_no = d.so_doc_no AND so.company_id = d.company_id
       WHERE d.status::text = 'DISPATCHED'
         AND upper(so.status::text) <> 'DELIVERED'
    ),
    delivered AS (
      SELECT doi.so_item_id, SUM(doi.qty)::numeric AS delivered_qty
        FROM scm.delivery_order_items doi
        JOIN scm.delivery_orders d ON d.id = doi.delivery_order_id
       WHERE doi.so_item_id IS NOT NULL
         AND upper(COALESCE(d.status::text, '')) NOT IN ('DRAFT', 'LOADED', 'CANCELLED')
       GROUP BY doi.so_item_id
    )
    SELECT t.doc_no,
           t.so_status,
           COUNT(soi.id)::int                                                  AS lines,
           COUNT(*) FILTER (WHERE COALESCE(del.delivered_qty, 0) >= soi.qty)::int AS lines_covered,
           SUM(soi.qty)::numeric                                               AS ordered_qty,
           SUM(COALESCE(del.delivered_qty, 0))::numeric                        AS delivered_qty
      FROM target_so t
      JOIN scm.mfg_sales_order_items soi
        ON soi.doc_no = t.doc_no AND soi.cancelled = false
      LEFT JOIN delivered del ON del.so_item_id = soi.id
     GROUP BY t.doc_no, t.so_status
     ORDER BY t.doc_no
  `;
  let fullyCoveredButNotDelivered = 0;
  if (coverage.length === 0) {
    console.log("   (none — every Sales Order behind a DISPATCHED DO reads DELIVERED)");
  } else {
    console.log("   SO doc_no        status      lines  covered  ordered  delivered  verdict");
    for (const r of coverage) {
      const full = Number(r.lines_covered) === Number(r.lines);
      if (full) fullyCoveredButNotDelivered += 1;
      console.log(
        `   ${String(r.doc_no).padEnd(16)} ${String(r.so_status).padEnd(11)}` +
          `${String(r.lines).padStart(5)}${String(r.lines_covered).padStart(9)}` +
          `${String(r.ordered_qty).padStart(9)}${String(r.delivered_qty).padStart(11)}  ` +
          (full ? "FULLY COVERED — the sync did not advance it" : "partial — sync correctly waiting"),
      );
    }
  }

  // ── 4. WHAT THE CLOSED-ONLY MACHINERY SKIPS ──────────────────────────────
  console.log("");
  console.log("── 4. proof-of-delivery evidence on the DISPATCHED ones ──");
  const pod = await pg`
    SELECT company_id,
           count(*)::int                                                AS rows,
           count(*) FILTER (WHERE signature_data IS NOT NULL)::int       AS sig_any,
           count(*) FILTER (WHERE length(signature_data) >= 2000)::int   AS sig_drawn,
           count(*) FILTER (WHERE pod_r2_key IS NOT NULL)::int           AS photo
      FROM scm.delivery_orders
     WHERE status::text = 'DISPATCHED'
     GROUP BY company_id
     ORDER BY company_id
  `;
  for (const r of pod) {
    console.log(
      `   company ${r.company_id}: ${r.rows} rows, signature!=null ${r.sig_any}, plausibly drawn ${r.sig_drawn}, photo ${r.photo}`,
    );
  }

  // ── 5. AUTOCOUNT ─────────────────────────────────────────────────────────
  // The status PATCH has no outbox enqueue outside the CANCELLED branch, so a
  // DISPATCHED->DELIVERED flip should send AutoCount nothing. What IS queued
  // for these documents came from their CREATE or an edit.
  console.log("");
  console.log("── 5. AutoCount outbox rows referencing the DISPATCHED DOs ──");
  // Columns from mig 0277: op / doc_type / doc_no / doc_id / status. The join is
  // on doc_no + company (doc_id is a nullable text mirror of the uuid), and it
  // is restricted to doc_type 'DO' so a Sales Order sharing a number cannot be
  // counted here.
  const outboxTable = await pg`
    SELECT table_schema
      FROM information_schema.tables
     WHERE table_name = 'autocount_outbox'
     ORDER BY table_schema
  `;
  if (outboxTable.length === 0) {
    console.log("   no autocount_outbox table found — not answered here rather than guessed.");
  } else {
    const sch = outboxTable[0].table_schema;
    const rows = await pg.unsafe(
      `SELECT o.op::text AS op, o.status::text AS status, count(*)::int AS rows
         FROM ${sch}.autocount_outbox o
         JOIN scm.delivery_orders d
           ON d.company_id = o.company_id AND d.do_number = o.doc_no
        WHERE o.doc_type = 'DO' AND d.status::text = 'DISPATCHED'
        GROUP BY o.op::text, o.status::text
        ORDER BY count(*) DESC`,
    );
    if (rows.length === 0) console.log(`   ${sch}.autocount_outbox holds nothing for them.`);
    for (const r of rows) console.log(`   ${r.op} / ${r.status}: ${r.rows}`);
  }

  console.log("");
  notice(
    dispatched === 0
      ? "No delivery order is sitting at DISPATCHED today. Whatever was seen has since moved or was measured differently — re-read section 1 before repeating the figure."
      : soNotDelivered === 0
        ? `${dispatched} delivery order(s) sit at DISPATCHED, and EVERY Sales Order behind them already reads DELIVERED. The order side is finished; what is outstanding is the delivery document's own closing tick, not the sale.`
        : fullyCoveredButNotDelivered === 0
          ? `${dispatched} delivery order(s) sit at DISPATCHED. ${soNotDelivered} Sales Order(s) behind them still read a pre-DELIVERED status, and section 3b shows EVERY ONE of those is a PARTIAL delivery — lines still undelivered. That is so-delivery-sync working, not failing: it advances an order only when every line is covered. Nothing here is stuck.`
          : `${dispatched} delivery order(s) sit at DISPATCHED, and ${fullyCoveredButNotDelivered} Sales Order(s) are FULLY COVERED yet still not DELIVERED. Partial delivery does not explain those — the sync did not advance them. Read section 3b; this is a real finding, separate from the DISPATCHED question.`,
  );
  process.exit(0);
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
