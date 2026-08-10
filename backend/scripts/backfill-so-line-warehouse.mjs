#!/usr/bin/env node
// Fill `warehouse_id` on the migrated sales-order lines from the `location` text
// they already carry.
//
// THE BUG THIS REPAIRS. import-ac-outstanding-so.mjs resolves every line's
// warehouse — `warehouseId: whId(l.Location)`, three call sites (:349, :360,
// :368) — and then never writes it: `warehouse_id` is absent from that script's
// INSERT column list (`ICOLS`, :467), which carries the free-text `location`
// instead. Measured on production 2026-08-10: 13,881 imported SO lines, ZERO
// with a warehouse_id, all four locations present as text (KL 9,434 / PG 3,502 /
// SRW 722 / SBH 223).
//
// WHY IT MATTERS MORE THAN IT LOOKS. Stock is bucketed by
// (warehouse_id, product_code, variant_key). so-stock-allocation puts a
// warehouse-less line in a 'NOWH' bucket that can match no lot, and the sofa
// path is harder still — sofa-set-coverage.findCoveringBatch returns null on the
// first line for a null warehouse, before it looks at any stock at all. So NO
// migrated line can be allocated, sofa or otherwise, however much stock exists.
//
// SCOPE. GROUP defaults to `sofa` — the set this was written to unblock, and the
// smallest change that proves the fix. GROUP=all covers every migrated line;
// that flips thousands of non-sofa lines from PENDING the moment allocation next
// runs, so it is an owner decision, not a default.
//
// SAFETY. Only ever fills a NULL: a line that already has a warehouse is never
// touched, so this cannot move goods between warehouses. Only the four location
// codes above are mapped, via the same SALESLOC table every AutoCount importer
// uses; anything else is REPORTED and skipped. Writes no inventory.
// DRY-RUN by default; APPLY=1 writes.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const GROUP = (process.env.GROUP || "sofa").toLowerCase();
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

/* The same AutoCount SalesLocation -> ERP warehouse table the importers use
   (import-ac-outstanding-so.mjs SALESLOC and its copies). Kept to the codes that
   actually appear on migrated SO lines; a display / service location has never
   been a sales location, so it is deliberately absent rather than guessed. */
const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; group=${GROUP}`);
  const whs = await sql`SELECT id, code FROM scm.warehouses WHERE company_id = 1`;
  const whByCode = new Map(whs.map((w) => [norm(w.code), w.id]));
  const resolve = (loc) => whByCode.get(norm(SALESLOC[norm(loc)] ?? loc)) ?? whByCode.get(norm(loc)) ?? null;

  const rows = await sql`
    SELECT i.item_group, i.location, count(*)::int n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL AND i.warehouse_id IS NULL
     GROUP BY 1, 2 ORDER BY 1, 2`;
  const total = rows.reduce((s, r) => s + r.n, 0);
  log(`migrated SO lines with NO warehouse_id: ${total}`);
  let inScope = 0, unresolved = 0;
  for (const r of rows) {
    const wh = resolve(r.location);
    const scoped = GROUP === "all" || String(r.item_group ?? "").toLowerCase() === GROUP;
    if (!wh) { unresolved += r.n; log(`   UNRESOLVED location ${JSON.stringify(r.location)} (${r.item_group}) — ${r.n} lines, skipped`); continue; }
    if (scoped) inScope += r.n;
    log(`   ${r.item_group} @ ${r.location} -> ${[...whByCode].find(([, v]) => v === wh)?.[0]} — ${r.n} lines${scoped ? "" : " (out of scope)"}`);
  }
  log(`in scope for group=${GROUP}: ${inScope} lines; unresolved location: ${unresolved}`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write. Nothing here touches inventory; lines flip on the next allocation recompute."); await sql.end(); return; }

  let done = 0;
  for (const [code, whName] of Object.entries(SALESLOC)) {
    const whId = whByCode.get(norm(whName));
    if (!whId) { log(`   skip ${code}: ERP has no warehouse ${whName}`); continue; }
    const res = GROUP === "all"
      ? await sql`UPDATE scm.mfg_sales_order_items i SET warehouse_id = ${whId}
                    FROM scm.mfg_sales_orders h
                   WHERE h.doc_no = i.doc_no AND h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
                     AND i.warehouse_id IS NULL AND upper(btrim(i.location)) = ${code}`
      : await sql`UPDATE scm.mfg_sales_order_items i SET warehouse_id = ${whId}
                    FROM scm.mfg_sales_orders h
                   WHERE h.doc_no = i.doc_no AND h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
                     AND i.warehouse_id IS NULL AND upper(btrim(i.location)) = ${code}
                     AND lower(i.item_group) = ${GROUP}`;
    log(`   ${code} -> ${whName}: ${res.count} lines`);
    done += res.count;
  }
  log(`DONE. SO lines given a warehouse: ${done}. Run the allocation recompute — nothing flips here.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
