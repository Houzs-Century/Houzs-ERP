#!/usr/bin/env node
/* repair-line-delivery-date-override — honour the per-line delivery date the
 * account book actually carries, on the SIX lines where the book confirms it.
 *
 * THE FAULT. `effectiveSoDelivery` uses a line's own delivery date only when
 * `line_delivery_date_overridden` is true; otherwise the header date wins. The
 * cutover copied AutoCount's per-line `SODTL.DeliveryDate` into
 * `line_delivery_date` and did NOT set that switch, so where the book gives a
 * line its own date the ERP silently promises the header date instead.
 *
 * Longest gap repaired here: `HC-SO-001920` (ALVEN) — the book says 2025-09-13
 * on four lines, the ERP promises 2025-07-19. Fifty-six days early.
 *
 * ── WHY SIX AND NOT NINE. Three populations look identical in SQL ───────────
 *
 * Nine live lines carry a line date with the switch off AND a date that differs
 * from the header. Each was checked against the book ONE BY ONE over ZeroTier,
 * and they are not the same thing:
 *
 *   6  THE BOOK CONFIRMS a different per-line date.  -> repaired here.
 *      HC-SO-001920 (x4), HC-SO-002069, HC-SO-000814
 *      (a seventh, HC-SO-013495, had its dates CLEARED by somebody between the
 *      measurement and the repair — see the note on VERIFIED below)
 *
 *   1  THE BOOK DOES NOT HAVE THAT DATE AT ALL.  HC-SO-000517's SOFT PILLOW
 *      reads 2026-08-28 in the ERP; all six lines of SO-000517 read 2026-08-27
 *      in AutoCount. Honouring it would invent a day of delay. NOT touched.
 *
 *   1  A STALE MIRROR LEFT BY A RESCHEDULE.  2990-SO-2607-023's line date
 *      EQUALS the customer date (2026-10-05); the order was later amended
 *      EARLIER to 2026-08-08, and the amendment cascade watches
 *      `customerDeliveryDate`, not `amendedDeliveryDate`, so the line kept the
 *      pre-amendment value. The system ignoring it is CORRECT — switching it on
 *      would push a READY_TO_SHIP order two months later. NOT touched.
 *
 * A blanket "set the switch where the dates differ" would have shipped both of
 * those. The population is therefore PINNED by (doc_no, item_code, line date)
 * rather than re-derived, and the script REFUSES if the tree it finds is not
 * exactly the six that were verified.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN; plan writes nothing and prints every row.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE — that
 *   each repaired line's EFFECTIVE date is now its own line date, computed with
 *   the same precedence `effectiveSoDelivery` uses. A row count cannot see a
 *   switch flipped on a line whose date the header still wins.
 *
 * RE-RUN: idempotent. The UPDATE carries
 * `coalesce(line_delivery_date_overridden,false) = false`, so a second run
 * selects nothing and writes nothing.
 *
 * REVERSAL: `UPDATE scm.mfg_sales_order_items
 *              SET line_delivery_date_overridden = false WHERE id IN (...)`
 * — every target was false before this ran; no line date is written or changed,
 * only the switch, so nothing else has to be restored.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (apply only)
 */
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'honour the book line delivery dates';

/* The six, each verified against AED_HOUZS SODTL.DeliveryDate on 2026-09-09.
   `bookDate` is what the BOOK says; the repair only proceeds where the ERP's
   stored line date still equals it. */
const VERIFIED = [
  /* HC-SO-013495 / 9058-1S (MR JERALD) was the worst case and is NO LONGER HERE.
     Between the measurement and the repair somebody CLEARED that order's dates:
     customer_delivery_date, amended_delivery_date and both line dates are now
     NULL, so there is no line date left to honour. The book still says the sofa
     is due 2026-10-10 and the pillow 2026-09-08, so the order has moved from
     "the line date is ignored" to "the ERP promises nothing at all" — a
     different problem, reported separately rather than repaired here.
     The count guard below is what caught it: the plan refused rather than
     writing against a list that had gone stale. */
  { doc: 'HC-SO-001920', item: 'ELEPAHNE-(SK)',             bookDate: '2025-09-13' },
  { doc: 'HC-SO-001920', item: 'AKEMI ARISTOI MATT (SK)',   bookDate: '2025-09-13' },
  { doc: 'HC-SO-002069', item: 'AK-SLEEP ESSENTIAL 7 HOLES', bookDate: '2024-10-18' },
  { doc: 'HC-SO-000814', item: 'SQUARE PILLOW',             bookDate: '2024-05-31' },
];
/* HC-SO-001920 carries TWO lines of each of its two items — four rows from two
   (doc, item) pairs — so the expected ROW count is not VERIFIED.length. It is
   asserted rather than derived: if the tree stops matching it, something moved
   and a human re-checks the book before anything is written. */
const EXPECTED_ROWS = 6;

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${CONFIRM_PHRASE}'. Refusing to write.`);
  process.exit(2);
}

const out = (m = '') => console.log(m);
const d = (x) => (x ? new Date(x).toISOString().slice(0, 10) : '-');
const head = (m) => { out(''); out('='.repeat(78)); out(m); out('='.repeat(78)); };
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20 });

