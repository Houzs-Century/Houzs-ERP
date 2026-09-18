#!/usr/bin/env node
// Put the migrated SO/PO special orders into the field the PICKER ACTUALLY READS.
//
// WHY THIS SCRIPT EXISTS. backfill-sofa-special-orders.mjs wrote
// `custom_specials`. That is the wrong field twice over:
//   - the picker binds to variants.specials
//     (frontend/src/vendor/scm/components/SpecialOrders.tsx:91,
//      callers SoLineCard.tsx:944, PoLineCard.tsx:493 + :541), so nothing it
//     wrote was ever visible as a tick;
//   - custom_specials is a DERIVED OUTPUT of the pricing recompute
//     (backend/src/scm/lib/mfg-pricing-recompute.ts:283 normalises
//     variants.specials, :604 emits custom_specials) and the SO line PATCH
//     overwrites it wholesale (backend/src/scm/routes/mfg-sales-orders.ts:8234),
//     so the FIRST UI edit of a migrated line erases whatever was put there.
//
// This writes variants.specials (a de-duplicated string[] of picker codes),
// preserves every other key in the variants jsonb, preserves codes already
// present, and never touches custom_specials — recompute regenerates that.
//
// THE MONEY GUARD. scm.special_addons rows carry selling_price_sen /
// cost_price_sen, and a picked code's selling surcharge is folded into the
// authoritative unit price (mfg-pricing.ts:396/400/405 -> unitPriceSen :408-415,
// consumed at mfg-pricing-recompute.ts:435). Stamping a PRICED code onto a
// migrated line therefore reprices that historical document on its next edit.
// So: APPLY refuses to run if any code this map would stamp carries a non-zero
// price. That is an owner decision, not this script's.
//
// THE SPLIT. SKIP_PRICED=1 lands the money-neutral majority without waiting on
// that owner decision: a code is stamped only when BOTH selling_price_sen and
// cost_price_sen are 0 in the LIVE scm.special_addons read, and any line that
// would RECEIVE a priced code is skipped WHOLE — not partly stamped — and
// reported separately. Priced-ness is never hard-coded, so a code the owner
// prices tomorrow is skipped automatically from that moment.
// Under SKIP_PRICED the write runs in ONE transaction that sums the affected
// lines' money columns before and after and ROLLS BACK on any difference: a
// zero-priced code contributes specialsSurchargeSen 0 (mfg-pricing.ts:396-415),
// so the sums must be identical, and the transaction proves it rather than
// asserting it.
//
// DRY-RUN by default; APPLY=1 writes.
import postgres from "postgres";
/* The phrase -> picker-code rules moved to scripts/lib/special-order-phrase-mapper.mjs
   so the follow-up that records the HELD-BACK priced options derives the SAME
   population by construction rather than by a second author re-deriving it. */
import {
  K, asArray, loadPhraseMap, buildLiveIndex, classifyLine, variantsShape,
} from "./lib/special-order-phrase-mapper.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const SKIP_PRICED = process.env.SKIP_PRICED === "1";
const DIAG = process.env.DIAG === "1";
const CO = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 40); // per-line change lines to print
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const MAP = loadPhraseMap();

/* The money columns of the two line tables. NOTE the name: the authoritative
   selling figure the recompute calls `unit_price_sen`
   (mfg-pricing-recompute.ts:600) is PERSISTED into the column
   `unit_price_sen` (mfg-sales-orders.ts:4291) — the column name is a legacy
   misnomer, the unit is sen. Summing the wrong column would prove nothing. */
const MONEY_COLS = {
  mfg_sales_order_items: ["unit_price_sen", "total_sen", "total_inc_sen", "discount_sen",
    "unit_cost_sen", "line_cost_sen", "special_order_price_sen", "divan_price_sen", "leg_price_sen"],
  purchase_order_items: ["unit_price_sen", "line_total_sen", "discount_sen",
    "unit_cost_sen", "special_order_price_sen", "divan_price_sen", "leg_price_sen"],
};

async function moneySums(tx, table, ids) {
  const cols = MONEY_COLS[table];
  if (!ids.length) return { n: 0, ...Object.fromEntries(cols.map((c) => [c, "0"])) };
  const sel = cols.map((c) => `COALESCE(SUM(${c}),0)::text AS ${c}`).join(", ");
  const [row] = await tx.unsafe(
    `SELECT COUNT(*)::int AS n, ${sel} FROM scm.${table} WHERE id = ANY($1::uuid[])`, [ids]);
  return row;
}

