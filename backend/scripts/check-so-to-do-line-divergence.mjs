// Read-only: WHY A DELIVERY ORDER DOES NOT MATCH THE SALES ORDER IT CAME FROM,
// and why AutoCount refuses the ones that are stuck.
//
// The owner's question, 2026-09-08: "我们的SO 转去DO 为什么不一样呢" — asked
// about ten delivery orders the AutoCount Sync page marks NOT ACCEPTED.
//
// Two refusal shapes were already known from the outbox health report, and both
// say the same thing in different voices:
//
//   "Invalid transfer item."                  — AutoCount refused a line key.
//   "of 3 line key(s) given, only 2 exist"    — OUR OWN guard refused first
//                                               (AcSyncService KeysBySourceDoc).
//
// What was NOT known is WHICH line, and this script exists to stop that being
// guessed at. Two guesses have already died on this document family, so every
// number below is read out of the row rather than reasoned about.
//
// THE EVIDENCE IS ALREADY IN THE TABLE. On a failure the host runs
// DescribeSourceKeys and writes, for every key the ERP sent, what the account
// book holds for it — Qty, TransferedQty, Transferable, docCancelled,
// outstanding, or "NOT FOUND in SODTL". That string is stored in
// scm.autocount_outbox.last_error. Parsing it is reading the BOOK's answer, not
// re-deriving one.
//
// REDACTION IS NOT OPTIONAL HERE. This repository and its Actions logs are
// PUBLIC. last_error carries item codes and, on some rows, a customer name, so
// it is NEVER printed verbatim: only the structured per-key fields are lifted
// out, the [ITEM-CODE] bracket is dropped, and the free-text tail is classified
// into a reason code. Document numbers, counts and flags are safe and are what
// make the answer actionable.
//
// Strictly read-only: SELECTs only, no DDL, no writes, no transaction. Exits 0
// for every legitimate answer including "nothing is failing" — a red job reads
// as "the check broke" and the ANSWER is the output. Only an unreachable
// database exits non-zero.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error('No DATABASE_URL. Dispatch the workflow, or set it locally.');
  process.exit(1);
}

/* The SERVICE-line rule, mirrored from scm/shared/service-sku.ts in SQL.
   isServiceLine = item_group contains SERVICE, OR item_code starts with SVC-
   and is longer than the prefix (hence the underscore — a bare "SVC-" is not a
   code). Kept as one expression so the two line tables cannot drift apart. */
const SERVICE_SQL = (t) =>
  `(upper(coalesce(${t}.item_group, '')) LIKE '%SERVICE%'
    OR upper(coalesce(${t}.item_code, '')) LIKE 'SVC-_%')`;

/* One key's row as the BOOK described it. Everything inside [] is an item code
   and is dropped on the floor before anything is printed. */
function parseKeyFacts(text) {
  const out = [];
  if (!text) return out;
  for (const m of text.matchAll(/(\d{5,})\s+NOT FOUND in (\w+)/g)) {
    out.push({ key: m[1], found: false, table: m[2] });
  }
  const re = /(\d{5,}) on (SO|PO|DO|GR) (\S+) \[[^\]]*\] Qty=(\S+) TransferedQty=(\S+) Transferable=(\S+) docCancelled=(\S+) outstanding=(\S+)/g;
  for (const m of text.matchAll(re)) {
    out.push({
      key: m[1], found: true, srcType: m[2], srcDocNo: m[3],
      qty: m[4], transferred: m[5], transferable: m[6],
      cancelled: m[7], outstanding: m[8],
    });
  }
  return out;
}

/* The failure, as a CODE. The free text is never printed; this is what stands
   in for it, and each value has a different remedy. */
