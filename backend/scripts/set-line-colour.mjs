#!/usr/bin/env node
/* Write a fabric colour onto a sales-order line and every line of its chain —
   the reusable form of a request the owner makes often (「帮我补颜色」).

   Owner 2026-09-15 ruled that recurring data operations are workflows with
   document inputs, not a new script each time. First use: HC-SO-011114's stool,
   whose Description 2 reads "HOK-5536 Stool(40x40'Inch)/Col:BOO315-22" — the
   colour is BO315-22; the Sofa Accessory data run left it blank because it read
   the stool's model number as a second colour.

   INPUT  SETS = "DOC:LINE_NO:COLOUR[;DOC:LINE_NO:COLOUR...]"
          e.g. "HC-SO-011114:3:BO315-22"
   For each entry (company 1):
     - COLOUR must be an ACTIVE colour_id in scm.fabric_colours; else refused;
     - the SO line is found by doc + line_no, exactly one, not cancelled; else refused;
     - variants.fabricCode is written on that SO line and on every line that
       points at it: PO (so_item_id), GRN (purchase_order_item_id), PI
       (grn_item_id), DO (so_item_id), SI (so_item_id);
     - a line that already carries THIS colour is skipped; a line carrying a
       DIFFERENT colour refuses the whole entry (nothing of it is written);
     - an entry whose GRN line opened a stock lot is refused: the lot's key would
       disagree with the line, and moving stock is a separate, audited run.
   Nothing else changes — no text, qty, price, status or stock.

   MODE=plan (default) runs inside a transaction and ROLLS BACK.
   MODE=apply requires CONFIRM="SET LINE COLOUR".
   After an apply a FRESH connection re-reads every written row: variants is a
   jsonb OBJECT whose fabricCode equals the requested colour.

   RE-RUN: idempotent — rows already carrying the colour are skipped. */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "SET LINE COLOUR";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) { console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`); process.exit(2); }
const COMPANY = 1;
const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);

const SETS = String(process.env.SETS || "").split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
  const m = s.match(/^(.+?):(\d+):(.+)$/);
  return m ? { doc: m[1].trim(), lineNo: Number(m[2]), colour: m[3].trim() } : { bad: s };
});
if (!SETS.length) { console.error('SETS is empty — e.g. SETS="HC-SO-011114:3:BO315-22"'); process.exit(2); }
const bad = SETS.filter((s) => s.bad);
if (bad.length) { console.error(`unreadable SETS entries: ${bad.map((b) => b.bad).join(" | ")} (want DOC:LINE_NO:COLOUR)`); process.exit(2); }

async function plan(tx) {
  notice(`=== set line colour — ${APPLY ? "APPLY" : "PLAN (rolled back)"} · ${SETS.length} entr${SETS.length === 1 ? "y" : "ies"} ===`);
  const writes = [];
  let refused = 0;
  for (const e of SETS) {
    const tag = `${e.doc} ln${e.lineNo} -> ${e.colour}`;
    const [colour] = await tx`SELECT colour_id, label FROM scm.fabric_colours WHERE company_id = ${COMPANY} AND colour_id = ${e.colour} AND active`;
    if (!colour) { notice(`REFUSED ${tag}: not an active colour in the fabric library`); refused++; continue; }
    const so = await tx`SELECT id::text, item_code, qty, cancelled, variants, description2 FROM scm.mfg_sales_order_items
      WHERE company_id = ${COMPANY} AND doc_no = ${e.doc} AND line_no = ${e.lineNo}`;
    if (so.length !== 1 || so[0].cancelled) { notice(`REFUSED ${tag}: ${so.length} line(s) at that number${so[0]?.cancelled ? " (cancelled)" : ""}`); refused++; continue; }
    const s = so[0];
    const chain = [["mfg_sales_order_items", s.id, s.variants]];
    const grnIds = [];
    for (const p of await tx`SELECT id::text, variants FROM scm.purchase_order_items WHERE so_item_id::text = ${s.id}`) {
      chain.push(["purchase_order_items", p.id, p.variants]);
      for (const g of await tx`SELECT id::text, grn_id::text, variants FROM scm.grn_items WHERE purchase_order_item_id::text = ${p.id}`) {
        chain.push(["grn_items", g.id, g.variants]); grnIds.push(g.grn_id);
        for (const pi of await tx`SELECT id::text, variants FROM scm.purchase_invoice_items WHERE grn_item_id::text = ${g.id}`) chain.push(["purchase_invoice_items", pi.id, pi.variants]);
      }
    }
    for (const d of await tx`SELECT id::text, variants FROM scm.delivery_order_items WHERE so_item_id::text = ${s.id}`) chain.push(["delivery_order_items", d.id, d.variants]);
    for (const si of await tx`SELECT id::text, variants FROM scm.sales_invoice_items WHERE so_item_id::text = ${s.id}`) chain.push(["sales_invoice_items", si.id, si.variants]);

    const conflict = chain.filter(([, , v]) => {
      const cur = v && typeof v === "object" && !Array.isArray(v) ? (v.fabricCode ?? v.fabricColor ?? "") : "";
      return cur && String(cur).toUpperCase() !== e.colour.toUpperCase();
    });
    if (conflict.length) { notice(`REFUSED ${tag}: ${conflict.map(([t, , v]) => `${t} already ${v.fabricCode ?? v.fabricColor}`).join(", ")}`); refused++; continue; }
    const shaped = chain.filter(([, , v]) => v != null && (typeof v !== "object" || Array.isArray(v)));
    if (shaped.length) { notice(`REFUSED ${tag}: variants not an object on ${shaped.map(([t]) => t).join(", ")}`); refused++; continue; }
    if (grnIds.length) {
      const [lots] = await tx`SELECT count(*)::int AS n FROM scm.inventory_lots WHERE company_id = ${COMPANY} AND source_doc_type = 'GRN'
        AND source_doc_id::text = ANY(${grnIds}) AND upper(btrim(item_code)) = upper(btrim(${s.item_code}))`;
      if (lots.n) { notice(`REFUSED ${tag}: its receipt opened ${lots.n} stock lot(s) — relabel stock in a separate run`); refused++; continue; }
    }
    say(`${tag} (${colour.label}) · ${s.item_code} qty ${s.qty} · "${String(s.description2 ?? "").replace(/\s+/g, " ").slice(0, 70)}"`);
    for (const [table, id, v] of chain) {
      const already = v && typeof v === "object" && String(v.fabricCode ?? "").toUpperCase() === e.colour.toUpperCase();
      if (already) { say(`   ${table} ${id}: already ${e.colour}, skipped`); continue; }
      const res = await tx.unsafe(`UPDATE scm.${table}
        SET variants = CASE WHEN variants IS NULL OR jsonb_typeof(variants) = 'null' THEN jsonb_build_object('fabricCode', $1::text)
                            ELSE jsonb_set(variants, '{fabricCode}', to_jsonb($1::text), true) END
        WHERE id::text = $2 AND company_id = $3 RETURNING id::text`, [e.colour, id, COMPANY]);
      if (res.length) writes.push({ table, id, colour: e.colour });
      say(`   ${table} ${id}: fabricCode -> ${e.colour}`);
    }
  }
  notice(`writes ${writes.length} · refused entries ${refused}`);
  return writes;
}

async function verify(writes) {
  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const fails = [];
  try {
    for (const w of writes) {
      const [r] = await check.unsafe(`SELECT jsonb_typeof(variants) AS t, variants->>'fabricCode' AS f FROM scm.${w.table} WHERE id::text = $1`, [w.id]);
      if (!r || r.t !== "object" || r.f !== w.colour) fails.push(`${w.table} ${w.id}: ${r?.t} ${r?.f}`);
    }
  } finally { await check.end(); }
  if (fails.length) { notice(`VERIFY FAILED: ${fails.join(" | ")}`); process.exit(1); }
  notice(`VERIFY OK (fresh connection): ${writes.length} rows carry the requested colour as a jsonb object`);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });
let writes;
try {
  await sql.begin(async (tx) => {
    writes = await plan(tx);
    if (!APPLY) throw new Error("PLAN_ROLLBACK");
  }).catch((e) => { if (e.message !== "PLAN_ROLLBACK") throw e; });
} catch (e) { console.error(e); await sql.end(); process.exit(1); }
await sql.end();
if (!APPLY) { notice("PLAN — rolled back, nothing written."); process.exit(0); }
await verify(writes);