/* Verification read — how many migrated lines actually carry picker codes in
   the field the picker reads, counted from the DB rather than from our own
   update list. Read-only, safe to run in DRY-RUN too. */
async function carryingCounts() {
  const [so] = await sql`SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL
       AND jsonb_typeof(i.variants->'specials') = 'array' AND jsonb_array_length(i.variants->'specials') > 0`;
  const [po] = await sql`SELECT COUNT(*)::int AS n FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
     WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL
       AND jsonb_typeof(i.variants->'specials') = 'array' AND jsonb_array_length(i.variants->'specials') > 0`;
  return { so: so.n, po: po.n };
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} skipPriced=${SKIP_PRICED ? 1 : 0} diag=${DIAG ? 1 : 0} company=${CO}`);

  // ── the picker master, read LIVE, WITH PRICES ────────────────────────────────
  const addons = await sql`SELECT code, label, categories, active, selling_price_sen, cost_price_sen
    FROM scm.special_addons WHERE company_id = ${CO} ORDER BY code`;
  log(`scm.special_addons rows: ${addons.length}`);
  log(`   ${"sell".padStart(6)} ${"cost".padStart(6)}  active  categories        code`);
  for (const r of addons) {
    log(`   ${String(r.selling_price_sen ?? 0).padStart(6)} ${String(r.cost_price_sen ?? 0).padStart(6)}` +
        `  ${r.active === false ? "  no  " : " yes  "}  ${(r.categories || []).join("+").padEnd(16)}  [${r.code}]`);
  }

  /* Priced-ness comes from THIS live read every run — never a list in the
     source. A code the owner prices tomorrow starts being skipped tomorrow. */
  const { liveByCat, priceOf, isPriced } = buildLiveIndex(addons);
  for (const cat of ["SOFA", "BEDFRAME"])
    log(`${cat} picker codes: ${new Set([...liveByCat.get(cat).values()]).size}`);
  const livePriced = addons.filter((r) => isPriced(r.code));
  log("");
  log(`live price split of scm.special_addons: ${addons.length - livePriced.length} zero-priced, ${livePriced.length} priced`);
  for (const r of livePriced) log(`   PRICED  sell=${r.selling_price_sen} cost=${r.cost_price_sen}  [${r.code}]`);
  if (SKIP_PRICED) log(`SKIP_PRICED=1 — only 0/0 codes will be stamped; any line receiving a priced code is skipped whole.`);

  // families whose code the owner has not created (or has re-categorised away)
  const missing = [];
  for (const f of MAP.families)
    for (const cat of f.categories)
      if (!liveByCat.get(cat).has(K(f.code))) missing.push(`${cat}  ${f.code}`);
  for (const [, want] of MAP.swaps)
    if (!liveByCat.get("SOFA").has(K(want))) missing.push(`SOFA  ${want}`);
  if (missing.length) {
    log("");
    log(`map entries whose code is NOT live — their phrases fall through to UNMAPPED, never invented:`);
    for (const m of missing) log(`   MISSING  ${m}`);
  }

  // ── the migrated lines ───────────────────────────────────────────────────────
  const soLines = await sql`SELECT i.id, i.doc_no AS doc, i.item_code AS code, i.item_group AS grp,
      i.description2 AS d2, i.variants
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL`;
  // purchase_orders numbers itself po_number; only the SO header uses doc_no
  const poLines = await sql`SELECT i.id, h.po_number AS doc, i.item_code AS code, i.item_group AS grp,
      i.description2 AS d2, i.variants
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL`;
  const nSofa = (rs) => rs.filter((r) => r.grp === "sofa").length;
  log("");
  log(`migrated lines: SO ${soLines.length} (sofa ${nSofa(soLines)}, bedframe ${soLines.length - nSofa(soLines)})` +
      `, PO ${poLines.length} (sofa ${nSofa(poLines)}, bedframe ${poLines.length - nSofa(poLines)})`);

  const byCode = new Map();       // picker code -> lines that would gain it
  const unmapped = new Map();     // phrase -> occurrences
  const excludedHits = new Map(); // excluded rule why -> occurrences
  const updates = { so: [], po: [] };
  const samples = [];
  const skippedByCode = new Map();  // priced code -> lines held back because of it
  const skippedLines = [];          // one line per held-back line, for the report
  let forgoneZeroCodes = 0;         // 0/0 codes NOT stamped because their line was held back
  const oddVariants = [];           // rows whose variants jsonb is not an object
  const hydraulic = { lines: [], withDivan: 0, codeInItem: 0 }; // DIAG only

  for (const [which, rows] of [["so", soLines], ["po", poLines]]) {
    for (const r of rows) {
      /* ONE classifier, shared with record-priced-specials-on-migrated-lines.mjs
         (scripts/lib/special-order-phrase-mapper.mjs) so the two scripts cannot
         disagree about which lines are in which half of the split. */
      const cls = classifyLine(r, MAP, liveByCat);
      const { cat, phrases } = cls;
      if (!phrases.length) continue;

      /* HYDRAULIC is the biggest unmapped phrase. It is not obviously an
         add-on: parse-bedframe.mjs:46-75 uses the word to DERIVE the divan
         height (outer wins, inner+2) and only then pushes it as a "special".
         Report what those lines already carry so the owner can rule on whether
         it is a picker code at all — this script never invents one. */
      if (DIAG && phrases.some((p) => /HYDRAUL/i.test(p))) {
        const vv = (r.variants && typeof r.variants === "object" && !Array.isArray(r.variants)) ? r.variants : {};
        const dh = vv.divanHeight;
        if (!(dh === undefined || dh === null || String(dh).trim() === "")) hydraulic.withDivan++;
        if (/HYDRAUL/i.test(String(r.code || ""))) hydraulic.codeInItem++;
        hydraulic.lines.push({
          which, doc: r.doc, code: r.code, divanHeight: dh ?? null,
          specialsNow: asArray(vv.specials).length, d2: String(r.d2 || "").slice(0, 90),
        });
      }

      for (const why of cls.excludedHits) excludedHits.set(why, (excludedHits.get(why) || 0) + 1);
      for (const u of cls.unmapped) unmapped.set(u, (unmapped.get(u) || 0) + 1);
      if (!cls.gained.length) continue;

      /* `variants` is not always a JSON OBJECT in production. jsonb_set's path
         addresses object keys, so on a row holding a jsonb ARRAY it fails the
         whole statement — "path element at position 1 is not an integer:
         specials", which rolled back run 31417530815 entirely. Coercing such a
         row to '{}' would DELETE whatever it holds, which the owner's
         不可以删只可以 cancel rule forbids, so the line is skipped and reported
         for a human to look at. */
      const vtype = variantsShape(r.variants);
      if (vtype !== "object" && vtype !== "null") {
        oddVariants.push(`   ${which.toUpperCase()} ${String(r.doc ?? "").padEnd(14)} ${String(r.code ?? "").padEnd(18)} ` +
                         `jsonb is ${vtype}: ${JSON.stringify(r.variants).slice(0, 120)}`);
        continue;
      }

      /* MERGE, never replace: keep every other key in the variants jsonb and
         every code the line already carries. `special` is the HOOKKA-compatible
         singular the picker also reads (SpecialOrders.tsx:91). */
      const { had, next, addedNow } = cls;
      if (!addedNow.length) continue;

      /* THE SPLIT. "Would receive" is addedNow, not gained: a line that ALREADY
         carries the priced code is not being repriced by us, so it stays in the
         safe set. A line that would newly receive one is held back WHOLE — its
         0/0 codes are forgone too, so the line is never left half-stamped. */
      if (SKIP_PRICED) {
        const pricedNow = addedNow.filter(isPriced);
        if (pricedNow.length) {
          const zeroNow = addedNow.filter((c) => !isPriced(c));
          forgoneZeroCodes += zeroNow.length;
          for (const c of pricedNow) skippedByCode.set(c, (skippedByCode.get(c) || 0) + 1);
          skippedLines.push(`   SKIP ${which.toUpperCase()} ${String(r.doc ?? "").padEnd(14)} ${String(r.code ?? "").padEnd(18)} ` +
                            `priced=${JSON.stringify(pricedNow)}` + (zeroNow.length ? ` forgone=${JSON.stringify(zeroNow)}` : ""));
          continue;
        }
      }

      for (const c of addedNow) byCode.set(c, (byCode.get(c) || 0) + 1);
      /* OWNER RULE 2026-08-11: 不可以删只可以 cancel — nothing is ever deleted.
         `next` must be a strict SUPERSET of what the line already carried, so a
         code a human picked can never be dropped by this sweep. Checked here
         per line, and again after the commit against what the DB actually
         holds. A violation is a bug in this script, so it stops the run. */
      const lost = had.filter((h) => !next.includes(h));
      if (lost.length) throw new Error(`merge-only violated on ${which} ${r.id}: would drop ${JSON.stringify(lost)}`);
      updates[which].push({ id: r.id, had, next });
      if (samples.length < SHOW)
        samples.push(`   ${which.toUpperCase()} ${String(r.doc ?? "").padEnd(14)} ${String(r.code ?? "").padEnd(18)} ` +
                     `${JSON.stringify(had)} + ${JSON.stringify(addedNow)}`);
    }
  }

  // ── report ───────────────────────────────────────────────────────────────────
  log("");
  log(`per-line changes (first ${SHOW}):`);
  for (const s of samples) log(s);
  log("");
  log(`per-code tally (lines that would GAIN the code):`);
  let pricedTotal = 0;
  const priced = [];
  for (const [c, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    const p = priceOf.get(c) || { sell: 0, cost: 0 };
    const tag = (p.sell || p.cost) ? `   <-- PRICED sell=${p.sell} cost=${p.cost}` : "";
    if (p.sell || p.cost) { priced.push({ c, n, ...p }); pricedTotal += p.sell * n; }
    log(`   ${String(n).padStart(4)}  ${c}${tag}`);
  }
  log("");
  log(`phrases deliberately NOT a special code (owner ruling — compartment / free text / leg pool):`);
  for (const [w, n] of [...excludedHits.entries()].sort((a, b) => b[1] - a[1])) log(`   ${String(n).padStart(4)}  ${w}`);
  log("");
  log(`UNMAPPED phrases — no owner code, left alone: ${[...unmapped.values()].reduce((a, b) => a + b, 0)} (${unmapped.size} distinct)`);
  for (const [p, n] of [...unmapped.entries()].sort((a, b) => b[1] - a[1])) log(`   ${String(n).padStart(4)}  ${p}`);
  if (SKIP_PRICED) {
    log("");
    log(`HELD BACK for carrying a priced code: ${skippedLines.length} lines ` +
        `(and ${forgoneZeroCodes} zero-priced codes forgone with them):`);
    for (const s of skippedLines) log(s);
    log(`   per priced code (lines held back BECAUSE of it):`);
    let heldSell = 0;
    for (const [c, n] of [...skippedByCode.entries()].sort((a, b) => b[1] - a[1])) {
      const p = priceOf.get(c) || { sell: 0, cost: 0 };
      heldSell += p.sell * n;
      log(`   ${String(n).padStart(4)}  ${c}  sell=${p.sell} cost=${p.cost}`);
    }
    log(`   selling exposure NOT taken: ${heldSell} sen (RM ${(heldSell / 100).toFixed(2)})`);
  }

  if (DIAG) {
    log("");
    log(`HYDRAULIC diagnostic: ${hydraulic.lines.length} lines whose parsed specials include it`);
    log(`   already carry variants.divanHeight: ${hydraulic.withDivan}/${hydraulic.lines.length}`);
    log(`   item_code itself contains HYDRAULIC: ${hydraulic.codeInItem}/${hydraulic.lines.length}`);
    for (const h of hydraulic.lines.slice(0, 25))
      log(`   ${h.which.toUpperCase()} ${String(h.doc ?? "").padEnd(14)} ${String(h.code ?? "").padEnd(24)} ` +
          `divanHeight=${JSON.stringify(h.divanHeight)} specials=${h.specialsNow}  d2="${h.d2}"`);
    /* The no-height tail in FULL, never truncated. The owner asked which lines
       carry no divanHeight, and the 25-line slice above answers that only by
       luck. These are the lines where the tick is the ONLY thing the ERP will
       know about the bed, so a human has to read the slip — nobody may infer a
       height for them, here or anywhere else. */
    const noHeight = hydraulic.lines.filter((h) =>
      h.divanHeight === null || h.divanHeight === undefined || String(h.divanHeight).trim() === "");
    log(`   --- hydraulic lines with NO divanHeight: ${noHeight.length} (listed in full) ---`);
    for (const h of noHeight)
      log(`   NO-HEIGHT ${h.which.toUpperCase()} ${String(h.doc ?? "").padEnd(14)} ${String(h.code ?? "").padEnd(24)} d2="${h.d2}"`);
    const hyAddon = addons.filter((r) => /HYDRAUL/i.test(String(r.code || "") + " " + String(r.label || "")));
    log(`   scm.special_addons rows matching HYDRAUL: ${hyAddon.length}` +
        (hyAddon.length ? ` -> ${hyAddon.map((r) => `[${r.code}]`).join(" ")}` : " (none — no picker code exists)"));
  }

  if (oddVariants.length) {
    log("");
    log(`SKIPPED — variants jsonb is not an object on ${oddVariants.length} lines. jsonb_set cannot address a`);
    log(`key inside an array, and overwriting one would delete what it holds. Left exactly as found:`);
    for (const s of oddVariants) log(s);
  }

  log("");
  log(`lines that would change: SO ${updates.so.length}, PO ${updates.po.length}`);

  // ── money verdict ────────────────────────────────────────────────────────────
  log("");
  if (priced.length) {
    log(`MONEY: ${priced.length} of the codes this backfill would stamp are PRICED. Stamping them`);
    log(`repices those historical lines on their next UI edit (mfg-pricing.ts:408-415 folds`);
    log(`specialsSurchargeSen into unitPriceSen; mfg-pricing-recompute.ts:435 charges it).`);
    for (const p of priced) log(`   ${p.c}: sell=${p.sell} sen cost=${p.cost} sen x ${p.n} lines`);
    log(`   total selling exposure: ${pricedTotal} sen (RM ${(pricedTotal / 100).toFixed(2)})`);
  } else {
    log(`MONEY: every code this backfill would stamp is priced 0/0 in scm.special_addons,`);
    log(`so specialsSurchargeSen stays 0 and no line total can move (mfg-pricing.ts:396-415).`);
  }

  const before0 = await carryingCounts();
  log("");
  log(`lines ALREADY carrying a non-empty variants.specials: SO ${before0.so}, PO ${before0.po}`);

  if (!APPLY) { log(""); log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  if (priced.length) {
    log("");
    log("REFUSING TO APPLY: a priced code would move money on migrated documents. Owner decision.");
    await sql.end();
    return;
  }

  const TABLES = [["so", "mfg_sales_order_items"], ["po", "purchase_order_items"]];

  /* jsonb_set on the ONE key, so every other key in variants survives even if
     another writer touched the row between the read and this write. */
  /* Count the rows each UPDATE actually touched. An UPDATE whose WHERE matches
     nothing is silent, and "APPLIED" printed from a loop counter is not
     evidence — refresh-sofa-colours.mjs logged "stamped 146 sofa lines" three
     times and a read 29 seconds later found nothing (BUG-HISTORY.md). */
  const writeBatch = async (tx, table, list) => {
    let touched = 0;
    for (const u of list) {
      /* The type guard is in the WHERE, not a CASE in the SET: a row that turned
         into an array between the read and this write must be LEFT ALONE, not
         coerced. It then shows up as a shortfall in the row count below, which
         rolls the transaction back rather than half-applying it. */
      const res = await tx.unsafe(
        `UPDATE scm.${table}
            SET variants = jsonb_set(COALESCE(variants, '{}'::jsonb), '{specials}', $1::jsonb, true)
          WHERE id = $2
            AND (variants IS NULL OR jsonb_typeof(variants) = 'object')`,
        // tx.json, never JSON.stringify - see BUG-HISTORY / docs/jsonb-double-
        // encoding-coe.md, 2026-08-10. postgres.js applies its own
        // JSON.stringify to any parameter it resolves to json/jsonb, and with
        // prepare:false + parameters it always learns that type from the server
        // before binding, so a pre-stringified value is encoded TWICE and
        // jsonb_set writes variants.specials as a STRING - invisible to every
        // Array.isArray() reader, which is exactly how custom_specials broke.
        [tx.json(u.next), u.id]);
      touched += res.count ?? 0;
    }
    return touched;
  };

  if (SKIP_PRICED) {
    /* Belt and braces: the split already excluded them, so a priced code
       reaching here would mean the classifier is wrong, not the data. */
    const leak = [...byCode.keys()].filter(isPriced);
    if (leak.length) {
      log("");
      log(`ABORT: priced codes reached the safe set — ${leak.join(", ")}. Not writing.`);
      await sql.end();
      return;
    }
    /* ONE transaction: sum the money columns of exactly the rows about to be
       written, write, sum again, and throw on any difference so the whole thing
       rolls back. Proof, not assertion. */
    let proved = false;
    const touchedBy = {};
    try {
      await sql.begin(async (tx) => {
        const before = {}, after = {};
        for (const [which, table] of TABLES) before[which] = await moneySums(tx, table, updates[which].map((u) => u.id));
        for (const [which, table] of TABLES) touchedBy[which] = await writeBatch(tx, table, updates[which]);
        for (const [which, table] of TABLES) after[which] = await moneySums(tx, table, updates[which].map((u) => u.id));
        /* Rows the UPDATE actually matched must equal rows we meant to write.
           A shortfall means the WHERE found nothing — roll back, do not log a
           success. */
        for (const [which] of TABLES)
          if (touchedBy[which] !== updates[which].length)
            throw new Error(`${which}: UPDATE touched ${touchedBy[which]} rows, expected ${updates[which].length}`);
        const diffs = [];
        for (const [which, table] of TABLES) {
          log("");
          log(`money proof ${which.toUpperCase()} (${before[which].n} rows locked in this transaction):`);
          for (const c of MONEY_COLS[table]) {
            const b = String(before[which][c]), a = String(after[which][c]);
            log(`   ${c.padEnd(24)} before=${b.padStart(12)}  after=${a.padStart(12)}  ${b === a ? "IDENTICAL" : "MOVED"}`);
            if (b !== a) diffs.push(`${which}.${c} ${b} -> ${a}`);
          }
        }
        if (diffs.length) throw new Error(`MONEY MOVED, rolling back: ${diffs.join("; ")}`);
        proved = true;
      });
    } catch (e) {
      log("");
      log(`ROLLED BACK — ${e.message}`);
      await sql.end();
      process.exit(1);
    }
    log("");
    log(`transaction committed — UPDATE touched SO ${touchedBy.so}/${updates.so.length}, ` +
        `PO ${touchedBy.po}/${updates.po.length}. Money columns identical: ${proved}.`);

    /* READ-BACK ON A NEW CONNECTION. Everything above happened inside the
       transaction that wrote it, so it cannot prove the commit is visible to
       anybody else. Open a SEPARATE session and read the rows back. If this
       does not show the codes, the run reports NOT LANDED. */
    const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
    let ok = 0, bad = 0;
    const badSamples = [];
    try {
      for (const [which, table] of TABLES) {
        const list = updates[which];
        for (let i = 0; i < list.length; i += 500) {
          const b = list.slice(i, i + 500);
          const rows = await v.unsafe(
            `SELECT id::text AS id, COALESCE(variants->'specials', '[]'::jsonb) AS specials
               FROM scm.${table} WHERE id = ANY($1::uuid[])`, [b.map((u) => u.id)]);
          const got = new Map(rows.map((r) => [r.id, asArray(r.specials).map((x) => K(x))]));
          for (const u of b) {
            const have = got.get(String(u.id)) || [];
            // every code we wrote is there, AND every code the line already had
            // is STILL there — merge only, nothing deleted (owner 2026-08-11)
            const missing = u.next.filter((c) => !have.includes(K(c)));
            const dropped = u.had.filter((c) => !have.includes(K(c)));
            if (missing.length || dropped.length) {
              bad++;
              if (badSamples.length < 10) badSamples.push(
                `   ${which} ${u.id} missing=${JSON.stringify(missing)} DROPPED=${JSON.stringify(dropped)} have=${JSON.stringify(have)}`);
            } else ok++;
          }
        }
      }
    } finally { await v.end(); }

    log("");
    log(`READ-BACK on a NEW connection: ${ok} lines carry every code we wrote, ${bad} do not.`);
    for (const s of badSamples) log(s);

    const after0 = await carryingCounts();
    log(`VERIFY — lines carrying a non-empty variants.specials: SO ${after0.so} (was ${before0.so}), ` +
        `PO ${after0.po} (was ${before0.po})`);

    if (bad || ok !== updates.so.length + updates.po.length) {
      log("");
      log(`NOT LANDED — the read-back does not account for every line. Do not treat this run as applied.`);
      await sql.end();
      process.exit(1);
    }
    log("");
    log(`APPLIED (SKIP_PRICED) — SO ${updates.so.length} lines, PO ${updates.po.length} lines, ` +
        `${skippedLines.length} lines held back as priced, PROVEN by read-back. custom_specials untouched.`);
    await sql.end();
    return;
  }

  for (const [which, table] of TABLES) {
    const list = updates[which];
    let touched = 0;
    for (let i = 0; i < list.length; i += 200) {
      const b = list.slice(i, i + 200);
      await sql.begin(async (tx) => { touched += await writeBatch(tx, table, b); });
      log(`  ${which} ..${Math.min(i + 200, list.length)}/${list.length}`);
    }
    log(`  ${which} rows actually touched by UPDATE: ${touched}/${list.length}`);
  }
  log(`APPLIED — SO ${updates.so.length} lines, PO ${updates.po.length} lines. custom_specials untouched.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
