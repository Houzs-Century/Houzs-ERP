#!/usr/bin/env node
// ----------------------------------------------------------------------------
// THE LAST THREE CUTOVER DOCUMENTS, EACH ALIGNED TO THE ACCOUNT BOOK.
// Three named documents, three shapes, one reviewed list. Nothing sweeps.
//
// WHY ONE SCRIPT AND NOT THREE. Each of these is a single row on a single named
// document, and each already has a purpose-built repair that CANNOT reach it —
// checked before writing this, not assumed:
//
//   repair-migrated-grn-item-codes.mjs  ran, "NOTHING TO REPAIR": it fixes an
//                                       UNTRANSLATED book code, and both codes
//                                       here are already ERP codes. They are
//                                       merely on each other's line.
//   repair-grn-variant-snapshot.mjs     restores a value that COULD NOT be a
//                                       measurement. A blank is absent, not
//                                       impossible, so its gate 1 refuses.
//   repair-gr-money-from-book.mjs       is the RECEIPT side; PO-006690 is an
//                                       ORDER, and that script's plan is 0.
//
// Widening any of those three to reach one row would arm a sweep for a case
// nobody has measured. This is the reviewed-list shape instead
// (`data/variant-book-corrections.json` is the same idea): the population is
// typed out below, and anything not matching what was reviewed is REFUSED.
//
// ── THE THREE, AND THE OWNER'S WORD ON EACH ─────────────────────────────────
//
//  A  PO-006690 — MONEY. The book states one line, DtlKey 655505,
//     `HOK-DIVAN ONLY (Q)`, qty 1, and NO PRICE. We hold RM 380.00. The owner,
//     2026-09-09, asked directly whether "follow the book" means clearing our
//     380 to zero on a purchase order: 「跟账本」, then 「是的」.
//     A purchase order carrying no price is the NORMAL shape in this book —
//     10,810 of 18,890 PODTL lines have none — because Houzs prices a purchase
//     on arrival. This is a copy of that absence, not a write-down.
//
//  B  GR-005334 — TWO LINES ARE ON EACH OTHER'S KEY. Not a missing code:
//         DtlKey 917594  book AKEMI IMMORTAL MATT (K)   we hold ULTIMATE
//         DtlKey 917604  book AKEMI ULTIMATE MATT (K)   we hold IMMORTAL
//     Both codes are real, both are on the document, and they are transposed.
//     This is `docs/bugs/0690`'s class exactly, which is why the swap is stated
//     as a pair and applied in ONE transaction: half of a swap is worse than
//     neither half.
//
//  C  GR-005256 — the RECEIPT's leg is blank where the book says 1". The owner:
//     「你这些需要再PO 处理然后convert就没问题了」. That is right for a receipt
//     RAISED from a purchase order, and this one was not — it was written by
//     `create-migrated-documents.mjs`, which copied the PO line's variants at
//     the moment of migration, when the leg was blank. Correcting the PO (done,
//     run 34341039880) cannot reach backwards into a snapshot. The book states
//     the same 1" the PO now states, so this writes a value BOTH of them agree
//     on and invents nothing.
//
// ── FOUR GATES, EVERY ONE A REFUSAL RATHER THAN A FALLBACK ──────────────────
//   1  MODE defaults to plan. APPLY needs MODE=apply.
//   2  CONFIRM must be the phrase. Refused with a non-zero exit, never
//      downgraded to a plan — an operator who asked for a write and got a plan
//      reads the plan as the write.
//   3  EVERY row asserts what it currently holds before it is touched. If the
//      row moved since this list was written, somebody edited it and this
//      file's answer may no longer be right: REFUSED and named, never written.
//   4  A fresh connection re-reads all three afterwards and asserts the SHAPE —
//      the codes, the leg, and the MONEY both before and after, because a row
//      count answers "did a row change", never "does it now hold what I meant".
//
// STOCK IS PROVED UNTOUCHED, not assumed: both receipts are asserted
// `migrated_no_stock` with zero inventory movements, inside the transaction.
//
// RE-RUN: inert. Gate 3 turns every row into "already the book's value —
// skipped" on a second run, so nothing is written twice and the swap cannot
// swap back.
//
//   MODE=apply CONFIRM="ALIGN THE LAST THREE TO THE BOOK" \
//     node scripts/align-last-three-cutover-docs.mjs
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "ALIGN THE LAST THREE TO THE BOOK";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM="${CONFIRM_PHRASE}". Nothing was written.`);
  process.exit(2);
}

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const rm = (sen) => `RM ${(Number(sen || 0) / 100).toFixed(2)}`;

/* The reviewed list. Every `now` is what the ERP held when this was written,
   read from the tally of 2026-09-09 (runs 34336722458 and the GR diag). */
const PO_MONEY = { doc: "HC-PO-006690", acDoc: "PO-006690", dtlKey: "655505", nowTotalSen: 38000, wantTotalSen: 0 };
const GR_SWAP = {
  doc: "HC-GR-005334", acDoc: "GR-005334",
  pair: [
    { dtlKey: "917594", now: "AKEMI ULTIMATE MATT (K)", want: "AKEMI IMMORTAL MATT (K)" },
    { dtlKey: "917604", now: "AKEMI IMMORTAL MATT (K)", want: "AKEMI ULTIMATE MATT (K)" },
  ],
};
const GR_LEG = { doc: "HC-GR-005256-PO-009652", acDoc: "GR-005256", dtlKey: "906540", want: '1"' };

const K = (s) => String(s ?? "").trim().toUpperCase();
let refused = 0;

async function main() {
  log(`align the last three cutover documents — mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"} company=${CO}`);
  log("");

  /* ── A. PO-006690, the money ───────────────────────────────────────────── */
  log(`── A ${PO_MONEY.doc}: the book states no price; we hold ${rm(PO_MONEY.nowTotalSen)} ──`);
  const poRows = await sql`
    SELECT i.id, i.item_code, i.qty, i.unit_price_sen, i.discount_sen, i.line_total_sen, i.linked_ac_dtlkey,
           p.id AS po_id, p.po_number, p.status, p.subtotal_sen, p.tax_sen, p.total_sen
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND (p.po_number = ${PO_MONEY.doc} OR p.linked_ac_docno = ${PO_MONEY.acDoc})
     ORDER BY i.id`;
  let poPlan = null;
  if (!poRows.length) { bad(`${PO_MONEY.doc}: the ERP holds no such purchase order — REFUSED`); refused++; }
  else {
    const sum = poRows.reduce((n, r) => n + Number(r.line_total_sen || 0), 0);
    for (const r of poRows) log(`   line ${r.item_code} qty ${r.qty} unit ${rm(r.unit_price_sen)} total ${rm(r.line_total_sen)} key ${r.linked_ac_dtlkey ?? "(none)"}`);
    log(`   header total ${rm(poRows[0].total_sen)} · lines sum ${rm(sum)} · status ${poRows[0].status}`);
    if (sum !== PO_MONEY.nowTotalSen) {
      const already = sum === PO_MONEY.wantTotalSen;
      bad(`${PO_MONEY.doc}: the lines now sum to ${rm(sum)}, the list expected ${rm(PO_MONEY.nowTotalSen)} — ${already ? "ALREADY the book's value, nothing to do" : 'somebody edited it since; re-review before writing'}. REFUSED`);
      refused++;
    } else {
      poPlan = { poId: poRows[0].po_id, ids: poRows.map((r) => r.id) };
      log(`   -> zero every money column on ${poRows.length} line(s) and roll the header to ${rm(PO_MONEY.wantTotalSen)}`);
    }
  }

  /* ── B. GR-005334, the transposed pair ─────────────────────────────────── */
  log("");
  log(`── B ${GR_SWAP.doc}: two lines hold each other's item code ──`);
  const swapRows = await sql`
    SELECT gi.id, gi.item_code, gi.material_name, gi.linked_ac_dtlkey, g.id AS grn_id, g.grn_number, g.migrated_no_stock
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
     WHERE g.company_id = ${CO}
       AND gi.linked_ac_dtlkey::text = ANY(${GR_SWAP.pair.map((p) => p.dtlKey)})
     ORDER BY gi.linked_ac_dtlkey`;
  let swapPlan = null;
  const byKey = new Map(swapRows.map((r) => [String(r.linked_ac_dtlkey).trim(), r]));
  /* FOUND BY THE BOOK'S LINE KEY, not by our document number. The first version
     joined on `g.grn_number = 'HC-GR-005334'` and found ZERO rows: a migrated
     receipt's ERP number is not always the book's number with a prefix — several
     in this batch carry a `-PO-NNNNNN` suffix. The KEY is the identity; the
     number is a label. The document is printed rather than assumed, and both
     rows must be on the SAME one. */
  const swapDocs = [...new Set(swapRows.map((r) => r.grn_number))];
  if (swapRows.length) log(`   found on ${swapDocs.join(", ")}`);
  if (swapRows.length !== 2) { bad(`${GR_SWAP.acDoc}: expected 2 keyed line(s), found ${swapRows.length} — REFUSED`); refused++; }
  else if (swapDocs.length !== 1) { bad(`${GR_SWAP.acDoc}: the two keys sit on DIFFERENT documents (${swapDocs.join(", ")}) — that is not a swap. REFUSED`); refused++; }
  else if (swapRows.some((r) => r.migrated_no_stock !== true)) { bad(`${GR_SWAP.acDoc}: not migrated paperwork — REFUSED`); refused++; }
  else {
    const mism = GR_SWAP.pair.filter((p) => K(byKey.get(p.dtlKey)?.item_code) !== K(p.now));
    for (const p of GR_SWAP.pair) log(`   DtlKey ${p.dtlKey}: holds ${JSON.stringify(byKey.get(p.dtlKey)?.item_code)} -> ${JSON.stringify(p.want)}`);
    if (mism.length) {
      const already = GR_SWAP.pair.every((p) => K(byKey.get(p.dtlKey)?.item_code) === K(p.want));
      bad(`${GR_SWAP.doc}: ${already ? "ALREADY the book's codes, nothing to do" : "the rows do not hold what the list expected; somebody edited them since"} — REFUSED`);
      refused++;
    } else {
      swapPlan = GR_SWAP.pair.map((p) => ({ id: byKey.get(p.dtlKey).id, want: p.want }));
      log("   -> swap both, in ONE transaction (half a swap is worse than neither half)");
    }
  }

  /* ── C. GR-005256, the leg the snapshot never took ─────────────────────── */
  log("");
  log(`── C ${GR_LEG.doc}: the receipt's leg is blank; the book and the purchase order both say ${GR_LEG.want} ──`);
  const legRows = await sql`
    SELECT gi.id, gi.item_code, gi.variants, gi.linked_ac_dtlkey, g.grn_number,
           jsonb_typeof(COALESCE(gi.variants,'{}'::jsonb)) AS kind, g.migrated_no_stock
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
     WHERE g.company_id = ${CO} AND gi.linked_ac_dtlkey::text = ${GR_LEG.dtlKey}
     ORDER BY gi.id`;
  /* ONE BOOK LINE IS MANY ERP ROWS. A sofa is one line in the book and one ERP
     row PER COMPARTMENT, every one carrying the same DtlKey
     (docs/modules/purchase-order.md: "indexed, NOT unique"). The first version
     asked for exactly one row and refused on finding two — this repo's own
     documented shape. A SCALAR axis is written identically to every piece of a
     build, so all are read, all must agree, and all are written. */
  let legPlan = null;
  const legDocs = [...new Set(legRows.map((r) => r.grn_number))];
  if (legRows.length) log(`   found ${legRows.length} compartment row(s) on ${legDocs.join(", ")}: ${legRows.map((r) => r.item_code).join(" + ")}`);
  const heldOf = (r) => (r.variants && typeof r.variants === "object" && !Array.isArray(r.variants)
    ? String(r.variants.legHeight ?? r.variants.sofaLegHeight ?? "").trim() : "");
  const spread = [...new Set(legRows.map(heldOf))];
  if (!legRows.length) { bad(`${GR_LEG.acDoc}: no line on DtlKey ${GR_LEG.dtlKey} — REFUSED`); refused++; }
  else if (legDocs.length !== 1) { bad(`${GR_LEG.acDoc}: that key sits on ${legDocs.length} documents (${legDocs.join(", ")}) — REFUSED`); refused++; }
  else if (legRows.some((r) => r.kind !== "object")) { bad(`${GR_LEG.acDoc}: a row's variants is not a jsonb object — REFUSED`); refused++; }
  else if (legRows.some((r) => r.migrated_no_stock !== true)) { bad(`${GR_LEG.acDoc}: not migrated paperwork — REFUSED`); refused++; }
  else if (spread.length > 1) {
    bad(`${GR_LEG.acDoc}: the ${legRows.length} pieces of this build do not agree on the leg (${spread.map((x) => JSON.stringify(x || "")).join(", ")}) — a human has to look at that. REFUSED`);
    refused++;
  } else if (spread[0]) {
    bad(`${GR_LEG.acDoc}: the leg already reads ${JSON.stringify(spread[0])} — this list expected blank. ${spread[0] === GR_LEG.want ? "ALREADY the book's value" : "somebody edited it since"} — REFUSED`);
    refused++;
  } else { legPlan = { ids: legRows.map((r) => r.id) }; log(`   -> merge { legHeight: ${JSON.stringify(GR_LEG.want)} } onto all ${legRows.length} piece(s) (a MERGE, never a rebuild)`); }

  log("");
  const ready = [poPlan && "A", swapPlan && "B", legPlan && "C"].filter(Boolean);
  log(`PLAN: ${ready.length} of 3 ready (${ready.join(", ") || "none"}); ${refused} refused.`);
  if (!APPLY) { log(`PLAN ONLY — nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`); await sql.end(); return; }
  if (!ready.length) { log("APPLY: nothing to write."); await sql.end(); return; }

  /* ── the write ─────────────────────────────────────────────────────────── */
  log("");
  log(`=== APPLYING ${ready.length} ===`);
  if (poPlan) {
    await sql.begin(async (tx) => {
      const [{ n: mv }] = await tx`SELECT COUNT(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${PO_MONEY.doc}`;
      if (Number(mv) > 0) throw new Error(`${PO_MONEY.doc} now carries ${mv} inventory movement(s)`);
      await tx`UPDATE scm.purchase_order_items
                  SET unit_price_sen = 0, discount_sen = 0, line_total_sen = 0
                WHERE id = ANY(${poPlan.ids}::uuid[])`;
      await tx`UPDATE scm.purchase_orders SET subtotal_sen = 0, tax_sen = 0, total_sen = 0 WHERE id = ${poPlan.poId}::uuid`;
    });
    log(`   A ${PO_MONEY.doc}: written`);
  }
  if (swapPlan) {
    await sql.begin(async (tx) => {
      for (const p of swapPlan) {
        await tx`UPDATE scm.grn_items SET item_code = ${p.want}, material_name = ${p.want} WHERE id = ${p.id}::uuid`;
      }
    });
    log(`   B ${GR_SWAP.doc}: both lines written in one transaction`);
  }
  if (legPlan) {
    await sql`UPDATE scm.grn_items
                 SET variants = COALESCE(variants,'{}'::jsonb) || ${sql.json({ legHeight: GR_LEG.want })}
               WHERE id = ANY(${legPlan.ids}::uuid[])
                 AND jsonb_typeof(COALESCE(variants,'{}'::jsonb)) = 'object'`;
    log(`   C ${GR_LEG.doc}: written`);
  }
  await sql.end();

  /* ── the verification, on a FRESH connection ───────────────────────────── */
  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  log("");
  log("=== VERIFY — re-read on a fresh connection ===");
  const wrong = [];
  if (poPlan) {
    const rows = await v`SELECT i.line_total_sen, i.unit_price_sen, p.total_sen
                           FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
                          WHERE i.purchase_order_id = ${poPlan.poId}::uuid`;
    const sum = rows.reduce((n, r) => n + Number(r.line_total_sen || 0), 0);
    const hdr = Number(rows[0]?.total_sen ?? -1);
    if (sum !== 0 || hdr !== 0) wrong.push(`${PO_MONEY.doc}: lines sum ${rm(sum)}, header ${rm(hdr)} — wanted RM 0.00 on both`);
    else log(`   OK ${PO_MONEY.doc}: ${rows.length} line(s) at RM 0.00, header RM 0.00`);
  }
  if (swapPlan) {
    const rows = await v`SELECT linked_ac_dtlkey, item_code FROM scm.grn_items WHERE id = ANY(${swapPlan.map((p) => p.id)}::uuid[])`;
    const now = new Map(rows.map((r) => [String(r.linked_ac_dtlkey).trim(), K(r.item_code)]));
    const off = GR_SWAP.pair.filter((p) => now.get(p.dtlKey) !== K(p.want));
    if (off.length) wrong.push(`${GR_SWAP.doc}: ${off.map((p) => `${p.dtlKey} reads ${now.get(p.dtlKey)}, wanted ${K(p.want)}`).join("; ")}`);
    else log(`   OK ${GR_SWAP.doc}: ${GR_SWAP.pair.map((p) => `${p.dtlKey}=${p.want}`).join(" · ")}`);
  }
  if (legPlan) {
    const rows = await v`SELECT id, variants, jsonb_typeof(COALESCE(variants,'{}'::jsonb)) AS kind FROM scm.grn_items WHERE id = ANY(${legPlan.ids}::uuid[])`;
    const off = rows.filter((r) => r.kind !== "object" || (r.variants?.legHeight ?? null) !== GR_LEG.want);
    if (rows.length !== legPlan.ids.length || off.length) wrong.push(`${GR_LEG.acDoc}: ${off.length} of ${rows.length} piece(s) do not read legHeight ${GR_LEG.want}`);
    else log(`   OK ${GR_LEG.acDoc}: all ${rows.length} piece(s) read legHeight ${GR_LEG.want}, variants still jsonb objects`);
  }
  await v.end();
  if (wrong.length) {
    for (const w of wrong) bad(`VERIFY FAILED — ${w}`);
    console.error(`REFUSING to report success: ${wrong.length} document(s) do not hold what was written.`);
    process.exit(1);
  }
  log(`VERIFIED on a fresh connection: ${ready.length} document(s) hold the book's values.`);
}

main().catch((e) => { console.error(e); process.exit(2); });
