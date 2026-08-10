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
// DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parseSofa, SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { parseBedframe } from "./lib/parse-bedframe.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 40); // per-line change lines to print
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = JSON.parse(fs.readFileSync(path.join(here, "data", "special-order-phrase-map.json"), "utf8"));

const K = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
// the parser's own dedupe identity: letters and digits only, nilon = nylon
const skey = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/NILON/g, "NYLON");
// match on words, so "BACK REST", "BACKREST" and "back-rest" are one thing
const flat = (s) => " " + String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " ";
const rx = (src) => (src ? new RegExp(src) : null);

const FAMILIES = MAP.families.map((f) => ({ ...f, _yes: rx(f.yes), _no: rx(f.no) }));
const EXCLUDED = MAP.excluded.map((e) => ({ ...e, _m: rx(e.match) }));
const SWAPS = MAP.cushionSwapModels;

/* One phrase -> the picker codes it means. `live` is the LIVE code index; a
   family whose code is not in it contributes nothing (reported separately). */
function mapPhrase(raw, live, cat) {
  const s = flat(raw);
  const out = new Set();
  for (const f of FAMILIES) {
    if (!f.categories.includes(cat)) continue;
    if (f._no && f._no.test(s)) continue;
    if (!f._yes.test(s)) continue;
    const code = live.get(K(f.code));
    if (code) out.add(code);
  }
  if (cat === "SOFA" && /\bback ?rest\b|\bback ?cushion\b/.test(s) && !/\b(5537|5540)\b/.test(s)) {
    for (const [model, want] of SWAPS) {
      if (!new RegExp(`\\b${model}\\b`).test(s)) continue;
      // "9058 sofa backrest change 9028" names the sofa first: the model being
      // changed TO is the last number mentioned
      const nums = s.match(/\b\d{4}\b/g) || [];
      if (nums.length > 1 && nums[nums.length - 1] !== model) continue;
      const code = live.get(K(want));
      if (code) out.add(code);
    }
  }
  return [...out];
}

const excludedBy = (raw) => {
  const s = flat(raw);
  for (const e of EXCLUDED) if (e._m.test(s)) return e;
  return null;
};

/* Union the phrases a line asks for, using the SAME containment dedupe the
   parsers use so "BACKRESTCHANGE8030" and "BACK REST CHANGE 8030" are one. */
