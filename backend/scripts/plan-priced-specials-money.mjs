#!/usr/bin/env node
// THE MONEY THE OWNER HAS TO RULE ON — read-only, one document per row.
//
// `backfill-specials-into-variants.mjs --SKIP_PRICED=1` lands every special
// order whose picker code is priced 0/0 and HOLDS BACK any line that would
// newly gain a PRICED one. Prod run 34125641978: SO 89 + PO 38 stamped, **358
// lines held back**, RM 29,060.00 of selling surcharge not taken.
//
// Those 358 are not a defect and they are not blocked on engineering. They are
// one owner decision — 「单据的钱可不可以动」 — and he cannot make it from a
// single total. He asked to see the money, so this prints it the way a person
// reads it: WHICH document, WHICH line, WHICH option, what it ADDS in ringgit,
// and what the document's total is BEFORE and AFTER.
//
// RE-RUN: safe and encouraged — this is a PLAN, it has no apply path at all.
// It opens one connection, runs SELECTs, prints, and exits. Running it twice
// prints the same thing twice. There is deliberately no MODE/APPLY gate here
// because there is nothing to gate: a script that cannot write does not need a
// confirmation phrase, and adding a fake one would teach the next reader that
// the phrase is decoration.
//
// WHAT IT DOES NOT DO, said plainly. It does not decide, it does not write, and
// it does not recommend a number. Whether a historical document's total may
// move is the owner's call and nobody else's.
//
// ── HOW THE "AFTER" IS COMPUTED, AND WHY IT IS AN UPPER BOUND ───────────────
// The surcharge is NOT stored on the line and NOT recomputed on read. It is
// persisted on a route WRITE that changes the line's priced shape
// (mfg-sales-orders.ts shouldRecompute), so today's stored totals are the
// BEFORE. The AFTER here is qty x selling_price_sen summed onto the stored
// total — the arithmetic the pricing engine would do
// (mfg-pricing.ts folds specialsSurchargeSen into unitPriceSen).
//
// It is an UPPER BOUND on the customer-facing side, and the reason is worth
// reading before quoting it: on a MIGRATED sales order the selling surcharge is
// switched off STRUCTURALLY — mfg-pricing-recompute.ts sets
// chargeableSurchargesSen = 0 under trustOperatorSelling === 'including-zero'
// and persists the STORED price. So for SO lines the customer price would NOT
// actually move even if the code were stamped into variants.specials. The COST
// side has no such exemption. Both numbers are printed separately rather than
// netted, because "what the customer pays" and "what we book as cost" are two
// different questions and the owner is entitled to answer them separately.
import postgres from "postgres";
import {
  K, buildLiveIndex, classifyLine, loadPhraseMap,
} from "./lib/special-order-phrase-mapper.mjs";
/* The processing-date column is named in ONE place and read through it, exactly
   as check-ac-erp-reconcile.mjs does — which is why the two cannot disagree
   about what "proceeded" means. */
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 400);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const rm = (sen) => `RM ${(Number(sen || 0) / 100).toFixed(2)}`;
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const PDATE = soProcessingDateFragment(sql);

const MAP = loadPhraseMap();

