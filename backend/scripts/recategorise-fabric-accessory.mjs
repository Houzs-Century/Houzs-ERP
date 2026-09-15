#!/usr/bin/env node
/* Move products to the Sofa Accessory category, move their order lines with
   them, write the fabric colour each line already names in its text into the
   field stock and MRP read, and relabel the received stock whose own receipt
   names a colour.

   OWNER, 2026-09-14:
     「然后我就开始换category 换了你帮我处理就是这个category 是可以选fabrics的
       然后MRP 就可以跟据fabric去分配了」
     「这几个也是swap去sofa accessory 然后看一下之前旧的order 都帮我backfill颜色」
   Models AR01, AR02, BC04, BC04-MF, BC05, BC05-MF, SB02 and the model-less SKUs
   SQUARE PILLOW, LONG PILLOW — company 1 (Houzs Century). Company 2 carries
   its own SQUARE PILLOW / LONG PILLOW and is not touched.

   WHAT IT WRITES, all in ONE transaction:
   1. product_models.category and mfg_products.category -> FABRIC_ACCESSORY.
   2. item_group -> 'fabric_accessory' on every line of those codes in the six
      line tables (SO, PO, GRN, DO, PI, SI). The header money buckets read
      includes('accessor'), so a line stays in the accessories total.
   3. variants.fabricCode, only where the line has none and its colour RESOLVES
      (the one matcher, lib/fabric-colour-match.mjs, through
      lib/line-colour-verdict.mjs: one colour, not an assumed series). A line's own text wins; a
      line whose own text names no colour inherits from the line it came from
      (PO <- SO, GRN <- PO, DO <- SO, PI <- GRN, SI <- DO <- SO). A line whose
      own text is `several` / `unknown` is left blank and LISTED —
      it is never overridden by its parent.
   4. STOCK, per lot, never per bucket (owner decision 2 of 2026-09-14,
      「我们的库存是分item的」). A lot is relabelled only when it came from a GRN
      and can be tied to exactly ONE GRN line of its code (the only line, or the
      one whose variants and description2 equal the lot's IN movement), and that
      line resolves a colour. The new key is the variant-key mirror of that
      line's variants with the colour added. The lot, its IN movement, its
      consumptions and each OUT movement that consumed it move together — and an
      OUT movement that ALSO consumed a lot of a different new key refuses every
      lot it touches. AutoCount opening-balance lots carry no colour and stay
      keyed ''. Label moves only: no qty, no cost changes.

   WHAT IT DOES NOT DO: it does not touch prices, costs, quantities, document
   status, the AutoCount outbox, or `committed_variant_key` on delivery lines. It
   does not recompute SO stock readiness — run recompute-so-allocation after an
   apply so open orders re-read the relabelled stock.

   MODE=plan (default) runs everything inside a transaction and ROLLS BACK.
   MODE=apply requires CONFIRM="MOVE TO SOFA ACCESSORY".
   After an apply, a FRESH connection re-reads and asserts the shape: every line
   of the codes carries the new group, every written variants is still a jsonb
   OBJECT whose fabricCode equals the plan, every product is FABRIC_ACCESSORY,
   every lot's consumptions share the lot's key, and the per (warehouse, code)
   movement quantity is unchanged.

   RE-RUN: idempotent. A second run finds the categories and groups already
   moved and every resolvable line already carrying fabricCode (skipped, never
   overwritten), and every relabelled lot already on its key. */
import postgres from "postgres";
import { buildFabricColourIndex } from "./lib/fabric-colour-match.mjs";
import { lineColourVerdict } from "./lib/line-colour-verdict.mjs";
import { variantKeyMirror } from "./lib/ledger-repair-core.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "MOVE TO SOFA ACCESSORY";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const COMPANY = Number(process.env.COMPANY || 1);
const list = (s, d) => String(s || d).split(",").map((x) => x.trim()).filter(Boolean);
const MODELS = list(process.env.MODELS, "AR01,AR02,BC04,BC04-MF,BC05,BC05-MF,SB02");
const LOOSE_SKUS = list(process.env.SKUS, "SQUARE PILLOW,LONG PILLOW");
const GROUP = "fabric_accessory";
const CATEGORY = "FABRIC_ACCESSORY";

