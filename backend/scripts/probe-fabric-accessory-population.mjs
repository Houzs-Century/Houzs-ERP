// probe-fabric-accessory-population — READ-ONLY. What moves when a product
// model and its SKUs change category to FABRIC_ACCESSORY (Sofa Accessory).
//
// Owner 2026-09-14: 「这几个也是swap去sofa accessory 然后看一下之前旧的order 都帮我
// backfill颜色」 — models AR01, AR02, BC04, BC04-MF, BC05, BC05-MF, SB02, plus the
// SQUARE PILLOW / LONG PILLOW SKUs.
//
// PRINTS
//   1. the product_models rows and every mfg_products SKU under them (or named);
//   2. every scm/public table carrying an item_code column: how many rows name
//      those SKUs, with the item_group spread where the table has one;
//   3. per document line table with `variants`: how many lines already hold a
//      fabric, and a sample of the colour TEXT they carry instead;
//   4. how many of those texts contain a token that is a live fabric code;
//   5. stock tables keyed by variant_key: the buckets holding those SKUs.
//
// READ-ONLY: SELECTs only, session READ ONLY. RE-RUN: idempotent.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const list = (s, d) => String(s || d).split(",").map((x) => x.trim()).filter(Boolean);
const MODELS = list(process.env.MODELS, "AR01,AR02,BC04,BC04-MF,BC05,BC05-MF,SB02");
const EXTRA = list(process.env.SKUS, "SQUARE PILLOW,LONG PILLOW");
const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });
const q = (s) => `"${s.replace(/"/g, '""')}"`;

try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; } catch { /* SELECT only */ }

notice("──── 1. models and SKUs ────");
const models = await sql`SELECT id::text, company_id, model_code, name, category::text FROM scm.product_models
  WHERE upper(model_code) = ANY(${MODELS.map((m) => m.toUpperCase())}) ORDER BY company_id, model_code`;
for (const m of models) say(`model co${m.company_id} ${m.model_code.padEnd(10)} ${m.category.padEnd(18)} ${m.name} · ${m.id}`);
const skus = await sql`SELECT p.id::text, p.company_id, p.code, p.name, p.category::text, p.status::text, m.model_code
  FROM scm.mfg_products p LEFT JOIN scm.product_models m ON m.id = p.model_id
  WHERE p.model_id = ANY(${models.map((m) => m.id)}::uuid[]) OR upper(btrim(p.code)) = ANY(${EXTRA.map((c) => c.toUpperCase())})
  ORDER BY p.company_id, p.code`;
for (const s of skus) say(`sku   co${s.company_id} ${s.code.padEnd(16)} ${s.category.padEnd(18)} ${s.status.padEnd(8)} model ${s.model_code ?? "—"} · ${s.name}`);
const codes = [...new Set(skus.map((s) => s.code.trim().toUpperCase()))];
notice(`${models.length} model rows, ${skus.length} SKU rows, ${codes.length} distinct codes: ${codes.join(" | ")}`);

notice("──── 2. every table naming those codes ────");
const cols = await sql`SELECT table_schema, table_name, array_agg(column_name::text) AS cols
  FROM information_schema.columns c
  WHERE table_schema IN ('scm','public') AND EXISTS (SELECT 1 FROM information_schema.tables t
    WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE')
  GROUP BY 1,2 HAVING 'item_code' = ANY(array_agg(column_name::text))`;
const lineTables = [];
for (const t of cols) {
  const fq = `${q(t.table_schema)}.${q(t.table_name)}`;
  const hasGroup = t.cols.includes("item_group");
  let rows;
  try {
    rows = await sql.unsafe(`SELECT ${hasGroup ? "coalesce(item_group::text,'∅')" : "'-'"} AS g, count(*)::int AS n
      FROM ${fq} WHERE upper(btrim(item_code)) = ANY($1) GROUP BY 1 ORDER BY 2 DESC`, [codes]);
  } catch (e) { say(`  ${fq}: ${e.message}`); continue; }
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total) continue;
  say(`  ${fq.padEnd(48)} ${String(total).padStart(5)} rows · groups ${rows.map((r) => `${r.g}=${r.n}`).join(" ")} · variants=${t.cols.includes("variants")} variant_key=${t.cols.includes("variant_key")}`);
  if (t.cols.includes("variants")) lineTables.push({ fq, cols: t.cols });
}

