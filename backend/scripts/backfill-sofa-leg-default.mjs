#!/usr/bin/env node
// Every migrated sofa line came in with NO leg pick at all, so the Leg Height
// picker shows "Select..." on lines that are otherwise complete.
//
// Owner 2026-08-10 (docs/sofa-import-handoff.md section 2.5):
//   "脚全部找不到就直接选 default" — no leg written = use the default.
//
// The sofa Leg Height axis is deliberately `required: false` in
// backend/src/scm/shared/so-variant-rule.ts *because* it is meant to arrive
// pre-filled with the standing "Default" option (RM 0.00). The importers never
// set it: parse-sofa.mjs lifts a leg PHRASE out of Desc2 into `specials`, and
// nothing ever writes variants.legHeight. This closes that gap for the rows
// AutoCount brought in.
//
// Two hard rules:
//   1. Fill ONLY where legHeight AND sofaLegHeight are both empty. A leg
//      somebody chose is never overwritten.
//   2. If the line's OWN text names a leg, do NOT default it — the source says
//      something specific and a human owes it a real pick. Those are reported
//      separately, grouped by the phrase, with their document numbers.
//
// An inch height only counts as a leg when it sits INSIDE the leg phrase
// ("Leg Change 101Middle Leg(8')"). A bare inch anywhere else in a sofa Desc2
// is the SEAT depth (28" / 70cm), not a leg — treating it as one would refuse
// to default nearly every sofa line.
//
// Scope: company 1, item_group = 'sofa', migrated rows only (parent carries
// linked_ac_docno — docs/autocount-cutover-ledger.md section 1, signatures 1
// and 2). Both scm.mfg_sales_order_items and scm.purchase_order_items.
//
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert. classify() puts a line that already carries legHeight in the already-set bucket and only the fill bucket is written.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const isEmpty = (v) => v === undefined || v === null || String(v).trim() === "";
const K = (s) => String(s ?? "").trim().toUpperCase();
const val = (v) => (v && typeof v === "object" ? v.value : v);

/* The same chunk parse-sofa.mjs lifts out as the leg phrase, widened to "legs"
   so a plural still counts as "the source named a leg" — over-reporting here
   costs a human one pick, under-reporting silently defaults a stated leg. */
const LEG_SEG = /[^\/\n|]*\blegs?\b[^\/\n|]*/i;

const legPhrase = (row) => {
  const texts = [];
  if (row.description2) texts.push(["description2", String(row.description2)]);
  const sp = row.variants && row.variants.specials;
  if (Array.isArray(sp)) for (const s of sp) if (s) texts.push(["specials", String(s)]);
  for (const [where, t] of texts) {
    const m = LEG_SEG.exec(t);
    if (m) return { where, phrase: m[0].trim().replace(/^[*\s+]+/, "").replace(/\s+/g, " ") };
  }
  return null;
};

function classify(rows) {
  const out = { fill: [], names: [], already: 0 };
  for (const r of rows) {
    const v = r.variants || {};
    if (!isEmpty(v.legHeight) || !isEmpty(v.sofaLegHeight)) { out.already++; continue; }
    const named = legPhrase(r);
    if (named) out.names.push({ ...r, ...named });
    else out.fill.push(r);
  }
  return out;
}

function reportNamed(tag, named) {
  if (!named.length) return;
  const by = new Map();
  for (const n of named) {
    const key = n.phrase;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(n.docNo);
  }
  log(`  ${tag} source names a leg, needs a real pick — ${named.length} line(s), ${by.size} distinct phrase(s):`);
  for (const [phrase, docs] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const shown = [...new Set(docs)];
    const list = shown.slice(0, 8).join(", ") + (shown.length > 8 ? `, +${shown.length - 8} more` : "");
    log(`    ${String(docs.length).padStart(4)} x "${phrase.slice(0, 90)}"  [${list}]`);
  }
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  /* The pool is the master maintenance config, same read as
     move-altay-leg-and-merge-nolegs.mjs. Use the pool's OWN spelling so the
     written value matches an option the picker can actually resolve. */
  const [cfg] = await sql`SELECT config FROM scm.maintenance_config_history
    WHERE company_id = ${CO} AND scope = 'master' AND effective_from <= CURRENT_DATE
    ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
  const pool = (cfg && cfg.config && cfg.config.sofaLegHeights) || [];
  log(`sofa leg pool (${pool.length}): ${pool.map(val).join(", ")}`);
  const hit = pool.find((e) => K(val(e)) === "DEFAULT");
  if (!hit) {
    log('STOP — the sofa leg pool has no "Default" option. Nothing written; add it to sofaLegHeights first.');
    await sql.end();
    return;
  }
  const LEG = String(val(hit));
  log(`will fill legHeight = "${LEG}"`);
  log("");

  const soRows = await sql`SELECT i.id, i.doc_no AS "docNo", i.item_code, i.description2, i.variants
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.company_id = ${CO}
      AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  const poRows = await sql`SELECT i.id, p.po_number AS "docNo", i.item_code, i.description2, i.variants
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND i.company_id = ${CO}
      AND i.item_group = 'sofa' AND p.linked_ac_docno IS NOT NULL`;

  const so = classify(soRows);
  const po = classify(poRows);

  log(`SO migrated sofa lines: ${soRows.length}`);
  log(`  SO fill with "${LEG}": ${so.fill.length}`);
  log(`  SO source names a leg: ${so.names.length}`);
  log(`  SO already set: ${so.already}`);
  log(`PO migrated sofa lines: ${poRows.length}`);
  log(`  PO fill with "${LEG}": ${po.fill.length}`);
  log(`  PO source names a leg: ${po.names.length}`);
  log(`  PO already set: ${po.already}`);
  log(`TOTAL fill ${so.fill.length + po.fill.length}; names-a-leg ${so.names.length + po.names.length}; already-set ${so.already + po.already}`);
  log("");
  reportNamed("SO", so.names);
  reportNamed("PO", po.names);

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }

  /* Merge the ONE key into the existing jsonb rather than rewriting the whole
     object, so nothing else on the line can be lost by this backfill. */
  const write = async (label, ids, upd) => {
    for (let i = 0; i < ids.length; i += 200) {
      const b = ids.slice(i, i + 200);
      await sql.begin(async (tx) => { for (const id of b) await upd(tx, id); });
      log(`  ${label} ..${Math.min(i + 200, ids.length)}/${ids.length}`);
    }
  };
  await write("SO", so.fill.map((r) => r.id), (tx, id) =>
    tx`UPDATE scm.mfg_sales_order_items
         SET variants = COALESCE(variants, '{}'::jsonb) || jsonb_build_object('legHeight', ${LEG}::text)
       WHERE id = ${id}`);
  await write("PO", po.fill.map((r) => r.id), (tx, id) =>
    tx`UPDATE scm.purchase_order_items
         SET variants = COALESCE(variants, '{}'::jsonb) || jsonb_build_object('legHeight', ${LEG}::text)
       WHERE id = ${id}`);
  log(`DONE. filled legHeight="${LEG}" on ${so.fill.length} SO + ${po.fill.length} PO sofa lines`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
