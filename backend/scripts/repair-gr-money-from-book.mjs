#!/usr/bin/env node
// ----------------------------------------------------------------------------
// PUT THE ACCOUNT BOOK'S OWN RECEIPT MONEY ONTO THE MIGRATED GOODS RECEIPT.
// Nothing else. 「这三个就跟着line item去跟着autocount就对了 autocount怎么写我们就
// 怎么写」 — the owner, 2026-09-09.
//
// WHAT IS WRONG, AND IT IS OUR COPY RATHER THAN THE BOOK. AutoCount prices the
// RECEIPT. Measured on the committed cut 2026-09-09T00:18:49Z: 19,833 of 21,746
// GRDTL lines carry a unit price (91.2%), against 8,080 of 18,890 PODTL lines
// (42.8%). We priced the receipt from the ORDER instead —
// reshape-migrated-grns.mjs:727-728, `} else if (poi) { price =
// n0(poi.unit_price_sen);` — and the type config says so out loud
// (lib/ac-reconcile-erp-sql.mjs, `priceDeclared`: "grn_items.unit_price_sen is
// taken from the PURCHASE ORDER line by design, not from GRDTL.UnitPrice").
// So a receipt the book prices lands at RM 0.00 whenever its order line is
// blank, and 57% of order lines are.
//
// AND WHERE THE ORDER *IS* PRICED, THE DISCOUNT IS LOST. The reshape writes
// `lineTotal = qty x price - discount` and takes `discount` only from money the
// ERP already held; a migrated line has none, so a book line reading
// `UnitPrice 1050.0000 / SubTotal 787.50` — AutoCount's own 25% — is rewritten
// as 1050. Three receipts are exactly book x 4/3 today, which is that.
//
// THE FIX IS A COPY, NOT A COMPUTATION. Every value written here is read out of
// `GRDTL` and written unchanged: `SubTotal` becomes `line_total_sen`,
// `UnitPrice` becomes `unit_price_sen`, and `discount_sen` is the difference
// the book itself states between them. migration-copy-never-compute — nothing
// is derived from a quantity, a percentage, or the purchase order.
//
// PAIRED ON THE BOOK'S OWN LINE KEY, NEVER ON POSITION. `PO-009081` ordered two
// identical bedframes and two receipts each took one; a position-based pairing
// pairs them backwards, and a position-based test failed 6 of 8 where the
// key-based one passed 8 of 8 (docs/bugs/0690). `scm.grn_items.linked_ac_dtlkey`
// carries the book's GRDTL key, and a receipt with ANY keyless line is REFUSED
// whole rather than half-paired.
//
// FOUR GATES, EVERY ONE A REFUSAL RATHER THAN A FALLBACK:
//
//   1  THE RECEIPT IS MIGRATED PAPERWORK THAT MOVED NO STOCK.
//      `scm.grns.migrated_no_stock` is true AND no `scm.inventory_movements`
//      row names it. This is 「库存先不看」 honoured by construction: a receipt
//      with movements has costed layers hanging off its price, and re-pricing
//      it would move an on-hand VALUE. Those are refused and NAMED, never
//      written. It is the same proof `zeroMoneyProof` already computes
//      (lib/ac-reconcile-erp-sql.mjs) and the same question
//      apply-sofa-compartment-corrections.mjs asks (`source_doc_no`).
//   2  EVERY LINE OF THE RECEIPT CARRIES THE BOOK'S LINE KEY, and every key
//      resolves to a GRDTL row of THIS receipt. A key naming a line of another
//      document is not this receipt's money whatever it says.
//   3  THE RECEIPT IS IN LOCAL CURRENCY. An exchange rate looks exactly like a
//      discount: reading a local-currency total as the document's wrote
//      RM 13,068.55 of fake discount onto a CNY purchase order (docs/bugs/0721).
//      A non-MYR receipt is refused, not converted.
//   4  THE INVOICED QUANTITY IS UNTOUCHED. `invoiced_qty` is not money and is
//      not read or written here; a purchase invoice already raised off a line
//      keeps its own figure.
//
// WHAT MOVES ON THE SCREEN, plainly: a migrated goods receipt that showed
// RM 0.00 shows what AutoCount shows, and a purchase invoice can be raised off
// it again — which is the cost the 「GR 0 没关系」 decision was accepting
// (lib/ac-reconcile-erp-sql.mjs, `consequence`).
//
//   MODE=plan (default)  read, pair, print every receipt and every ringgit,
//                        write NOTHING.
//   MODE=apply           needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". One
//                        transaction per receipt, then a re-read on a FRESH
//                        connection asserting the SHAPE — every repaired
//                        receipt's line totals sum to its header and each line
//                        equals the book's SubTotal for its own key. Not a row
//                        count: a row count reported 7 of 7 while 7 production
//                        rows were being corrupted (docs/bugs, the jsonb COE).
//
//   DATABASE_URL           required
//   COMPANY_ID             default 1 (AED_HOUZS)
//   DOC                    one ERP receipt number, or blank for every one
//   MAX_SNAPSHOT_AGE_DAYS  default 2 — refuses rather than write from a stale book
//
// RE-RUN: idempotent. A second run re-reads the same book values, finds every
// line already equal to them, plans zero receipts and writes nothing.
//
// REVERSAL: no structure is added or dropped. To undo a run, restore the prior
// unit_price_sen / discount_sen / line_total_sen / subtotal_sen / total_sen
// from the plan output, which prints the BEFORE and AFTER of every value it
// would write.
//
// IT ENQUEUES NOTHING. No outbox row, no AutoCount call, no write-back. Owner
// 2026-09-08: 「写回autocount的你不需要理了」.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { buildScope, decodeSnapshot, currencyVerdict } from "./lib/ac-scope.mjs";
import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { planReceiptMoney } from "./lib/gr-money-from-book.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const CO = Number(process.env.COMPANY_ID || 1);
const MODE = String(process.env.MODE || "plan").toLowerCase();
const DOC = String(process.env.DOC || "").trim();
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const rm = (sen) => `RM ${(Number(sen || 0) / 100).toFixed(2)}`;
const n0 = (v) => Number(v || 0);

