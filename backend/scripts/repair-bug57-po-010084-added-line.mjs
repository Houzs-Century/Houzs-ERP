// ---------------------------------------------------------------------------
// repair-bug57-po-010084-added-line.mjs — put the amendment-ADDED 9028-1NA of
// HC-SO-013385 onto HC-PO-010084, the purchase order it should have joined.
//
// THE DAMAGE (BUG-57, 2026-10-05). HC-SO-013385/A1 added 9028-1NA (qty 1) to a
// VERANO set whose only PO, HC-PO-010084, is DORSETTLOFT SOFA (400-D004). The
// code's main supplier is HOOKKA INDUSTRIES (400-H004), which has no PO on the
// order, so the confirm of HC-PO-010084/A1 warned "raise a separate PO" and the
// line reached no PO, although DORSETTLOFT is bound for 9028-1NA as an
// alternate (DSL-9028 SOFA 1NA). The fix (pickAddLineBinding) only helps future
// amendments; this places the one line already lost.
//
// THE REPAIR. One transaction:
//   1. re-verify the shape: PO still SUBMITTED, the added SO line live and on
//      no PO line;
//   2. run the FIXED reviseBoundPo for that amendment scoped to HC-PO-010084 —
//      the same engine the PO-Amendments confirm runs, so the line is priced,
//      coded and linked (so_item_id) exactly as a confirm would, the PO is
//      snapshotted (revision 2 -> 3) and the SO audit trail records it;
//   3. refuse unless exactly one line was added, nothing was removed, no
//      warning was raised, the new line is priced, and the four existing lines
//      are unchanged;
//   4. queue the AutoCount PO edit (enqueueEdit) naming the inserted row, as the
//      PO line routes do, so PO-010084 in AutoCount gains the line too.
//
// DRY-RUN BY DEFAULT: plan runs all of it and ROLLS BACK. MODE=apply with the
// CONFIRM phrase commits, then re-reads on a fresh connection.
//
//   npx tsx scripts/repair-bug57-po-010084-added-line.mjs
//   MODE=apply CONFIRM="ADD 9028-1NA TO HC-PO-010084" npx tsx scripts/repair-bug57-po-010084-added-line.mjs
//
// RE-RUN: inert. Step 1 finds a PO line already linked to the added SO line and
// exits without writing, so a second apply changes nothing.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { reviseBoundPo } from "../src/scm/lib/so-revision.ts";
import { pgTransactionSupabase } from "../src/scm/lib/pg-supabase-transaction.ts";
import { enqueueEdit } from "../src/scm/lib/autocount-outbox.ts";

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "ADD 9028-1NA TO HC-PO-010084";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM=${JSON.stringify(CONFIRM_PHRASE)}. Aborting.`);
  process.exit(2);
}

const COMPANY_ID = 1;
const SO_AMENDMENT_ID = "1f9e2be3-4c2a-46b5-a6b2-b5ab1ea4068a";   // HC-SO-013385/A1
const PO_ID = "a8aceb26-0354-474b-b672-56a6c2ffb7e7";             // HC-PO-010084
const PO_NUMBER = "HC-PO-010084";
const SO_DOC_NO = "HC-SO-013385";
const SO_ITEM_ID = "a548f981-0ac3-41fa-903a-0125961485a5";        // the added 9028-1NA
const ITEM_CODE = "9028-1NA";
const EXPECTED_SUPPLIER_SKU = "DSL-9028 SOFA 1NA";
const COMPARED = ["item_code", "material_name", "supplier_sku", "qty", "unit_price_sen",
  "line_total_sen", "delivery_date", "description2", "variants", "so_item_id"];

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const fail = (m) => { throw new Error(`REFUSED: ${m}`); };
const rm = (sen) => `RM ${(Number(sen || 0) / 100).toFixed(2)}`;
const fp = (row) => JSON.stringify(COMPARED.map((k) => row[k] instanceof Date ? row[k].toISOString() : row[k]));

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const DATABASE_URL = resolveUrl();
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

/* The PO-Amendments confirm hands reviseBoundPo a Hono context; the engine
   reads only the active company (po_revisions.company_id) and env (the 2990
   ownership flag, unset here = a Houzs doc stays revisable). */
const ctx = { get: (k) => (k === "companyId" ? COMPANY_ID : undefined), env: {} };

const DRY_RUN_ROLLBACK = "DRY-RUN-ROLLBACK";
const sql = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
let outcome = "none";

try {
  log(`mode=${APPLY ? "APPLY" : "PLAN (rolled back)"}  ${SO_DOC_NO} -> ${PO_NUMBER}  line ${ITEM_CODE}`);
  await sql.begin(async (tx) => {
    // 1. Re-verify the shape inside the transaction, with the PO row locked.
    const [po] = await tx`
      SELECT id, po_number, status, revision, supplier_id, subtotal_sen, company_id
      FROM scm.purchase_orders WHERE id = ${PO_ID} FOR UPDATE`;
    if (!po || po.po_number !== PO_NUMBER) fail(`${PO_NUMBER} not found under id ${PO_ID}`);
    if (po.status !== "SUBMITTED" && po.status !== "PARTIALLY_RECEIVED") fail(`${PO_NUMBER} is ${po.status}`);

    const [soLine] = await tx`
      SELECT id, doc_no, item_code, qty, cancelled
      FROM scm.mfg_sales_order_items WHERE id = ${SO_ITEM_ID}`;
    if (!soLine || soLine.doc_no !== SO_DOC_NO || soLine.item_code !== ITEM_CODE) fail(`SO line ${SO_ITEM_ID} is not ${SO_DOC_NO} ${ITEM_CODE}`);
    if (soLine.cancelled === true) fail(`SO line ${SO_ITEM_ID} is cancelled`);

    const already = await tx`
      SELECT p.id, p.po_number FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
      WHERE i.so_item_id = ${SO_ITEM_ID}`;
    if (already.length > 0) {
      log(`already on ${already.map((r) => r.po_number).join(", ")} — nothing to do.`);
      outcome = "inert";
      return;
    }

    const before = await tx`
      SELECT id, ${tx(COMPARED)} FROM scm.purchase_order_items
      WHERE purchase_order_id = ${PO_ID} ORDER BY line_no`;
    log(`before: ${PO_NUMBER} rev ${po.revision}, ${before.length} lines, subtotal ${rm(po.subtotal_sen)}`);
    for (const r of before) log(`  ${r.item_code}  qty ${r.qty}  ${rm(r.unit_price_sen)}  ${r.supplier_sku}`);

    // 2. The fixed engine, scoped to this PO.
    const sb = pgTransactionSupabase(tx);
    const res = await reviseBoundPo(sb, SO_AMENDMENT_ID, null, ctx, { onlyPoId: PO_ID });

    // 3. Refuse anything but the one intended change.
    const mine = res.perPo.find((p) => p.poId === PO_ID);
    if (res.warnings.length > 0) fail(`engine warned: ${res.warnings.join(" | ")}`);
    if (!mine || mine.linesAdded !== 1 || mine.linesRemoved !== 0) fail(`expected 1 added / 0 removed, got ${JSON.stringify(mine ?? null)}`);

    const after = await tx`
      SELECT id, line_no, ${tx(COMPARED)} FROM scm.purchase_order_items
      WHERE purchase_order_id = ${PO_ID} ORDER BY line_no`;
    const beforeById = new Map(before.map((r) => [r.id, fp(r)]));
    for (const r of after) {
      if (beforeById.has(r.id) && beforeById.get(r.id) !== fp(r)) fail(`existing line ${r.item_code} (${r.id}) changed`);
    }
    const added = after.filter((r) => !beforeById.has(r.id));
    if (added.length !== 1) fail(`expected one new PO line, found ${added.length}`);
    const line = added[0];
    if (line.so_item_id !== SO_ITEM_ID || line.item_code !== ITEM_CODE) fail(`new line is ${line.item_code} / ${line.so_item_id}`);
    if (line.supplier_sku !== EXPECTED_SUPPLIER_SKU) fail(`new line supplier code is ${line.supplier_sku}, expected ${EXPECTED_SUPPLIER_SKU}`);
    if (!(Number(line.unit_price_sen) > 0)) fail(`new line priced ${rm(line.unit_price_sen)}`);

    const [poAfter] = await tx`SELECT revision, subtotal_sen FROM scm.purchase_orders WHERE id = ${PO_ID}`;
    log(`after:  ${PO_NUMBER} rev ${poAfter.revision}, ${after.length} lines, subtotal ${rm(poAfter.subtotal_sen)}`);
    log(`  + line ${line.line_no}: ${line.item_code}  qty ${line.qty}  ${rm(line.unit_price_sen)}  ${line.supplier_sku}  ${line.description2 ?? ""}`);
    log(`  delivery ${line.delivery_date instanceof Date ? line.delivery_date.toISOString().slice(0, 10) : line.delivery_date}`);

    // 4. AutoCount PO-010084 gets the line through the outbox, as a PO line insert does.
    const queued = await enqueueEdit(sb, {
      companyId: po.company_id ?? COMPANY_ID, docType: "PO", docId: PO_ID, docNo: PO_NUMBER, newLineIds: [line.id],
    });
    log(`AutoCount edit queued: ${queued}`);
    if (!queued) {
      // enqueueEdit is silent about WHY; these two reads say it.
      const [flag] = await tx`SELECT value FROM scm.app_config WHERE key = 'scm.autocount_writeback'`;
      const [poLink] = await tx`SELECT linked_ac_docno FROM scm.purchase_orders WHERE id = ${PO_ID}`;
      const recent = await tx`
        SELECT op, status, created_at, last_error AS why
        FROM scm.autocount_outbox WHERE doc_type = 'PO' AND (doc_id = ${PO_ID} OR doc_no = ${PO_NUMBER})
        ORDER BY created_at DESC LIMIT 5`;
      log(`  write-back flag: ${JSON.stringify(flag?.value ?? null)}  linked_ac_docno: ${poLink?.linked_ac_docno ?? null}`);
      for (const r of recent) log(`  outbox ${r.op} ${r.status} ${r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at} ${r.why ?? ""}`);
    }

    if (!APPLY) throw new Error(DRY_RUN_ROLLBACK);
    outcome = "applied";
  });
} catch (e) {
  if (e instanceof Error && e.message === DRY_RUN_ROLLBACK) {
    outcome = "planned";
    log("PLAN: rolled back. Re-run with MODE=apply and the CONFIRM phrase to commit.");
  } else {
    console.error(e instanceof Error ? e.message : e);
    await sql.end();
    process.exit(1);
  }
}
await sql.end();

// Fresh connection: what the committed rows now ARE.
if (outcome === "applied") {
  const verify = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
  const rows = await verify`
    SELECT i.item_code, i.supplier_sku, i.qty, i.unit_price_sen, i.so_item_id, p.revision, p.subtotal_sen,
           (SELECT SUM(line_total_sen) FROM scm.purchase_order_items WHERE purchase_order_id = p.id) AS lines_sum
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE i.purchase_order_id = ${PO_ID} AND i.so_item_id = ${SO_ITEM_ID}`;
  await verify.end();
  const r = rows[0];
  const ok = rows.length === 1 && r.item_code === ITEM_CODE && r.supplier_sku === EXPECTED_SUPPLIER_SKU
    && Number(r.qty) === 1 && Number(r.unit_price_sen) > 0 && Number(r.subtotal_sen) === Number(r.lines_sum);
  log(`verify: ${JSON.stringify(rows)}`);
  if (!ok) { console.error("VERIFY FAILED: the committed line is not the expected shape."); process.exit(1); }
  log(`verified: ${ITEM_CODE} is on ${PO_NUMBER} (rev ${r.revision}), subtotal ${rm(r.subtotal_sen)}.`);
}