async function main() {
  log(`PLAN ONLY — nothing is written by this script. company=${CO}`);

  const addons = await sql`SELECT code, label, categories, active, selling_price_sen, cost_price_sen
    FROM scm.special_addons WHERE company_id = ${CO} ORDER BY code`;
  const liveByCat = buildLiveIndex(addons);
  const priceOf = new Map();
  for (const r of addons) {
    priceOf.set(K(r.code), { sell: Number(r.selling_price_sen || 0), cost: Number(r.cost_price_sen || 0) });
  }
  const isPriced = (c) => {
    const p = priceOf.get(K(c));
    return !!p && (p.sell !== 0 || p.cost !== 0);
  };
  const priced = addons.filter((r) => isPriced(r.code));
  log(`scm.special_addons: ${addons.length} rows, ${priced.length} PRICED (read live, never hard-coded)`);
  for (const r of priced.sort((a, b) => Number(b.selling_price_sen) - Number(a.selling_price_sen))) {
    plain(`   ${rm(r.selling_price_sen).padStart(11)} sell / ${rm(r.cost_price_sen).padStart(11)} cost   [${r.code}]`);
  }

  /* THE SAME QUERY AND THE SAME CLASSIFIER the backfill uses, so this cannot
     describe a different population from the one that was actually held back. */
  const soLines = await sql`SELECT i.id, i.doc_no AS doc, i.item_code AS code, i.item_group AS grp,
      i.description2 AS d2, i.variants, i.qty
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL`;
  const poLines = await sql`SELECT i.id, h.po_number AS doc, i.item_code AS code, i.item_group AS grp,
      i.description2 AS d2, i.variants, i.qty
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL`;

  /* THE COLUMN NAMES ARE COPIED FROM check-ac-erp-reconcile.mjs, not guessed.
     The SO header total is COALESCE(local_total_sen, subtotal_sen) — that table
     has no `total_sen` at all — and "proceeded" is the shared processing-date
     fragment. The obvious `total_sen` / `proceeded_at` spelling was written here
     first and would have failed on first dispatch: the exact shape CLAUDE.md
     records for #2120, a workflow copied by name-similarity onto columns nobody
     checked. */
  const soTotals = new Map();
  for (const r of await sql`SELECT doc_no,
        COALESCE(local_total_sen, subtotal_sen, 0) AS t,
        (${PDATE} IS NOT NULL) AS proceeded
      FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`) {
    soTotals.set(r.doc_no, { total: Number(r.t || 0), proceeded: r.proceeded === true });
  }
  const poTotals = new Map();
  for (const r of await sql`SELECT po_number, COALESCE(total_sen, 0) AS t
      FROM scm.purchase_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`) {
    poTotals.set(r.po_number, { total: Number(r.t || 0), proceeded: true });
  }

  const docs = new Map();     // "SO HC-SO-0001" -> { side, doc, lines[], addSell, addCost }
  const perCode = new Map();
  let heldLines = 0;

  for (const [side, rows] of [["SO", soLines], ["PO", poLines]]) {
    for (const r of rows) {
      const cls = classifyLine(r, MAP, liveByCat);
      if (!cls.phrases.length) continue;
      const pricedNow = cls.addedNow.filter(isPriced);
      if (!pricedNow.length) continue;   // the 0/0 majority: already landed
      heldLines++;
      const qty = Math.max(1, Number(r.qty || 1));
      let sell = 0, cost = 0;
      for (const c of pricedNow) {
        const p = priceOf.get(K(c));
        sell += p.sell * qty;
        cost += p.cost * qty;
        const e = perCode.get(c) || { n: 0, sell: 0, unit: p.sell };
        e.n++; e.sell += p.sell * qty;
        perCode.set(c, e);
      }
      const key = `${side} ${r.doc}`;
      if (!docs.has(key)) {
        const t = (side === "SO" ? soTotals : poTotals).get(r.doc) || { total: 0, proceeded: false };
        docs.set(key, { side, doc: r.doc, before: t.total, proceeded: t.proceeded, lines: [], sell: 0, cost: 0 });
      }
      const d = docs.get(key);
      d.lines.push({ code: r.code, qty, options: pricedNow, sell, cost, zeroRiding: cls.addedNow.filter((c) => !isPriced(c)) });
      d.sell += sell;
      d.cost += cost;
    }
  }

  const list = [...docs.values()].sort((a, b) => b.sell - a.sell || a.doc.localeCompare(b.doc));
  const totSell = list.reduce((a, d) => a + d.sell, 0);
  const totCost = list.reduce((a, d) => a + d.cost, 0);

  plain("");
  log(`HELD BACK FOR MONEY: ${heldLines} lines across ${list.length} documents ` +
      `(SO ${list.filter((d) => d.side === "SO").length}, PO ${list.filter((d) => d.side === "PO").length})`);
  log(`If every one were charged: selling +${rm(totSell)}, cost +${rm(totCost)}`);
  plain("");
  plain("Every document, and what its total would become. BEFORE is what the ERP holds today.");
  plain("");
  plain("document           proceeded        total now        would add        total after");
  for (const d of list.slice(0, SHOW)) {
    plain(
      `${(d.side + " " + d.doc).padEnd(19)}${(d.proceeded ? "yes" : "no").padEnd(11)}` +
        `${rm(d.before).padStart(14)}${rm(d.sell).padStart(17)}${rm(d.before + d.sell).padStart(19)}`,
    );
    for (const ln of d.lines) {
      plain(`      ${ln.code}  x${ln.qty}  ${ln.options.join(" + ")}  -> +${rm(ln.sell)}` +
        (ln.zeroRiding.length ? `   (free options riding along, forgone with it: ${ln.zeroRiding.join(", ")})` : ""));
    }
  }
  if (list.length > SHOW) plain(`... and ${list.length - SHOW} more documents`);

  plain("");
  log(`per option, across every held-back line:`);
  for (const [c, e] of [...perCode.entries()].sort((a, b) => b[1].sell - a[1].sell)) {
    plain(`   ${String(e.n).padStart(4)} lines   ${rm(e.unit).padStart(11)} each   ${rm(e.sell).padStart(13)} total   [${c}]`);
  }

  /* ONE MEMBER OF A POPULATION BEHAVING UNLIKE THE REST IS THE FINDING. Every
     other priced option ADDS money; a negative one SUBTRACTS it, so "charge
     them all" is not uniformly in the owner's favour and he should be told
     which rows go the other way rather than discovering it afterwards. */
  const negative = priced.filter((r) => Number(r.selling_price_sen) < 0);
  if (negative.length) {
    plain("");
    log(`NOT ALL OF THEM ADD: ${negative.length} priced option(s) carry a NEGATIVE price — charging these LOWERS the document:`);
    for (const r of negative) {
      const e = perCode.get(r.code);
      plain(`   [${r.code}]  ${rm(r.selling_price_sen)} each` +
        (e ? `  on ${e.n} held-back line(s), ${rm(e.sell)} in total` : "  on no held-back line"));
    }
  }

  plain("");
  plain("Reading this: 'total now' is what the document shows today and it does NOT change by itself.");
  plain("Nothing here is written anywhere. The options are already RECORDED against the lines for the");
  plain("factory to see (variants.specialsRecorded, the 2026-09-03 ruling); the only open question is");
  plain("whether the money on these historical documents may move.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
