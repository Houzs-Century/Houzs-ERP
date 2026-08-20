#!/usr/bin/env node
// Repair the purchase_order_items.so_item_id links the AutoCount cutover lost,
// using the evidence backfill-po-so-item-links.mjs cannot see.
//
// ── WHY A FOURTH RULE, AND NOT A FOURTH TIER IN THE OTHER SCRIPT ───────────
// backfill-po-so-item-links.mjs resolves a link from the PO's own "From SOs:"
// note, written at raise time by the SO -> PO convert. A MIGRATED purchase
// order has no such note — measured, not assumed: of the 181 company-1 sofa /
// bedframe PO lines with a NULL so_item_id, the notes of exactly ZERO name a
// sales order (diag-sofa-cutover-residue.mjs section D). Its three tiers are
// therefore structurally blind here, and widening them would blur two
// different kinds of evidence into one score.
//
// The evidence that DOES exist on a migrated line is the AutoCount text — the
// description2 that came across with the document. The rule:
//
//   The PO line sits on a purchase order where OTHER lines ARE linked (so the
//   document is not a stock buy), and exactly ONE still-unclaimed, non-
//   cancelled sales-order line carries the SAME item code AND the SAME
//   AutoCount text. One candidate, or nothing is written.
//
// That is the same 1:1 discipline the other script applies, on a different
// column. It measured 8 such lines, and those 8 are exactly the lines behind 6
// of the 8 "short PO" findings on LEG 1 — the factory IS being asked to build
// the right thing; only the per-line link is missing.
//
// ── THE MIS-LINKED ONE IS HANDLED SEPARATELY, AND DEFENSIVELY ─────────────
// HC-PO-000290's second CODY-(K) line points at HC-SO-000870 line 2, which is a
// MATTRESS line (LUMBARIA MATT (K)) — the single dangling FK in the corpus. It
// is not a null link to fill but a wrong link to correct, so it runs under its
// own switch and its own rule: re-point it at the unclaimed CODY-(K) line on
// the SAME order if exactly one exists, and otherwise NULL it. A null link is
// honest; a wrong link is not. This never guesses a target.
//
// ── WHAT IS DELIBERATELY LEFT ALONE ───────────────────────────────────────
//   · The 168 lines on POs where NO line is linked. A stock purchase is not
//     raised for any order and has nothing to point at; per
//     docs/modules/document-traceability.md the column is procurement
//     PROVENANCE and binds no execution. Filling it would invent a dedication.
//   · Any code that does not pair 1:1. Reported with its candidates, never
//     written.
//   · HC-SO-012949's CODY-(S). It is on no purchase order at all, its
//     stock_status is PENDING, and no unlinked line anywhere carries it. That
//     is a GENUINE SHORT ORDER — a customer waiting on a frame nobody has been
//     asked to build — and it is a commercial act to fix, not a data repair.
//
// Every UPDATE re-asserts so_item_id IS NULL, so a link written by anyone
// between the plan and the write is left alone rather than overwritten.
//
// DRY-RUN by default; APPLY=1 writes. FIXDANGLING=1 also repairs HC-PO-000290.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const FIXDANGLING = process.env.FIXDANGLING === "1";
const CO = Number(process.env.COMPANY || 1);
const CAP = Number(process.env.CAP || 40);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const key = (code, d2) => `${norm(code)}|${norm(d2).slice(0, 140)}`;

async function pull() {
  const po = (await sql`
    SELECT i.id::text AS id, p.po_number AS doc, p.id::text AS hdr, i.item_code AS code,
           i.description2 AS d2, i.qty, i.item_group AS grp, i.so_item_id::text AS so_item_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group IN ('bedframe', 'sofa')
     ORDER BY p.po_number`).map((r) => ({ ...r }));
  const so = (await sql`
    SELECT i.id::text AS id, i.doc_no AS doc, i.line_no, i.item_code AS code, i.item_group AS grp,
           i.description2 AS d2, i.qty, i.cancelled
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
     WHERE i.company_id = ${CO} AND i.item_group IN ('bedframe', 'sofa')
     ORDER BY i.doc_no, i.line_no`).map((r) => ({ ...r }));
  return { po, so };
}

/* Exactly the rule diag-sofa-cutover-residue.mjs section D measured with, so
   the plan this prints and the number that diagnostic reports are the same
   thing rather than two similar things. */