const pairs = VERIFIED.map((v) => `(${[v.doc, v.item, v.bookDate].map((s) => `'${s.replace(/'/g, "''")}'`).join(',')})`).join(',');

const targets = () => sql.unsafe(`
  WITH verified(doc_no, item_code, book_date) AS (VALUES ${pairs})
  SELECT i.id, i.doc_no, i.item_code, i.line_delivery_date::date AS line_date,
         COALESCE(h.amended_delivery_date::date, h.customer_delivery_date::date) AS header_date,
         h.debtor_name, h.status
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    JOIN verified v ON v.doc_no = i.doc_no
                   AND UPPER(TRIM(v.item_code)) = UPPER(TRIM(i.item_code))
                   AND i.line_delivery_date::date = v.book_date::date
   WHERE h.company_id = 1
     AND COALESCE(i.cancelled, false) = false
     AND COALESCE(i.line_delivery_date_overridden, false) = false
     AND h.status NOT IN ('CANCELLED','CLOSED','SHIPPED','DELIVERED','INVOICED','DRAFT')
   ORDER BY i.doc_no, i.item_code`);

async function main() {
  head(`REPAIR line delivery date override — MODE=${MODE}`);
  out(APPLY ? 'APPLY: the switch below WILL be turned on.' : 'PLAN: nothing is written.');
  out('');
  const rows = await targets();
  out(`${rows.length} line(s) matched the verified list (expected ${EXPECTED_ROWS}).`);
  out('');
  for (const r of rows) {
    out(`  ${r.doc_no.padEnd(16)} ${String(r.debtor_name ?? '').slice(0, 18).padEnd(18)} `
      + `${String(r.item_code).slice(0, 26).padEnd(26)} promised ${d(r.header_date)} -> ${d(r.line_date)}   [${r.status}]`);
  }

  if (rows.length !== EXPECTED_ROWS) {
    head('REFUSING');
    out(`Expected exactly ${EXPECTED_ROWS} verified line(s), found ${rows.length}.`);
    out('The tree moved since these were checked against the account book one by one.');
    out('Re-verify against AutoCount before running this again — the whole point of');
    out('pinning the list is that two look-alike populations must NOT be repaired.');
    await sql.end({ timeout: 5 });
    process.exit(3);
  }

  if (!APPLY) {
    head('PLAN ONLY — nothing written');
    out(`To apply:  MODE=apply CONFIRM='${CONFIRM_PHRASE}'`);
    await sql.end({ timeout: 5 });
    return;
  }

  head('APPLYING');
  let wrote = 0;
  for (const r of rows) {
    const res = await sql`
      UPDATE scm.mfg_sales_order_items
         SET line_delivery_date_overridden = true
       WHERE id = ${r.id}
         AND COALESCE(line_delivery_date_overridden, false) = false`;
    wrote += res.count ?? 0;
  }
  out(`${wrote} switch(es) turned on.`);
  const ids = rows.map((r) => r.id);
  await sql.end({ timeout: 5 });

  /* ── VERIFY on a FRESH connection, on the SHAPE ───────────────────────────
     The question is NOT "did N rows update" — it is "is the EFFECTIVE date now
     the line's own date". That is computed here with the same precedence
     effectiveSoDelivery uses, so a switch flipped on a line the header still
     wins would be caught. */
  head('VERIFY (fresh connection, effective date recomputed)');
  const v = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20 });
  let bad = 0;
  try {
    const check = await v`
      SELECT i.doc_no, i.item_code, i.line_delivery_date::date AS line_date,
             CASE WHEN COALESCE(i.line_delivery_date_overridden,false)
                       AND i.line_delivery_date IS NOT NULL
                  THEN i.line_delivery_date::date
                  ELSE COALESCE(h.amended_delivery_date::date, h.customer_delivery_date::date,
                                i.line_delivery_date::date) END AS effective
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE i.id = ANY(${ids})
       ORDER BY i.doc_no, i.item_code`;
    for (const r of check) {
      const ok = d(r.effective) === d(r.line_date);
      if (!ok) bad += 1;
      out(`  ${r.doc_no.padEnd(16)} ${String(r.item_code).slice(0, 26).padEnd(26)} effective=${d(r.effective)}  ${ok ? 'OK' : '*** STILL THE HEADER DATE ***'}`);
    }
    /* The two look-alikes must be UNTOUCHED — asserted, not assumed. */
    const untouched = await v`
      SELECT i.doc_no, i.item_code, COALESCE(i.line_delivery_date_overridden,false) AS sw
        FROM scm.mfg_sales_order_items i
       WHERE (i.doc_no = 'HC-SO-000517' AND UPPER(TRIM(i.item_code)) = 'SOFT PILLOW')
          OR i.doc_no = '2990-SO-2607-023'`;
    const flipped = untouched.filter((r) => r.sw === true);
    out('');
    out(`  look-alikes deliberately NOT repaired, switch still off: ${untouched.length - flipped.length} of ${untouched.length}`);
    if (flipped.length > 0) { bad += 1; out('  *** one of them was flipped — that must never happen ***'); }
  } finally {
    await v.end({ timeout: 5 });
  }
  head(bad === 0 ? 'VERIFIED' : 'VERIFICATION FAILED');
  if (bad !== 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