function classify(text) {
  const t = (text || '').toLowerCase();
  if (!t) return 'no_error_recorded';
  if (t.includes('exist on a')) return 'our_guard_key_not_in_book';
  if (t.includes('invalid transfer item')) return 'autocount_refused_the_line';
  if (t.includes('debtor code is empty')) return 'no_customer_on_target';
  if (t.includes('no transferable lines')) return 'nothing_left_to_transfer';
  if (t.includes('timeout') || t.includes('timed out')) return 'host_timeout';
  if (t.includes('fetch failed') || t.includes('econnrefused')) return 'host_unreachable';
  return 'other';
}

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  const failed = await pg`
    SELECT doc_no, doc_id, attempts, status, created_at, last_error,
           payload #> '{body,DtlKeys}' AS sent_keys
      FROM scm.autocount_outbox
     WHERE op = 'so_to_do' AND status IN ('failed', 'pending')
     ORDER BY created_at DESC`;

  console.log('=== 1. THE REFUSALS, CLASSIFIED ===');
  console.log(`so_to_do rows not yet in the book: ${failed.length}`);
  const byReason = new Map();
  for (const r of failed) {
    const code = classify(r.last_error);
    byReason.set(code, (byReason.get(code) ?? 0) + 1);
  }
  for (const [code, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${code}`);
  }

  console.log('');
  console.log('=== 2. WHAT THE BOOK SAID ABOUT EVERY KEY WE SENT ===');
  console.log('(lifted from the host DescribeSourceKeys dump; item codes dropped)');
  const stuckDocIds = [];
  for (const r of failed) {
    const facts = parseKeyFacts(r.last_error);
    const sent = Array.isArray(r.sent_keys) ? r.sent_keys.length : null;
    const notFound = facts.filter((f) => !f.found).length;
    const notTransferable = facts.filter((f) => f.found && !/^t/i.test(f.transferable)).length;
    const docCancelled = facts.filter((f) => f.found && /^t/i.test(f.cancelled)).length;
    const nothingLeft = facts.filter((f) => f.found && Number(f.outstanding) <= 0).length;
    const srcDocs = new Set(facts.filter((f) => f.found).map((f) => f.srcDocNo));
    console.log(
      `  ${r.doc_no}  status=${r.status} tries=${r.attempts}  reason=${classify(r.last_error)}`
      + `  keysSent=${sent ?? 'none-in-payload'} described=${facts.length}`
      + `  NOTinBook=${notFound} notTransferable=${notTransferable} sourceCancelled=${docCancelled} alreadyShipped=${nothingLeft}`
      + `  sourceDocs=${srcDocs.size}`,
    );
    if (r.doc_id) stuckDocIds.push(r.doc_id);
  }

  console.log('');
  console.log('=== 3. THE SAME DOCUMENTS, AS THE ERP HOLDS THEM ===');
  console.log('(does every DO line name a sales-order line, and does that line carry a book key)');
  if (!stuckDocIds.length) {
    console.log('  no stuck row carries a doc_id, so the ERP side cannot be joined');
  } else {
    const shape = await pg.unsafe(`
      SELECT d.do_number,
             count(*)::int                                              AS do_lines,
             count(*) FILTER (WHERE di.so_item_id IS NULL)::int          AS lines_with_no_so_line,
             count(*) FILTER (WHERE ${SERVICE_SQL('di')})::int           AS do_service_lines,
             count(*) FILTER (WHERE di.so_item_id IS NOT NULL
                              AND si.linked_ac_dtlkey IS NULL)::int      AS so_lines_with_no_book_key,
             count(*) FILTER (WHERE di.so_item_id IS NOT NULL
                              AND ${SERVICE_SQL('si')}
                              AND si.linked_ac_dtlkey IS NULL)::int      AS service_so_lines_with_no_key,
             count(DISTINCT si.doc_no)::int                              AS source_sales_orders
        FROM scm.delivery_orders d
        JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
        LEFT JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
       WHERE d.id = ANY($1::uuid[])
       GROUP BY d.do_number
       ORDER BY d.do_number`, [stuckDocIds]);
    for (const s of shape) {
      console.log(
        `  ${s.do_number}  DOlines=${s.do_lines} noSOline=${s.lines_with_no_so_line}`
        + ` serviceLines=${s.do_service_lines} SOlineNoBookKey=${s.so_lines_with_no_book_key}`
        + ` (ofWhichService=${s.service_so_lines_with_no_key}) sourceSOs=${s.source_sales_orders}`,
      );
    }

    console.log('');
    console.log('=== 4. AND THE SALES ORDERS BEHIND THEM ===');
    console.log('(the whole SO, not just the shipped part — a partial transfer is refused when ANY line lacks a key)');
    const parents = await pg.unsafe(`
      WITH src AS (
        SELECT DISTINCT si.doc_no
          FROM scm.delivery_orders d
          JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
          JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
         WHERE d.id = ANY($1::uuid[])
      )
      SELECT si.doc_no,
             count(*)::int                                                     AS so_lines,
             count(*) FILTER (WHERE si.linked_ac_dtlkey IS NULL)::int          AS no_book_key,
             count(*) FILTER (WHERE ${SERVICE_SQL('si')})::int                 AS service_lines,
             count(*) FILTER (WHERE ${SERVICE_SQL('si')}
                              AND si.linked_ac_dtlkey IS NULL)::int            AS service_lines_no_key
        FROM scm.mfg_sales_order_items si
        JOIN src ON src.doc_no = si.doc_no
       GROUP BY si.doc_no
       ORDER BY si.doc_no`, [stuckDocIds]);
    for (const p of parents) {
      console.log(
        `  ${p.doc_no}  SOlines=${p.so_lines} noBookKey=${p.no_book_key}`
        + ` serviceLines=${p.service_lines} (serviceWithNoKey=${p.service_lines_no_key})`,
      );
    }
  }

  console.log('');
  console.log('=== 5. IS THIS THE WHOLE SYSTEM OR JUST THESE TEN ===');
  const pop = await pg.unsafe(`
    SELECT count(DISTINCT d.id)::int                                          AS delivery_orders,
           count(DISTINCT d.id) FILTER (WHERE di.so_item_id IS NULL)::int     AS with_a_line_naming_no_so,
           count(DISTINCT d.id) FILTER (WHERE ${SERVICE_SQL('di')})::int      AS carrying_a_service_line,
           count(DISTINCT d.id) FILTER (WHERE di.so_item_id IS NOT NULL
                                        AND si.linked_ac_dtlkey IS NULL)::int AS with_a_source_line_missing_its_key
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id`);
  const p0 = pop[0];
  console.log(`  delivery orders in the ERP: ${p0.delivery_orders}`);
  console.log(`    with a line that names no sales-order line: ${p0.with_a_line_naming_no_so}`);
  console.log(`    carrying at least one SERVICE line:         ${p0.carrying_a_service_line}`);
  console.log(`    whose source line carries no book key:      ${p0.with_a_source_line_missing_its_key}`);

  console.log('');
  console.log('=== 6. SERVICE LINES, END TO END ===');
  console.log('(a fee line exists in the ERP; does it exist in the account book?)');
  const svc = await pg.unsafe(`
    SELECT count(*)::int                                                AS service_so_lines,
           count(*) FILTER (WHERE si.linked_ac_dtlkey IS NOT NULL)::int  AS with_a_book_key,
           count(*) FILTER (WHERE si.linked_ac_dtlkey IS NULL)::int      AS without_a_book_key
      FROM scm.mfg_sales_order_items si
     WHERE ${SERVICE_SQL('si')}`);
  const s0 = svc[0];
  console.log(`  SERVICE lines on sales orders: ${s0.service_so_lines}`);
  console.log(`    carrying an AutoCount line key: ${s0.with_a_book_key}`);
  console.log(`    carrying none:                  ${s0.without_a_book_key}`);

  const goods = await pg.unsafe(`
    SELECT count(*)::int                                              AS goods_so_lines,
           count(*) FILTER (WHERE si.linked_ac_dtlkey IS NULL)::int    AS without_a_book_key
      FROM scm.mfg_sales_order_items si
     WHERE NOT ${SERVICE_SQL('si')}`);
  const g0 = goods[0];
  console.log(`  GOODS lines on sales orders:   ${g0.goods_so_lines}`);
  console.log(`    carrying none:                  ${g0.without_a_book_key}`);
  console.log('');
  console.log('READ IT LIKE THIS: if the SERVICE row is the one with no key, the fee line');
  console.log('is what AutoCount cannot take. If GOODS lines are missing keys too, it is not');
  console.log('about fees at all and the line-key backfill is the answer.');
} catch (e) {
  console.error('DB unreachable or query failed:', e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