function planLinks(po, so) {
  const linkedHdrs = new Set(po.filter((r) => r.so_item_id).map((r) => r.hdr));
  const claimed = new Set(po.filter((r) => r.so_item_id).map((r) => r.so_item_id));
  const byKey = new Map();
  for (const s of so) {
    if (!norm(s.d2)) continue;
    const k = key(s.code, s.d2);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  }
  const plan = [], ambiguous = [], noText = [], noCand = [], stock = [];
  for (const p of po) {
    if (p.so_item_id) continue;
    if (!linkedHdrs.has(p.hdr)) { stock.push(p); continue; }
    if (!norm(p.d2)) { noText.push(`      ${p.doc}  ${p.code} x${p.qty}: the PO line carries no AutoCount text to match on`); continue; }
    const cands = (byKey.get(key(p.code, p.d2)) ?? []).filter((s) => !claimed.has(s.id) && !s.cancelled);
    if (cands.length === 1) { plan.push({ p, s: cands[0] }); claimed.add(cands[0].id); continue; }
    if (cands.length > 1) { ambiguous.push(`      ${p.doc}  ${p.code} x${p.qty}: ${cands.length} unclaimed SO lines match on code AND text — ${cands.map((c) => `${c.doc} line ${c.line_no}`).join(", ")}. NOT written.`); continue; }
    noCand.push(`      ${p.doc}  ${p.code} x${p.qty}: no unclaimed sales-order line carries this code with this AutoCount text`);
  }
  return { plan, ambiguous, noText, noCand, stock };
}