const refuse = (why) => { console.error(`REFUSED: ${why}`); process.exit(2); };

if (!process.env.DATABASE_URL) refuse("DATABASE_URL not set.");
if (MODE !== "plan" && MODE !== "apply") refuse(`MODE must be plan or apply, got ${JSON.stringify(MODE)}.`);
if (MODE === "apply" && process.env.CONFIRM !== CONFIRM_PHRASE)
  refuse(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}".`);

/* ── THE BOOK ───────────────────────────────────────────────────────────────
   The committed cut, refused when stale. `decodeSnapshot` is the repo's one
   reader of it, so the money field names here are the DECODED ones —
   `subTotalSen` / `unitPriceSen`. Reading `subTotal` off a decoded row returns
   undefined, and arithmetic on undefined reads as zero: that is how a
   measurement once reported "18,890 of 18,890 order lines have no price". */
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))).toString("utf8").replace(/^﻿/, ""));
const snap = gz("ac-reconcile-truth.json.gz");
const ageDays = (Date.now() - Date.parse(snap.exported_at)) / 86400000;
if (!(ageDays >= 0) || ageDays > MAX_AGE)
  refuse(`the AutoCount snapshot is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE}). Re-cut it rather than writing money from an old book.`);
const book = decodeSnapshot(snap);
const scope = buildScope(book);
/* One reader of the book's GRDTL rows, shared by the plan and the verify, so the
   two can never disagree about which line a key names. */
const bookLine = (k) => book.GR.byDtlKey.get(String(k)) ?? book.GR.byDtlKey.get(Number(k));

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: "require" });