const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);
const cut = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/* Line tables: text columns, parent link. */
const LINES = {
  so: { table: "mfg_sales_order_items", doc: "doc_no", text: ["description2", "remark"], parent: null },
  po: { table: "purchase_order_items", doc: "purchase_order_id", text: ["description2", "notes"], parent: ["so", "so_item_id"] },
  grn: { table: "grn_items", doc: "grn_id", text: ["description2", "notes"], parent: ["po", "purchase_order_item_id"] },
  do: { table: "delivery_order_items", doc: "delivery_order_id", text: ["description2", "notes"], parent: ["so", "so_item_id"] },
  pi: { table: "purchase_invoice_items", doc: "purchase_invoice_id", text: ["description2", "notes"], parent: ["grn", "grn_item_id"] },
  si: { table: "sales_invoice_items", doc: "sales_invoice_id", text: ["description2", "notes"], parent: ["do", "do_item_id"], parent2: ["so", "so_item_id"] },
};

const lineText = (r, cols) => {
  const v = r.variants && typeof r.variants === "object" && !Array.isArray(r.variants) ? r.variants : {};
  const specials = Array.isArray(v.specials) ? v.specials.map((s) => (typeof s === "string" ? s : s?.label ?? s?.name ?? "")) : [];
  return [v.extraAddonNote, ...specials, ...cols.map((c) => r[c])]
    .filter(Boolean).join(" | ")
    .replace(/账本原文:.*$/s, "")
    .replace(/(?:topped up|created) from AutoCount.*$/is, "")
    .replace(/\b(?:AMN|HOK|DSL|RDS)-\s*(?:SQUARE|LONG) PILLOW.*$/i, "");
};
const hasFabric = (v) => !!(v && typeof v === "object" && (v.fabricCode || v.colorCode || v.colourCode || v.fabricColor));

