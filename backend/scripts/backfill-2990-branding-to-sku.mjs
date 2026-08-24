#!/usr/bin/env node
// ---------------------------------------------------------------------------
// backfill-2990-branding-to-sku.mjs — align 2990's stored branding with the SKU
// catalogue, which is the vocabulary the owner actually maintains.
//
// OWNER RULE (2026-08-18, verbatim): "如果那个 SKU 有 branding 就根据 branding"
// — asked what to do about lines whose stored text disagrees with their SKU.
// And on the SO header: "我要表头啊", so the header is FILLED rather than left
// to derive, which makes 2990 read the way Houzs already does.
//
// THE VALUE WRITTEN IS ALWAYS COPIED, NEVER COMPUTED. Every row takes the
// branding of a row that already has one:
//
//   (a) mfg_sales_order_items.branding  <- its own SKU's mfg_products.branding
//   (b) mfg_sales_orders.branding       <- the representative LINE's SKU brand
//                                          (first main line by line_no, else the
//                                          earliest line — the same rep-line
//                                          pick the SO list's label rule makes)
//   (c) product_models.branding         <- the single distinct branding of the
//                                          SKUs minted FROM that model
//
// DELIBERATELY NOT THE DISPLAY LABEL. brandingLabel prints "Accessory" for an
// accessory order while the owner's brand list holds "Accessories"; copying the
// SKU lands on his vocabulary and the label does not. That one-character
// difference is the whole reason this writes the catalogue value, and the
// owner confirmed it before this script was written.
//
// REFUSALS — reported, never guessed:
//   · a SKU with no branding leaves its line alone;
//   · an order whose rep line's SKU has no branding leaves its header blank;
//   · a model whose SKUs carry TWO different brandings is REFUSED, because
//     conflicting evidence is not evidence. Measured 2026-08-18: all 27 blank
//     models have exactly one, so this refusal fires on nothing today and
//     exists for the day it does.
//
// HOUZS IS NOT TOUCHED. Owner, asked whether the same sweep should run there:
// "Houzs 的不需要". Its 13,916 blank lines stay blank — AutoCount carries no
// per-line branding, so filling them would be inventing a value rather than
// copying one, and its orders display from the AutoCount header regardless.
//
// MODE=plan (default) prints every change and writes nothing. MODE=apply also
// requires CONFIRM=backfill-2990-branding-to-sku. Verification re-reads on a FRESH connection
// and asserts the SHAPE: every written value equals its source AND no live line
// is left disagreeing with its SKU.
//
// RE-RUN: idempotent. A second run reports 0 pending in all three phases — a
// row is only written when its value differs from its source.
// ---------------------------------------------------------------------------
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE ?? "plan").toLowerCase();
const APPLY = MODE === "apply";
/* A phrase, not a number. "2990" is four characters and is already on screen
   in every line of the plan, so it could be typed by reflex; this has to be
   copied on purpose. */