notice("──── 3/4. colour on document lines ────");
const fabrics = await sql`SELECT DISTINCT upper(btrim(fabric_code)) AS c FROM scm.fabric_trackings WHERE fabric_code IS NOT NULL`;
const fabricSet = new Set(fabrics.map((f) => f.c));
say(`fabric master: ${fabricSet.size} distinct fabric codes`);
const tokenHit = (txt) => {
  const toks = String(txt || "").toUpperCase().split(/[\s,;:()\[\]\/]+/).filter(Boolean);
  return [...new Set(toks.filter((t) => fabricSet.has(t)))];
};
for (const t of lineTables) {
  const textCols = ["description2", "notes", "remark", "description"].filter((c) => t.cols.includes(c));
  const sel = textCols.map((c) => `coalesce(${q(c)}::text,'')`).join(` || ' ' || `) || "''";
  const rows = await sql.unsafe(`SELECT variants, ${sel} AS txt FROM ${t.fq} WHERE upper(btrim(item_code)) = ANY($1)`, [codes]);
  let withFabric = 0, resolvable = 0, ambiguous = 0, none = 0; const samples = [];
  for (const r of rows) {
    const v = r.variants && typeof r.variants === "object" ? r.variants : {};
    if (v.fabricCode || v.fabricColor || v.colorCode || v.colourCode) { withFabric++; continue; }
    const text = [v.extraAddonNote, JSON.stringify(v.specials ?? ""), r.txt].join(" ");
    const hit = tokenHit(text);
    if (hit.length === 1) resolvable++; else if (hit.length > 1) ambiguous++; else { none++; if (samples.length < 12 && text.trim()) samples.push(text.replace(/\s+/g, " ").slice(0, 110)); }
  }
  say(`  ${t.fq.padEnd(48)} ${rows.length} lines · has fabric ${withFabric} · text resolves to ONE fabric ${resolvable} · several ${ambiguous} · none ${none}`);
  for (const s of samples) say(`       no-match text: ${s}`);
}

notice("──── 5. stock buckets ────");
for (const t of cols.filter((c) => c.cols.includes("variant_key"))) {
  const fq = `${q(t.table_schema)}.${q(t.table_name)}`;
  const qtyCol = ["qty_on_hand", "quantity", "qty", "remaining_qty"].find((c) => t.cols.includes(c));
  try {
    const rows = await sql.unsafe(`SELECT item_code, coalesce(variant_key,'') AS vk, count(*)::int AS n${qtyCol ? `, sum(${q(qtyCol)})::numeric AS qty` : ""}
      FROM ${fq} WHERE upper(btrim(item_code)) = ANY($1) GROUP BY 1,2 ORDER BY 1,2`, [codes]);
    if (!rows.length) continue;
    say(`  ${fq} (qty col ${qtyCol ?? "none"})`);
    for (const r of rows.slice(0, 40)) say(`     ${r.item_code.padEnd(16)} key "${r.vk}" rows ${r.n}${qtyCol ? ` qty ${r.qty}` : ""}`);
  } catch (e) { say(`  ${fq}: ${e.message}`); }
}

notice("──── 6. colour text -> fabric master (company 1), every distinct text ────");
const fcols = await sql`SELECT column_name::text AS c FROM information_schema.columns WHERE table_schema='scm' AND table_name='fabric_trackings' ORDER BY ordinal_position`;
say(`fabric_trackings columns: ${fcols.map((r) => r.c).join(", ")}`);
const nameCol = ["fabric_name", "name", "description", "colour", "color"].filter((c) => fcols.some((r) => r.c === c));
const fab = await sql.unsafe(`SELECT fabric_code, supplier_code${nameCol.length ? ", " + nameCol.map(q).join(", ") : ""} FROM scm.fabric_trackings WHERE company_id = 1`);
say(`company-1 fabric rows: ${fab.length}`);
const norm = (x) => String(x ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const keys = [];
for (const f of fab) for (const k of [f.fabric_code, f.supplier_code]) { const n = norm(k); if (n.length >= 4) keys.push({ n, f }); }
const texts = new Map();
for (const t of ["mfg_sales_order_items", "purchase_order_items", "grn_items", "delivery_order_items", "purchase_invoice_items", "sales_invoice_items"]) {
  const tc = (await sql`SELECT array_agg(column_name::text) AS c FROM information_schema.columns WHERE table_schema='scm' AND table_name=${t}`)[0].c;
  const txtCols = ["description2", "notes", "remark"].filter((c) => tc.includes(c));
  const rows = await sql.unsafe(`SELECT variants${txtCols.map((c) => ", " + q(c)).join("")} FROM scm.${q(t)} WHERE upper(btrim(item_code)) = ANY($1)`, [codes]);
  for (const r of rows) {
    const v = r.variants && typeof r.variants === "object" ? r.variants : {};
    const txt = [v.extraAddonNote, ...(Array.isArray(v.specials) ? v.specials.map((x) => typeof x === "string" ? x : x?.label ?? x?.name ?? "") : []), ...txtCols.map((c) => r[c])]
      .filter(Boolean).join(" | ").replace(/账本原文:.*$/, "").replace(/(AMN|HOK|DSL)-\s*(SQUARE|LONG) PILLOW.*$/i, "").trim();
    const e = texts.get(txt) ?? { n: 0, tables: new Set() }; e.n++; e.tables.add(t); texts.set(txt, e);
  }
}
const sorted = [...texts.entries()].sort((a, b) => b[1].n - a[1].n);
for (const [txt, e] of sorted) {
  const nt = norm(txt);
  const hits = keys.filter((k) => nt.includes(k.n));
  const best = new Map();
  for (const h of hits) best.set(h.f.fabric_code, h);
  const cands = [...best.values()].sort((a, b) => b.n.length - a.n.length).slice(0, 4)
    .map((h) => `${h.f.fabric_code}[sup ${h.f.supplier_code ?? "-"}${nameCol.length ? " " + nameCol.map((c) => h.f[c] ?? "").join("/") : ""}]`);
  say(`  ${String(e.n).padStart(3)}× "${txt.slice(0, 70)}" -> ${cands.length ? cands.join(" ; ") : "NO MATCH"}`);
}

notice("READ-ONLY — nothing was written.");
await sql.end();
