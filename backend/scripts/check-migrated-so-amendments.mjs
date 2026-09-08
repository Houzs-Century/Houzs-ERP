#!/usr/bin/env node
// Read-only report: SO amendments that are still OPEN on a MIGRATED sales order.
//
// WHY THIS EXISTS. `docs/migrated-so-lock.md` §7 records the hole this answers:
// the migrated-SO lock is mounted at `/mfg-sales-orders/*`, so no NEW amendment
// can be raised on a migrated order — `POST /:docNo/amendments` is behind the
// guard — but `/so-amendments/:id/*` sits on a DIFFERENT prefix, and an
// amendment that was ALREADY OPEN when the lock shipped could still be driven
// through approve-so, which runs `applySoAmendment` and rewrites the migrated
// order's header and lines in place.
//
// Before that path is closed, somebody has to know how big it is: how many open
// amendments are sitting on migrated orders right now, and in which state. That
// is a fact that lives only in production, and the repo rule is to build the
// check rather than ask the owner to run a query (CLAUDE.md, "Never ask the
// owner to run a query"). Twin of backend/scripts/check-write-freeze.mjs.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer, INCLUDING zero rows — "there are none" is the answer, not a
// failure. Only an unreachable database exits non-zero.
//
// RE-RUN: safe, and the intended use — the count moves as staff resolve
// amendments, so it is a snapshot and must be re-read at the moment it is
// quoted, never recalled from an earlier run.
import { readFileSync } from "node:fs";
import postgres from "postgres";

/* The four non-terminal states of the amendment machine
   (backend/src/scm/shared/so-amendment.ts): SENT and REJECTED are terminal —
   'withdraw' lands on REJECTED too, so there is no third terminal value. An
   amendment in any other state can still be driven forward by a PATCH. */
const OPEN_STATUSES = ["REQUESTED", "SUPPLIER_PENDING", "SO_APPROVED", "PO_APPROVED"];

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

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARNING: ${m}`);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  /* DENOMINATORS FIRST. A count of open-on-migrated means nothing without the
     population it came out of, and the owner's rule is that every number
     carries its denominator. */
  const [totals] = await sql`
    SELECT
      count(*)::int                                                        AS amendments_all,
      count(*) FILTER (WHERE status = ANY(${OPEN_STATUSES}))::int          AS amendments_open
    FROM scm.so_amendments
  `;
  const [soTotals] = await sql`
    SELECT
      count(*)::int                                             AS so_all,
      count(*) FILTER (WHERE linked_ac_docno IS NOT NULL)::int   AS so_migrated
    FROM scm.mfg_sales_orders
  `;

  /* The population that matters: an amendment whose bound SO carries
     linked_ac_docno — the SAME predicate the lock uses
     (backend/src/scm/lib/so-is-migrated.ts). Joined, never inferred from the
     doc-number prefix: `HC-` is a company prefix, not a migration marker, and a
     natively created HC order carries it too. */
  const rows = await sql`
    SELECT a.status,
           so.company_id,
           count(*)::int AS n
      FROM scm.so_amendments a
      JOIN scm.mfg_sales_orders so ON so.doc_no = a.so_doc_no
     WHERE so.linked_ac_docno IS NOT NULL
       AND a.status = ANY(${OPEN_STATUSES})
     GROUP BY a.status, so.company_id
     ORDER BY so.company_id, a.status
  `;

  const detail = await sql`
    SELECT a.id, a.so_doc_no, a.amendment_no, a.status, a.lane,
           so.company_id, so.linked_ac_docno, a.created_at, a.updated_at
      FROM scm.so_amendments a
      JOIN scm.mfg_sales_orders so ON so.doc_no = a.so_doc_no
     WHERE so.linked_ac_docno IS NOT NULL
       AND a.status = ANY(${OPEN_STATUSES})
     ORDER BY so.company_id, a.created_at
     LIMIT 200
  `;

  const openOnMigrated = rows.reduce((s, r) => s + r.n, 0);

  log(
    `OPEN amendments on MIGRATED sales orders: ${openOnMigrated}`
    + ` (of ${totals.amendments_open} open amendments in all,`
    + ` ${totals.amendments_all} amendments ever)`,
  );
  log(
    `migrated sales orders: ${soTotals.so_migrated} of ${soTotals.so_all}`
    + " (predicate: mfg_sales_orders.linked_ac_docno IS NOT NULL)",
  );

  if (openOnMigrated === 0) {
    /* Zero is an ANSWER, not an absence of one. Say it plainly and exit 0 — the
       guard being shipped is still worth shipping, because it stops the NEXT
       one, and a count taken now can be non-zero an hour later. */
    log("NONE. No amendment can currently be approved through /so-amendments/:id/* onto a migrated order.");
  } else {
    warn(`${openOnMigrated} amendment(s) could be driven forward onto a migrated order.`);
    for (const r of rows) warn(`  company ${r.company_id}  ${r.status}  ${r.n}`);
    for (const d of detail) {
      log(
        `  ${d.so_doc_no}  amd ${d.amendment_no ?? d.id}  ${d.status}`
        + `  lane=${d.lane ?? "(legacy)"}  ac=${d.linked_ac_docno}`
        + `  raised ${d.created_at?.toISOString?.() ?? d.created_at}`,
      );
    }
    if (detail.length === 200) warn("detail list capped at 200 rows; the COUNT above is complete.");
  }

  log("read-only: this script never writes. The lock itself is scm.app_config 'scm.migrated_so_lock'.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