const CONFIRM_PHRASE = "backfill-2990-branding-to-sku";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM=${CONFIRM_PHRASE} — refusing to write.`);
  process.exit(2);
}
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const blank = (v) => v == null || String(v).trim() === "";
const tidy = (v) => String(v ?? "").trim();

const normCat = (raw) => {
  const g = tidy(raw).toUpperCase();
  if (g.includes("BEDFRAME")) return "BEDFRAME";
  if (g.includes("SOFA")) return "SOFA";
  if (g.includes("MATTRESS")) return "MATTRESS";
  if (g.includes("ACCESSOR")) return "ACCESSORY";
  if (g.includes("SERVICE")) return "SERVICE";
  return "OTHERS";
};
const MAIN = new Set(["SOFA", "BEDFRAME", "MATTRESS"]);

async function buildPlan(sql) {
  const [co] = await sql`SELECT id FROM companies WHERE code = '2990'`;
  if (!co) throw new Error("company code 2990 not found — refusing to run");
  const cid = Number(co.id);
  log(`company 2990 -> company_id=${cid}   MODE=${MODE}`);

  const vocab = (await sql`
    SELECT name FROM project_brands WHERE company_id = ${cid} AND active = 1
  `).map((b) => b.name);
  if (vocab.length === 0) throw new Error("no active project_brands for 2990 — refusing to run");
  log(`brand vocabulary (${vocab.length}): ${vocab.join(" | ")}`);

  const prods = await sql`
    SELECT code, branding, category::text AS category, model_id
    FROM scm.mfg_products WHERE company_id = ${cid}`;
  const skuBrand = new Map();
  const prodCat = new Map();
  for (const p of prods) {
    if (!blank(p.branding)) skuBrand.set(p.code, tidy(p.branding));
    prodCat.set(p.code, normCat(p.category));
  }

  // (a) LINES -> their own SKU's branding.
  const lines = await sql`
    SELECT id, doc_no, item_code, branding, item_group
    FROM scm.mfg_sales_order_items
    WHERE company_id = ${cid} AND cancelled = false
    ORDER BY doc_no, line_no NULLS LAST, created_at`;
  const lineWrites = [];
  for (const l of lines) {
    const want = l.item_code ? skuBrand.get(l.item_code) : undefined;
    if (!want) continue;                        // SKU has none -> leave alone
    if (tidy(l.branding) === want) continue;    // already right -> idempotent
    lineWrites.push({
      id: l.id, doc_no: l.doc_no, code: l.item_code,
      from: tidy(l.branding) || "(blank)", to: want,
    });
  }

  // (b) HEADERS -> the representative line's SKU branding.
  const byDoc = new Map();
  for (const l of lines) {
    if (!byDoc.has(l.doc_no)) byDoc.set(l.doc_no, []);
    byDoc.get(l.doc_no).push(l);
  }
  const heads = await sql`
    SELECT doc_no, branding FROM scm.mfg_sales_orders WHERE company_id = ${cid}`;
  const headWrites = [], headSkipped = [];
  for (const h of heads) {
    if (!blank(h.branding)) continue;           // an existing header is never overwritten
    const ls = byDoc.get(h.doc_no) ?? [];
    if (ls.length === 0) { headSkipped.push([h.doc_no, "no live lines"]); continue; }
    const rep = ls.find((l) => MAIN.has(prodCat.get(l.item_code) ?? normCat(l.item_group))) ?? ls[0];
    const want = rep.item_code ? skuBrand.get(rep.item_code) : undefined;
    if (!want) { headSkipped.push([h.doc_no, `rep SKU ${rep.item_code} carries no branding`]); continue; }
    headWrites.push({ doc_no: h.doc_no, to: want, via: rep.item_code });
  }

  // (c) MODELS -> the single distinct branding of their own SKUs.
  const models = await sql`
    SELECT id, model_code, branding FROM scm.product_models WHERE company_id = ${cid}`;
  const brandsByModel = new Map();
  for (const p of prods) {
    if (!p.model_id || blank(p.branding)) continue;
    if (!brandsByModel.has(p.model_id)) brandsByModel.set(p.model_id, new Set());
    brandsByModel.get(p.model_id).add(tidy(p.branding));
  }
  const modelWrites = [], modelRefused = [];
  for (const m of models) {
    if (!blank(m.branding)) continue;
    const set = brandsByModel.get(m.id);
    if (!set || set.size === 0) { modelRefused.push([m.model_code, "no branded SKU under it"]); continue; }
    if (set.size > 1) { modelRefused.push([m.model_code, `SKUs disagree: ${[...set].join(" / ")}`]); continue; }
    modelWrites.push({ id: m.id, model_code: m.model_code, to: [...set][0] });
  }

  return { cid, vocab, lineWrites, headWrites, headSkipped, modelWrites, modelRefused };
}

function report(p) {
  const outside = (v) => (p.vocab.some((b) => b.toLowerCase() === v.toLowerCase()) ? "" : "   <- NOT in project_brands");
  log(`\n=== (a) SO LINES — ${p.lineWrites.length} pending`);
  for (const w of p.lineWrites) log(`   ${w.doc_no}  ${w.code}  "${w.from}" -> "${w.to}"${outside(w.to)}`);
  log(`\n=== (b) SO HEADERS — ${p.headWrites.length} pending, ${p.headSkipped.length} left blank`);
  for (const w of p.headWrites) log(`   ${w.doc_no}  (blank) -> "${w.to}"   via ${w.via}${outside(w.to)}`);
  for (const [d, why] of p.headSkipped) log(`   SKIP ${d}: ${why}`);
  log(`\n=== (c) PRODUCT MODELS — ${p.modelWrites.length} pending, ${p.modelRefused.length} refused`);
  for (const w of p.modelWrites) log(`   ${w.model_code} (blank) -> "${w.to}"${outside(w.to)}`);
  for (const [m, why] of p.modelRefused) log(`   REFUSED ${m}: ${why}`);
  const bad = [...p.lineWrites, ...p.headWrites, ...p.modelWrites].filter((w) => outside(w.to));
  log(`\nTOTAL ${p.lineWrites.length + p.headWrites.length + p.modelWrites.length} rows to write; ${bad.length} of them outside the brand vocabulary`);
  return bad.length;
}

async function applyPlan(sql, p) {
  for (const w of p.lineWrites) {
    await sql`UPDATE scm.mfg_sales_order_items SET branding = ${w.to} WHERE id = ${w.id} AND company_id = ${p.cid}`;
  }
  for (const w of p.headWrites) {
    await sql`UPDATE scm.mfg_sales_orders SET branding = ${w.to} WHERE doc_no = ${w.doc_no} AND company_id = ${p.cid}`;
  }
  for (const w of p.modelWrites) {
    await sql`UPDATE scm.product_models SET branding = ${w.to} WHERE id = ${w.id} AND company_id = ${p.cid}`;
  }
  log(`applied: ${p.lineWrites.length} lines, ${p.headWrites.length} headers, ${p.modelWrites.length} models`);
}

/* SHAPE, not a row count. "144 rows updated" would have been just as true if
   every one of them had been written the empty string, or another company's
   brand — the 2026-08-13 jsonb repair reported 7 of 7 while corrupting all 7. */
async function verify(p) {
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const problems = [];
    for (const w of p.lineWrites) {
      const [r] = await fresh`SELECT branding, company_id FROM scm.mfg_sales_order_items WHERE id = ${w.id}`;
      if (!r) problems.push(`line ${w.id} vanished`);
      else if (tidy(r.branding) !== w.to) problems.push(`line ${w.id}: "${tidy(r.branding)}" != "${w.to}"`);
      else if (Number(r.company_id) !== p.cid) problems.push(`line ${w.id} belongs to company ${r.company_id}`);
    }
    for (const w of p.headWrites) {
      const [r] = await fresh`SELECT branding FROM scm.mfg_sales_orders WHERE doc_no = ${w.doc_no} AND company_id = ${p.cid}`;
      if (!r || tidy(r.branding) !== w.to) problems.push(`header ${w.doc_no}: "${tidy(r?.branding)}" != "${w.to}"`);
    }
    for (const w of p.modelWrites) {
      const [r] = await fresh`SELECT branding FROM scm.product_models WHERE id = ${w.id} AND company_id = ${p.cid}`;
      if (!r || tidy(r.branding) !== w.to) problems.push(`model ${w.model_code}: "${tidy(r?.branding)}" != "${w.to}"`);
    }
    const [{ n }] = await fresh`
      SELECT count(*)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = i.company_id
      WHERE i.company_id = ${p.cid} AND i.cancelled = false
        AND COALESCE(NULLIF(TRIM(p.branding), ''), '') <> ''
        AND COALESCE(TRIM(i.branding), '') IS DISTINCT FROM TRIM(p.branding)`;
    if (n !== 0) problems.push(`${n} live lines still disagree with their SKU`);
    if (problems.length) {
      problems.forEach((x) => log(`VERIFY FAIL: ${x}`));
      throw new Error(`${problems.length} verification failures`);
    }
    log("VERIFY OK — every written row equals its source, and no live line disagrees with its SKU");
  } finally { await fresh.end(); }
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
try {
  const p = await buildPlan(sql);
  const outside = report(p);
  if (!APPLY) {
    log("\nMODE=plan — nothing written. Re-run with MODE=apply CONFIRM=backfill-2990-branding-to-sku to write.");
  } else if (outside > 0) {
    log("\nREFUSING to apply: a value outside the brand vocabulary means the catalogue and the dropdown disagree, and that is the owner's call, not this script's.");
    process.exitCode = 1;
  } else {
    await applyPlan(sql, p);
    await verify(p);
  }
} finally { await sql.end(); }
