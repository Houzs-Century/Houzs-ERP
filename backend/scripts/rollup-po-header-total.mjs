#!/usr/bin/env node
// Roll a migrated purchase order's header total up from its OWN lines.
// READ-ONLY by default.
//
// THE OWNER'S RULING, 2026-09-08: recompute the header = add up the lines.
//
// WHAT WENT WRONG (docs/bugs/0675-70-migrated-purchase-orders-*). Both purchase
// -order importers write `total_sen = SUM(qty x priceSen)` with `priceSen`
// copied straight from AutoCount's `PODTL.UnitPrice`, which is RM 0.00 on
// 10,810 of the book's 18,890 PO lines - Houzs does not price factory purchase
// orders in AutoCount (7,591 of 9,416 purchase orders have `NetTotal` 0.00). The
// header faithfully copied a zero; the ERP's LINE prices were set later by
// something other than the import, and that repricing never rolled up. So 70
// documents read RM 0.00 at the header while their own lines carry money.
//
// THE ROLL-UP RULE IS THE APP'S OWN. `applyPoAmendment`
// (src/scm/lib/po-revision.ts:285-303): `subtotal_sen = SUM(line_total_sen)`,
// `total_sen = subtotal + tax_sen`. Stated once, in lib/po-header-rollup.mjs. A
// header this writes is indistinguishable from one the app would have written
// after an amendment, which is the point - a second definition of what a
// purchase order is worth is this repo's most expensive recurring bug.
//
// ROLLING UP IS NOT REPRICING. No line is read for anything but its own
// `line_total_sen`, no line is written, and the fresh-connection verify re-reads
// EVERY line of every document it touched and asserts that not one
// `unit_price_sen` or `line_total_sen` moved. If any did, this exits non-zero.
//
// THE CURRENCY GUARD, and why it is structural rather than a filter.
// `purchase_order_items` has NO currency column: a line is stated in its
// document's currency by construction, so summing a document's OWN lines into
// its OWN header cannot mix currencies. What this script therefore never does is
// compare either figure against the book's `netTotal`, which is the LOCAL (MYR)
// amount - reading that against a document-currency figure is what wrote
// RM 13,068.55 of fabricated discount onto a CNY purchase order (docs/bugs/0665,
// 0666; `PO-009335` is CNY at rate 0.619380, book MYR 21,266.35, own-currency
// 34,334.90, and the ERP correctly holds 34,334.90). Every total this prints is
// PER CURRENCY. Nothing sums two currencies together, and a document with no
// currency at all is refused rather than assumed to be ringgit.
//
//   DATABASE_URL   required
//   MODE           plan (default, writes NOTHING) | apply
//   CONFIRM        on apply, must equal "ROLL UP <n> PURCHASE ORDER HEADERS"
//                  with the count THIS run measured, so a phrase copied from an
//                  earlier run cannot fire
//   COMPANY_ID     default 1
//   OUT            restorable dump path
//
// RE-RUN: convergent. The population is every document whose header is still
// zero while its own lines carry money, so a second apply finds nothing left,
// says so, and exits 0 without writing. The UPDATE re-asserts the zero it read,
// so a header a person set in between is not overwritten.
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

import { planPoHeaderRollups } from "./lib/po-header-rollup.mjs";

const DST = process.env.DATABASE_URL;
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = process.env.CONFIRM ?? "";
const CO = Number(process.env.COMPANY_ID || 1);
const OUT = process.env.OUT || path.join(process.cwd(), "po-header-rollup-dump.json");

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!["plan", "apply"].includes(MODE)) { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m = "") => console.log(m);
const rpad = (s, n) => String(s ?? "").padEnd(n);
/* Amounts are printed with their CURRENCY, never with a bare "RM" - the whole
   defect class this script guards against is a figure read in the wrong one. */
