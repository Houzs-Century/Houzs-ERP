#!/usr/bin/env node
// Put the sofa SPECIAL ORDERS the AutoCount slips asked for onto the migrated
// lines, as picker codes where one exists and as free text where none does.
//
// Owner 2026-08-10, verbatim: "那些 Special order 全部 match 回来 special order
// 的 picker listing, 没有的才用 customs others 那边写进去."
//
// The picker master is scm.special_addons (SOFA category). It is READ LIVE and
// every rule below resolves its target against that read - a rule whose code is
// not in the database is REPORTED and its phrases fall through to free text,
// never silently mapped to a code that does not exist.
//
// WHERE THE PHRASES COME FROM. The line keeps its original AutoCount Desc2 in
// description2, so this re-decodes that text with the CURRENT parser and unions
// the result with whatever custom_specials already carries. Nothing already on
// the line is dropped. The re-decode matters: until today parse-sofa deleted
// every `bottom...` phrase before specials were collected, so all 53 umbrella
// fabric instructions were absent from the ERP entirely.
//
// RE-RUN: safe only because it now REFUSES the rows it used to corrupt. This
// writes the legacy `string[]` shape, but scm.*_items.custom_specials is
// declared `Array<{ description, surchargeSen }>` (mfg-pricing-recompute.ts:117)
// and the recompute writes that object shape whenever a line is edited. On the
// first run every migrated line was still NULL or string[], so the union below
// was harmless. On a SECOND run a recomputed line hands `had` an array of
// OBJECTS, `push()` does String(o) on each, and the row is rewritten as
// ["[object Object]"] - the pricing engine's own surcharge breakdown replaced
// by a placeholder, on a money-bearing column. Those rows are now refused and
// reported instead. Everything else re-derives the same union and is inert.
//
// (census-custom-specials-arrays.mjs, run 31428435434, is the measurement: all
// 604 array-shaped rows on prod are bare string[] with correct content, so the
// legacy shape this writes is not itself damage - the object shape is the one
// that must never be touched by a data script.)
//
// DRY-RUN by default; APPLY=1 writes.
import postgres from "postgres";
import { parseSofa, SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { CUSHION_MODELS, K, RULES, mapPhrase, skey } from "./lib/sofa-special-map.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  // ---- the picker, read LIVE ------------------------------------------------
  const addons = await sql`SELECT code, label, categories, active FROM scm.special_addons
    WHERE company_id = ${CO} ORDER BY code`;
  const sofa = addons.filter((r) => (r.categories || []).some((c) => /sofa/i.test(String(c))));
  log(`special_addons rows: ${addons.length}; SOFA category: ${sofa.length}`);
  for (const r of sofa) log(`   [${r.code}]${r.active === false ? " (inactive)" : ""}`);

  const live = new Map();
  for (const r of sofa) { live.set(K(r.code), r.code); if (r.label) live.set(K(r.label), r.code); }
  const missing = [];
  for (const c of [...RULES.map((r) => r.code), ...CUSHION_MODELS.map(([, c]) => c)])
    if (!live.has(K(c))) missing.push(c);
  if (missing.length) {
    log("");
    log(`RULES whose picker code is NOT in the database - their phrases fall through to free text:`);
    for (const c of missing) log(`   MISSING  ${c}`);
  }

  // ---- the migrated sofa lines ---------------------------------------------
  const soLines = await sql`SELECT i.id, i.item_code AS code, i.description2 AS d2, i.custom_specials
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  const poLines = await sql`SELECT i.id, i.item_code AS code, i.description2 AS d2, i.custom_specials
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  log("");
  log(`migrated sofa lines: SO ${soLines.length}, PO ${poLines.length}`);

  const byCode = new Map();       // picker code -> phrase instances mapped to it
  const freeCounts = new Map();   // unmatched phrase -> occurrences
  let freeTotal = 0, matchedTotal = 0;
  const updates = { so: [], po: [] };
  const recomputed = { so: [], po: [] };  // rows the pricing engine owns - see the header

  for (const [which, rows] of [["so", soLines], ["po", poLines]]) {
    for (const r of rows) {
      /* THE PRICING ENGINE'S OWN OUTPUT IS NOT OURS TO MERGE. custom_specials
         is declared Array<{ description, surchargeSen }> and the recompute
         emits exactly that; this script speaks the legacy string[] dialect.
         Unioning the two would run String() over each object and store
         "[object Object]", losing a surcharge breakdown that carries money.
         A row holding anything that is not a plain string is left alone and
         printed. */
      if (Array.isArray(r.custom_specials) && r.custom_specials.some((x) => typeof x !== "string")) {
        recomputed[which].push(r);
        continue;
      }
      /* {model}-{compartment}; the alias table is what the importers apply, so
         the re-decode sees the same model they did. */
      let model = String(r.code || "").split("-")[0].toUpperCase();
      model = SOFA_MODEL_ALIAS[model] || model;
      const phrases = [];
      const seen = new Set();
      const push = (t) => {
        const v = String(t ?? "").trim();
        const k = skey(v);
        if (!k) return;
        for (let i = 0; i < phrases.length; i++) {
          const e = skey(phrases[i]);
          if (e.includes(k)) return;
          if (k.includes(e)) { phrases[i] = v; return; }
        }
        seen.add(k); phrases.push(v);
      };
      /* Both recliner states decode the same specials (the sweep runs before
         any model logic), so one pass is enough. */
      if (r.d2) for (const s of parseSofa(r.d2, model, false).specials) push(s);
      const had = Array.isArray(r.custom_specials) ? r.custom_specials : [];
      for (const s of had) push(s);
      if (!phrases.length) continue;

      const codes = new Set(), free = [];
      for (const p of phrases) {
        // already a real picker code (a previous pass, or a hand-picked option)
        if (live.has(K(p))) { codes.add(live.get(K(p))); byCode.set(live.get(K(p)), (byCode.get(live.get(K(p))) || 0) + 1); continue; }
        const hit = mapPhrase(p, live);
        if (hit.length) {
          for (const c of hit) { codes.add(c); byCode.set(c, (byCode.get(c) || 0) + 1); }
          matchedTotal++;
        } else {
          free.push(p);
          freeCounts.set(K(p), (freeCounts.get(K(p)) || 0) + 1);
          freeTotal++;
        }
      }
      const next = [...codes, ...free];
      if (JSON.stringify(next) === JSON.stringify(had)) continue;
      updates[which].push({ id: r.id, next });
    }
  }

  // ---- report ---------------------------------------------------------------
  log("");
  log(`phrases matched to a picker code: ${matchedTotal}`);
  for (const [c, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) log(`   ${String(n).padStart(4)}  ${c}`);
  log("");
  log(`phrases with no code, written as free text verbatim: ${freeTotal} (${freeCounts.size} distinct)`);
  for (const [p, n] of [...freeCounts.entries()].sort((a, b) => b[1] - a[1])) log(`   ${String(n).padStart(4)}  ${p}`);
  log("");
  const skipped = recomputed.so.length + recomputed.po.length;
  log(`lines REFUSED because the pricing engine already owns their custom_specials: ${skipped} (SO ${recomputed.so.length}, PO ${recomputed.po.length})`);
  for (const which of ["so", "po"])
    for (const r of recomputed[which].slice(0, 40))
      log(`   ${which.toUpperCase()} ${String(r.code ?? "").padEnd(22)} ${JSON.stringify(r.custom_specials)}`);
  log(`lines to update: SO ${updates.so.length}, PO ${updates.po.length}`);

  if (!APPLY) { log(""); log("DRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  for (const [which, table] of [["so", "mfg_sales_order_items"], ["po", "purchase_order_items"]]) {
    const list = updates[which];
    for (let i = 0; i < list.length; i += 200) {
      const b = list.slice(i, i + 200);
      await sql.begin(async (tx) => {
        for (const u of b)
          await tx.unsafe(`UPDATE scm.${table} SET custom_specials = $1::jsonb WHERE id = $2`,
            // tx.json, never JSON.stringify - see BUG-HISTORY 2026-08-10:
            // postgres.js JSON-encodes any parameter it resolves to json/jsonb,
            // so a pre-stringified value is encoded twice and lands as a jsonb
            // STRING. This script is where that was first seen (#1913).
            [tx.json(u.next), u.id]);
      });
      log(`  ${which} ..${Math.min(i + 200, list.length)}/${list.length}`);
    }
  }
  log(`APPLIED - SO ${updates.so.length} lines, PO ${updates.po.length} lines.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
