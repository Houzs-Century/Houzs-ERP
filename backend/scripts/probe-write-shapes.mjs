#!/usr/bin/env node
/* Which write SHAPE actually survives a commit? A canary, not an experiment.

   `refresh-sofa-colours.mjs` writes with ONE shape:

       await sql.begin(async (tx) => { await tx.unsafe(text, [a, b]) })

   and reports the command tag (`res.count`). Three apply runs reported a
   non-zero tag for every row and the next read found the rows unchanged. The
   same shape - postgres.js, `sql.begin`, `unsafe(text, values)` - is what
   `scm/lib/pg-supabase-transaction.ts` puts behind seven staff endpoints,
   including the sofa colour fill-in, so "which shape persists" is a go-live
   question and not only a repair question.

   HOW THIS STAYS SAFE. It does not invent a test write. It takes rows that are
   already in the TO FILL set - rows every apply run is trying to stamp anyway -
   and writes each one with a DIFFERENT shape. A shape that works leaves the row
   correctly filled; a shape that does not leaves it exactly as it was. Nothing
   is deleted, nothing is invented, no scratch table, no DDL. The worst case is
   the intended data on five rows.

   THE READ THAT DECIDES. After the writes, the pool is closed and a BRAND NEW
   postgres() client is opened to re-read the five rows. A connection that has
   just written is the last witness that should be trusted about whether the
   write committed.

   Shapes, in the order printed:
     1  autocommit, tagged template          sql`UPDATE ...`
     2  autocommit, unsafe + params          sql.unsafe(text, values)
     3  transaction, tagged template         sql.begin -> tx`UPDATE ...`
     4  transaction, unsafe + params         sql.begin -> tx.unsafe(text, values)   <= the suspect
     5  transaction, unsafe + RETURNING      as 4, but the statement returns the row

   DRY-RUN by default; APPLY=1 writes. */