const show = (arr, label) => {
  if (!arr.length) { log(`      ${label}: none`); return; }
  log(`      --- ${label} (${arr.length}; up to ${CAP}) ---`);
  for (const t of arr.slice(0, CAP)) log(t);
  if (arr.length > CAP) log(`      ... ${arr.length - CAP} more (raise CAP)`);
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO} fix-dangling=${FIXDANGLING ? "yes" : "no"}`);
  const { po, so } = await pull();
  const nullBefore = po.filter((r) => !r.so_item_id).length;
  log(`sofa/bedframe PO lines ${po.length} · so_item_id NULL ${nullBefore}`);

  const { plan, ambiguous, noText, noCand, stock } = planLinks(po, so);
  log("");
  log("── PLAN: NULL links recoverable from item code + AutoCount text");
  log(`    on a PO where NO line is linked — a stock purchase, LEFT ALONE   ${stock.length}`);
  log(`    on a part-linked PO, recoverable 1:1                             ${plan.length}`);
  log(`    on a part-linked PO, ambiguous — NOT written                     ${ambiguous.length}`);
  log(`    on a part-linked PO, no AutoCount text to match on               ${noText.length}`);
  log(`    on a part-linked PO, no unclaimed SO line carries it             ${noCand.length}`);
  for (const x of plan.slice(0, CAP)) log(`      ${x.p.doc}  ${x.p.code} x${x.p.qty}  ->  ${x.s.doc} line ${x.s.line_no} (${x.s.code}, same AutoCount text)`);
  if (plan.length > CAP) log(`      ... ${plan.length - CAP} more`);
  show(ambiguous, "ambiguous");
  show(noCand, "no candidate");
  show(noText, "no AutoCount text");

  // ── the single dangling FK ─────────────────────────────────────────────────
  log("");
  log("── THE DANGLING FK: a link that points somewhere WRONG, not nowhere");
  const soById = new Map(so.map((s) => [s.id, s]));
  const dangling = po.filter((r) => r.so_item_id && !soById.has(r.so_item_id));
  log(`    PO lines whose so_item_id is not a company-${CO} sofa/bedframe SO line: ${dangling.length}`);
  const danglingPlan = [];
  for (const p of dangling) {
    const [hit] = await sql`SELECT i.id::text AS id, i.doc_no, i.item_code, i.item_group, i.cancelled, i.line_no
                              FROM scm.mfg_sales_order_items i WHERE i.id = ${p.so_item_id}::uuid LIMIT 1`;
    if (!hit) { log(`      ${p.doc}  ${p.code}: target row is GONE. Proposal — NULL the link (honest) rather than invent one.`); danglingPlan.push({ p, to: null, why: "target row no longer exists" }); continue; }
    if (norm(hit.item_group) === norm(p.grp)) { log(`      ${p.doc}  ${p.code}: target ${hit.doc_no} line ${hit.line_no} is the same group — outside this audit's scope, not a defect. LEFT ALONE.`); continue; }
    /* Wrong GROUP is the defect: a bedframe PO line dedicated to a mattress
       sales-order line. The correct target, if it exists, is an unclaimed line
       on the SAME order carrying the SAME code. */
    const claimed = new Set(po.filter((r) => r.so_item_id && r.id !== p.id).map((r) => r.so_item_id));
    const cands = so.filter((s) => s.doc === hit.doc_no && norm(s.code) === norm(p.code) && !claimed.has(s.id) && !s.cancelled);
    log(`      ${p.doc}  ${p.code} x${p.qty}  -> ${hit.doc_no} line ${hit.line_no} ${hit.item_code} group=${hit.item_group}` +
        `  MIS-LINKED: the PO line is ${p.grp}, the target is ${hit.item_group}.`);
    if (cands.length === 1) { log(`         correct target found: ${cands[0].doc} line ${cands[0].line_no} ${cands[0].code}, unclaimed. Proposal — re-point.`); danglingPlan.push({ p, to: cands[0], why: `re-pointed from a ${hit.item_group} line to the unclaimed ${cands[0].code} on the same order` }); }
    else { log(`         ${cands.length} unclaimed ${p.code} line(s) on ${hit.doc_no} — the correct target cannot be identified with certainty. Proposal — NULL the link.`); danglingPlan.push({ p, to: null, why: `${cands.length} candidates, none certain` }); }
  }
  if (danglingPlan.length && !FIXDANGLING) log("    (set FIXDANGLING=1 to include these in an APPLY run; they are excluded by default)");

  if (!APPLY) {
    log("");
    log(`DRY-RUN — nothing was written. ${plan.length} link(s) and ${FIXDANGLING ? danglingPlan.length : 0} dangling repair(s) would be applied.`);
    await sql.end(); return;
  }

  const written = await sql.begin(async (tx) => {
    let n = 0, raced = 0;
    for (const x of plan) {
      const res = await tx`UPDATE scm.purchase_order_items SET so_item_id = ${x.s.id}::uuid
                            WHERE id = ${x.p.id}::uuid AND so_item_id IS NULL`;
      if (res.count) n += res.count; else raced++;
    }
    if (raced) log(`   ${raced} line(s) were already linked by someone else at write time — left alone.`);
    return n;
  });
  log("");
  log(`APPLIED: ${written} so_item_id link(s) stamped, in one transaction.`);

  let dWritten = 0;
  if (FIXDANGLING && danglingPlan.length) {
    dWritten = await sql.begin(async (tx) => {
      let n = 0;
      for (const d of danglingPlan) {
        const res = await tx`UPDATE scm.purchase_order_items SET so_item_id = ${d.to ? d.to.id : null}
                              WHERE id = ${d.p.id}::uuid AND so_item_id = ${d.p.so_item_id}::uuid`;
        n += res.count;
        log(`   ${d.p.doc} ${d.p.code}: ${d.to ? `-> ${d.to.doc} line ${d.to.line_no}` : "-> NULL"} (${d.why})`);
      }
      return n;
    });
    log(`APPLIED: ${dWritten} dangling link(s) corrected.`);
  }

  log("");
  log("── INDEPENDENT READ-BACK (a fresh SELECT — a log line is not evidence)");
  const after = await pull();
  const nullAfter = after.po.filter((r) => !r.so_item_id).length;
  const soAfter = new Map(after.so.map((s) => [s.id, s]));
  const dangAfter = after.po.filter((r) => r.so_item_id && !soAfter.has(r.so_item_id)).length;
  log(`   so_item_id NULL   ${nullBefore} -> ${nullAfter}   (expected drop ${written})`);
  log(`   dangling FK       ${dangling.length} -> ${dangAfter}`);
  for (const x of plan) {
    const [r] = await sql`SELECT so_item_id::text AS so_item_id FROM scm.purchase_order_items WHERE id = ${x.p.id}::uuid`;
    log(`   ${x.p.doc} ${x.p.code}: so_item_id is now ${r?.so_item_id ?? "NULL"} ${r?.so_item_id === x.s.id ? "= the planned target. CONFIRMED." : "!= the planned target."}`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
