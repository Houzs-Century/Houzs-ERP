#!/usr/bin/env node
// Repair the three things the cutover lost on the SAME purchase-order lines:
// the SO dedication, the delivery date, and the AutoCount line key.
//
// They are one repair because they are one row and one cause. The migrated PO
// lines were written by two importers:
//
//   import-ac-outstanding-po.mjs   INSERT column list carries no so_item_id at
//                                  all, and read the delivery date from
//                                  `l.DelivDate` — a key the re-cut export
//                                  (a5f51653, PR #1779) renamed to
//                                  `DeliveryDate`. 0 of 338 rows have the old
//                                  key; 338 of 338 have the new one. An
//                                  undefined field is not an error in
//                                  JavaScript, so every line imported with a
//                                  blank date and no dedication, silently.
//   import-ac-so-linked-pos.mjs    DOES dedicate — but skips a document whole
//                                  when it already exists ("PO docs in file:
//                                  366; already in ERP: 267"), so it never went
//                                  back for the documents the first importer
//                                  had already created. It also computes
//                                  `dtlKey: Number(l.DtlKey)` at three sites
//                                  and writes it nowhere.
//
// backfill-po-expected-at.mjs cannot rescue the header date either: it derives
// the header from the LINES, and the lines are the thing that is null.
//
// WHAT THIS WRITES, per line, only where the column is still NULL:
//   so_item_id         the ERP sales-order line named by PODTL.FromSODtlKey
//   delivery_date      PODTL.DeliveryDate
//   linked_ac_dtlkey   PODTL.DtlKey (bigint PRIMARY KEY, all 738 snapshot keys
//                      still resolve in the live book) so no future repair has
//                      to re-derive this link by fuzzy matching
// and then, per header, expected_at = the earliest of its own line dates —
// exactly the rule backfill-po-expected-at.mjs and the app's SO->PO convert use.
//
// NO STOCK MOVES. This is paperwork on rows that already exist.
//
// Idempotent: every UPDATE re-asserts that the column is still NULL, so a
// re-run plans nothing and a value a human has since set by hand is never
// overwritten. DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { acDeliveryDate, acDtlKey, acFromSoDtlKey, mergeAcPoLines } from "./lib/ac-po-line.mjs";
import { matchAcLinesToErpRows } from "./lib/ac-po-line-match.mjs";
import { makeSoLineTaker } from "./lib/so-line-dedication.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  /* ac-so-linked-pos first: it is the export cut FOR the PO<->SO link, so where
     the two files describe the same PODTL row its copy is the authoritative
     one. DtlKey de-duplicates them. */
  const acByKey = mergeAcPoLines(gz("ac-so-linked-pos.json.gz"), gz("ac-outstanding-po.json.gz"));
  const soSnap = gz("ac-outstanding-so.json.gz");
  const soByDtl = new Map(soSnap.map((r) => [String(r.DtlKey), { doc: r.DocNo, code: r.ItemCode }]));
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }
  log(`AutoCount PO lines in the snapshots: ${acByKey.size} (union by DtlKey); sales-order lines: ${soByDtl.size}`);

  const acByDoc = new Map();
  for (const l of acByKey.values()) {
    if (!acByDoc.has(l.DocNo)) acByDoc.set(l.DocNo, []);
    acByDoc.get(l.DocNo).push(l);
  }

  /* linked_ac_dtlkey arrives with the migration in this PR (and with #1819,
     which adds the SAME column for the write-back edit path — same name, same
     type, both idempotent). Probe rather than assume, so a run against a
     database that has not taken either one reports the gap instead of dying
     mid-plan. */
  const [{ has_dtlkey }] = await sql`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'scm' AND table_name = 'purchase_order_items'
         AND column_name = 'linked_ac_dtlkey') AS has_dtlkey`;
  if (!has_dtlkey) log("NOTE: scm.purchase_order_items.linked_ac_dtlkey does not exist on this database — the line key will be reported but not written.");

  const headers = await sql`SELECT id, po_number, linked_ac_docno, expected_at
    FROM scm.purchase_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL
    ORDER BY linked_ac_docno`;
  const rows = has_dtlkey
    ? await sql`SELECT i.id, i.purchase_order_id, i.material_code, i.supplier_sku, i.qty,
                       i.description2, i.delivery_date, i.so_item_id, i.item_group, i.linked_ac_dtlkey
                  FROM scm.purchase_order_items i
                  JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
                 WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`
    : await sql`SELECT i.id, i.purchase_order_id, i.material_code, i.supplier_sku, i.qty,
                       i.description2, i.delivery_date, i.so_item_id, i.item_group, NULL::bigint AS linked_ac_dtlkey
                  FROM scm.purchase_order_items i
                  JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
                 WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  const rowsByPo = new Map();
  for (const r of rows) {
    if (!rowsByPo.has(r.purchase_order_id)) rowsByPo.set(r.purchase_order_id, []);
    rowsByPo.get(r.purchase_order_id).push(r);
  }
  log(`migrated purchase orders: ${headers.length}; their lines: ${rows.length}`);
  log(`  lines missing so_item_id ${rows.filter((r) => !r.so_item_id).length}; missing delivery_date ${rows.filter((r) => !r.delivery_date).length}; missing linked_ac_dtlkey ${rows.filter((r) => r.linked_ac_dtlkey == null).length}`);
  log(`  headers missing expected_at: ${headers.filter((h) => !h.expected_at).length}`);

  /* A cancelled sales-order line is not a thing a purchase order can serve, so
     it is not offered — the repair may only refuse a link, never invent one. */
  const soItems = await sql`SELECT i.id, i.item_code, i.line_no, h.linked_ac_docno AS ac
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
   WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND i.cancelled = false
   ORDER BY i.line_no`;
  const taken = new Set(
    (await sql`SELECT DISTINCT so_item_id FROM scm.purchase_order_items WHERE so_item_id IS NOT NULL`)
      .map((r) => r.so_item_id),
  );
  const taker = makeSoLineTaker(soItems, taken);
  log(`ERP sales-order lines on migrated orders: ${soItems.length}; already claimed by some PO line: ${taken.size}`);

  const plan = [];            // { id, poNo, soItemId?, deliveryDate?, dtlKey? }
  const unresolved = [];      // { poNo, code, reason }
  const refusals = [];
  const noAcDoc = [];
  let sole = 0, split = 0, indistinguishable = 0, unmatchedErp = 0, unmatchedAc = 0;

  for (const h of headers) {
    const erpRows = rowsByPo.get(h.id) ?? [];
    if (!erpRows.length) continue;
    const acLines = acByDoc.get(h.linked_ac_docno) ?? [];
    if (!acLines.length) {
      noAcDoc.push(`${h.po_number} (AutoCount ${h.linked_ac_docno}, ${erpRows.length} line(s))`);
      /* Every unrepaired line gets a reason, including these: the document was
         imported by a round whose export is not one of the two committed here,
         so this repair has nothing to read for it. */
      for (const r of erpRows) {
        if (r.so_item_id && r.delivery_date && r.linked_ac_dtlkey != null) continue;
        unresolved.push({ poNo: h.po_number, code: r.material_code, reason: `AutoCount document ${h.linked_ac_docno} is not in either committed PO export, so there is nothing to read for this line` });
      }
      continue;
    }

    const shaped = acLines.map((l) => ({
      key: acDtlKey(l), itemCode: l.ItemCode, qty: Number(l.Qty) || 0, desc2: l.Desc2,
      erpCodes: [byAc.get(norm(l.ItemCode))].filter(Boolean), raw: l,
    })).filter((l) => l.key !== null);

    const m = matchAcLinesToErpRows(shaped, erpRows);
    unmatchedErp += m.unmatchedErp.length;
    unmatchedAc += m.unmatchedAc.length;
    for (const r of m.refused) refusals.push({ poNo: h.po_number, ...r });
    for (const r of m.unmatchedErp) unresolved.push({ poNo: h.po_number, code: r.material_code, reason: `no AutoCount line on ${h.linked_ac_docno} owns supplier_sku "${r.supplier_sku ?? "-"}"` });

    /* Deterministic order so a re-run hands the same SO lines to the same PO
       lines: AutoCount DtlKey ascending, then ERP row id. */
    const pairs = m.pairs.slice().sort((a, b) =>
      Number(a.ac.key) - Number(b.ac.key) || String(a.row.id).localeCompare(String(b.row.id)));

    for (const { row, ac, how } of pairs) {
      if (how === "sole") sole++; else if (how === "split") split++; else indistinguishable++;
      const upd = { id: row.id, poNo: h.po_number };
      let want = false;

      if (!row.delivery_date) {
        const d = acDeliveryDate(ac.raw);
        if (d) { upd.deliveryDate = d; want = true; }
        else unresolved.push({ poNo: h.po_number, code: row.material_code, reason: `AutoCount line ${ac.key} carries no delivery date` });
      }
      /* Planned even when the column is not there yet, so the DRY-RUN still
         REPORTS how many lines it would key. The writer is what skips it. */
      if (row.linked_ac_dtlkey == null) { upd.dtlKey = ac.key; want = has_dtlkey || want; }

      if (!row.so_item_id) {
        const fromKey = acFromSoDtlKey(ac.raw);
        const src = fromKey ? soByDtl.get(fromKey) : null;
        if (!fromKey) {
          unresolved.push({ poNo: h.po_number, code: row.material_code, reason: "AutoCount line has no FromSODtlKey — this PO was not raised from a sales order" });
        } else if (!src) {
          unresolved.push({ poNo: h.po_number, code: row.material_code, reason: `FromSODtlKey ${fromKey} names a sales-order line that is not in the cutover snapshot (its order was fully delivered and correctly never imported)` });
        } else {
          /* Most specific first: the ERP row's OWN code, which for a sofa is
             already the compartment. Then the sales order's own item, which is
             what the SO-linked importer uses for a plain line. Then the sofa
             placeholder the import falls back to when a build could not be
             decoded — same derivation, so the link lands on the same line the
             importer would have chosen. */
          const base = byAc.get(norm(src.code)) || "";
          const poBase = byAc.get(norm(ac.itemCode)) || "";
          let model = poBase.replace(/-1S$/i, "");
          model = SOFA_MODEL_ALIAS[model] || model;
          const attempts = [row.material_code, base, model ? `${model}-1S` : null].filter(Boolean);
          let picked = null;
          for (const code of attempts) { picked = taker.take(src.doc, code); if (picked) break; }
          if (picked) { upd.soItemId = picked; want = true; }
          else unresolved.push({ poNo: h.po_number, code: row.material_code, reason: `${taker.explain(src.doc, row.material_code)} (AutoCount SO ${src.doc}, tried ${attempts.join(" / ")})` });
        }
      }
      if (want) plan.push(upd);
    }
  }

  const nSo = plan.filter((p) => p.soItemId).length;
  const nDate = plan.filter((p) => p.deliveryDate).length;
  const nKey = plan.filter((p) => p.dtlKey != null).length;
  log("");
  log(`matched ERP line -> AutoCount line: sole ${sole}; split by (qty, Desc2) ${split}; indistinguishable, zipped in DtlKey order ${indistinguishable}`);
  log(`unmatched: ERP rows ${unmatchedErp}; AutoCount lines with no ERP row ${unmatchedAc}; POs with no AutoCount document in the snapshots ${noAcDoc.length}`);
  for (const p of noAcDoc.slice(0, 20)) log(`   ${p}`);
  log("");
  log(`PLAN: ${plan.length} line(s) to update — so_item_id ${nSo}; delivery_date ${nDate}; linked_ac_dtlkey ${nKey}${has_dtlkey ? "" : " (COLUMN ABSENT — counted, not written)"}`);
  const groupOf = new Map(rows.map((r) => [r.id, r.item_group ?? "?"]));
  const byGroup = new Map();
  for (const p of plan) { if (!p.soItemId) continue; const g = groupOf.get(p.id) ?? "?"; byGroup.set(g, (byGroup.get(g) ?? 0) + 1); }
  log(`       new dedications by item group: ${[...byGroup.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join("; ") || "none"}`);

  // Header date: earliest of the line dates this repair would leave in place.
  const dateByLine = new Map(plan.filter((p) => p.deliveryDate).map((p) => [p.id, p.deliveryDate]));
  const headerFill = [];
  for (const h of headers) {
    if (h.expected_at) continue;
    const dates = (rowsByPo.get(h.id) ?? [])
      .map((r) => (r.delivery_date ? String(r.delivery_date).slice(0, 10) : dateByLine.get(r.id)))
      .filter(Boolean).sort();
    if (dates.length) headerFill.push({ id: h.id, poNo: h.po_number, eta: dates[0] });
  }
  log(`       ${headerFill.length} header(s) to give an expected_at (earliest of their own line dates)`);
  for (const f of headerFill.slice(0, 10)) log(`   ${f.poNo} -> ${f.eta}`);
  if (headerFill.length > 10) log(`   ... and ${headerFill.length - 10} more`);

  if (refusals.length) {
    log("");
    log(`REFUSED — the AutoCount lines and the ERP rows do not split the same way, so which is which is not recorded: ${refusals.length} group(s)`);
    for (const r of refusals) log(`   ${r.poNo} "${r.code}": ${r.acLines} AutoCount line(s) vs ${r.erpRows} ERP row(s) — ${r.reason}`);
  }

  if (unresolved.length) {
    const byReason = new Map();
    for (const u of unresolved) {
      const k = u.reason.replace(/\d{3,}/g, "N").replace(/(SO|PO)-\d+/g, "$1-N");
      byReason.set(k, (byReason.get(k) ?? 0) + 1);
    }
    log("");
    log(`NOT REPAIRED — every line, with its reason: ${unresolved.length}`);
    for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) log(`   ${n} x  ${reason}`);
    log("");
    for (const u of unresolved) log(`   ${u.poNo}  ${u.code ?? "-"}  ${u.reason}`);
  }

  if (!APPLY) {
    log("");
    log("DRY-RUN — nothing was written. Re-run with apply=1. Every UPDATE re-asserts the column is still NULL, so this is safe to repeat.");
    await sql.end();
    return;
  }

  let lines = 0, hdrs = 0;
  for (let i = 0; i < plan.length; i += 200) {
    const batch = plan.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const p of batch) {
        if (p.soItemId) lines += (await tx`UPDATE scm.purchase_order_items SET so_item_id = ${p.soItemId}
          WHERE id = ${p.id} AND so_item_id IS NULL`).count;
        if (p.deliveryDate) await tx`UPDATE scm.purchase_order_items SET delivery_date = ${p.deliveryDate}
          WHERE id = ${p.id} AND delivery_date IS NULL`;
        if (has_dtlkey && p.dtlKey != null) await tx`UPDATE scm.purchase_order_items SET linked_ac_dtlkey = ${p.dtlKey}
          WHERE id = ${p.id} AND linked_ac_dtlkey IS NULL`;
      }
    });
    log(`  ..${Math.min(i + 200, plan.length)}/${plan.length}`);
  }
  for (const f of headerFill) {
    hdrs += (await sql`UPDATE scm.purchase_orders SET expected_at = ${f.eta}
      WHERE id = ${f.id} AND expected_at IS NULL`).count;
  }
  log(`DONE. lines updated ${plan.length} (of which dedications actually stamped ${lines}); headers given a date ${hdrs}`);
  log("no inventory movements written — this repair is paperwork on rows that already exist.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