import postgres from "postgres";
import { parseSofa, SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const open = () => postgres(DST, { ssl: "require", prepare: false, max: 1 });

const txt = (v) => (typeof v === "string" ? v.trim() : "");
const isBound = (v) => !!(txt(v?.fabricId) || txt(v?.colourId) || txt(v?.fabricCode));

const GUARD = `COALESCE(variants->>'fabricId','') = ''
           AND COALESCE(variants->>'colourId','') = ''
           AND COALESCE(variants->>'fabricCode','') = ''`;
const SET = `variants = COALESCE(variants, '{}'::jsonb) || $1::jsonb`;

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);
  const sql = open();

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const rows = await sql`SELECT i.id, i.item_code AS code, i.description2 AS d2, i.variants
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;

  const todo = [];
  for (const r of rows) {
    if (todo.length >= 5) break;
    const had = r.variants || {};
    if (isBound(had)) continue;
    let model = String(r.code || "").split("-")[0].toUpperCase();
    model = SOFA_MODEL_ALIAS[model] || model;
    const ps = r.d2 ? parseSofa(r.d2, model, false) : null;
    const raw = txt(ps?.color) || txt(had.colourLabel);
    if (!raw || isPendingColour(raw)) continue;
    const hit = findColour(raw);
    if (!hit) continue;
    todo.push({
      id: r.id, code: r.code, raw,
      patch: {
        fabricId: hit.fabric_id, colourId: hit.colour_id, fabricCode: hit.colour_id,
        colourLabel: hit.label, fabricLabel: hit.fabric_id,
      },
    });
  }
  log(`canary rows: ${todo.length}`);
  for (const [i, t] of todo.entries())
    log(`  shape ${i + 1}  id=${t.id}  ${t.code}  "${t.raw}" -> ${t.patch.fabricId} / ${t.patch.colourId}`);
  if (!todo.length) { log("nothing to fill - the set is empty"); await sql.end(); return; }
  if (!APPLY) { log("DRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  const report = [];
  const P = (t) => JSON.stringify(t.patch);

  // 1 - autocommit, tagged template
  if (todo[0]) {
    const t = todo[0];
    const r = await sql`UPDATE scm.mfg_sales_order_items
      SET variants = COALESCE(variants, '{}'::jsonb) || ${sql.json(t.patch)}
      WHERE id = ${t.id} AND COALESCE(variants->>'fabricId','') = ''
        AND COALESCE(variants->>'colourId','') = '' AND COALESCE(variants->>'fabricCode','') = ''`;
    report.push([1, "autocommit tagged", t.id, `count=${r.count} len=${r.length}`]);
  }
  // 2 - autocommit, unsafe + params
  if (todo[1]) {
    const t = todo[1];
    const r = await sql.unsafe(
      `UPDATE scm.mfg_sales_order_items SET ${SET} WHERE id = $2 AND ${GUARD}`, [P(t), t.id]);
    report.push([2, "autocommit unsafe+params", t.id, `count=${r.count} len=${r.length}`]);
  }
  // 3 - transaction, tagged template
  if (todo[2]) {
    const t = todo[2];
    let s = "";
    await sql.begin(async (tx) => {
      const r = await tx`UPDATE scm.mfg_sales_order_items
        SET variants = COALESCE(variants, '{}'::jsonb) || ${tx.json(t.patch)}
        WHERE id = ${t.id} AND COALESCE(variants->>'fabricId','') = ''
          AND COALESCE(variants->>'colourId','') = '' AND COALESCE(variants->>'fabricCode','') = ''`;
      s = `count=${r.count} len=${r.length}`;
    });
    report.push([3, "tx tagged", t.id, s]);
  }
  // 4 - transaction, unsafe + params  <= exactly what refresh-sofa-colours does
  if (todo[3]) {
    const t = todo[3];
    let s = "";
    await sql.begin(async (tx) => {
      const r = await tx.unsafe(
        `UPDATE scm.mfg_sales_order_items SET ${SET} WHERE id = $2 AND ${GUARD}`, [P(t), t.id]);
      s = `count=${r.count} len=${r.length}`;
    });
    report.push([4, "tx unsafe+params (SUSPECT)", t.id, s]);
  }
  // 5 - transaction, unsafe + params + RETURNING
  if (todo[4]) {
    const t = todo[4];
    let s = "";
    await sql.begin(async (tx) => {
      const r = await tx.unsafe(
        `UPDATE scm.mfg_sales_order_items SET ${SET} WHERE id = $2 AND ${GUARD}
         RETURNING id::text, variants->>'fabricId' AS f`, [P(t), t.id]);
      s = `count=${r.count} len=${r.length} returned=${JSON.stringify(r[0] ?? null)}`;
    });
    report.push([5, "tx unsafe+params+RETURNING", t.id, s]);
  }

  await sql.end();
  log("");
  log("what each shape REPORTED:");
  for (const [n, name, id, s] of report) log(`  ${n}  ${name.padEnd(28)} ${id}  ${s}`);

  // ---- the read that decides, on a brand new client ---------------------------
  const fresh = open();
  const back = await fresh`SELECT id::text AS id, xmin::text AS xmin,
      coalesce(variants::text,'<NULL>') AS v, coalesce(variants->>'fabricId','') AS f
    FROM scm.mfg_sales_order_items WHERE id = ANY(${todo.map((t) => t.id)})`;
  const byId = new Map(back.map((r) => [r.id, r]));
  log("");
  log("what a FRESH CONNECTION finds:");
  let lost = 0;
  for (const [n, name, id] of report) {
    const r = byId.get(String(id));
    const ok = r && r.f !== "";
    if (!ok) lost++;
    log(`  ${n}  ${name.padEnd(28)} ${ok ? "PERSISTED" : "LOST     "}  xmin=${r?.xmin ?? "?"}  ${r?.v ?? "(row not read back)"}`);
  }
  log("");
  log(lost ? `${lost}/${report.length} shapes did not survive the commit.` : `all ${report.length} shapes survived.`);
  await fresh.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
