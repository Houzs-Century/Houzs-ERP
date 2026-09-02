#!/usr/bin/env node
// Record the PRICED special orders the backfill held back — WITHOUT letting any
// document's money move. Owner's choice 甲, 2026-09-03: 「记下来给工厂看，但单据的
//钱不可以动」.
//
// RE-RUN: idempotent. The stamp is a MERGE on two variants keys — a code already
// present is not re-added, and `specialsRecordedOnly` is rewritten as the union
// of what it holds and what this run recorded. A second APPLY writes 0 rows and
// its money proof is the same IDENTICAL block. Nothing is ever removed.
//
// ─── WHAT THE BACKFILL LEFT ───────────────────────────────────────────────────
// `backfill-specials-into-variants.mjs` with SKIP_PRICED=1 stamped the 0/0-priced
// codes and HELD BACK every line that would newly gain a PRICED one — prod run
// 33517835461: 442 lines stamped, 338 held back, RM 27,900 of selling surcharge
// "not taken". Those 338 lines are the ones whose AutoCount Desc2 asks for an
// option the ERP line does not carry, so the factory cannot see it in the picker.
//
// ─── THE MONEY TRACE, WHICH IS THE WHOLE QUESTION ─────────────────────────────
// The surcharge is NOT stored on the line by this write and it is NOT recomputed
// on read. It is recomputed and PERSISTED on a route WRITE that changes the
// line's priced shape, and only then:
//
//   · `mfg-sales-orders.ts:8357`  shouldRecompute = variantsChanged ||
//     itemCodeChangedOnPatch || priceChanged, where `variantsChanged` compares
//     the INCOMING variants against the STORED ones through a key-order-
//     independent canonJson (`:8345-8356`). Re-saving a line the operator did
//     not touch recomputes nothing.
//   · `mfg-pricing-recompute.ts:381-387` replaces the config's specials pool with
//     THIS line's pool built from `scm.special_addons`
//     (`mfg-pricing.ts:buildSpecialsPoolFromAddons`), so `sellingPriceSen` =
//     selling_price_sen and `priceSen` = cost_price_sen.
//   · SELLING — `mfg-pricing.ts:438/442/447` sum it into
//     `breakdown.specialsSurchargeSen` and `:456-463` fold it into unitPriceSen.
//     On a MIGRATED line that is switched OFF STRUCTURALLY:
//     `mfg-pricing-recompute.ts:546-547` sets chargeableSurchargesSen = 0 under
//     `trustOperatorSelling === 'including-zero'`, and `:725-730` persists the
//     STORED price. The marker comes from `erpLineTrust(..., soIsMigrated)`
//     (`:275`), fed by `linked_ac_docno IS NOT NULL` (`mfg-sales-orders.ts:8231`).
//     → the customer-facing price of a migrated SO CANNOT move. (owner, 2026-09-02)
//   · COST — `mfg-pricing-recompute.ts:579` unitCostSen = costBreakdown
//     .unitPriceSen, which includes `sumSpecialsCost` (`mfg-pricing.ts:538/541/
//     543`). This has NO migrated exemption, and the route persists it into
//     unit_cost_sen / line_cost_sen / line_margin_sen
//     (`mfg-sales-orders.ts:8522-8538`).
//   · The breakdown column `special_order_price_sen` is written from
//     `breakdown.specialsSurchargeSen` (`:8546`) — also with no migrated
//     exemption.
//   · PURCHASE ORDERS have NO server recompute at all: PATCH
//     /:id/items/:itemId (`mfg-purchase-orders.ts:3131`) persists whatever the
//     client sends (`:3164-3172`, `:3204-3208`). The re-pricing is in the ERP UI
//     — `PurchaseOrderDetail.tsx:415` re-prices any line whose `priceTouched` is
//     false and `:621-629` clears that flag when the operator edits a variant —
//     and it reads the SUPPLIER MAINTENANCE CONFIG's specials pool
//     (`computeMfgPoUnitCost` -> `computeMfgLineCost`), NOT scm.special_addons.
//     Whether those codes are priced THERE is a live fact, so this script reads
//     it and prints it rather than assuming either way.
//
// So: writing variants.specials moves NOTHING at rest — and this run PROVES that
// rather than asserting it, by censusing pg_trigger and the generated columns of
// both line tables (a write and its read-back disagreeing because of a trigger
// is a real trap here: migration 0229 canonicalises `venue` that way).
// What it does is ARM the next genuine line edit, on the COST side.
//
// ─── SO THE STAMP CARRIES ITS OWN "DO NOT CHARGE" ─────────────────────────────
// Alongside `variants.specials` this writes `variants.specialsRecordedOnly` —
// the exact codes THIS backfill recorded, never anything a human picked. It is
// the line-level statement that these options are a RECORD of what AutoCount had
// already priced into the imported figure, not a new charge. The pricing engine
// honours it by dropping those codes from both surcharge sums, so the tick shows
// in the picker and prints on the slip while contributing 0 to selling AND cost,
// on every future recompute, on the SO server path and the PO client path alike.
//
// MODE=plan is the default and writes nothing. MODE=apply additionally requires
// CONFIRM=RECORD-NOT-CHARGE.
import postgres from "postgres";
import {
  K, asArray, loadPhraseMap, buildLiveIndex, classifyLine, variantsShape,
} from "./lib/special-order-phrase-mapper.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = process.env.CONFIRM || "";
const CONFIRM_PHRASE = "RECORD-NOT-CHARGE";
const CO = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 40);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const MAP = loadPhraseMap();

