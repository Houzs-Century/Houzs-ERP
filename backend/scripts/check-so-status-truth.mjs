#!/usr/bin/env node
/* check-so-status-truth — does the sales-order BOARD say what the data says?
 *
 * WHY IT EXISTS. The owner, 2026-09-04, looking at the Houzs Century board:
 *
 *   「为什么这一个明明没有 processing date，却是在 in production 的地方？」
 *   「为什么我全部都是 ready to ship 的？我没有单是已经送货了的吗？」
 *
 * Two questions about the same thing — whether a status TILE is telling the
 * truth — and neither can be answered by opening one order.
 *
 * WHAT MAKES THEM ANSWERABLE TOGETHER. Status here is written at a TRANSITION,
 * never derived on read (scm/shared/so-proceeded-status.ts says so in its own
 * words: "the PROCEED is the transition, not the presence"). That is a
 * deliberate design — but it means a row that ARRIVED in a status, from the
 * AutoCount migration, was never subject to either rule and nothing will ever
 * correct it. So the interesting number is not "what is the rule" but "how many
 * rows does the rule not describe".
 *
 * READ-ONLY. SELECTs on one connection, no DDL, no writes, no transaction.
 * Exit 0 for every legitimate answer — a count of zero and a count of hundreds
 * are both answers; non-zero is reserved for a database it cannot reach.
 *
 * SAFE IN A PUBLIC LOG. This repository is public and its Actions logs are
 * readable. It prints counts and DOCUMENT NUMBERS — the same thing the outbox
 * health check already prints — and never a customer, an item code, an address
 * or an amount.
 *
 * `status` IS AN ENUM (`scm.mfg_so_status`), not text, so every comparison casts
 * it: `upper(status::text)`. Without the cast Postgres answers
 * `function upper(scm.mfg_so_status) does not exist` and the check dies AFTER
 * printing its first section, which reads like a partial answer rather than a
 * broken query.
 *
 * RE-RUN: idempotent. It reads and prints, and holds no state between runs.
 */
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
  console.error('check-so-status-truth: no DATABASE_URL.');
  process.exit(1);
}

/** How many document numbers to name per finding. The COUNTS are always whole. */
const SAMPLE = Number(process.env.SAMPLE || 12);

const pg = postgres(url, { max: 1, prepare: false, idle_timeout: 5 });
const note = (s) => console.log(`::notice::${s}`);

try {
  /* 1. THE BOARD, as the tiles count it. */
  const board = await pg`
    SELECT company_id, status, count(*)::int AS n
      FROM scm.mfg_sales_orders
     GROUP BY company_id, status
     ORDER BY company_id, status`;
  note('SALES ORDER BOARD — every company, every status');
  for (const r of board) note(`  company ${r.company_id}  ${r.status}  ${r.n}`);

  /* 2. IN PRODUCTION WITH NO PROCESSING DATE.
     The forward rule moves CONFIRMED -> IN_PRODUCTION when a date is SET, and
     the backward rule moves it back when a date is CLEARED. Neither has ever
     seen a row that arrived carrying the status and no date. */
  const noDate = await pg`
    SELECT company_id, doc_no
      FROM scm.mfg_sales_orders
     WHERE upper(status::text) = 'IN_PRODUCTION'
       AND coalesce(trim(processing_date::text), '') = ''
     ORDER BY company_id, doc_no`;
  note(`IN PRODUCTION WITH NO PROCESSING DATE: ${noDate.length} — the status was never`
    + ' written by either rule, so nothing will correct it on its own.');
  for (const r of noDate.slice(0, SAMPLE)) note(`  company ${r.company_id}  ${r.doc_no}`);
  if (noDate.length > SAMPLE) note(`  ... and ${noDate.length - SAMPLE} more`);

  /* 3. THE MIRROR CASE, which tells you whether the FORWARD rule is working:
     a date present and the order still sitting in CONFIRMED. */
  const datedConfirmed = await pg`
    SELECT company_id, count(*)::int AS n
      FROM scm.mfg_sales_orders
     WHERE upper(status::text) = 'CONFIRMED'
       AND coalesce(trim(processing_date::text), '') <> ''
     GROUP BY company_id ORDER BY company_id`;
  note('CONFIRMED BUT CARRYING A PROCESSING DATE (the forward rule\'s misses):');
  if (!datedConfirmed.length) note('  none');
  for (const r of datedConfirmed) note(`  company ${r.company_id}  ${r.n}`);

  /* 4. WHY NOTHING IS DELIVERED. A sales order reaches DELIVERED through a
     delivery order; if none was ever created for a company, the tile CANNOT be
     anything but zero and the board is not wrong, it is empty. */
  const dos = await pg`
    SELECT company_id, count(*)::int AS n,
           count(*) FILTER (WHERE so_doc_no IS NOT NULL)::int AS linked
      FROM scm.delivery_orders
     GROUP BY company_id ORDER BY company_id`;
  note('DELIVERY ORDERS THAT EXIST AT ALL, per company:');
  if (!dos.length) note('  none, in any company');
  for (const r of dos) note(`  company ${r.company_id}  ${r.n} DO(s), ${r.linked} carry a sales-order number`);

  /* 5. THE ONE THAT WOULD BE A REAL DEFECT: a sales order that HAS a delivery
     order and is still not marked delivered. */
  const shipped = await pg`
    SELECT s.company_id, s.doc_no, s.status
      FROM scm.mfg_sales_orders s
     WHERE upper(s.status::text) IN ('CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP')
       AND EXISTS (SELECT 1 FROM scm.delivery_orders d
                    WHERE d.so_doc_no = s.doc_no
                      AND upper(coalesce(d.status::text, '')) NOT IN ('CANCELLED', 'DRAFT'))
     ORDER BY s.company_id, s.doc_no`;
  note(`SHIPPED BUT NOT MARKED DELIVERED: ${shipped.length} — these have a live`
    + ' delivery order and the sales order still sits earlier on the board.');
  for (const r of shipped.slice(0, SAMPLE)) note(`  company ${r.company_id}  ${r.doc_no}  ${r.status}`);
  if (shipped.length > SAMPLE) note(`  ... and ${shipped.length - SAMPLE} more`);
} catch (e) {
  console.error(`check-so-status-truth: the database could not be read — ${e.message}`);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