/* Every migrated, un-cancelled receipt of this company, with the two facts gate
   1 rests on, read the same way every other script in this repo asks them. */
const receipts = await sql`SELECT g.id, g.grn_number, g.linked_ac_gr_docno AS ac_gr,
    COALESCE(g.migrated_no_stock, false) AS migrated_no_stock,
    COALESCE(g.subtotal_sen, 0) AS subtotal_sen, COALESCE(g.total_sen, 0) AS total_sen,
    g.currency::text AS currency,
    (SELECT count(*)::int FROM scm.inventory_movements m
      WHERE m.company_id = g.company_id AND m.source_doc_no = g.grn_number) AS movements
  FROM scm.grns g
  WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED' AND g.linked_ac_gr_docno IS NOT NULL
    ${DOC ? sql`AND g.grn_number = ${DOC}` : sql``}
  ORDER BY g.grn_number`;

plain(`mode=${MODE.toUpperCase()}  company=${CO}  book cut ${snap.exported_at} (${ageDays.toFixed(2)} days old)${DOC ? `  DOC=${DOC}` : ""}`);
plain(`${receipts.length} migrated goods receipt(s) in range.`);

/* The AutoCount -> ERP item-code sheet, read by the repo's ONE parser. Two
   parsers for this file is how 40 of 101 item-code "defects" were invented
   (docs/bugs/0689), so this reads it the same way the reconcile does. */
