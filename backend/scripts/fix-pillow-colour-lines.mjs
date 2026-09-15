#!/usr/bin/env node
/* Give the pillow lines whose colour text did not resolve the colour they plainly
   name — owner 2026-09-15: 「这些能看到的颜色就解决掉」.

   Found by the Sofa Accessory data run (recategorise-fabric-accessory plan run
   34878202334) and read live with probe-colour-codes (run 34878893165).

   A. TYPOS — the family the text names does not exist in the fabric library,
      and the colour NAME in brackets matches exactly one live colour of the
      family one digit away:
        HC-SO-010214  "CH151-5 (PEARL)"  -> CH141-05  ("CH141-05 PEARL"; no CH151 family)
        HC-SO-012900  "M2401-1 (PEARL)"  -> M2402-01  ("M2402-01 PEARL"; no M2401 family)
      fabricCode is written on the sales-order line and on every line of its
      chain (PO, GRN, PI, DO, SI). The typed text is left as it is — it is what
      the book said.

   B. TWO COLOURS ON ONE LINE, NOT YET ORDERED — split into one line per colour:
        HC-SO-011561  qty 2  "{COL:CH141-5PEARL x 1unit}/{COL:CH141-1CREAM x 1unit}"
          -> qty 1 CH141-05  +  qty 1 CH141-01
      Refused unless the line is still exactly as read: qty 2, no purchase /
      delivery / invoice line points at it, price 0. The new line copies every
      column of the original (including its book line key, the precedent for a
      book line held as several ERP rows), takes the next line number, and the
      header's line_count follows.

   NOT HERE, and why: HC-SO-012046 and HC-SO-012927 also carry two colours, but
   their pillows are already received (and 012046 delivered) with posted GRN and
   purchase invoices — splitting those is a separate decision. GD526-16,
   KN390-11 and MEKA-09 are not in the fabric library at all.

   MODE=plan (default) runs inside a transaction and ROLLS BACK.
   MODE=apply requires CONFIRM="FIX PILLOW COLOURS".
   After an apply a FRESH connection re-reads: each written variants is a jsonb
   object carrying the planned fabricCode, HC-SO-011561 holds exactly two pillow
   lines of qty 1 with the two colours, and its header line_count equals its
   line rows.

   RE-RUN: idempotent. Lines already carrying a fabricCode are skipped, and a
   split line no longer has qty 2, so the split is refused as already done. */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "FIX PILLOW COLOURS";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) { console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`); process.exit(2); }
const COMPANY = 1;
const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);

const TYPOS = [
  { doc: "HC-SO-010214", item: "SQUARE PILLOW", text: "CH151-5", code: "CH141-05" },
  { doc: "HC-SO-012900", item: "SQUARE PILLOW", text: "M2401-1", code: "M2402-01" },
];
const SPLIT = {
  doc: "HC-SO-011561", item: "SQUARE PILLOW", qty: 2,
  keep: { code: "CH141-05", note: "{COL:CH141-5PEARL x 1unit}" },
  add: { code: "CH141-01", note: "{COL:CH141-1CREAM x 1unit}" },
};

const setFabric = (tx, table, id, code) => tx.unsafe(`UPDATE scm.${table}
  SET variants = CASE WHEN variants IS NULL OR jsonb_typeof(variants) = 'null' THEN jsonb_build_object('fabricCode', $1::text)
                      ELSE jsonb_set(variants, '{fabricCode}', to_jsonb($1::text), true) END
  WHERE id::text = $2 AND company_id = $3 AND (variants IS NULL OR jsonb_typeof(variants) IN ('object','null'))
    AND coalesce(variants->>'fabricCode','') = '' RETURNING id::text`, [code, id, COMPANY]);

async function plan(tx) {
  notice(`=== fix pillow colour lines — ${APPLY ? "APPLY" : "PLAN (rolled back)"} ===`);
  const writes = [];
  for (const t of TYPOS) {
    const [colour] = await tx`SELECT colour_id FROM scm.fabric_colours WHERE company_id = ${COMPANY} AND colour_id = ${t.code} AND active`;
    if (!colour) { notice(`REFUSED ${t.doc}: ${t.code} is not a live library colour`); continue; }
    const so = await tx`SELECT id::text, line_no, variants, description2 FROM scm.mfg_sales_order_items
      WHERE company_id = ${COMPANY} AND doc_no = ${t.doc} AND upper(btrim(item_code)) = ${t.item}`;
    const hit = so.filter((r) => String(r.description2 ?? "").toUpperCase().includes(t.text));
    if (hit.length !== 1) { notice(`REFUSED ${t.doc}: ${hit.length} lines carry "${t.text}"`); continue; }
    const s = hit[0];
    const chain = [["mfg_sales_order_items", s.id]];
    for (const p of await tx`SELECT id::text FROM scm.purchase_order_items WHERE so_item_id::text = ${s.id}`) {
      chain.push(["purchase_order_items", p.id]);
      for (const g of await tx`SELECT id::text FROM scm.grn_items WHERE purchase_order_item_id::text = ${p.id}`) {
        chain.push(["grn_items", g.id]);
        for (const pi of await tx`SELECT id::text FROM scm.purchase_invoice_items WHERE grn_item_id::text = ${g.id}`) chain.push(["purchase_invoice_items", pi.id]);
      }
    }
    for (const d of await tx`SELECT id::text FROM scm.delivery_order_items WHERE so_item_id::text = ${s.id}`) chain.push(["delivery_order_items", d.id]);
    for (const si of await tx`SELECT id::text FROM scm.sales_invoice_items WHERE so_item_id::text = ${s.id}`) chain.push(["sales_invoice_items", si.id]);
    for (const [table, id] of chain) {
      const n = (await setFabric(tx, table, id, t.code)).length;
      if (n) writes.push({ table, id, code: t.code });
      say(`   ${t.doc} ${table} ${id}: fabricCode ${n ? `-> ${t.code}` : "already set, skipped"}`);
    }
  }

  const lines = await tx`SELECT * FROM scm.mfg_sales_order_items WHERE company_id = ${COMPANY} AND doc_no = ${SPLIT.doc} AND upper(btrim(item_code)) = ${SPLIT.item}`;
  const two = lines.filter((r) => Number(r.qty) === SPLIT.qty && !r.cancelled);
  let split = null;
  if (two.length !== 1) {
    notice(`SPLIT ${SPLIT.doc}: no single qty-${SPLIT.qty} line (${lines.map((r) => `ln${r.line_no} qty ${r.qty}`).join(", ")}) — already split or changed, nothing done`);
  } else {
    const r = two[0];
    const [links] = await tx`SELECT
      (SELECT count(*)::int FROM scm.purchase_order_items WHERE so_item_id = ${r.id}) +
      (SELECT count(*)::int FROM scm.delivery_order_items WHERE so_item_id = ${r.id}) +
      (SELECT count(*)::int FROM scm.sales_invoice_items WHERE so_item_id = ${r.id}) AS n`;
    if (links.n || Number(r.unit_price_sen ?? 0) !== 0) {
      notice(`REFUSED SPLIT ${SPLIT.doc}: ${links.n} downstream lines, price ${r.unit_price_sen}`);
    } else {
      const unitCost = Number(r.unit_cost_sen ?? 0);
      const v = r.variants && typeof r.variants === "object" && !Array.isArray(r.variants) ? r.variants : {};
      await tx`UPDATE scm.mfg_sales_order_items SET qty = 1,
          variants = ${tx.json({ ...v, fabricCode: SPLIT.keep.code, extraAddonNote: SPLIT.keep.note })},
          description2 = ${SPLIT.keep.note},
          line_cost_sen = ${unitCost}, line_margin_sen = ${-unitCost}
        WHERE id = ${r.id} AND company_id = ${COMPANY}`;
      const cols = (await tx`SELECT column_name::text AS c FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'mfg_sales_order_items' AND column_name <> 'id' ORDER BY ordinal_position`).map((x) => x.c);
      const [{ next }] = await tx`SELECT coalesce(max(line_no), 0) + 1 AS next FROM scm.mfg_sales_order_items WHERE doc_no = ${SPLIT.doc}`;
      const override = {
        qty: "1", line_no: String(next), created_at: "now()",
        variants: `$1::jsonb`, description2: `$2::text`,
        line_cost_sen: String(unitCost), line_margin_sen: String(-unitCost),
        po_qty_picked: "0", stock_qty_ready: "0", stock_status: "stock_status",
      };
      const sel = cols.map((c) => (c in override ? `${override[c]}` : `"${c}"`)).join(", ");
      const [ins] = await tx.unsafe(`INSERT INTO scm.mfg_sales_order_items (${cols.map((c) => `"${c}"`).join(", ")})
        SELECT ${sel} FROM scm.mfg_sales_order_items WHERE id::text = $3 RETURNING id::text, line_no`,
        [{ ...v, fabricCode: SPLIT.add.code, extraAddonNote: SPLIT.add.note }, SPLIT.add.note, String(r.id)]);
      await tx`UPDATE scm.mfg_sales_orders SET line_count = (SELECT count(*) FROM scm.mfg_sales_order_items WHERE doc_no = ${SPLIT.doc}) WHERE doc_no = ${SPLIT.doc} AND company_id = ${COMPANY}`;
      split = { keepId: String(r.id), addId: ins.id };
      say(`   ${SPLIT.doc} ln${r.line_no} qty 2 -> qty 1 ${SPLIT.keep.code}  +  new ln${ins.line_no} qty 1 ${SPLIT.add.code}`);
    }
  }
  notice(`colour writes ${writes.length} · split ${split ? "done" : "not done"}`);
  return { writes, split };
}

async function verify({ writes, split }) {
  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const fails = [];
  try {
    for (const w of writes) {
      const [r] = await check.unsafe(`SELECT jsonb_typeof(variants) AS t, variants->>'fabricCode' AS f FROM scm.${w.table} WHERE id::text = $1`, [w.id]);
      if (!r || r.t !== "object" || r.f !== w.code) fails.push(`${w.table} ${w.id}: ${r?.t} ${r?.f}`);
    }
    if (split) {
      const rows = await check`SELECT qty, jsonb_typeof(variants) AS t, variants->>'fabricCode' AS f FROM scm.mfg_sales_order_items
        WHERE doc_no = ${SPLIT.doc} AND upper(btrim(item_code)) = ${SPLIT.item} AND NOT cancelled`;
      const codes = rows.map((r) => r.f).sort().join(",");
      if (rows.length !== 2 || rows.some((r) => Number(r.qty) !== 1 || r.t !== "object") || codes !== [SPLIT.keep.code, SPLIT.add.code].sort().join(","))
        fails.push(`${SPLIT.doc} pillow lines: ${JSON.stringify(rows)}`);
      const [h] = await check`SELECT line_count, (SELECT count(*)::int FROM scm.mfg_sales_order_items WHERE doc_no = ${SPLIT.doc}) AS n FROM scm.mfg_sales_orders WHERE doc_no = ${SPLIT.doc}`;
      if (Number(h.line_count) !== h.n) fails.push(`${SPLIT.doc} line_count ${h.line_count} vs ${h.n} rows`);
    }
  } finally { await check.end(); }
  if (fails.length) { notice(`VERIFY FAILED: ${fails.join(" | ")}`); process.exit(1); }
  notice(`VERIFY OK (fresh connection): ${writes.length} colour writes as jsonb objects; split ${split ? "2 lines of qty 1, line_count matches" : "not applicable"}`);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });
let result;
try {
  await sql.begin(async (tx) => {
    result = await plan(tx);
    if (!APPLY) throw new Error("PLAN_ROLLBACK");
  }).catch((e) => { if (e.message !== "PLAN_ROLLBACK") throw e; });
} catch (e) { console.error(e); await sql.end(); process.exit(1); }
await sql.end();
if (!APPLY) { notice("PLAN — rolled back, nothing written."); process.exit(0); }
await verify(result);