function phrasesOf(list) {
  const phrases = [];
  for (const t of list) {
    const v = String(t ?? "").replace(/\s+/g, " ").trim();
    const k = skey(v);
    if (!k) continue;
    let merged = false;
    for (let i = 0; i < phrases.length; i++) {
      const e = skey(phrases[i]);
      if (e.includes(k)) { merged = true; break; }
      if (k.includes(e)) { phrases[i] = v; merged = true; break; }
    }
    if (!merged) phrases.push(v);
  }
  return phrases;
}

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  // ── the picker master, read LIVE, WITH PRICES ────────────────────────────────
  const addons = await sql`SELECT code, label, categories, active, selling_price_sen, cost_price_sen
    FROM scm.special_addons WHERE company_id = ${CO} ORDER BY code`;
  log(`scm.special_addons rows: ${addons.length}`);
  log(`   ${"sell".padStart(6)} ${"cost".padStart(6)}  active  categories        code`);
  for (const r of addons) {
    log(`   ${String(r.selling_price_sen ?? 0).padStart(6)} ${String(r.cost_price_sen ?? 0).padStart(6)}` +
        `  ${r.active === false ? "  no  " : " yes  "}  ${(r.categories || []).join("+").padEnd(16)}  [${r.code}]`);
  }

  const liveByCat = new Map();       // 'SOFA' -> Map(K(code|label) -> code)
  for (const cat of ["SOFA", "BEDFRAME"]) {
    const m = new Map();
    for (const r of addons) {
      if (!(r.categories || []).some((c) => String(c).toUpperCase() === cat)) continue;
      m.set(K(r.code), r.code);
      if (r.label) m.set(K(r.label), r.code);
    }
    liveByCat.set(cat, m);
    log(`${cat} picker codes: ${new Set([...m.values()]).size}`);
  }
  const priceOf = new Map(addons.map((r) => [r.code, {
    sell: Number(r.selling_price_sen ?? 0), cost: Number(r.cost_price_sen ?? 0),
  }]));

  // families whose code the owner has not created (or has re-categorised away)
  const missing = [];
  for (const f of FAMILIES)
    for (const cat of f.categories)
      if (!liveByCat.get(cat).has(K(f.code))) missing.push(`${cat}  ${f.code}`);
  for (const [, want] of SWAPS)
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
  const poLines = await sql`SELECT i.id, h.doc_no AS doc, i.material_code AS code, i.item_group AS grp,
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

  for (const [which, rows] of [["so", soLines], ["po", poLines]]) {
    for (const r of rows) {
      const cat = r.grp === "sofa" ? "SOFA" : "BEDFRAME";
      const live = liveByCat.get(cat);
      let raw = [];
      if (r.d2) {
        if (cat === "SOFA") {
          let model = String(r.code || "").split("-")[0].toUpperCase();
          model = SOFA_MODEL_ALIAS[model] || model;
          // both recliner states decode the same specials — the sweep runs
          // before any model logic, so one pass is enough
          raw = parseSofa(r.d2, model, false).specials || [];
        } else {
          raw = parseBedframe(r.d2).specials || [];
        }
      }
      const phrases = phrasesOf(raw);
      if (!phrases.length) continue;

      const gained = new Set();
      for (const p of phrases) {
        // already a real picker code (the parser emits several verbatim)
        if (live.has(K(p))) { gained.add(live.get(K(p))); continue; }
        const hit = mapPhrase(p, live, cat);
        if (hit.length) { for (const c of hit) gained.add(c); continue; }
        const ex = excludedBy(p);
        if (ex) { excludedHits.set(ex.why, (excludedHits.get(ex.why) || 0) + 1); continue; }
        unmapped.set(K(p), (unmapped.get(K(p)) || 0) + 1);
      }
      if (!gained.size) continue;

      /* MERGE, never replace: keep every other key in the variants jsonb and
         every code the line already carries. `special` is the HOOKKA-compatible
         singular the picker also reads (SpecialOrders.tsx:91). */
      const v = (r.variants && typeof r.variants === "object" && !Array.isArray(r.variants)) ? r.variants : {};
      const had = [...new Set([...asArray(v.specials), ...asArray(v.special)].map((x) => String(x).trim()).filter(Boolean))];
      const next = [...had];
      const addedNow = [];
      for (const c of gained) if (!next.some((x) => K(x) === K(c))) { next.push(c); addedNow.push(c); }
      if (!addedNow.length) continue;

      for (const c of addedNow) byCode.set(c, (byCode.get(c) || 0) + 1);
      updates[which].push({ id: r.id, next });
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

  if (!APPLY) { log(""); log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  if (priced.length) {
    log("");
    log("REFUSING TO APPLY: a priced code would move money on migrated documents. Owner decision.");
    await sql.end();
    return;
  }

  /* jsonb_set on the ONE key, so every other key in variants survives even if
     another writer touched the row between the read and this write. */
  for (const [which, table] of [["so", "mfg_sales_order_items"], ["po", "purchase_order_items"]]) {
    const list = updates[which];
    for (let i = 0; i < list.length; i += 200) {
      const b = list.slice(i, i + 200);
      await sql.begin(async (tx) => {
        for (const u of b)
          await tx.unsafe(
            `UPDATE scm.${table}
                SET variants = jsonb_set(COALESCE(variants, '{}'::jsonb), '{specials}', $1::jsonb, true)
              WHERE id = $2`,
            [JSON.stringify(u.next), u.id]);
      });
      log(`  ${which} ..${Math.min(i + 200, list.length)}/${list.length}`);
    }
  }
  log(`APPLIED — SO ${updates.so.length} lines, PO ${updates.po.length} lines. custom_specials untouched.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