async function plan(tx) {
  notice(`=== Sofa Accessory recategorisation — ${APPLY ? "APPLY" : "PLAN (rolled back)"} · company ${COMPANY} ===`);

  // ── products ──
  const models = await tx`SELECT id::text, model_code, category::text FROM scm.product_models
    WHERE company_id = ${COMPANY} AND upper(model_code) = ANY(${MODELS.map((m) => m.toUpperCase())})`;
  const skus = await tx`SELECT id::text, code, category::text, model_id::text FROM scm.mfg_products
    WHERE company_id = ${COMPANY} AND (model_id::text = ANY(${models.map((m) => m.id)}) OR upper(btrim(code)) = ANY(${LOOSE_SKUS.map((c) => c.toUpperCase())}))`;
  const missingModels = MODELS.filter((m) => !models.some((r) => r.model_code.toUpperCase() === m.toUpperCase()));
  if (missingModels.length) notice(`models not found in company ${COMPANY}: ${missingModels.join(", ")}`);
  const offCategory = [...models, ...skus].filter((r) => !["ACCESSORY", CATEGORY].includes(r.category));
  if (offCategory.length) {
    notice(`REFUSED: ${offCategory.map((r) => `${r.model_code ?? r.code}=${r.category}`).join(", ")} — only an ACCESSORY may move here`);
    return { refused: true };
  }
  const codes = [...new Set(skus.map((s) => s.code.trim().toUpperCase()))];
  notice(`products: ${models.length} models, ${skus.length} SKUs — ${codes.join(" | ")}`);
  const before = await snapshot(tx, codes);
  const mMoved = await tx`UPDATE scm.product_models SET category = ${CATEGORY}, updated_at = now()
    WHERE company_id = ${COMPANY} AND id::text = ANY(${models.map((m) => m.id)}) AND category::text <> ${CATEGORY} RETURNING id`;
  const sMoved = await tx`UPDATE scm.mfg_products SET category = ${CATEGORY}, updated_at = now()
    WHERE company_id = ${COMPANY} AND id::text = ANY(${skus.map((s) => s.id)}) AND category::text <> ${CATEGORY} RETURNING id`;
  say(`  moved now: ${mMoved.length} models, ${sMoved.length} SKUs`);

  // ── the fabric colour library, through the one matcher ──
  const fab = await tx`SELECT fabric_id, colour_id, label, active FROM scm.fabric_colours WHERE company_id = ${COMPANY}`;
  const { explainColour } = buildFabricColourIndex(fab);
  say(`fabric colour library: ${fab.length} rows`);

  // ── lines ──
  const rows = {};
  for (const [k, d] of Object.entries(LINES)) {
    const extra = [d.parent?.[1], d.parent2?.[1]].filter(Boolean).map((c) => `, ${c}::text AS ${c}`).join("");
    const qtyCols = k === "grn" ? ", qty_received, qty_accepted" : "";
    rows[k] = await tx.unsafe(`SELECT id::text, ${d.doc}::text AS doc, item_code, item_group, variants, ${d.text.join(", ")}${extra}${qtyCols}
      FROM scm.${d.table} WHERE company_id = $1 AND upper(btrim(item_code)) = ANY($2)`, [COMPANY, codes]);
  }
  const byId = {};
  for (const k of Object.keys(LINES)) byId[k] = new Map(rows[k].map((r) => [r.id, r]));

  const own = {};
  for (const [k, d] of Object.entries(LINES)) {
    own[k] = new Map(rows[k].map((r) => [r.id, hasFabric(r.variants)
      ? { verdict: "has-fabric", code: r.variants.fabricCode ?? r.variants.fabricColor ?? r.variants.colorCode ?? r.variants.colourCode }
      : lineColourVerdict(lineText(r, d.text), explainColour)]));
  }
  const resolved = {};
  const resolve = (k, id, depth = 0) => {
    if (!id || depth > 4) return null;
    resolved[k] ??= new Map();
    if (resolved[k].has(id)) return resolved[k].get(id);
    const r = byId[k].get(id);
    const o = own[k].get(id);
    let out = null;
    if (!r || !o) out = null;
    else if (o.verdict === "match" || o.verdict === "has-fabric") out = { code: o.code, from: "own" };
    else if (o.verdict === "no-colour") {
      const d = LINES[k];
      const p = d.parent ? resolve(d.parent[0], r[d.parent[1]], depth + 1) : null;
      const p2 = !p && d.parent2 ? resolve(d.parent2[0], r[d.parent2[1]], depth + 1) : null;
      out = p || p2 ? { code: (p || p2).code, from: "parent" } : null;
    }
    resolved[k].set(id, out);
    return out;
  };

  const writes = [];
  const unresolved = [];
  for (const k of Object.keys(LINES)) {
    const tally = { lines: rows[k].length, has: 0, own: 0, parent: 0, blank: 0, several: 0, unknown: 0 };
    for (const r of rows[k]) {
      const o = own[k].get(r.id);
      if (o.verdict === "has-fabric") { tally.has++; continue; }
      const res = resolve(k, r.id);
      if (res) {
        tally[res.from]++;
        writes.push({ k, id: r.id, code: res.code, from: res.from, text: cut(lineText(r, LINES[k].text), 60), doc: r.doc });
      } else if (o.verdict === "no-colour") tally.blank++;
      else { tally[o.verdict]++; unresolved.push({ k, doc: r.doc, id: r.id, verdict: o.verdict, text: cut(lineText(r, LINES[k].text), 80), detail: o.codes ?? o.keys ?? [] }); }
    }
    say(`  ${k.padEnd(3)} ${LINES[k].table.padEnd(24)} ${JSON.stringify(tally)}`);
  }

  // item_group on every line, fabricCode where resolved
  for (const [k, d] of Object.entries(LINES)) {
    await tx.unsafe(`UPDATE scm.${d.table} SET item_group = $1 WHERE company_id = $2 AND upper(btrim(item_code)) = ANY($3) AND coalesce(item_group,'') <> $1`, [GROUP, COMPANY, codes]);
  }
  let colourWrites = 0;
  for (const w of writes) {
    const res = await tx.unsafe(`UPDATE scm.${LINES[w.k].table}
      SET variants = CASE WHEN variants IS NULL OR jsonb_typeof(variants) = 'null' THEN jsonb_build_object('fabricCode', $1::text)
                          ELSE jsonb_set(variants, '{fabricCode}', to_jsonb($1::text), true) END
      WHERE id::text = $2 AND company_id = $3
        AND (variants IS NULL OR jsonb_typeof(variants) IN ('object', 'null'))
        AND coalesce(variants->>'fabricCode','') = '' AND coalesce(variants->>'fabricColor','') = ''
      RETURNING id`, [w.code, w.id, COMPANY]);
    colourWrites += res.length;
  }
  const noObject = writes.length - colourWrites;
  notice(`colour: ${writes.length} lines resolve, ${colourWrites} written${noObject ? `, ${noObject} skipped (variants not an object)` : ""} · ${unresolved.length} lines name a colour that does not resolve`);
  for (const w of writes) say(`   + ${w.k.padEnd(3)} ${cut(w.doc, 38).padEnd(38)} ${w.code.padEnd(18)} ${w.from.padEnd(6)} "${w.text}"`);
  notice("── lines whose colour text does NOT resolve (left blank, for a person) ──");
  for (const u of unresolved) say(`   ? ${u.k.padEnd(3)} ${cut(u.doc, 38).padEnd(38)} ${u.verdict.padEnd(9)} "${u.text}" ${u.detail.length ? `[${u.detail.join(", ")}]` : ""}`);

  // ── stock, per lot ──
  const lots = await tx`SELECT l.id::text, l.item_code, l.warehouse_id::text AS wh, l.variant_key, l.qty_received, l.qty_remaining,
      l.source_doc_type, l.source_doc_id::text AS src, l.source_doc_no, l.movement_id::text AS mov,
      m.variants AS mv, m.description2 AS md2
    FROM scm.inventory_lots l LEFT JOIN scm.inventory_movements m ON m.id = l.movement_id
    WHERE l.company_id = ${COMPANY} AND upper(btrim(l.item_code)) = ANY(${codes})`;
  const plans = new Map();
  const skipped = [];
  for (const l of lots) {
    if (l.source_doc_type !== "GRN") { skipped.push(`${l.item_code} ${l.source_doc_no} rem ${l.qty_remaining}: not a receipt (${l.source_doc_type}) — stays "${l.variant_key}"`); continue; }
    const cands = rows.grn.filter((g) => g.doc === l.src && g.item_code.trim().toUpperCase() === l.item_code.trim().toUpperCase());
    let line = cands.length === 1 ? cands[0] : null;
    if (!line && cands.length > 1) {
      const same = cands.filter((g) => JSON.stringify(g.variants ?? {}) === JSON.stringify(l.mv ?? {}) && String(g.description2 ?? "") === String(l.md2 ?? ""));
      line = same.length === 1 ? same[0] : null;
      if (!line) {
        const byQty = cands.filter((g) => Number(g.qty_accepted ?? g.qty_received) === Number(l.qty_received));
        line = byQty.length === 1 ? byQty[0] : null;
      }
    }
    if (!line) { skipped.push(`${l.item_code} ${l.source_doc_no} rem ${l.qty_remaining}: ${cands.length} GRN lines, cannot tie the lot to one`); continue; }
    const colour = resolve("grn", line.id);
    if (!colour) { skipped.push(`${l.item_code} ${l.source_doc_no} rem ${l.qty_remaining}: its GRN line names no resolvable colour`); continue; }
    const v = line.variants && typeof line.variants === "object" ? line.variants : {};
    const key = variantKeyMirror(GROUP, { ...v, fabricCode: colour.code });
    plans.set(l.id, { lot: l, key });
  }
  const cons = await tx`SELECT c.id::text, c.lot_id::text AS lot, c.movement_id::text AS mov, c.variant_key, c.qty_consumed, c.source_doc_no
    FROM scm.inventory_lot_consumptions c WHERE c.company_id = ${COMPANY} AND upper(btrim(c.item_code)) = ANY(${codes})`;
  // refuse any lot whose consuming movement also draws on a lot with a different planned key
  const keyOfLot = (id) => (plans.has(id) ? plans.get(id).key : lots.find((x) => x.id === id)?.variant_key ?? "");
  const movKeys = new Map();
  for (const c of cons) { const s = movKeys.get(c.mov) ?? new Set(); s.add(keyOfLot(c.lot)); movKeys.set(c.mov, s); }
  for (const c of cons) {
    if (plans.has(c.lot) && (movKeys.get(c.mov)?.size ?? 0) > 1) {
      skipped.push(`${plans.get(c.lot).lot.item_code} ${plans.get(c.lot).lot.source_doc_no}: consumed by ${c.source_doc_no} together with a lot of another colour — not split`);
      plans.delete(c.lot);
    }
  }
  let relabelled = 0;
  for (const { lot, key } of plans.values()) {
    if (lot.variant_key === key) continue;
    await tx`UPDATE scm.inventory_lots SET variant_key = ${key} WHERE id::text = ${lot.id} AND company_id = ${COMPANY}`;
    if (lot.mov) await tx`UPDATE scm.inventory_movements SET variant_key = ${key} WHERE id::text = ${lot.mov} AND company_id = ${COMPANY}`;
    const lc = cons.filter((c) => c.lot === lot.id);
    if (lc.length) {
      await tx`UPDATE scm.inventory_lot_consumptions SET variant_key = ${key} WHERE lot_id::text = ${lot.id} AND company_id = ${COMPANY}`;
      await tx`UPDATE scm.inventory_movements SET variant_key = ${key} WHERE id::text = ANY(${[...new Set(lc.map((c) => c.mov))]}) AND company_id = ${COMPANY}`;
    }
    relabelled++;
    say(`   ~ lot ${lot.item_code} ${lot.source_doc_no} rcv ${lot.qty_received} rem ${lot.qty_remaining}: "${lot.variant_key}" -> "${key}"${lc.length ? ` (+${lc.length} consumptions: ${[...new Set(lc.map((c) => c.source_doc_no))].join(", ")})` : ""}`);
  }
  notice(`stock: ${lots.length} lots · ${relabelled} relabelled · ${skipped.length} stay as they are`);
  for (const s of skipped) say(`   = ${s}`);
  return { codes, writes, before, refused: false };
}

