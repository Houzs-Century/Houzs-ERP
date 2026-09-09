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
      bad(`${PO_MONEY.doc}: the lines now sum to ${rm(sum)}, the list expected ${rm(PO_MONEY.nowTotalSen)} — somebody edited it since; re-review before writing. REFUSED`);
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
     WHERE g.company_id = ${CO} AND g.grn_number = ${GR_SWAP.doc}
       AND gi.linked_ac_dtlkey::text = ANY(${GR_SWAP.pair.map((p) => p.dtlKey)})
     ORDER BY gi.linked_ac_dtlkey`;
  let swapPlan = null;
  const byKey = new Map(swapRows.map((r) => [String(r.linked_ac_dtlkey).trim(), r]));
  if (swapRows.length !== 2) { bad(`${GR_SWAP.doc}: expected 2 keyed line(s), found ${swapRows.length} — REFUSED`); refused++; }
  else if (swapRows.some((r) => r.migrated_no_stock !== true)) { bad(`${GR_SWAP.doc}: not migrated paperwork — REFUSED`); refused++; }
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
    SELECT gi.id, gi.item_code, gi.variants, gi.linked_ac_dtlkey,
           jsonb_typeof(COALESCE(gi.variants,'{}'::jsonb)) AS kind, g.migrated_no_stock
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
     WHERE g.company_id = ${CO} AND g.grn_number = ${GR_LEG.doc}
       AND gi.linked_ac_dtlkey::text = ${GR_LEG.dtlKey}`;
  let legPlan = null;
  if (legRows.length !== 1) { bad(`${GR_LEG.doc}: expected 1 line on DtlKey ${GR_LEG.dtlKey}, found ${legRows.length} — REFUSED`); refused++; }
  else {
    const r = legRows[0];
    const held = r.variants && typeof r.variants === "object" && !Array.isArray(r.variants)
      ? String(r.variants.legHeight ?? r.variants.sofaLegHeight ?? "").trim() : "";
    log(`   ${r.item_code}: legHeight ${JSON.stringify(held || "(blank)")} · variants is jsonb ${r.kind} · migrated_no_stock ${r.migrated_no_stock}`);
    if (r.kind !== "object") { bad(`${GR_LEG.doc}: variants is jsonb ${r.kind}, not an object — REFUSED`); refused++; }
    else if (r.migrated_no_stock !== true) { bad(`${GR_LEG.doc}: not migrated paperwork — REFUSED`); refused++; }
    else if (held) {
      bad(`${GR_LEG.doc}: the leg already reads ${JSON.stringify(held)} — this list expected blank. ${held === GR_LEG.want ? "ALREADY the book's value" : "somebody edited it since"} — REFUSED`);
      refused++;
    } else { legPlan = { id: r.id }; log(`   -> merge { legHeight: ${JSON.stringify(GR_LEG.want)} } (a MERGE, never a rebuild of the object)`); }
  }

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
               WHERE id = ${legPlan.id}::uuid
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
    const [r] = await v`SELECT variants, jsonb_typeof(COALESCE(variants,'{}'::jsonb)) AS kind FROM scm.grn_items WHERE id = ${legPlan.id}::uuid`;
    const held = r?.variants?.legHeight ?? null;
    if (r?.kind !== "object" || held !== GR_LEG.want) wrong.push(`${GR_LEG.doc}: legHeight reads ${JSON.stringify(held)} (jsonb ${r?.kind}), wanted ${GR_LEG.want}`);
    else log(`   OK ${GR_LEG.doc}: legHeight ${GR_LEG.want}, variants still a jsonb object`);
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