const money = (sen, cur) => `${cur} ${(Number(sen) / 100).toFixed(2)}`;

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${MODE} company=${CO} out=${OUT}`);

  const headers = await sql`
    SELECT p.id, p.po_number, p.currency::text AS currency, p.status::text AS status,
           p.linked_ac_docno,
           p.subtotal_sen::int AS subtotal_sen, p.tax_sen::int AS tax_sen, p.total_sen::int AS total_sen,
           COUNT(i.id)::int                                   AS line_count,
           COALESCE(SUM(i.line_total_sen), 0)::bigint         AS line_sum_sen,
           COALESCE(SUM(i.qty::bigint * i.unit_price_sen), 0)::bigint AS qty_price_sum_sen
      FROM scm.purchase_orders p
      LEFT JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
     WHERE p.company_id = ${CO}
     GROUP BY p.id
     ORDER BY p.po_number`;
  log(`company ${CO}: ${headers.length} purchase order(s) read`);

  const { plan, refused, counts, byCurrency } = planPoHeaderRollups({ headers });

  log("");
  log("THE POPULATION, measured");
  log(`  purchase orders in this company                    ${counts.documents}`);
  log(`  header already equals its own lines plus tax       ${counts.headerAlreadyEqualsLines}`);
  log(`  header is ZERO and the lines carry money  <- roll  ${counts.zeroHeaderPricedLines}`);
  log(`  header is zero and the lines are zero too          ${counts.zeroHeaderZeroLines}   (nothing to roll up; the book prices no factory PO)`);
  log(`  header disagrees with its lines but is NOT zero    ${counts.headerDisagreesButNotZero}   <- outside the ruling; reported, never written`);
  log(`  REFUSED, the header carries no currency            ${counts.noCurrency}`);
  log(`  REFUSED, the LINES disagree with themselves        ${counts.lineSumUnsound}`);
  log(`  documents this run would write                     ${plan.length}`);
  for (const r of refused.slice(0, 40)) log(`   REFUSED ${r.poNumber} (${r.currency ?? "no currency"}): ${r.detail}`);
  if (refused.length > 40) log(`   ... and ${refused.length - 40} more`);

  log("");
  log("PER CURRENCY - nothing below sums two currencies together.");
  for (const [cur, c] of [...byCurrency].sort()) {
    log(`  ${cur}: ${c.documents} document(s), header ${money(c.before_sen, cur)} -> ${money(c.after_sen, cur)}`);
    if (cur !== "MYR") log(`     ^ NOT ringgit. This is the document's OWN currency, which is what the ERP stores; it is never compared against the book's local (MYR) netTotal (docs/bugs/0665).`);
  }
  if (byCurrency.size === 0) log("  (nothing to write)");

  if (plan.length === 0) {
    log("");
    log("nothing to roll up - no purchase order in this company has a zero header over priced lines.");
    await sql.end();
    return;
  }

  /* Every LINE of every document about to be touched, read BEFORE the write.
     This is what makes "no line price moved" a measurement afterwards instead
     of an intention: the verify re-reads these same rows on a fresh connection
     and compares value by value. */
  const ids = plan.map((p) => String(p.id));
  const linesBefore = await sql`
    SELECT id, purchase_order_id, item_code, qty::int AS qty,
           unit_price_sen::int AS unit_price_sen, line_total_sen::int AS line_total_sen
      FROM scm.purchase_order_items
     WHERE purchase_order_id = ANY(${ids})
     ORDER BY purchase_order_id, item_code`;
  log(`${linesBefore.length} line(s) across the ${plan.length} document(s) recorded before the write`);

  plain("");
  plain("EVERY DOCUMENT THIS WOULD WRITE - the header is the sum of its own lines, nothing else changes.");
  plain("```enumeration");
  plain(`${rpad("purchase order", 16)}${rpad("book doc", 14)}${rpad("cur", 5)}${rpad("lines", 7)}${rpad("header now", 18)}${rpad("header after", 18)}status`);
  for (const p of plan) {
    plain(`${rpad(p.poNumber, 16)}${rpad(p.acDocNo ?? "-", 14)}${rpad(p.currency, 5)}${rpad(p.lineCount, 7)}${rpad(money(p.fromTotalSen, p.currency), 18)}${rpad(money(p.toTotalSen, p.currency), 18)}${p.status}`);
    plain(`${rpad("", 16)}  subtotal ${money(p.fromSubtotalSen, p.currency)} -> ${money(p.toSubtotalSen, p.currency)}; tax ${money(p.taxSen, p.currency)} unchanged`);
  }
  plain("```");
  plain("");

  const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  const dump = {
    dumpedAt: new Date().toISOString(),
    reason: "restorable dump taken immediately before rolling scm.purchase_orders.subtotal_sen/total_sen up from the document's own lines",
    database: "production (secrets.DATABASE_URL)",
    companyId: CO,
    ruling: "owner 2026-09-08: recompute the header = add up the lines",
    rows: plan,
    refused,
    counts,
    byCurrency: Object.fromEntries(byCurrency),
    linesBefore: linesBefore.map((l) => ({ ...l })),
    restore: plan.map((p) =>
      `UPDATE scm.purchase_orders SET subtotal_sen = ${p.fromSubtotalSen}, total_sen = ${p.fromTotalSen} WHERE id = ${q(p.id)};`),
  };
  const json = JSON.stringify(dump, null, 2);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json, "utf8");

  /* READ IT BACK. Writing is intent; parsing what came off the disk is
     evidence, and evidence is the precondition for the write below. */
  const readBack = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const dumpOk = Array.isArray(readBack.rows)
    && readBack.rows.length === plan.length
    && readBack.rows.every((r) => r.id && r.currency && Number.isFinite(r.toTotalSen))
    && readBack.linesBefore.length === linesBefore.length
    && readBack.restore.length === plan.length;
  log(`dump written to ${OUT} (${json.length} bytes) and re-read: ${dumpOk ? "OK" : "FAILED"}`);
  plain("----- BEGIN RESTORABLE DUMP -----");
  plain(json);
  plain("----- END RESTORABLE DUMP -----");

  const PHRASE = `ROLL UP ${plan.length} PURCHASE ORDER HEADERS`;
  if (!APPLY) {
    log(`PLAN ONLY - nothing written. To roll up: MODE=apply CONFIRM="${PHRASE}"`);
    await sql.end();
    return;
  }
  if (!dumpOk) { log("REFUSED: the dump did not read back. Nothing rolled up."); await sql.end(); process.exit(1); }
  if (CONFIRM !== PHRASE) {
    log(`REFUSED: MODE=apply needs CONFIRM="${PHRASE}" - the count is the one THIS run measured, so a phrase copied from an earlier run cannot fire.`);
    await sql.end();
    process.exit(2);
  }

  /* The ZERO this run read is RE-ASSERTED inside the statement, and the new
     figure is re-derived from the LIVE lines in the same statement rather than
     from the number JavaScript computed a moment ago. A header a person set
     between plan and apply fails the re-assertion, is not written, and shows up
     in the count. */
  let written = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const res = await tx`
        UPDATE scm.purchase_orders h
           SET subtotal_sen = s.line_sum,
               total_sen    = s.line_sum + h.tax_sen,
               updated_at   = now()
          FROM (SELECT COALESCE(SUM(line_total_sen), 0)::int AS line_sum
                  FROM scm.purchase_order_items WHERE purchase_order_id = ${p.id}) s
         WHERE h.id = ${p.id}
           AND h.company_id = ${CO}
           AND h.total_sen = 0
           AND h.subtotal_sen = ${p.fromSubtotalSen}
           AND h.tax_sen = ${p.taxSen}
           AND s.line_sum > 0
        RETURNING h.id`;
      written += res.length;
    }
  });
  log(`purchase-order headers rolled up: ${written} of ${plan.length} intended`);

  /* ---- verification on a connection this run has not used ----------------
     Two assertions, both of SHAPE and neither a row count:
       1. the header now equals the sum of its OWN lines plus its own tax
       2. NOT ONE LINE MOVED - every unit_price_sen and line_total_sen is
          compared value by value against what was read before the write. This
          is a roll-UP, not a repricing, and that has to be observable. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const after = await v`
    SELECT p.id, p.po_number, p.currency::text AS currency,
           p.subtotal_sen::int AS subtotal_sen, p.tax_sen::int AS tax_sen, p.total_sen::int AS total_sen,
           COALESCE(SUM(i.line_total_sen), 0)::bigint AS line_sum_sen
      FROM scm.purchase_orders p
      LEFT JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
     WHERE p.id = ANY(${ids})
     GROUP BY p.id
     ORDER BY p.po_number`;
  const lineAfter = await v`
    SELECT id, purchase_order_id, qty::int AS qty,
           unit_price_sen::int AS unit_price_sen, line_total_sen::int AS line_total_sen
      FROM scm.purchase_order_items
     WHERE purchase_order_id = ANY(${ids})`;

  let headerWrong = 0, stillZero = 0, gone = 0;
  const byId = new Map(after.map((a) => [String(a.id), a]));
  for (const p of plan) {
    const a = byId.get(String(p.id));
    if (!a) { gone++; log(`   VERIFY: purchase order ${p.poNumber} is GONE`); continue; }
    const want = Number(a.line_sum_sen) + Number(a.tax_sen);
    if (Number(a.total_sen) !== want || Number(a.subtotal_sen) !== Number(a.line_sum_sen)) {
      headerWrong++;
      log(`   VERIFY: ${a.po_number} header ${money(a.total_sen, a.currency)} <> its lines ${money(a.line_sum_sen, a.currency)} + tax ${money(a.tax_sen, a.currency)}`);
    }
    if (Number(a.total_sen) === 0) { stillZero++; log(`   VERIFY: ${a.po_number} is still zero`); }
    log(`   VERIFY ${a.po_number}: header ${money(a.total_sen, a.currency)} = lines ${money(a.line_sum_sen, a.currency)} + tax ${money(a.tax_sen, a.currency)} (${a.currency})`);
  }

  const beforeById = new Map(linesBefore.map((l) => [String(l.id), l]));
  let lineMoved = 0, lineGone = 0;
  for (const l of lineAfter) {
    const b = beforeById.get(String(l.id));
    if (!b) { lineMoved++; log(`   VERIFY: line ${l.id} did not exist before this run`); continue; }
    if (Number(l.unit_price_sen) !== Number(b.unit_price_sen)
      || Number(l.line_total_sen) !== Number(b.line_total_sen)
      || Number(l.qty) !== Number(b.qty)) {
      lineMoved++;
      log(`   VERIFY: LINE MOVED ${b.item_code} - qty ${b.qty}->${l.qty}, unit ${b.unit_price_sen}->${l.unit_price_sen}, line total ${b.line_total_sen}->${l.line_total_sen}`);
    }
  }
  if (lineAfter.length !== linesBefore.length) {
    lineGone = Math.abs(lineAfter.length - linesBefore.length);
    log(`   VERIFY: the line COUNT changed, ${linesBefore.length} -> ${lineAfter.length}`);
  }
  log(`VERIFY on a fresh connection: ${after.length} of ${ids.length} header(s) re-read; header still wrong ${headerWrong}; still zero ${stillZero}; missing ${gone}`);
  log(`VERIFY no repricing: ${lineAfter.length} line(s) re-read; prices or quantities that moved ${lineMoved}; line-count drift ${lineGone}`);
  await v.end();
  await sql.end();
  if (headerWrong > 0 || stillZero > 0 || gone > 0 || lineMoved > 0 || lineGone > 0) process.exit(1);
  log(`DONE. ${written} purchase-order header(s) now equal the sum of their own lines; no line price moved. The restorable dump is at ${OUT} and printed above.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