async function snapshot(db, codes) {
  return db`SELECT warehouse_id::text AS wh, upper(btrim(item_code)) AS code, sum(qty)::numeric AS q
    FROM scm.inventory_movements WHERE company_id = ${COMPANY} AND upper(btrim(item_code)) = ANY(${codes}) GROUP BY 1, 2`;
}

async function verify(codes, writes, before) {
  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const fails = [];
  try {
    const cats = await check`SELECT code, category::text FROM scm.mfg_products WHERE company_id = ${COMPANY} AND upper(btrim(code)) = ANY(${codes})`;
    for (const c of cats) if (c.category !== CATEGORY) fails.push(`SKU ${c.code} is ${c.category}`);
    for (const d of Object.values(LINES)) {
      const [r] = await check.unsafe(`SELECT count(*)::int AS n FROM scm.${d.table} WHERE company_id = $1 AND upper(btrim(item_code)) = ANY($2) AND coalesce(item_group,'') <> $3`, [COMPANY, codes, GROUP]);
      if (r.n) fails.push(`${d.table}: ${r.n} lines not ${GROUP}`);
    }
    for (const w of writes) {
      const [r] = await check.unsafe(`SELECT jsonb_typeof(variants) AS t, variants->>'fabricCode' AS f FROM scm.${LINES[w.k].table} WHERE id::text = $1`, [w.id]);
      if (!r || r.t !== "object" || (r.f ?? "") === "") fails.push(`${w.k} ${w.id}: variants ${r?.t} fabricCode ${r?.f}`);
    }
    const [mis] = await check`SELECT count(*)::int AS n FROM scm.inventory_lot_consumptions c JOIN scm.inventory_lots l ON l.id = c.lot_id
      WHERE c.company_id = ${COMPANY} AND upper(btrim(c.item_code)) = ANY(${codes}) AND c.variant_key IS DISTINCT FROM l.variant_key`;
    if (mis.n) fails.push(`${mis.n} consumptions disagree with their lot's key`);
    const after = await snapshot(check, codes);
    const k = (r) => `${r.wh}|${r.code}`;
    const a = new Map(after.map((r) => [k(r), String(r.q)]));
    for (const b of before) if (a.get(k(b)) !== String(b.q)) fails.push(`movement qty moved for ${k(b)}: ${b.q} -> ${a.get(k(b))}`);
  } finally { await check.end(); }
  if (fails.length) { notice(`VERIFY FAILED (fresh connection): ${fails.length}`); for (const f of fails) say(`   ! ${f}`); process.exit(1); }
  notice(`VERIFY OK (fresh connection): categories, line groups, ${writes.length} colour writes as jsonb objects, lot/consumption keys, movement totals unchanged`);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });
let result;
try {
  await sql.begin(async (tx) => {
    result = await plan(tx);
    if (result.refused) throw new Error("REFUSED");
    if (!APPLY) throw new Error("PLAN_ROLLBACK");
  }).catch((e) => { if (e.message !== "PLAN_ROLLBACK") throw e; });
} catch (e) {
  if (e.message === "REFUSED") { notice("nothing written"); await sql.end(); process.exit(0); }
  console.error(e); await sql.end(); process.exit(1);
}
await sql.end();
if (!APPLY) { notice("PLAN — rolled back, nothing written."); process.exit(0); }
await verify(result.codes, result.writes, result.before);
