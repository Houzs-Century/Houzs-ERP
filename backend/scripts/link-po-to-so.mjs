#!/usr/bin/env node
// Link an EXISTING purchase order to a sales order's lines by stamping
// purchase_order_items.so_item_id — the binding the sofa drop-ship guard requires
// (resolveExpectedBatchBySoItem). A PO raised outside "Convert from SO" leaves
// so_item_id NULL, so the SO's Incoming-PO column (which matches by item code) shows
// the PO while the guard, which needs so_item_id, still hard-blocks the DO.
//
// Matches PO line <-> SO line one-to-one by item_code, ONLY when the code is
// unambiguous on both sides (exactly one unlinked PO line and one still-unlinked SO
// line). Anything ambiguous is reported and skipped — never guessed. Idempotent
// (already-linked PO lines are left alone). APPLY=1 to write, DRY-RUN otherwise.
//
// PO_NUMBER=<po_number>  SO_DOC=<so doc no>
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const PO_NUMBER = (process.env.PO_NUMBER || "").trim();
const SO_DOC = (process.env.SO_DOC || "").trim();
if (!PO_NUMBER || !SO_DOC) { console.error("need PO_NUMBER and SO_DOC"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const sb = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  log(`=== Link PO ${PO_NUMBER} -> SO ${SO_DOC}  (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);

  const [po] = await sb`SELECT id, po_number, status FROM scm.purchase_orders WHERE po_number = ${PO_NUMBER}`;
  if (!po) { log(`PO ${PO_NUMBER} not found. Nothing to do.`); return; }
  log(`PO status: ${po.status}`);

  // PO lines use material_code for the item code (SO lines use item_code).
  const poLines = await sb`
    SELECT id, material_code AS item_code, qty, so_item_id
      FROM scm.purchase_order_items
     WHERE purchase_order_id = ${po.id}
     ORDER BY material_code`;
  const soLines = await sb`
    SELECT id, item_code, qty
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ${SO_DOC} AND cancelled = false
     ORDER BY item_code`;
  if (poLines.length === 0) { log("PO has no lines."); return; }
  if (soLines.length === 0) { log("SO has no active lines."); return; }

  // SO lines already pointed at by any PO line are unavailable (avoid double-link).
  const soIds = soLines.map((l) => l.id);
  const linked = await sb`
    SELECT DISTINCT so_item_id FROM scm.purchase_order_items
     WHERE so_item_id = ANY(${soIds})`;
  const takenSo = new Set(linked.map((r) => r.so_item_id));

  const byCode = (rows) => {
    const m = new Map();
    for (const r of rows) { const a = m.get(r.item_code) ?? []; a.push(r); m.set(r.item_code, a); }
    return m;
  };
  const poByCode = byCode(poLines.filter((l) => !l.so_item_id)); // only unlinked PO lines
  const soByCode = byCode(soLines.filter((l) => !takenSo.has(l.id))); // only free SO lines

  let willLink = 0, skipped = 0, already = poLines.filter((l) => l.so_item_id).length;
  const pairs = [];
  const codes = new Set([...poByCode.keys(), ...soByCode.keys()]);
  for (const code of codes) {
    const pos = poByCode.get(code) ?? [];
    const sos = soByCode.get(code) ?? [];
    if (pos.length === 1 && sos.length === 1) {
      pairs.push({ poLineId: pos[0].id, soLineId: sos[0].id, code });
      willLink++;
    } else if (pos.length > 0) {
      log(`  SKIP ${code}: ambiguous (unlinked PO lines ${pos.length}, free SO lines ${sos.length}) — link manually.`);
      skipped++;
    }
  }

  log("");
  log(`PO lines: ${poLines.length} (${already} already linked). To link now: ${willLink}. Ambiguous/skipped: ${skipped}.`);
  for (const p of pairs) log(`  ${p.code}: PO line ${p.poLineId} -> SO line ${p.soLineId}`);

  if (!APPLY) { log(""); log(`DRY-RUN — re-run APPLY=1 to write the ${willLink} link(s).`); return; }

  let done = 0;
  for (const p of pairs) {
    const res = await sb`UPDATE scm.purchase_order_items SET so_item_id = ${p.soLineId} WHERE id = ${p.poLineId} AND so_item_id IS NULL`;
    done += res.count;
  }
  log("");
  log(`APPLIED — linked ${done} PO line(s) to ${SO_DOC}. The DO drop-ship path should now offer.`);
}

main().then(() => sb.end()).catch(async (e) => {
  console.error("LINK_PO_SO_FAIL", e.message);
  try { await sb.end(); } catch {}
  process.exit(1);
});