/* The money columns of the two line tables — the SAME list
   backfill-specials-into-variants.mjs proves identical, so the two runs'
   proofs are comparable line for line. */
const MONEY_COLS = {
  mfg_sales_order_items: ["unit_price_sen", "total_sen", "total_inc_sen", "discount_sen",
    "unit_cost_sen", "line_cost_sen", "special_order_price_sen", "divan_price_sen", "leg_price_sen"],
  purchase_order_items: ["unit_price_sen", "line_total_sen", "discount_sen",
    "unit_cost_sen", "special_order_price_sen", "divan_price_sen", "leg_price_sen"],
};
const TABLES = [["so", "mfg_sales_order_items"], ["po", "purchase_order_items"]];

async function moneySums(tx, table, ids) {
  const cols = MONEY_COLS[table];
  if (!ids.length) return { n: 0, ...Object.fromEntries(cols.map((c) => [c, "0"])) };
  const sel = cols.map((c) => `COALESCE(SUM(${c}),0)::text AS ${c}`).join(", ");
  const [row] = await tx.unsafe(
    `SELECT COUNT(*)::int AS n, ${sel} FROM scm.${table} WHERE id = ANY($1::uuid[])`, [ids]);
  return row;
}

/* THE SHAPE CENSUS THAT MAKES "no money moved" A MEASUREMENT.
   A write whose SET list touches one jsonb key still moves money if a TRIGGER
   or a GENERATED column derives money from that key. Migration 0229 does exactly
   that to `venue`, and a repair that compared its own write against the raw
   master once cried FAILED over it. Read pg_catalog, not the migration files. */
async function derivationCensus(db) {
  const rows = await db`
    SELECT c.relname::text AS table_name, t.tgname::text AS trigger_name,
           pg_get_triggerdef(t.oid)::text AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = 'scm'
       AND c.relname IN ('mfg_sales_order_items', 'purchase_order_items')
     ORDER BY c.relname, t.tgname`;
  const gen = await db`
    SELECT c.relname::text AS table_name, a.attname::text AS column_name,
           a.attgenerated::text AS generated
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'scm' AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attgenerated <> ''
       AND c.relname IN ('mfg_sales_order_items', 'purchase_order_items')
     ORDER BY c.relname, a.attname`;
  return { triggers: rows, generated: gen };
}

/* The SUPPLIER-side pool. The PO client re-price reads THIS, not
   scm.special_addons, so a code that is priced in special_addons and absent
   here cannot move a PO line — and the reverse is equally possible. Report
   what is actually there. */
