#!/usr/bin/env node
// Fill in what the migrated delivery-order writer never copied: item_group,
// variants and description2 on scm.delivery_order_items.
//
// ── THE DEFECT, AND WHY IT READ AS "CLEAN" ─────────────────────────────────
// create-migrated-documents.mjs writes a DO line with SEVEN columns —
// delivery_order_id, so_item_id, item_code, description, uom, qty, company_id.
// The GRN writer in the SAME FILE copies item_group and variants. The DO writer
// does not, and nothing complained, because the failure mode is silence:
//
//   WHERE item_group IN ('sofa','bedframe')  matches ZERO delivery-order lines
//   in company 1. An audit filtered that way reports "aligned" while measuring
//   an empty set.
//
// Company 2's 41 sofa/bedframe DO lines all carry their own item_group, because
// they were not made by this writer. That contrast is the proof that the NULLs
// are the writer's doing and not drift.
//
// ── WHAT THIS FILLS FROM, AND WHY THAT IS THE RIGHT PARENT ─────────────────
// A delivery order is a SNAPSHOT OF THE SALES ORDER AT DISPATCH — the chain
// forks at the SO (docs/sofa-document-chain-map.md section 1); the DO does not
// hang off the GRN. So the parent is delivery_order_items.so_item_id, and the
// values copied are the SO line's, not the product catalogue's.
//
// WHERE so_item_id IS NULL there is no parent, and this script SAYS SO and
// leaves the line alone. Inferring the group from mfg_products.category would
// work and would also be a guess written into a snapshot column, which is
// indistinguishable from a fact afterwards.
//
// ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
//   · It never overwrites a stated value. Every UPDATE re-asserts that the
//     target column IS NULL, so a line a human filled in is left alone even if
//     it disagrees with its SO line — that disagreement is a finding for the
//     chain audit, not something to erase here.
//   · It writes no inventory movement and touches no quantity or money column.
//     These documents carry migrated_no_stock = true (migration 0276): the
//     balance snapshot already counted the units.
//
// SCOPE=migrated (default) restricts to delivery_orders.migrated_no_stock =
// true — the documents this writer made. SCOPE=all covers every DO line in the
// company. DRY-RUN by default; APPLY=1 writes.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const SCOPE = (process.env.SCOPE || "migrated").toLowerCase();
const CAP = Number(process.env.CAP || 40);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const MIGRATED_ONLY = SCOPE !== "all";

const shortJson = (v) => (v == null ? "-" : JSON.stringify(v).slice(0, 70));

