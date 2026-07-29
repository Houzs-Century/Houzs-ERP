#!/usr/bin/env node
// READ-ONLY diagnostic: for a Sales Order, report why its sofa lines can or cannot
// ship — the exact question the DO create guard answers. A sofa line hard-blocks
// with NO drop-ship option when it has neither an allocated batch NOR a single live
// bound PO. This mirrors resolveExpectedBatchBySoItem (dropship-batch.ts): a PO binds
// to an SO line via purchase_order_items.so_item_id, and only through "Convert from SO"
// (a hand-typed PO leaves so_item_id NULL). Dead POs (CANCELLED/DRAFT) do not count (H1);
// two+ live POs is the multi-PO ambiguity (H3).
//
// Owner rule: never ask him to run SQL — this is the check. Read-only, exit 0 for every
// legitimate answer. SO_DOC=<sales order doc no> (e.g. 2990-SO-2607-005).
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const SO_DOC = (process.env.SO_DOC || "").trim();
if (!SO_DOC) { console.error("need SO_DOC=<sales order doc no>"); process.exit(2); }
const sb = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const DEAD = new Set(["CANCELLED", "DRAFT"]);

async function main() {
  log(`=== Sofa drop-ship diagnostic for SO ${SO_DOC} ===`);

  // SO lines (allocated_batch_no is a later-migration column — read best-effort).
  let lines;
  try {
    lines = await sb`
      SELECT id, item_code, item_group, qty, allocated_batch_no
        FROM scm.mfg_sales_order_items
       WHERE doc_no = ${SO_DOC} AND cancelled = false
       ORDER BY item_group, item_code`;
  } catch {
    lines = await sb`
      SELECT id, item_code, item_group, qty, NULL::text AS allocated_batch_no
        FROM scm.mfg_sales_order_items
       WHERE doc_no = ${SO_DOC} AND cancelled = false
       ORDER BY item_group, item_code`;
  }
  if (lines.length === 0) { log(`No non-cancelled lines found for ${SO_DOC}. Check the doc no.`); return; }

  const ids = lines.map((l) => l.id);

  // PO links (so_item_id -> PO) + live/dead status, exactly like the guard.
  const poi = await sb`
    SELECT so_item_id, purchase_order_id
      FROM scm.purchase_order_items
     WHERE so_item_id = ANY(${ids}) AND purchase_order_id IS NOT NULL`;
  const poIds = [...new Set(poi.map((r) => r.purchase_order_id))];
  const pos = poIds.length
    ? await sb`SELECT id, po_number, status FROM scm.purchase_orders WHERE id = ANY(${poIds})`
    : [];
  const poById = new Map(pos.map((p) => [p.id, p]));
  const livePoNumbersByLine = new Map();
  const allBoundByLine = new Map(); // so_item_id -> [{po_number, status, dead}] incl. dead POs
  for (const r of poi) {
    const po = poById.get(r.purchase_order_id);
    if (!po) continue;
    const dead = DEAD.has(String(po.status ?? "").toUpperCase());
    const arr = allBoundByLine.get(r.so_item_id) ?? [];
    arr.push({ po_number: po.po_number, status: po.status, dead });
    allBoundByLine.set(r.so_item_id, arr);
    if (dead) continue; // H1 — dead POs do not count as live
    const set = livePoNumbersByLine.get(r.so_item_id) ?? new Set();
    if (po.po_number) set.add(po.po_number);
    livePoNumbersByLine.set(r.so_item_id, set);
  }

  let sofaNoPo = 0, sofaMultiPo = 0, sofaOnePo = 0, sofaHasBatch = 0;
  const isSofa = (g) => String(g ?? "").toLowerCase().includes("sofa");
  log("");
  for (const l of lines) {
    const live = [...(livePoNumbersByLine.get(l.id) ?? new Set())];
    const batch = l.allocated_batch_no;
    let verdict;
    if (batch) verdict = `HAS ALLOCATED BATCH ${batch} -> normal ship OK`;
    else if (live.length === 0) verdict = "NO live bound PO -> HARD BLOCK, no drop-ship. Fix: raise the PO via 'Convert from SO' (or backfill so_item_id).";
    else if (live.length === 1) verdict = `ONE live bound PO ${live[0]} -> drop-ship IS offerable.`;
    else verdict = `MULTIPLE live bound POs [${live.join(", ")}] -> H3 ambiguity, blocks until one is cancelled.`;
    const sofaTag = isSofa(l.item_group) ? "[SOFA] " : "";
    log(`  ${sofaTag}${l.item_code} (${l.item_group}, qty ${l.qty}): ${verdict}`);
    // Show the bound POs and their status so "I have a PO" reconciles with the verdict
    // (a DRAFT/CANCELLED bound PO is excluded by H1 — approving it makes drop-ship offer).
    const bound = allBoundByLine.get(l.id) ?? [];
    if (bound.length === 0) log(`        bound POs: none (so_item_id not linked to any PO line — the SO's Incoming-PO column may match by item code, which is NOT the drop-ship link).`);
    else for (const b of bound) log(`        bound PO ${b.po_number ?? "(no number)"}: status ${b.status}${b.dead ? " -> DEAD (excluded; approve/activate it out of DRAFT/CANCELLED)" : " -> live"}`);
    if (isSofa(l.item_group)) {
      if (batch) sofaHasBatch++;
      else if (live.length === 0) sofaNoPo++;
      else if (live.length === 1) sofaOnePo++;
      else sofaMultiPo++;
    }
  }
  log("");
  log(`SOFA lines — no-PO(hard block): ${sofaNoPo}, one-PO(dropship ok): ${sofaOnePo}, multi-PO(H3): ${sofaMultiPo}, has-batch(ok): ${sofaHasBatch}`);
  if (sofaNoPo > 0) log(`VERDICT: DATA issue. ${sofaNoPo} sofa line(s) have no LIVE bound PO. If a bound PO shows DRAFT/CANCELLED above, APPROVE/activate it (that alone makes drop-ship offer). If it shows 'bound POs: none', the PO is not linked to the SO line — re-raise via 'Convert from SO'.`);
  else if (sofaMultiPo > 0) log(`VERDICT: cancel the extra PO(s) on the multi-PO line(s), then drop-ship offers.`);
  else log(`VERDICT: no no-PO sofa lines — if it still hard-blocks, it is the genuine logic gap (stock on hand under an un-locked batch) that needs the operator-chosen-batch feature.`);
}

main().then(() => sb.end()).catch(async (e) => {
  console.error("SOFA_DIAG_FAIL", e.message);
  try { await sb.end(); } catch {}
  process.exit(1);
});