async function maintenanceSpecialsPool(db) {
  const rows = await db`SELECT scope, config FROM scm.maintenance_config_history
     ORDER BY effective_from DESC`;
  const bestByScope = new Map();
  for (const r of rows) if (!bestByScope.has(r.scope)) bestByScope.set(r.scope, r.config);
  const out = [];
  for (const [scope, cfg] of bestByScope) {
    for (const key of ["specials", "sofaSpecials"]) {
      for (const o of Array.isArray(cfg?.[key]) ? cfg[key] : []) {
        out.push({ scope, key, value: o?.value, priceSen: Number(o?.priceSen ?? 0),
          costSen: Number(o?.costSen ?? 0), sellingPriceSen: Number(o?.sellingPriceSen ?? 0) });
      }
    }
  }
  return { scopes: [...bestByScope.keys()], entries: out };
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"} company=${CO}`);
  if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
    log(`REFUSING: MODE=apply needs CONFIRM=${CONFIRM_PHRASE}. Nothing was read or written.`);
    await sql.end();
    process.exit(2);
  }

  // ── the picker master, read LIVE, WITH PRICES ───────────────────────────────
  const addons = await sql`SELECT code, label, categories, active, selling_price_sen, cost_price_sen
    FROM scm.special_addons WHERE company_id = ${CO} ORDER BY code`;
  const { liveByCat, priceOf, isPriced } = buildLiveIndex(addons);
  const priced = addons.filter((r) => isPriced(r.code));
  log(`scm.special_addons rows: ${addons.length} — ${addons.length - priced.length} zero-priced, ${priced.length} priced`);
  for (const r of priced) log(`   PRICED  sell=${r.selling_price_sen} cost=${r.cost_price_sen}  [${r.code}]`);

  // ── the migrated lines (verbatim the backfill's two queries) ────────────────
  const soLines = await sql`SELECT i.id, i.doc_no AS doc, i.item_code AS code, i.item_group AS grp,
      i.description2 AS d2, i.variants, i.qty
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL`;
  const poLines = await sql`SELECT i.id, h.po_number AS doc, i.item_code AS code, i.item_group AS grp,
      i.description2 AS d2, i.variants, i.qty
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL`;
  log("");
  log(`migrated lines read: SO ${soLines.length}, PO ${poLines.length}`);

  const updates = { so: [], po: [] };
  const byCode = new Map();          // priced code -> lines that would record it
  const zeroRidingAlong = new Map(); // 0/0 code forgone by the earlier split, now landed
  const samples = [];
  const oddVariants = [];
  const alreadyArmed = { so: 0, po: 0, codes: new Map() }; // lines that ALREADY carry a priced code
  let safeSetSize = 0;               // what the earlier SKIP_PRICED pass would stamp today

  for (const [which, rows] of TABLES.map(([w]) => [w, w === "so" ? soLines : poLines])) {
    for (const r of rows) {
      /* Lines that ALREADY carry a priced code are the population whose next
         edit is armed TODAY, with or without this script. Counting them is what
         says whether the engine's record-only rule is new behaviour or a
         correction to behaviour already live. */
      const v0 = (r.variants && typeof r.variants === "object" && !Array.isArray(r.variants)) ? r.variants : {};
      const carries = [...new Set([...asArray(v0.specials), ...asArray(v0.special)].map((x) => String(x).trim()))]
        .filter((c) => isPriced(c));
      if (carries.length) {
        alreadyArmed[which]++;
        for (const c of carries) alreadyArmed.codes.set(c, (alreadyArmed.codes.get(c) || 0) + 1);
      }

      const cls = classifyLine(r, MAP, liveByCat);
      if (!cls.phrases.length || !cls.addedNow.length) continue;
      const pricedNow = cls.addedNow.filter(isPriced);
      if (!pricedNow.length) { safeSetSize++; continue; }   // the earlier pass owns these

      const vtype = variantsShape(r.variants);
      if (vtype !== "object" && vtype !== "null") {
        oddVariants.push(`   ${which.toUpperCase()} ${String(r.doc ?? "").padEnd(14)} ${String(r.code ?? "").padEnd(18)} ` +
                         `jsonb is ${vtype}: ${JSON.stringify(r.variants).slice(0, 120)}`);
        continue;
      }

      /* MERGE ONLY (owner 2026-08-11 不可以删只可以 cancel). `next` must be a
         strict superset of what the line already carried; a violation is a bug
         in this script, so it stops the run rather than writing. */
      const lost = cls.had.filter((h) => !cls.next.includes(h));
      if (lost.length) throw new Error(`merge-only violated on ${which} ${r.id}: would drop ${JSON.stringify(lost)}`);

      const zeroNow = cls.addedNow.filter((c) => !isPriced(c));
      for (const c of pricedNow) byCode.set(c, (byCode.get(c) || 0) + 1);
      for (const c of zeroNow) zeroRidingAlong.set(c, (zeroRidingAlong.get(c) || 0) + 1);

      /* The record-only marker is the UNION of what the line already declares
         and what this run recorded — never a replacement, so a rerun (or a
         second pass over a line the owner has since edited) cannot silently
         drop a code from the no-charge list. Only codes THIS backfill added go
         in; a code a human picked stays chargeable. */
      const declared = asArray(v0.specialsRecordedOnly).map((x) => String(x).trim()).filter(Boolean);
      const recordedOnly = [...new Set([...declared, ...cls.addedNow])];

      updates[which].push({
        id: r.id, doc: r.doc, code: r.code, qty: Number(r.qty ?? 0),
        had: cls.had, next: cls.next, addedNow: cls.addedNow, pricedNow, recordedOnly,
      });
      if (samples.length < SHOW)
        samples.push(`   ${which.toUpperCase()} ${String(r.doc ?? "").padEnd(14)} ${String(r.code ?? "").padEnd(20)} ` +
                     `${JSON.stringify(cls.had)} + ${JSON.stringify(cls.addedNow)}  recordOnly=${JSON.stringify(recordedOnly)}`);
    }
  }

  // ── report ──────────────────────────────────────────────────────────────────
  log("");
  log(`per-line changes (first ${SHOW}):`);
  for (const s of samples) log(s);
  log("");
  log(`lines this run would RECORD: SO ${updates.so.length}, PO ${updates.po.length} ` +
      `(total ${updates.so.length + updates.po.length})`);
  log(`lines the earlier 0/0 pass still owns and this run leaves alone: ${safeSetSize}`);
  log("");
  log(`per PRICED code (lines that would record it):`);
  for (const [c, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    const p = priceOf.get(c) || { sell: 0, cost: 0 };
    log(`   ${String(n).padStart(4)}  ${c}  sell=${p.sell} cost=${p.cost}`);
  }
  if (zeroRidingAlong.size) {
    log("");
    log(`0/0 codes that ride along on those same lines (forgone by the earlier split):`);
    for (const [c, n] of [...zeroRidingAlong.entries()].sort((a, b) => b[1] - a[1])) log(`   ${String(n).padStart(4)}  ${c}`);
  }
  if (oddVariants.length) {
    log("");
    log(`SKIPPED — variants jsonb is not an object on ${oddVariants.length} lines; left exactly as found:`);
    for (const s of oddVariants) log(s);
  }

  log("");
  log(`lines ALREADY carrying a PRICED code today (armed with or without this run): SO ${alreadyArmed.so}, PO ${alreadyArmed.po}`);
  for (const [c, n] of [...alreadyArmed.codes.entries()].sort((a, b) => b[1] - a[1]))
    log(`   ${String(n).padStart(4)}  ${c}`);

  // ── the SHAPE census: can this write move money by itself? ──────────────────
  const census = await derivationCensus(sql);
  log("");
  log(`DERIVATION CENSUS (pg_catalog, live — not the migration files):`);
  log(`   non-internal triggers on the two line tables: ${census.triggers.length}`);
  for (const t of census.triggers) log(`   TRIGGER  ${t.table_name}.${t.trigger_name}: ${t.def.slice(0, 160)}`);
  log(`   GENERATED columns on the two line tables: ${census.generated.length}`);
  for (const g of census.generated) log(`   GENERATED  ${g.table_name}.${g.column_name}`);
  const writeIsInert = census.triggers.length === 0 && census.generated.length === 0;
  log(`   -> a variants-only UPDATE ${writeIsInert
    ? "cannot move a money column: nothing derives one from variants."
    : "MUST be re-checked against the definitions above before it is applied."}`);

  // ── the PO side's real pool ─────────────────────────────────────────────────
  const pool = await maintenanceSpecialsPool(sql);
  const wanted = new Set([...byCode.keys()]);
  const poHits = pool.entries.filter((e) => wanted.has(String(e.value ?? "")));
  log("");
  log(`SUPPLIER MAINTENANCE CONFIG (what the PO client re-price actually reads):`);
  log(`   scopes present: ${pool.scopes.join(", ") || "(none)"}`);
  log(`   specials/sofaSpecials entries across all scopes: ${pool.entries.length}`);
  log(`   entries matching a code this run would record: ${poHits.length}`);
  for (const e of poHits)
    log(`   ${e.scope} ${e.key}  [${e.value}]  priceSen=${e.priceSen} costSen=${e.costSen} sellingPriceSen=${e.sellingPriceSen}`);
  if (poHits.length === 0)
    log(`   -> none. computeMfgPoUnitCost sums this pool (mfg-pricing.ts:538), so on today's data a`);
  if (poHits.length === 0)
    log(`      recorded code contributes 0 to a PO line's re-price even without the record-only rule.`);

  // ── the LATENT exposure, per column, that the stamp would arm ───────────────
  let soCost = 0, soSpecialCol = 0, poCostIfPooled = 0;
  const poolCostOf = new Map(poHits.map((e) => [String(e.value), e.priceSen || e.costSen || 0]));
  for (const u of updates.so) {
    for (const c of u.addedNow) {
      const p = priceOf.get(c) || { sell: 0, cost: 0 };
      soCost += p.cost; soSpecialCol += p.sell;
    }
  }
  for (const u of updates.po) for (const c of u.addedNow) poCostIfPooled += poolCostOf.get(c) ?? 0;
  log("");
  log(`LATENT EXPOSURE — what the NEXT genuine line edit would add, if the code were recorded PLAIN:`);
  log(`   SO unit_price_sen (customer price)   +0 sen — suppressed structurally for a migrated line`);
  log(`                                        (mfg-pricing-recompute.ts:546-547 and :725-730)`);
  log(`   SO unit_cost_sen (per unit)          +${soCost} sen (RM ${(soCost / 100).toFixed(2)}) over ${updates.so.length} lines`);
  log(`   SO special_order_price_sen           +${soSpecialCol} sen (RM ${(soSpecialCol / 100).toFixed(2)})`);
  log(`   PO unit_price_sen (client re-price)  +${poCostIfPooled} sen from the maintenance pool above`);
  log(`   The record-only marker this run writes drives every one of those to 0 and keeps them there.`);

  // ── the money proof ─────────────────────────────────────────────────────────
  if (!APPLY) {
    log("");
    for (const [which, table] of TABLES) {
      const ids = updates[which].map((u) => u.id);
      const before = await moneySums(sql, table, ids);
      log(`money proof ${which.toUpperCase()} (${before.n} rows this run would write):`);
      for (const c of MONEY_COLS[table]) {
        const b = String(before[c]);
        log(`   ${c.padEnd(24)} before=${b.padStart(12)}  after=${b.padStart(12)}  ` +
            `${writeIsInert ? "IDENTICAL (variants-only SET, no trigger, no generated column)" : "UNPROVEN — see the census above"}`);
      }
      log("");
    }
    log(`PLAN — nothing was written. MODE=apply CONFIRM=${CONFIRM_PHRASE} writes,`);
    log(`and that run repeats this proof INSIDE the transaction and rolls back on any difference.`);
    await sql.end();
    return;
  }

  if (!writeIsInert) {
    log("");
    log(`REFUSING TO APPLY: something derives a column from these rows (see the census). Not writing.`);
    await sql.end();
    process.exit(1);
  }

  /* ONE transaction: sum the money columns of exactly the rows about to be
     written, write, sum again, and throw on any difference so the whole thing
     rolls back. Proof, not assertion. */
  const writeBatch = async (tx, table, list) => {
    let touched = 0;
    for (const u of list) {
      /* The type guard is in the WHERE, not a CASE in the SET: a row that turned
         into an array between the read and this write must be LEFT ALONE. The
         shortfall then rolls the transaction back rather than half-applying it.
         tx.json, never JSON.stringify — postgres.js stringifies a jsonb
         parameter itself, and a pre-stringified value is encoded TWICE and lands
         as a jsonb STRING invisible to every Array.isArray reader
         (docs/jsonb-double-encoding-coe.md). */
      const res = await tx.unsafe(
        `UPDATE scm.${table}
            SET variants = jsonb_set(
                  jsonb_set(COALESCE(variants, '{}'::jsonb), '{specials}', $1::jsonb, true),
                  '{specialsRecordedOnly}', $2::jsonb, true)
          WHERE id = $3
            AND (variants IS NULL OR jsonb_typeof(variants) = 'object')`,
        [tx.json(u.next), tx.json(u.recordedOnly), u.id]);
      touched += res.count ?? 0;
    }
    return touched;
  };

  let proved = false;
  const touchedBy = {};
  try {
    await sql.begin(async (tx) => {
      const before = {}, after = {};
      for (const [which, table] of TABLES) before[which] = await moneySums(tx, table, updates[which].map((u) => u.id));
      for (const [which, table] of TABLES) touchedBy[which] = await writeBatch(tx, table, updates[which]);
      for (const [which, table] of TABLES) after[which] = await moneySums(tx, table, updates[which].map((u) => u.id));
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

  /* READ-BACK ON A NEW CONNECTION, asserting the SHAPE and not a row count.
     A count of 7 of 7 was true while all 7 were being corrupted
     (docs/jsonb-double-encoding-coe.md), and only the shape check saw it. Both
     keys must come back as jsonb ARRAYS holding every code we wrote, with
     nothing the line already carried dropped. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  let ok = 0, bad = 0;
  const badSamples = [];
  try {
    for (const [which, table] of TABLES) {
      const list = updates[which];
      for (let i = 0; i < list.length; i += 500) {
        const b = list.slice(i, i + 500);
        const rows = await v.unsafe(
          `SELECT id::text AS id,
                  jsonb_typeof(variants->'specials')             AS specials_type,
                  jsonb_typeof(variants->'specialsRecordedOnly') AS record_type,
                  COALESCE(variants->'specials', '[]'::jsonb)             AS specials,
                  COALESCE(variants->'specialsRecordedOnly', '[]'::jsonb) AS recorded
             FROM scm.${table} WHERE id = ANY($1::uuid[])`, [b.map((u) => u.id)]);
        const got = new Map(rows.map((r) => [r.id, r]));
        for (const u of b) {
          const row = got.get(String(u.id));
          const have = asArray(row?.specials).map((x) => K(x));
          const rec = asArray(row?.recorded).map((x) => K(x));
          const problems = [];
          if (row?.specials_type !== "array") problems.push(`specials is jsonb ${row?.specials_type}`);
          if (row?.record_type !== "array") problems.push(`specialsRecordedOnly is jsonb ${row?.record_type}`);
          for (const c of u.next) if (!have.includes(K(c))) problems.push(`missing ${c}`);
          for (const c of u.had) if (!have.includes(K(c))) problems.push(`DROPPED ${c}`);
          for (const c of u.recordedOnly) if (!rec.includes(K(c))) problems.push(`not recorded ${c}`);
          if (problems.length) {
            bad++;
            if (badSamples.length < 10) badSamples.push(`   ${which} ${u.id} ${problems.join(", ")}`);
          } else ok++;
        }
      }
    }
  } finally { await v.end(); }

  log("");
  log(`READ-BACK on a NEW connection (shape + content): ${ok} lines correct, ${bad} not.`);
  for (const s of badSamples) log(s);
  if (bad || ok !== updates.so.length + updates.po.length) {
    log("");
    log(`NOT LANDED — the read-back does not account for every line. Do not treat this run as applied.`);
    await sql.end();
    process.exit(1);
  }
  log("");
  log(`APPLIED — SO ${updates.so.length} lines, PO ${updates.po.length} lines recorded as NOT chargeable, ` +
      `PROVEN by read-back. custom_specials untouched.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
