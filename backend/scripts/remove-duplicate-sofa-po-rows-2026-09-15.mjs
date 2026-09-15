#!/usr/bin/env node
/* remove-duplicate-sofa-po-rows-2026-09-15 — take the two DUPLICATE sofa pieces
 * off HC-PO-010041. Two named rows on one purchase order; nothing else.
 *
 * Owner, 2026-09-15: 「HC-PO-010041 删掉重复的两行（9058-1A(RHF)、9058-1NA）」.
 *
 * ── WHAT THE PURCHASE ORDER HOLDS, MEASURED ─────────────────────────────────
 * Read-only probe run 34878571364 (2026-09-14T18:05Z), HC-PO-010041, 5 sofa rows:
 *
 *   line 1  9058-L(LHF)   key 914330  so_item_id -> HC-SO-013312 ln 1  (import)
 *   line 2  9058-1NA      key (none)  so_item_id -> HC-SO-013312 ln 2  (2026-09-07)
 *   line 3  9058-1A(RHF)  key (none)  so_item_id -> HC-SO-013312 ln 3  (2026-09-07)
 *   (none)  9058-1A(RHF)  key 914330  so_item_id NULL, variants {specials only}  2026-09-10 17:44Z
 *   (none)  9058-1NA      key 914330  so_item_id NULL, variants {}               2026-09-10 17:44Z
 *
 * HC-SO-013312 holds exactly L(LHF) + 1NA + 1A(RHF), each piece covered by lines
 * 1-3. That build is also the supplier's (SO-2609-032) and the owner's
 * (sofa-compartment-corrections-2026-09.json, bug 0736). The last two rows are
 * the duplicates: a second 1A(RHF) and a second 1NA, dedicated to nothing.
 *
 * WHERE THEY CAME FROM. Apply run 34507126629 (2026-09-10) addressed this build
 * by line key 914330 (sofa-compartment-corrections-supplier-listing.json). Lines 2
 * and 3 carry no key, so the key selected line 1 alone, read 1NA and 1A(RHF) as
 * missing, and INSERTed them - with the key and with no sales link
 * (docs/bugs/0873 counts them as the "two SURPLUS duplicate pieces on
 * HC-PO-010041"). docs/bugs/0883 describes them as the keyless rows; that is the
 * other pair, the one that must be KEPT. Which pair goes is decided below by the
 * rows' own state, never by the code alone: deleting a dedicated line would leave
 * a sales-order piece reading SHORT.
 *
 * ── GUARDS, EVERY ONE A REFUSAL ─────────────────────────────────────────────
 * Per row, before anything is written:
 *   - the row id is the one measured, on HC-PO-010041, with the measured code;
 *   - so_item_id IS NULL and line_no IS NULL (the duplicate's own shape);
 *   - received_qty = 0 and both money columns are 0;
 *   - NOTHING references it: every foreign key pointing at
 *     scm.purchase_order_items is enumerated from pg_constraint at run time and
 *     each referencing table is counted (0 GRN lines, 0 allocations measured),
 *     plus po_amendment_lines, which carries the id without a constraint;
 *   - a DEDICATED sibling of the same code stays on the purchase order and
 *     points at a live sales-order line of the same code, so the piece is still
 *     on order after the delete.
 * And for the document: after the delete its sofa pieces must be the same
 * multiset as the sales order's live sofa pieces.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It touches no other purchase order, no sales order, no stock and no
 * AutoCount outbox. The two KEPT rows still carry no book line key after this;
 * that is repair-sofa-added-compartment-line-key.mjs's job (DOC=HC-PO-010041),
 * run after this one. Until it runs, a whole-file APPLY of the corrections
 * would read the build by key 914330 as L(LHF) alone and add the two pieces
 * again - so run the two back to back.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   One transaction; each DELETE repeats the guards in its WHERE and must remove
 *   exactly one row, or the transaction is rolled back.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE: the two
 *   ids are gone, the purchase order's sofa pieces equal the sales order's, every
 *   remaining sofa row is dedicated to a sales-order line of its own code, and
 *   the money sums are unchanged.
 *
 * REVERSAL: the apply log prints each removed row as JSON (to_jsonb) before the
 * delete; re-inserting that row restores it exactly.
 *
 * RE-RUN: inert. The rows it removes are gone, so a second run plans zero
 * deletes, writes nothing and still verifies the document's shape.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 */
import postgres from "postgres";

const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "remove HC-PO-010041 duplicate sofa rows";
const CO = 1;
const PO = "HC-PO-010041";
const SO = "HC-SO-013312";
const DUPLICATES = [
  { id: "26a8eda0-dd42-4e14-a51c-fbc77a61f3b1", code: "9058-1A(RHF)" },
  { id: "e2a89fc9-e8e5-43f7-86dd-da19beb81ba4", code: "9058-1NA" },
];
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const K = (s) => String(s ?? "").trim().toUpperCase();
const bag = (codes) => codes.map(K).sort().join(" | ");

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required."); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'. Nothing was written.`);
  process.exit(2);
}

