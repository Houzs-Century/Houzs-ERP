#!/usr/bin/env node
/* backfill-do-line-warehouse — put AutoCount's own per-line location onto the
 * migrated delivery lines.
 *
 * THE GAP. AutoCount records a Location on every DODTL row — HQ, PG, KL, SRW,
 * SBH — and until migration 20260907T2345 the ERP had no column for it, so the
 * reconcile reported it as `line location [NOT-C]`: a value the book states and
 * no importer carries. The owner ruled on 2026-09-07 that those codes ARE our
 * stock warehouses (「HQ PGG 就是我们的 stock warehouse location」), so this is a
 * MAPPING onto the warehouses the ERP already has, never a second concept. The
 * map is the SHARED SALESLOC in lib/ac-stock-compare.mjs, reached through
 * lib/migrated-do-writer.mjs's `resolveWarehouse` — the same function the writer
 * uses, so a document created tomorrow and a document repaired today cannot
 * disagree.
 *
 * WHY IT IS NOT ALREADY RIGHT. `resolveDoLineWarehouses` INFERS a warehouse per
 * line (SO line -> DO header -> company default) and the ERP has been showing
 * that inference all along. Measured on the committed book cut
 * (data/ac-partial-dos.json.gz): the inference agrees with the book on 363 of
 * the 366 delivery lines that carry a location and DIFFERS on 3 — DO-000097
 * shipped from HQ against a PG sales-order line. An inference that is right
 * 99.2% of the time is exactly the thing worth replacing with the stated value,
 * because nothing in the answer says which 0.8% is wrong.
 *
 * THE MATCH IS PER DOCUMENT, AND THAT IS EXACT HERE, NOT A SHORTCUT.
 * `SoDtlKey` is null on all 369 rows of the cut, so there is no line-level key
 * to join on. What makes a document-level stamp exact is a property of the data,
 * asserted at runtime rather than assumed: **all 84 delivery documents in the
 * cut carry exactly ONE distinct location across their lines.** A document that
 * ever carries two is REFUSED and listed — never split by guesswork — because a
 * sofa decomposes one AutoCount line into several ERP lines and there is no
 * honest way to hand them different warehouses without a key.
 *
 * SAFETY. Only ever fills a NULL, and only on documents carrying
 * `migrated_no_stock = true` — rows that by construction have written no
 * inventory movement (migration 0276), so this cannot move goods between
 * warehouses. A location that maps to no ERP warehouse leaves warehouse_id NULL
 * (the raw code is still stored in `location`, so the gap is visible instead of
 * absent) and the reader stays on the resolution it uses today.
 *
 * RE-RUN: inert. The plan is built from `warehouse_id IS NULL`, and the UPDATE
 * re-asserts that same predicate, so a second run selects nothing and a line an
 * operator has since routed by hand keeps its warehouse.
 *
 * Usage:
 *   MODE=plan  node backend/scripts/backfill-do-line-warehouse.mjs      (default)
 *   MODE=apply CONFIRM="I HAVE REVIEWED THE WAREHOUSE PLAN" node ...
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { SALESLOC } from "./lib/ac-stock-compare.mjs";
import { resolveWarehouse } from "./lib/migrated-do-writer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL not set. Aborting."); process.exit(2); }

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE WAREHOUSE PLAN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(CO) || CO <= 0) { console.error("COMPANY_ID must be a positive integer"); process.exit(2); }
const TOP = Number(process.env.TOP || 40);

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const line = (m = "") => console.log(m);
const pad = (s, n) => String(s ?? "").padEnd(n);

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/** The book's location PER DELIVERY DOCUMENT, refusing any document that names two. */
function bookLocationByDoc() {
  const rows = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-partial-dos.json.gz"))),
  );
  const byDoc = new Map();
  for (const r of rows) {
    const doc = String(r.DoNo ?? "").trim();
    if (!doc) continue;
    const loc = String(r.Location ?? "").trim();
    let g = byDoc.get(doc);
    if (!g) { g = { lines: 0, locs: new Map() }; byDoc.set(doc, g); }
    g.lines += 1;
    if (loc) g.locs.set(loc, (g.locs.get(loc) ?? 0) + 1);
  }
  const single = new Map();
  const refused = [];
  for (const [doc, g] of byDoc) {
    if (g.locs.size === 1) single.set(doc, [...g.locs.keys()][0]);
    else if (g.locs.size === 0) refused.push(`${doc}: the book states no location on any of its ${g.lines} line(s)`);
    else refused.push(`${doc}: the book states ${g.locs.size} DIFFERENT locations (${[...g.locs.keys()].join(", ")}) and there is no line key to split them by`);
  }
  return { single, refused, docs: byDoc.size, rows: rows.length };
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"} company_id=${CO}`);

  const book = bookLocationByDoc();
  log(`book cut: ${book.rows} delivery lines across ${book.docs} documents; ${book.single.size} document(s) state ONE location`);
  for (const r of book.refused.slice(0, TOP)) line(`  REFUSED (book side) — ${r}`);
  if (!book.single.size) {
    log("No document in the cut states a single location. Nothing can be filled from it — refusing rather than reporting a clean run.");
    await sql.end();
    return;
  }

  const warehouseByCode = new Map(
    (await sql`SELECT id, code FROM scm.warehouses WHERE company_id = ${CO}`)
      .map((w) => [String(w.code ?? "").trim().toUpperCase(), w.id]),
  );
  log(`warehouse master: ${warehouseByCode.size} row(s) for company ${CO}`);

  /* Only migrated documents, and only lines that state nothing yet. */
  const rows = await sql`
    SELECT i.id::text AS id, h.linked_ac_docno AS ac, h.do_number, i.item_code, i.warehouse_id::text AS warehouse_id, i.location
      FROM scm.delivery_order_items i
      JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
     WHERE h.company_id = ${CO}
       AND h.migrated_no_stock = true
       AND h.linked_ac_docno IS NOT NULL
     ORDER BY h.do_number, i.line_no NULLS LAST, i.id`;
  log(`migrated delivery lines in the ERP: ${rows.length} across ${new Set(rows.map((r) => r.ac)).size} document(s)`);

  const plan = [];
  const unmapped = new Map();
  let alreadySet = 0;
  let noBookDoc = 0;
  for (const r of rows) {
    const loc = book.single.get(String(r.ac).trim());
    if (!loc) { noBookDoc += 1; continue; }
    if (r.warehouse_id) { alreadySet += 1; continue; }
    const whId = resolveWarehouse(loc, warehouseByCode);
    if (!whId) unmapped.set(loc, (unmapped.get(loc) ?? 0) + 1);
    plan.push({ id: r.id, doNo: r.do_number, ac: r.ac, item: r.item_code, loc, whId, whName: SALESLOC[loc.toUpperCase()] ?? null });
  }

  log(`to fill: ${plan.length} line(s) across ${new Set(plan.map((p) => p.ac)).size} document(s); ${alreadySet} already carry a warehouse; ${noBookDoc} belong to a document the cut cannot speak for`);
  for (const [loc, n] of unmapped) {
    line(`  ${loc} maps to NO ERP warehouse — ${n} line(s) will store the raw code and leave warehouse_id NULL, never a guess`);
  }
  if (!plan.length) {
    log("Nothing to fill.");
    await sql.end();
    return;
  }
  line("");
  line("PLAN (first " + Math.min(TOP, plan.length) + "):");
  for (const p of plan.slice(0, TOP)) {
    line(`  ${pad(p.doNo, 18)} ${pad(p.item, 22)} ${pad(p.loc, 6)} -> ${p.whName ?? "(unmapped)"} ${p.whId ?? ""}`);
  }
  const byLoc = new Map();
  for (const p of plan) byLoc.set(p.loc, (byLoc.get(p.loc) ?? 0) + 1);
  line("");
  line(`by location: ${[...byLoc].map(([k, v]) => `${k}=${v}`).join(", ")}`);

  if (!APPLY) {
    log(`PLAN ONLY — ${plan.length} line(s) would be filled. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    return;
  }

  let changed = 0;
  const CHUNK = 200;
  for (let i = 0; i < plan.length; i += CHUNK) {
    const batch = plan.slice(i, i + CHUNK);
    await sql.begin(async (tx) => {
      for (const p of batch) {
        /* Re-asserts `warehouse_id IS NULL` so a line routed by hand between the
           plan and the write keeps its warehouse. `location` is written either
           way: it is the book's raw text and it is what makes an unmapped code
           visible. */
        const r = await tx`
          UPDATE scm.delivery_order_items
             SET location = ${p.loc}, warehouse_id = ${p.whId}
           WHERE id = ${p.id}::uuid AND company_id = ${CO} AND warehouse_id IS NULL
           RETURNING id`;
        changed += r.length;
      }
    });
  }
  log(`APPLIED. Lines filled: ${changed} of ${plan.length} planned.`);

  /* THE VERIFICATION IS A FRESH CONNECTION AND IT ASKS WHAT THE VALUE NOW IS.
     A row count is not a shape: it would have said "374 of 374" even if every
     line had landed on the wrong warehouse. This re-reads each line, joins the
     warehouse master, and asserts the CODE matches what the book's location maps
     to through the shared table. */
  const verify = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const back = await verify`
    SELECT i.id::text AS id, i.location, w.code AS wh_code, pg_typeof(i.warehouse_id)::text AS coltype
      FROM scm.delivery_order_items i
      LEFT JOIN scm.warehouses w ON w.id = i.warehouse_id
     WHERE i.id = ANY(${plan.map((p) => p.id)}::uuid[])`;
  const want = new Map(plan.map((p) => [p.id, p]));
  let bad = 0;
  const seen = new Set();
  for (const r of back) {
    seen.add(r.id);
    const p = want.get(r.id);
    const expectCode = p.whId ? (SALESLOC[p.loc.toUpperCase()] ?? p.loc) : null;
    const gotCode = r.wh_code == null ? null : String(r.wh_code).trim();
    if (String(r.location ?? "") !== p.loc) { bad += 1; line(`  VERIFY FAILED — ${p.doNo}: location reads '${r.location}', expected '${p.loc}'`); continue; }
    if ((expectCode ?? null) !== (gotCode ?? null)) { bad += 1; line(`  VERIFY FAILED — ${p.doNo}: warehouse reads '${gotCode}', expected '${expectCode}' (${r.coltype})`); }
  }
  const missing = plan.filter((p) => !seen.has(p.id));
  if (missing.length) { bad += 1; line(`  VERIFY FAILED — re-read returned ${back.length} of ${plan.length} lines`); }
  await verify.end();
  await sql.end();
  if (bad) { console.error(`${bad} verification failure(s).`); process.exit(1); }
  log(`Verified on a fresh connection: every filled line stores the book's own location text and resolves to the warehouse that code maps to.`);
}

main().catch(async (e) => { console.error(e); await sql.end().catch(() => {}); process.exit(1); });