const codeMap = new Map(
  [...readMappingCsv(fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8"))]
    .map(([ac, m]) => [ac, normCode(m.erp)]),
);
const codeKey = (c) => codeMap.get(normCode(c)) ?? normCode(c);

let nMoved = 0, nStock = 0, nKeyless = 0, nForeign = 0, nAgree = 0, nOutOfScope = 0;
let senBefore = 0, senAfter = 0;
const plan = [];

for (const g of receipts) {
  const acGr = String(g.ac_gr).trim();
  const hdr = book.GR.headers.get(acGr);
  if (!hdr || !scope.GR.has(acGr)) { nOutOfScope++; continue; }

  const items = (await sql`SELECT i.id, i.item_code, i.linked_ac_dtlkey::text AS key,
      COALESCE(i.unit_price_sen, 0) AS unit_price_sen,
      COALESCE(i.discount_sen, 0) AS discount_sen,
      COALESCE(i.line_total_sen, 0) AS line_total_sen
    FROM scm.grn_items i WHERE i.grn_id = ${g.id}::uuid ORDER BY i.id`)
    .map((i) => ({ id: i.id, itemCode: i.item_code, acDtlKey: i.key,
      unitPriceSen: n0(i.unit_price_sen), discountSen: n0(i.discount_sen), lineTotalSen: n0(i.line_total_sen) }));
  if (!items.length) { nOutOfScope++; continue; }

  /* THE DECISION IS NOT MADE HERE. lib/gr-money-from-book.mjs decides, and its
     test exercises that same function against the committed book cut, so what
     runs against production is what was proved RED against the importer's own
     `qty x price` rule. */
  const got = planReceiptMoney({
    header: {
      acGr, currency: String(g.currency || "MYR"),
      subtotalSen: n0(g.subtotal_sen), totalSen: n0(g.total_sen),
      migratedNoStock: g.migrated_no_stock === true, movements: n0(g.movements),
    },
    items, bookLine, localCurrency: currencyVerdict(hdr).kind === "local",
    /* THE KEYLESS MONEY ARM. The book's OWN rows of this receipt plus the
       importer's OWN item-code sheet — the module guesses neither. It writes
       money only where every candidate book row states the same quantity, the
       same UnitPrice and the same SubTotal, and it stamps no line key: identity
       stays lib/ac-forced-line-pairing.mjs's to refuse. */
    keylessMoney: {
      bookLines: (book.GR.lines.get(acGr) ?? []).map((l) => ({
        dtlKey: String(l.dtlKey), code: l.itemKey, qty: n0(l.qty),
        unitPriceSen: Math.round(n0(l.unitPriceSen)), subTotalSen: Math.round(n0(l.subTotalSen)),
      })),
      codeKey,
    },
  });

  if (got.verdict === "agree") { nAgree++; continue; }
  if (got.verdict === "foreign-currency") {
    plain(`  ${g.grn_number}: REFUSED — ${got.why}`); nForeign++; continue;
  }
  if (got.verdict === "keyless" || got.verdict === "foreign-key") {
    plain(`  ${g.grn_number}: REFUSED — ${got.why}${got.verdict === "keyless" ? ". backfill-ac-downstream-line-keys.mjs is what fills that." : ""}`);
    nKeyless++; continue;
  }
  if (got.verdict === "moved-stock") {
    plain(`  ${g.grn_number}: REFUSED — ${got.why}. Re-pricing it would move an on-hand VALUE: ${rm(g.total_sen)} -> ${rm(got.wantTotal)}, a change of ${rm(got.deltaSen)}. 「库存先不看」 — named, not written.`);
    nStock++; continue;
  }

  nMoved++;
  senBefore += n0(g.total_sen);
  senAfter += got.wantTotal;
  plan.push({ g, rows: got.rows, wantTotal: got.wantTotal });
  plain(`  ${g.grn_number} (${acGr}): ${rm(g.total_sen)} -> ${rm(got.wantTotal)}  (${rm(got.deltaSen)})`);
  for (const r of got.rows.filter((x) => x.changed))
    plain(`      ${r.item.itemCode}  unit ${rm(r.item.unitPriceSen)} -> ${rm(r.unit)}   disc ${rm(r.item.discountSen)} -> ${rm(r.disc)}   line ${rm(r.item.lineTotalSen)} -> ${rm(r.total)}`);
}

plain("");
plain(`agree already ${nAgree} · would change ${nMoved} · refused for real stock movement ${nStock} · refused for a missing line key ${nKeyless} · refused as foreign currency ${nForeign} · out of the reconcile's scope ${nOutOfScope}`);
plain(`money: ${rm(senBefore)} -> ${rm(senAfter)}  (${rm(senAfter - senBefore)})`);

if (MODE !== "apply") {
  log(`PLAN — ${nMoved} goods receipt(s) would take the account book's own money. Nothing was written. Re-run with MODE=apply and CONFIRM="${CONFIRM_PHRASE}".`);
  await sql.end();
  process.exit(0);
}

for (const p of plan) {
  await sql.begin(async (tx) => {
    for (const r of p.rows) {
      if (!r.changed) continue;
      /* NO `updated_at`. scm.grn_items does not carry one — the apply run
         34305708536 died on `42703 undefined column` at the first statement,
         inside its transaction, so nothing was written. Every sibling repair of
         this table (repair-migrated-grn-item-codes.mjs:285,
         repair-grn-variant-snapshot.mjs:140) sets no such column either; only
         scm.grns has it. */
      await tx`UPDATE scm.grn_items
                  SET unit_price_sen = ${r.unit}, discount_sen = ${r.disc}, line_total_sen = ${r.total}
                WHERE id = ${r.item.id}::uuid AND grn_id = ${p.g.id}::uuid`;
    }
    await tx`UPDATE scm.grns SET subtotal_sen = ${p.wantTotal}, total_sen = ${p.wantTotal}, updated_at = NOW()
              WHERE id = ${p.g.id}::uuid AND company_id = ${CO}`;
  });
}
await sql.end();

/* ── VERIFY ON A FRESH CONNECTION, AND ASSERT THE SHAPE ─────────────────────
   Not a row count: a count of updated rows would have been 7 of 7 while the rows
   were being corrupted.

   THE SHAPE IS GROUPED, and this assertion did not say so until run
   34307013844. It asserted that EVERY line equals the book's SubTotal for its
   own key — the pre-grouping rule — and so reported 24 failures, every one of
   them a non-lead compartment row correctly holding RM 0.00. The write was
   right and the assertion was wrong, which is the worse of the two ways round:
   an apply that exits 3 on a correct write teaches its next reader to ignore
   the exit code. Proved by re-planning on a fresh connection immediately after
   (run 34307484738): `agree already 368 · would change 0`.

   So the shape asserted now is the one the write actually makes: within one
   book line, the LEAD row carries the book's UnitPrice and SubTotal and every
   sibling is zero in both, and the header equals the sum over DISTINCT book
   lines. */
const v = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: "require" });
const bad = [];
for (const p of plan) {
  const [h] = await v`SELECT COALESCE(subtotal_sen,0) AS subtotal_sen, COALESCE(total_sen,0) AS total_sen
                        FROM scm.grns WHERE id = ${p.g.id}::uuid AND company_id = ${CO}`;
  const items = await v`SELECT i.id, i.item_code, i.linked_ac_dtlkey::text AS key,
      COALESCE(i.unit_price_sen,0) AS unit_price_sen, COALESCE(i.discount_sen,0) AS discount_sen,
      COALESCE(i.line_total_sen,0) AS line_total_sen
    FROM scm.grn_items i WHERE i.grn_id = ${p.g.id}::uuid ORDER BY i.id`;
  if (!h) { bad.push(`${p.g.grn_number}: the receipt is gone`); continue; }
  /* Grouped by the book's line, in the same row order the plan grouped them. */
  const groups = new Map();
  for (const i of items) {
    const k = String(i.key ?? "").trim();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  let sum = 0;
  for (const [k, members] of groups) {
    const bl = bookLine(k);
    if (!bl) { bad.push(`${p.g.grn_number}: line ${members[0].item_code} key ${k} names no book line`); continue; }
    const wantUnit = Math.round(n0(bl.unitPriceSen));
    const wantTotal = Math.round(n0(bl.subTotalSen));
    /* The book's figure exactly ONCE per book line, on the group's lead. */
    const lead = members[0];
    if (n0(lead.unit_price_sen) !== wantUnit || n0(lead.line_total_sen) !== wantTotal)
      bad.push(`${p.g.grn_number}: lead line ${lead.item_code} holds ${rm(lead.unit_price_sen)}/${rm(lead.line_total_sen)}, the book states ${rm(wantUnit)}/${rm(wantTotal)}`);
    /* And nowhere else. A sibling holding it is the multiplication of 0738. */
    for (const i of members.slice(1))
      if (n0(i.unit_price_sen) !== 0 || n0(i.line_total_sen) !== 0 || n0(i.discount_sen) !== 0)
        bad.push(`${p.g.grn_number}: compartment ${i.item_code} of book line ${k} holds ${rm(i.unit_price_sen)}/${rm(i.line_total_sen)} — every row but the lead must be zero, or one sofa's price is counted twice`);
    sum += wantTotal;
  }
  if (n0(h.total_sen) !== sum || n0(h.subtotal_sen) !== sum)
    bad.push(`${p.g.grn_number}: header ${rm(h.total_sen)} against the book's own lines summing ${rm(sum)}`);
}
await v.end();

if (bad.length) {
  console.error(`APPLIED, BUT THE VERIFY FAILED on ${bad.length} assertion(s):`);
  for (const b of bad) console.error(`   ${b}`);
  process.exit(3);
}
log(`APPLIED — ${plan.length} goods receipt(s) now carry the account book's own money: ${rm(senBefore)} -> ${rm(senAfter)} (${rm(senAfter - senBefore)}). Verified on a fresh connection: within each book line the LEAD row carries the book's own UnitPrice and SubTotal and every sibling is zero, and each header equals the sum over DISTINCT book lines.`);