const connect = () => postgres(process.env.DATABASE_URL, { ssl: "require", max: 1, prepare: false });

/** The purchase order's sofa rows and the sales order's live sofa rows. */
async function readDoc(db) {
  const [head] = await db`SELECT id, po_number, total_sen FROM scm.purchase_orders
                           WHERE company_id = ${CO} AND po_number = ${PO}`;
  if (!head) return null;
  const po = await db`SELECT i.id::text AS id, i.item_code, i.so_item_id::text AS so_item_id, i.line_no,
                             i.received_qty, i.unit_price_sen, i.line_total_sen, i.linked_ac_dtlkey::text AS dtl,
                             s.doc_no AS so_doc, s.item_code AS so_code, s.cancelled AS so_cancelled
                        FROM scm.purchase_order_items i
                        LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
                       WHERE i.purchase_order_id = ${head.id} AND i.item_group = 'sofa'
                       ORDER BY i.line_no NULLS LAST, i.id`;
  const so = await db`SELECT i.id::text AS id, i.item_code FROM scm.mfg_sales_order_items i
                       WHERE i.company_id = ${CO} AND i.doc_no = ${SO} AND i.item_group = 'sofa'
                         AND i.cancelled IS NOT TRUE ORDER BY i.line_no`;
  return { head, po, so };
}

/** Every table that holds a reference to a purchase-order line, with its column. */
async function referencingColumns(db) {
  const fks = await db`SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col
                         FROM pg_constraint con
                         JOIN pg_class c ON c.oid = con.conrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
                        WHERE con.contype = 'f' AND con.confrelid = 'scm.purchase_order_items'::regclass`;
  const cols = fks.map((f) => ({ sch: f.sch, tbl: f.tbl, col: f.col }));
  /* po_amendment_lines names the line without a constraint. */
  const [amend] = await db`SELECT 1 AS ok FROM information_schema.columns
                            WHERE table_schema = 'scm' AND table_name = 'po_amendment_lines'
                              AND column_name = 'purchase_order_item_id'`;
  if (amend && !cols.some((c) => c.tbl === "po_amendment_lines"))
    cols.push({ sch: "scm", tbl: "po_amendment_lines", col: "purchase_order_item_id" });
  for (const c of cols)
    for (const part of [c.sch, c.tbl, c.col])
      if (!/^[a-z_][a-z0-9_]*$/.test(part)) throw new Error(`refusing an unexpected identifier ${JSON.stringify(part)}`);
  return cols;
}

