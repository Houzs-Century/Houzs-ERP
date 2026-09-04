// Reconcile sales orders whose delivery order was IMPORTED, not created here.
//
// WHAT THE OWNER SAW (2026-09-04), on the Houzs Century board:
//   「为什么我全部都是 ready to ship 的？我没有单是已经送货了的吗？送货了的应该
//     已经是去 delivered 了。」
// 2,770 sales orders, and the DELIVERED tile does not merely read zero — the
// status does not appear in company 1's data at all, while 2990 has 55.
//
// WHAT WAS MEASURED, not assumed (check-so-status-truth, run 33852430695):
//   company 1: 71 delivery orders, and ALL 71 are already DELIVERED
//   company 1: 61 sales orders carry a live delivery order and sit earlier
//   company 1: 0 sales orders are DELIVERED
// Two guesses died on the way to that. First: "the delivery orders were never
// migrated" — there are 71. Second: "they are stuck at DISPATCHED like 2990's
// were in July" (backfill-2990-delivered-dos.mjs) — they are not, every one
// says DELIVERED. The account of what is wrong had to survive both.
//
// ROOT CAUSE. `syncSoDeliveredFromDo` is what advances a sales order once its
// delivery order covers it, and every caller of it is an ERP DELIVERY-ORDER
// ROUTE (delivery-orders-mfg, delivery-order-revert, publicDoScan). A delivery
// order that arrived by IMPORT never travelled a route, so the reconciliation
// never ran for it — not once, for any of the 71. Nothing is wrong with the
// delivery orders and nothing is wrong with the rule; they were simply never
// introduced to each other.
//
// REUSE, NOT REPLICATION. This runs the REAL `syncSoDeliveredFromDo` over
// lib/pgrest-shim.mjs on DATABASE_URL alone — the same function every DO route
// triggers. It contains NO coverage logic of its own, which matters more here
// than usual: the rule is deliberately conservative (Loo, 2026-05-30 — an order
// flips only when EVERY non-cancelled line is fully covered, so a partial
// delivery correctly stays where it is), and a second copy of that judgement
// would be the thing that marks a half-shipped order delivered.
//
// The real function has no dry-run, so this wraps it the way
// recompute-so-allocation.mjs does:
//   PLAN (default): BEGIN -> snapshot -> run canonical -> snapshot -> ROLLBACK.
//     The exact APPLY effect, with nothing persisted.
//   APPLY=1 + CONFIRM_COMPANY=<id>: the same flow, COMMIT.
//
// VERIFY re-reads on a FRESH CONNECTION and asserts the SHAPE, not a count: a
// row count would be equally true of an order advanced for the wrong reason.
// Every order it claims to have delivered must (a) read DELIVERED and (b) still
// carry a live delivery order.
//
// RE-RUN: idempotent, and idempotent in BOTH directions — the canonical
// function also releases a DELIVERED order back to READY_TO_SHIP when its
// coverage no longer holds. A second APPLY plans zero changes.
//
// Env: DATABASE_URL (the only credential). COMPANY=<id> scopes it (default 1).
// Run under tsx (TS imports): npx tsx scripts/repair-so-delivered-from-imported-dos.mjs
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { syncSoDeliveredFromDo } from '../src/scm/lib/so-delivery-sync';

const APPLY = process.env.APPLY === '1';
const COMPANY = Number(process.env.COMPANY || 1);
const CONFIRM_COMPANY = (process.env.CONFIRM_COMPANY || '').trim();

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

function fromDevVars(field) {
  try {
    return readFileSync('.dev.vars', 'utf8').match(new RegExp(`^${field}="?([^"\\n]+)"?`, 'm'))?.[1];
  } catch {
    return undefined;
  }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars('DATABASE_URL');
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
  process.exit(1);
}

/* The CONFIRM is the company id, repeated. It is stronger than a fixed phrase
   for the same reason delete-test-so.mjs asks for the document number: the
   value you must repeat is the value that decides the blast radius, so a
   copy-pasted command cannot silently apply to the other company's books. */
if (APPLY && CONFIRM_COMPANY !== String(COMPANY)) {
  console.error(`REFUSED: APPLY=1 needs CONFIRM_COMPANY=${COMPANY} (got '${CONFIRM_COMPANY}').`);
  console.error('The confirm value is the company id so a pasted command cannot hit the wrong books.');
  process.exit(1);
}