async function survey(label) {
  const [r] = await sql`
    SELECT COUNT(*)::int AS lines,
           COUNT(*) FILTER (WHERE di.so_item_id IS NULL)::int      AS no_parent,
           COUNT(*) FILTER (WHERE di.item_group IS NULL)::int      AS grp_null,
           COUNT(*) FILTER (WHERE di.variants IS NULL)::int        AS var_null,
           COUNT(*) FILTER (WHERE di.description2 IS NULL)::int    AS d2_null
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE d.company_id = ${CO}
       AND (${!MIGRATED_ONLY} OR d.migrated_no_stock = true)`;
  log(`   ${label}: ${r.lines} DO line(s) in scope · no so_item_id ${r.no_parent}` +
      ` · item_group NULL ${r.grp_null} · variants NULL ${r.var_null} · description2 NULL ${r.d2_null}`);
  return r;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO} scope=${MIGRATED_ONLY ? "migrated documents only" : "ALL delivery orders"}`);

  /* The three columns must exist before a plan is worth printing. The DO line
     table is not the GRN line table and the names are not interchangeable. */
  const cols = (await sql`SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'delivery_order_items'`).map((c) => c.column_name);
  const need = ["item_group", "variants", "description2", "so_item_id"];
  const missing = need.filter((c) => !cols.includes(c));
  if (missing.length) { log(`REFUSING — scm.delivery_order_items has no ${missing.join(", ")}.`); await sql.end(); return; }
  log(`scm.delivery_order_items carries ${need.join(", ")} — the columns exist, the writer simply never filled them.`);

  log("");
  log("── BEFORE");
  const before = await survey("scope");

  /* One row per fillable line, with the SO line beside it, so the plan can be
     read rather than trusted. LEFT JOIN, not JOIN: a line with no parent has to
     appear in the output as an untouched line, not vanish from the count. */
  const rows = await sql`
    SELECT di.id::text AS id, d.do_number AS doc, di.item_code AS code,
           di.item_group AS grp, di.variants AS variants, di.description2 AS d2,
           di.so_item_id::text AS so_item_id,
           si.doc_no AS so_doc, si.item_group AS so_grp, si.variants AS so_variants,
           si.description2 AS so_d2, si.cancelled AS so_cancelled
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
     WHERE d.company_id = ${CO}
       AND (${!MIGRATED_ONLY} OR d.migrated_no_stock = true)
       AND (di.item_group IS NULL OR di.variants IS NULL OR di.description2 IS NULL)
     ORDER BY d.do_number, di.item_code`;

  const orphans = rows.filter((r) => !r.so_item_id);
  const dangling = rows.filter((r) => r.so_item_id && !r.so_doc);
  const fillable = rows.filter((r) => r.so_doc);

  log("");
  log("── PLAN");
  log(`   lines with at least one of the three columns NULL   ${rows.length}`);
  log(`     no so_item_id — NO PARENT, left alone             ${orphans.length}`);
  log(`     so_item_id names a row that is gone — left alone  ${dangling.length}`);
  log(`     fillable from the parent SO line                  ${fillable.length}`);
  for (const r of orphans.slice(0, CAP)) log(`       LEFT ALONE ${r.doc} ${r.code}: so_item_id is NULL, so there is no snapshot parent to copy from. Not guessed.`);
  if (orphans.length > CAP) log(`       ... ${orphans.length - CAP} more`);
  for (const r of dangling.slice(0, CAP)) log(`       LEFT ALONE ${r.doc} ${r.code}: so_item_id ${r.so_item_id} names no live sales-order line.`);

  let wGrp = 0, wVar = 0, wD2 = 0, noSource = 0;
  const plan = [];
  for (const r of fillable) {
    const g = r.grp === null && r.so_grp !== null;
    const v = r.variants === null && r.so_variants !== null;
    const d = r.d2 === null && r.so_d2 !== null;
    if (!g && !v && !d) { noSource++; continue; }
    if (g) wGrp++; if (v) wVar++; if (d) wD2++;
    plan.push({ r, g, v, d });
  }
  log(`     of those, the parent actually HAS something to give ${plan.length}` +
      ` (item_group ${wGrp} · variants ${wVar} · description2 ${wD2})`);
  log(`     parent is itself empty on every NULL column          ${noSource}`);
  for (const p of plan.slice(0, CAP)) {
    log(`       ${p.r.doc} ${p.r.code}  <- ${p.r.so_doc}${p.r.so_cancelled ? " (SO line CANCELLED)" : ""}`);
    if (p.g) log(`          item_group   NULL -> ${p.r.so_grp}`);
    if (p.v) log(`          variants     NULL -> ${shortJson(p.r.so_variants)}`);
    if (p.d) log(`          description2 NULL -> ${String(p.r.so_d2).replace(/\s+/g, " ").slice(0, 70)}`);
  }
  if (plan.length > CAP) log(`       ... ${plan.length - CAP} more (raise CAP)`);

  if (!APPLY) {
    log("");
    log("DRY-RUN — nothing was written. Set APPLY=1 to backfill.");
    await sql.end(); return;
  }

  /* One transaction. Each SET is guarded by its own IS NULL so a value written
     by anyone between the plan and the write survives untouched. */
  const written = await sql.begin(async (tx) => {
    let n = 0, skipped = 0;
    for (const p of plan) {
      const res = await tx`
        UPDATE scm.delivery_order_items di
           SET item_group   = CASE WHEN di.item_group   IS NULL THEN si.item_group   ELSE di.item_group   END,
               variants     = CASE WHEN di.variants     IS NULL THEN si.variants     ELSE di.variants     END,
               description2 = CASE WHEN di.description2 IS NULL THEN si.description2 ELSE di.description2 END
          FROM scm.mfg_sales_order_items si
         WHERE di.id = ${p.r.id}::uuid AND si.id = di.so_item_id
           AND (di.item_group IS NULL OR di.variants IS NULL OR di.description2 IS NULL)`;
      if (res.count) n += res.count; else skipped++;
    }
    if (skipped) log(`   ${skipped} line(s) matched nothing at write time — already filled by someone else.`);
    return n;
  });
  log("");
  log(`APPLIED: ${written} delivery_order_items row(s) updated, in one transaction.`);

  log("");
  log("── INDEPENDENT READ-BACK (a fresh SELECT — a log line is not evidence)");
  const after = await survey("scope");
  log(`   item_group NULL   ${before.grp_null} -> ${after.grp_null}`);
  log(`   variants NULL     ${before.var_null} -> ${after.var_null}`);
  log(`   description2 NULL ${before.d2_null} -> ${after.d2_null}`);
  const [{ n: nowTagged }] = await sql`
    SELECT COUNT(*)::int AS n FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE d.company_id = ${CO} AND di.item_group IN ('sofa', 'bedframe')`;
  log(`   DO lines now matched by WHERE item_group IN ('sofa','bedframe'): ${nowTagged}`);
  log("   That query returned 0 before this ran, which is why the DO leg read as clean.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