const sql = connect();
try {
  log(`MODE=${MODE}   ${PO} (sales order ${SO})   ${DUPLICATES.length} named row(s)`);
  const doc = await readDoc(sql);
  if (!doc) { log(`${PO}: the ERP holds no such purchase order - nothing to do`); await sql.end(); process.exit(0); }

  log(`\n${PO} sofa rows now: ${doc.po.length}`);
  for (const r of doc.po)
    log(`  line ${String(r.line_no ?? "-").padEnd(3)} ${r.item_code.padEnd(14)} key ${String(r.dtl ?? "(none)").padEnd(7)} `
      + `-> ${r.so_item_id ? `${r.so_doc} ${r.so_code}` : "(no sales link)"}   received ${r.received_qty}   id ${r.id}`);
  log(`${SO} live sofa pieces: ${bag(doc.so.map((r) => r.item_code))}`);

  const refs = await referencingColumns(sql);
  const plan = [];
  const refused = [];
  for (const d of DUPLICATES) {
    const r = doc.po.find((x) => x.id === d.id);
    if (!r) { log(`  ${d.code} ${d.id}: not on ${PO} - already removed`); continue; }
    const why = [];
    if (K(r.item_code) !== K(d.code)) why.push(`its code is ${r.item_code}, measured ${d.code}`);
    if (r.so_item_id !== null) why.push(`it IS dedicated to a sales-order line (${r.so_doc} ${r.so_code})`);
    if (r.line_no !== null) why.push(`it carries line_no ${r.line_no}`);
    if (Number(r.received_qty) !== 0) why.push(`received_qty ${r.received_qty}`);
    if (Number(r.unit_price_sen) !== 0 || Number(r.line_total_sen) !== 0) why.push(`money ${r.unit_price_sen}/${r.line_total_sen}`);
    for (const c of refs) {
      const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM "${c.sch}"."${c.tbl}" WHERE "${c.col}" = $1`, [d.id]);
      if (n) why.push(`${n} row(s) in ${c.sch}.${c.tbl}.${c.col} point at it`);
    }
    const kept = doc.po.filter((x) => x.id !== d.id && !DUPLICATES.some((y) => y.id === x.id)
      && K(x.item_code) === K(d.code) && x.so_item_id && x.so_doc === SO && K(x.so_code) === K(d.code) && x.so_cancelled !== true);
    if (kept.length !== 1) why.push(`${kept.length} dedicated sibling(s) of ${d.code} would remain, expected exactly 1`);
    if (why.length) refused.push(`${d.code} ${d.id}: ${why.join("; ")}`);
    else plan.push({ ...d, keptId: kept[0].id });
  }

  const after = doc.po.filter((x) => !plan.some((p) => p.id === x.id));
  const soBag = bag(doc.so.map((r) => r.item_code));
  if (plan.length && bag(after.map((r) => r.item_code)) !== soBag)
    refused.push(`after the delete ${PO} would read ${bag(after.map((r) => r.item_code))}, and ${SO} reads ${soBag}`);

  log(`\n=== WOULD REMOVE: ${plan.length} row(s) ===`);
  for (const p of plan) log(`  ${p.code}  ${p.id}   (the dedicated ${p.code} ${p.keptId} stays)`);
  log(`checked ${refs.length} referencing column(s): ${refs.map((c) => `${c.tbl}.${c.col}`).join(", ")}`);
  if (refused.length) {
    log("\nREFUSED - nothing will be written:");
    for (const r of refused) log(`  ${r}`);
    await sql.end();
    process.exit(1);
  }

  if (!APPLY) {
    log("\nPLAN ONLY - nothing was written.");
    await sql.end();
    process.exit(0);
  }

  const moneyBefore = doc.po.reduce((a, r) => a + Number(r.unit_price_sen ?? 0) + Number(r.line_total_sen ?? 0), 0);
  if (plan.length) {
    await sql.begin(async (tx) => {
      for (const p of plan) {
        const [row] = await tx`SELECT to_jsonb(i) AS j FROM scm.purchase_order_items i WHERE i.id = ${p.id}`;
        log(`  REMOVING ${JSON.stringify(row?.j ?? null)}`);
        const gone = await tx`DELETE FROM scm.purchase_order_items
                               WHERE id = ${p.id} AND item_code = ${p.code}
                                 AND so_item_id IS NULL AND line_no IS NULL AND received_qty = 0
                                 AND COALESCE(unit_price_sen, 0) = 0 AND COALESCE(line_total_sen, 0) = 0
                              RETURNING id`;
        if (gone.length !== 1) throw new Error(`${p.code} ${p.id}: the guarded DELETE removed ${gone.length} row(s), expected 1 - rolled back`);
      }
    });
  }
  log(`\nAPPLIED: ${plan.length} row(s) removed from ${PO}.`);
  await sql.end();

  const check = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1, prepare: false });
  const now = await readDoc(check);
  await check.end();
  const bad = [];
  for (const d of DUPLICATES) if (now.po.some((r) => r.id === d.id)) bad.push(`${d.code} ${d.id} is still on ${PO}`);
  const poBagNow = bag(now.po.map((r) => r.item_code));
  const soBagNow = bag(now.so.map((r) => r.item_code));
  if (poBagNow !== soBagNow) bad.push(`${PO} reads ${poBagNow}, ${SO} reads ${soBagNow}`);
  const shape = now.po.map((r) => ({ code: K(r.item_code), so: r.so_doc, soCode: K(r.so_code) }));
  for (const s of shape) if (s.so !== SO || s.soCode !== s.code) bad.push(`a ${s.code} row is dedicated to ${JSON.stringify(s)} rather than ${SO} ${s.code}`);
  const dedicated = new Set(now.po.map((r) => r.so_item_id));
  if (dedicated.size !== now.po.length) bad.push(`${now.po.length} sofa rows but ${dedicated.size} distinct sales-order lines`);
  const moneyNow = now.po.reduce((a, r) => a + Number(r.unit_price_sen ?? 0) + Number(r.line_total_sen ?? 0), 0);
  if (moneyNow !== moneyBefore) bad.push(`money moved ${moneyBefore} -> ${moneyNow}`);

  log("\n=== VERIFY (fresh connection) ===");
  for (const r of now.po)
    log(`  line ${String(r.line_no ?? "-").padEnd(3)} ${r.item_code.padEnd(14)} key ${String(r.dtl ?? "(none)").padEnd(7)} -> ${r.so_doc ?? "(none)"} ${r.so_code ?? ""}`);
  log(`  shape ${JSON.stringify(shape)}`);
  if (bad.length) {
    for (const b of bad) log(`  WRONG ${b}`);
    console.error("VERIFY FAILED.");
    process.exit(1);
  }
  log(`VERIFY OK - ${PO} holds ${poBagNow}, one row per ${SO} piece, each dedicated to its own piece; money unchanged.`);
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