const pg = postgres(DATABASE_URL, { ssl: 'require', prepare: false, max: 1 });

/** The orders in scope: a live delivery order, and a status earlier than
 *  delivered. The canonical function decides what happens to them. */
async function candidates() {
  const rows = await pg`
    SELECT DISTINCT s.doc_no, s.status::text AS status
      FROM scm.mfg_sales_orders s
      JOIN scm.delivery_orders d ON d.so_doc_no = s.doc_no
     WHERE s.company_id = ${COMPANY}
       AND upper(s.status::text) IN ('CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED')
       AND upper(coalesce(d.status::text, '')) NOT IN ('CANCELLED', 'DRAFT')
     ORDER BY s.doc_no`;
  return rows.map((r) => ({ docNo: r.doc_no, status: r.status }));
}

async function snapshot(docNos) {
  if (!docNos.length) return new Map();
  const rows = await pg`
    SELECT doc_no, status::text AS status FROM scm.mfg_sales_orders
     WHERE doc_no = ANY(${docNos})`;
  return new Map(rows.map((r) => [r.doc_no, r.status]));
}

async function main() {
  notice(`mode: ${APPLY
    ? `APPLY (one transaction, COMMITTED) company=${COMPANY}`
    : `PLAN (the canonical function runs inside a transaction and is ROLLED BACK — nothing persisted) company=${COMPANY}`}`);

  const scope = await candidates();
  notice(`candidates: ${scope.length} sales order(s) with a live delivery order and a pre-delivered status`);
  if (!scope.length) {
    notice('nothing to do.');
    return;
  }
  const docNos = scope.map((s) => s.docNo);

  /* SERIALIZED savepoints, per docs/bugs/0562: Postgres releases a savepoint
     together with every savepoint made after it, so interleaved triads destroy
     each other. One statement's triad at a time. */
  let spN = 0;
  let spChain = Promise.resolve();
  const spSql = {
    unsafe: (text, params) => {
      const run = async () => {
        spN += 1;
        const sp = `pgrest_sp_${spN}`;
        await pg.unsafe(`SAVEPOINT ${sp}`);
        try {
          const rows = await pg.unsafe(text, params);
          await pg.unsafe(`RELEASE SAVEPOINT ${sp}`);
          return rows;
        } catch (e) {
          await pg.unsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw e;
        }
      };
      const next = spChain.then(run, run);
      spChain = next.then(() => undefined, () => undefined);
      return next;
    },
  };
  const sb = pgrestShim(spSql, 'scm');

  let before;
  let after;
  await pg.unsafe('BEGIN');
  try {
    before = await snapshot(docNos);
    await syncSoDeliveredFromDo(sb, docNos, null);
    after = await snapshot(docNos);
    if (APPLY) await pg.unsafe('COMMIT');
    else await pg.unsafe('ROLLBACK');
  } catch (e) {
    try { await pg.unsafe('ROLLBACK'); } catch { /* connection-level failure */ }
    throw e;
  }

  const moved = [];
  for (const docNo of docNos) {
    const from = before.get(docNo);
    const to = after.get(docNo);
    if (from !== to) moved.push({ docNo, from, to });
  }
  notice(`${APPLY ? 'ADVANCED' : 'WOULD ADVANCE'}: ${moved.length} of ${docNos.length}`);
  for (const m of moved.slice(0, 30)) notice(`  ${m.docNo}  ${m.from} -> ${m.to}`);
  if (moved.length > 30) notice(`  ... and ${moved.length - 30} more`);

  /* THE ONES THAT STAY ARE NOT FAILURES. The rule is deliberately conservative:
     a partially delivered order keeps its status until every line is covered.
     Saying so here stops the next reader reading the remainder as a shortfall. */
  const stayed = docNos.length - moved.length;
  if (stayed > 0) {
    notice(`${stayed} stayed where they are — the coverage rule requires EVERY non-cancelled`
      + ' line to be fully delivered, so a partial delivery correctly does not advance.');
  }

  /* WHY THEY STAYED — the section this script did not have on its first run, and
     needed within the hour.

     PLAN reported "0 of 61 would advance" and that refuted the account of the
     defect I had just written. A plan that says only how many moved cannot tell
     a conservative rule doing its job from an engine with nothing to read. The
     two are opposite findings and they look identical from the outside, so the
     script has to distinguish them itself.

     `isSoFullyCovered` sums DO line QUANTITIES per sales-order line — and an
     unlinked DO line is attributed by item code first (do-unlinked-coverage), so
     a missing `so_item_id` is NOT the explanation on its own. What no attribution
     can survive is a delivery order with NO LINE ROWS AT ALL: a header-only
     import leaves nothing to attribute, coverage is zero for every line, and the
     order can never advance however complete the shipment really was. */
  const why = await pg`
    SELECT s.doc_no,
           (SELECT count(*) FROM scm.mfg_sales_order_items i
             WHERE i.doc_no = s.doc_no AND coalesce(i.cancelled, false) = false)::int AS so_lines,
           (SELECT count(*) FROM scm.delivery_order_items di
              JOIN scm.delivery_orders d2 ON d2.id = di.delivery_order_id
             WHERE d2.so_doc_no = s.doc_no
               AND upper(coalesce(d2.status::text, '')) NOT IN ('CANCELLED', 'DRAFT'))::int AS do_lines,
           (SELECT count(*) FROM scm.delivery_order_items di
              JOIN scm.delivery_orders d2 ON d2.id = di.delivery_order_id
             WHERE d2.so_doc_no = s.doc_no
               AND di.so_item_id IS NOT NULL
               AND upper(coalesce(d2.status::text, '')) NOT IN ('CANCELLED', 'DRAFT'))::int AS do_lines_linked
      FROM scm.mfg_sales_orders s
     WHERE s.doc_no = ANY(${docNos})
     ORDER BY s.doc_no`;
  const noDoLines = why.filter((r) => r.do_lines === 0);
  const someUnlinked = why.filter((r) => r.do_lines > 0 && r.do_lines_linked < r.do_lines);
  notice('WHY THEY STAYED:');
  notice(`  ${noDoLines.length} of ${why.length} have a delivery order with NO LINE ROWS AT ALL —`
    + ' nothing to attribute, so coverage is zero however complete the shipment was.'
    + ' A header-only import looks exactly like this.');
  notice(`  ${someUnlinked.length} have delivery-order lines that carry no sales-order line`
    + ' pointer (attributed by item code, so not fatal on their own).');
  notice(`  ${why.length - noDoLines.length} have delivery-order lines to read.`);
  for (const r of why.slice(0, 10)) {
    notice(`  ${r.doc_no}: ${r.so_lines} SO line(s), ${r.do_lines} DO line(s)`
      + ` (${r.do_lines_linked} linked)`);
  }
  if (why.length > 10) notice(`  ... and ${why.length - 10} more`);

  if (!APPLY) {
    notice('PLAN only — nothing was written. Re-run with APPLY=1 and CONFIRM_COMPANY='
      + `${COMPANY} to commit.`);
    return;
  }

  /* VERIFY on a FRESH connection, and assert the SHAPE. A count would be just as
     true of an order advanced for the wrong reason. */
  const fresh = postgres(DATABASE_URL, { ssl: 'require', prepare: false, max: 1 });
  try {
    const advanced = moved.filter((m) => m.to === 'DELIVERED').map((m) => m.docNo);
    if (!advanced.length) {
      notice('VERIFY: nothing was advanced to DELIVERED, so there is no shape to check.');
      return;
    }
    const rows = await fresh`
      SELECT s.doc_no, s.status::text AS status,
             (SELECT count(*) FROM scm.delivery_orders d
               WHERE d.so_doc_no = s.doc_no
                 AND upper(coalesce(d.status::text, '')) NOT IN ('CANCELLED', 'DRAFT'))::int AS live_dos
        FROM scm.mfg_sales_orders s
       WHERE s.doc_no = ANY(${advanced})`;
    const bad = rows.filter((r) => r.status !== 'DELIVERED' || r.live_dos < 1);
    if (bad.length || rows.length !== advanced.length) {
      warn(`VERIFY FAILED: ${bad.length} of ${rows.length} do not hold the expected shape`
        + ` (read back ${rows.length} of ${advanced.length} asked for).`);
      for (const r of bad.slice(0, 10)) warn(`  ${r.doc_no} status=${r.status} liveDOs=${r.live_dos}`);
      process.exitCode = 1;
      return;
    }
    notice(`VERIFY: ${rows.length} of ${rows.length} read DELIVERED on a fresh connection and`
      + ' each still carries at least one live delivery order.');
  } finally {
    await fresh.end({ timeout: 5 });
  }
}

try {
  await main();
} finally {
  await pg.end({ timeout: 5 });
}
