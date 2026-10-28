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
//                      to re-derive this link by fuzzy matching. The COLUMN is
//                      #1819's migration 0273 — this fills it.
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
import { acDeliveryDate, acDtlKey, acFromSoDtlKey, isoDate, mergeAcPoLines } from "./lib/ac-po-line.mjs";
import { matchAcLinesToErpRows } from "./lib/ac-po-line-match.mjs";
import { dedicationCandidates, makeSoLineTaker } from "./lib/so-line-dedication.mjs";
import { codeMatchGapReason, compareStoredKey, isCompartmentSku } from "./lib/ac-line-key-audit.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
/* APPLY=1 alone used to be the whole gate on a script that writes four columns
   across two production tables. One environment variable is the same keystroke
   whether it is meant or mistyped, so the apply path now also needs the phrase
   spelled out — the shape every other gated repair in this directory uses. */
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
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
  const acSoLinked = gz("ac-so-linked-pos.json.gz");
  const acOutstanding = gz("ac-outstanding-po.json.gz");
  const acByKey = mergeAcPoLines(acSoLinked, acOutstanding);
  const soSnap = gz("ac-outstanding-so.json.gz");
  const soByDtl = new Map(soSnap.map((r) => [String(r.DtlKey), { doc: r.DocNo, code: r.ItemCode }]));
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }
  log(`AutoCount PO lines in the snapshots: ${acByKey.size} (union by DtlKey); sales-order lines: ${soByDtl.size}`);

  /* The OTHER rule's index, rebuilt here exactly as backfill-ac-line-keys.mjs
     builds it — same single file (it never opens ac-so-linked-pos.json.gz),
     same mapping CSV, same `${DocNo}|${ERP code}` key. Rebuilt rather than
     imported because that script's index is a local inside its main(); the
     point is that this census's "no AC match" is the SAME 589 that script
     reported on production, not a re-scoped near-miss. */
  const codeMatchIndex = new Set();
  const docsInOutstanding = new Set();
  for (const r of acOutstanding) {
    docsInOutstanding.add(r.DocNo);
    const erp = byAc.get(norm(r.ItemCode));
    if (erp) codeMatchIndex.add(`${r.DocNo}|${norm(erp)}`);
  }
  const docsInSoLinked = new Set(acSoLinked.map((r) => r.DocNo));

  const acByDoc = new Map();
  for (const l of acByKey.values()) {
    if (!acByDoc.has(l.DocNo)) acByDoc.set(l.DocNo, []);
    acByDoc.get(l.DocNo).push(l);
  }

  /* linked_ac_dtlkey is #1819's migration 0273, added for the write-back's edit
     path; this repair fills it rather than adding a second column of its own.
     Probe rather than assume, so a run against a database that has not taken
     0273 yet reports the gap instead of dying mid-plan. */
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
    ? await sql`SELECT i.id, i.purchase_order_id, i.item_code, i.supplier_sku, i.qty,
                       i.description2, i.delivery_date, i.so_item_id, i.item_group, i.linked_ac_dtlkey
                  FROM scm.purchase_order_items i
                  JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
                 WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`
    : await sql`SELECT i.id, i.purchase_order_id, i.item_code, i.supplier_sku, i.qty,
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
     it is not offered — the repair may only refuse a link, never invent one.
     COALESCE, not `= false`: the column is nullable and this repo reads it as
     nullable everywhere it matters, check-po-so-links.mjs — the checker for
     THIS link — included. A bare `= false` is NULL for a NULL row, so the row
     drops out of the taker pool; that both under-repairs and, because the pool
     is claim-once, can hand a DIFFERENT line to the PO row that follows. */
  const soItems = await sql`SELECT i.id, i.item_code, i.line_no, h.linked_ac_docno AS ac
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
   WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
     AND COALESCE(i.cancelled, false) = false
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
  const crossProduct = [];    // dedications refused because the SO line is another product
  const noAcDoc = [];
  /* Which AutoCount line this repair believes each ERP row descends from, kept
     for the whole run so the two audits below can speak about rows the plan
     never touches — including the ones already keyed by the other rule. */
  const acByRowId = new Map();
  let sole = 0, split = 0, indistinguishable = 0, unmatchedErp = 0, unmatchedAc = 0, wouldKey = 0;

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
        unresolved.push({ poNo: h.po_number, code: r.item_code, reason: `AutoCount document ${h.linked_ac_docno} is not in either committed PO export, so there is nothing to read for this line` });
      }
      continue;
    }

    /* fromSoKey and deliveryDate ride along because they are what this repair
       WRITES off the AutoCount line, and the matcher must refuse to zip two
       otherwise-identical lines that disagree on them. */
    const shaped = acLines.map((l) => ({
      key: acDtlKey(l), itemCode: l.ItemCode, qty: Number(l.Qty) || 0, desc2: l.Desc2,
      erpCodes: [byAc.get(norm(l.ItemCode))].filter(Boolean),
      fromSoKey: acFromSoDtlKey(l), deliveryDate: acDeliveryDate(l), raw: l,
    })).filter((l) => l.key !== null);

    const m = matchAcLinesToErpRows(shaped, erpRows);
    unmatchedErp += m.unmatchedErp.length;
    unmatchedAc += m.unmatchedAc.length;
    /* A refused group's rows are not in m.pairs, so they would otherwise fall
       out of the per-line reason list silently. Every unrepaired line gets a
       reason — that is the promise this report makes. */
    const rowById = new Map(erpRows.map((r) => [r.id, r]));
    for (const r of m.refused) {
      refusals.push({ poNo: h.po_number, ...r });
      for (const id of r.rowIds ?? []) {
        const row = rowById.get(id);
        if (row && row.so_item_id && row.delivery_date && row.linked_ac_dtlkey != null) continue;
        unresolved.push({ poNo: h.po_number, code: row?.item_code, reason: `REFUSED group "${r.code}": ${r.reason}` });
      }
    }
    for (const r of m.unmatchedErp) unresolved.push({ poNo: h.po_number, code: r.item_code, reason: `no AutoCount line on ${h.linked_ac_docno} owns supplier_sku "${r.supplier_sku ?? "-"}"` });

    /* Deterministic order so a re-run hands the same SO lines to the same PO
       lines: AutoCount DtlKey ascending, then ERP row id. */
    const pairs = m.pairs.slice().sort((a, b) =>
      Number(a.ac.key) - Number(b.ac.key) || Number(a.row.id) - Number(b.row.id) ||
      String(a.row.id).localeCompare(String(b.row.id)));

    for (const { row, ac, how } of pairs) {
      if (how === "sole") sole++; else if (how === "split") split++; else indistinguishable++;
      acByRowId.set(row.id, { ac, how });
      /* Carries the evidence, not just the values: the DRY-RUN prints one line
         per planned write so a human can check any single one against
         AutoCount before the write happens. */
      const upd = { id: row.id, poNo: h.po_number, code: row.item_code, acKey: ac.key, how };
      let want = false;

      if (!row.delivery_date) {
        const d = acDeliveryDate(ac.raw);
        if (d) { upd.deliveryDate = d; want = true; }
        else unresolved.push({ poNo: h.po_number, code: row.item_code, reason: `AutoCount line ${ac.key} carries no delivery date` });
      }
      /* Counted even when the column is not applied yet, so the DRY-RUN reports
         the true number it would key rather than only the lines it happens to
         be touching for another reason. */
      if (row.linked_ac_dtlkey == null) { wouldKey++; upd.dtlKey = ac.key; want = has_dtlkey || want; }

      if (!row.so_item_id) {
        const fromKey = acFromSoDtlKey(ac.raw);
        const src = fromKey ? soByDtl.get(fromKey) : null;
        if (!fromKey) {
          unresolved.push({ poNo: h.po_number, code: row.item_code, reason: "AutoCount line has no FromSODtlKey — this PO was not raised from a sales order" });
        } else if (!src) {
          unresolved.push({ poNo: h.po_number, code: row.item_code, reason: `FromSODtlKey ${fromKey} names a sales-order line that is not in the cutover snapshot (its order was fully delivered and correctly never imported)` });
        } else {
          /* Which codes this row may claim, and whether the SO line names a
             different product, is dedicationCandidates() in the shared lib —
             one implementation, guarded by tests that fail without the
             cross-product refusal. `base` is the SO line's ERP code; the
             placeholder is derived from THIS PO line's own AutoCount item, so
             it is the same product by construction. */
          const base = byAc.get(norm(src.code)) || "";
          const poBase = byAc.get(norm(ac.itemCode)) || "";
          let model = poBase.replace(/-1S$/i, "");
          model = SOFA_MODEL_ALIAS[model] || model;
          const { attempts, crossProduct: isCrossProduct } =
            dedicationCandidates(row.item_code, base, model ? `${model}-1S` : null);
          let picked = null;
          for (const code of attempts) { picked = taker.take(src.doc, code); if (picked) break; }
          if (picked) { upd.soItemId = picked; upd.soDoc = src.doc; upd.fromKey = fromKey; want = true; }
          else if (isCrossProduct) {
            /* The only reason left is the one this rule created, so name it
               rather than hiding it behind the taker's generic explanation. */
            crossProduct.push({ poNo: h.po_number, code: row.item_code, base, soDoc: src.doc, acCode: src.code, fromKey });
            unresolved.push({ poNo: h.po_number, code: row.item_code, reason: `REFUSED cross-product dedication: AutoCount SO ${src.doc} line "${src.code}" maps to ERP code ${base}, which is a DIFFERENT product from this PO line's ${row.item_code} (tried ${attempts.join(" / ")})` });
          }
          else unresolved.push({ poNo: h.po_number, code: row.item_code, reason: `${taker.explain(src.doc, row.item_code)} (AutoCount SO ${src.doc}, tried ${attempts.join(" / ")})` });
        }
      }
      if (want) plan.push(upd);
    }
  }

  const nSo = plan.filter((p) => p.soItemId).length;
  const nDate = plan.filter((p) => p.deliveryDate).length;
  const nKey = has_dtlkey ? plan.filter((p) => p.dtlKey != null).length : wouldKey;
  log("");
  log(`matched ERP line -> AutoCount line: sole ${sole}; split by (qty, Desc2) ${split}; indistinguishable, zipped in DtlKey order ${indistinguishable}`);
  log(`unmatched: ERP rows ${unmatchedErp}; AutoCount lines with no ERP row ${unmatchedAc}; POs with no AutoCount document in the snapshots ${noAcDoc.length}`);
  for (const p of noAcDoc) log(`   ${p}`);
  log("");
  log(`PLAN: ${plan.length} line(s) to update — so_item_id ${nSo}; delivery_date ${nDate}; linked_ac_dtlkey ${nKey}${has_dtlkey ? "" : " (COLUMN ABSENT — this is what it WOULD key once the migration is applied, and it is why those lines are not in the plan count above)"}`);
  const groupOf = new Map(rows.map((r) => [r.id, r.item_group ?? "?"]));
  const byGroup = new Map();
  for (const p of plan) { if (!p.soItemId) continue; const g = groupOf.get(p.id) ?? "?"; byGroup.set(g, (byGroup.get(g) ?? 0) + 1); }
  log(`       new dedications by item group: ${[...byGroup.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join("; ") || "none"}`);

  /* EVERY planned write, one line each. A summary count cannot be checked by a
     human: to approve the risky half of this repair the owner has to see the PO
     number, the material code, the AutoCount line it read, and the exact values
     it would put in the row — not "so_item_id 99". Nothing is truncated. */
  log("");
  log(`PLANNED WRITES — one line per row, nothing truncated (${plan.length}):`);
  log("   po / item_code / AC DtlKey / match / -> so_item_id (AC SO, FromSODtlKey) / date / dtlkey");
  for (const p of plan) {
    const bits = [];
    if (p.soItemId) bits.push(`so_item_id=${p.soItemId} (from AC SO ${p.soDoc}, FromSODtlKey ${p.fromKey})`);
    if (p.deliveryDate) bits.push(`delivery_date=${p.deliveryDate}`);
    if (p.dtlKey != null) bits.push(`linked_ac_dtlkey=${p.dtlKey}${has_dtlkey ? "" : " (column absent — NOT written)"}`);
    log(`   ${p.poNo}  ${p.code ?? "-"}  AC:${p.acKey}  [${p.how}]  ${bits.join("; ")}`);
  }

  /* Header date: earliest of the line dates this repair would leave in place.
     A `date` column comes back from postgres as a JS Date, whose String() is
     "Wed Mar 25 2003 ..." - slicing that to 10 characters yields "Wed Mar 25",
     which sorts wrong and is not a date any column would accept. */
  const dateByLine = new Map(plan.filter((p) => p.deliveryDate).map((p) => [p.id, p.deliveryDate]));
  const headerFill = [];
  for (const h of headers) {
    if (h.expected_at) continue;
    const dates = (rowsByPo.get(h.id) ?? [])
      .map((r) => isoDate(r.delivery_date) ?? dateByLine.get(r.id))
      .filter(Boolean).sort();
    if (dates.length) headerFill.push({ id: h.id, poNo: h.po_number, eta: dates[0] });
  }
  /* All of them, not the first ten. Some of these dates are pre-cutover and
     land on screen as permanently overdue (HC-PO-000136 -> 2003-03-25), which
     is faithful to AutoCount but is a decision the owner has to be able to
     make — and he cannot make it on a truncated list. Flagged, not filtered. */
  const today = new Date().toISOString().slice(0, 10);
  const stale = headerFill.filter((f) => f.eta < today);
  log(`       ${headerFill.length} header(s) to give an expected_at (earliest of their own line dates); ${stale.length} of them are in the PAST and will read as overdue`);
  for (const f of headerFill) log(`   ${f.poNo} -> ${f.eta}${f.eta < today ? "   <<< already past" : ""}`);

  if (refusals.length) {
    log("");
    log(`REFUSED groups — nothing is written for any row below: ${refusals.length}`);
    for (const r of refusals) {
      log(`   ${r.poNo} "${r.code}": ${r.acLines} AutoCount line(s) vs ${r.erpRows} ERP row(s) — ${r.reason}`);
      for (const c of r.candidates ?? []) log(`      candidate DtlKey ${c.key}: FromSODtlKey ${c.fromSoKey ?? "-"}, DeliveryDate ${c.deliveryDate ?? "-"}`);
      if (r.rowIds?.length) log(`      ERP rows left untouched: ${r.rowIds.join(", ")}`);
    }
  }

  if (crossProduct.length) {
    log("");
    log(`REFUSED cross-product dedications — the sales-order line names a DIFFERENT product than the PO line, so no link was written: ${crossProduct.length}`);
    log("   Each of these would need the owner's approval before any link is made.");
    for (const c of crossProduct) log(`   ${c.poNo}  PO line ${c.code}  <-  ${c.soDoc} line "${c.acCode}" (ERP ${c.base}), FromSODtlKey ${c.fromKey}`);
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

  /* po_qty_picked is NOT recomputed here, and that is a real gap, named so it
     is not discovered later. The app keeps it as a live count: recomputeSoPicked
     (backend/src/scm/routes/mfg-purchase-orders.ts) re-sums
     purchase_order_items.qty per so_item_id, and it only ever runs from a route
     handler. A dedication stamped by this script therefore does not move the
     counter, so these SO lines keep reading as still-needing-ordering in the
     From-SO picker (qty - picked > 0) — a duplicate-PO risk until something
     touches them. backfill-po-so-item-links.mjs has the same gap, so this is
     precedent rather than a regression. Every affected line is listed. */
  const dedicated = [...new Set(plan.filter((p) => p.soItemId).map((p) => p.soItemId))];
  if (dedicated.length) {
    log("");
    log(`po_qty_picked NOT RECOMPUTED for the ${dedicated.length} sales-order line(s) this would newly dedicate:`);
    for (const p of plan.filter((x) => x.soItemId)) log(`   ${p.soItemId}  <- ${p.poNo} ${p.code ?? "-"} (AC SO ${p.soDoc})`);
  }

  /* ------------------------------------------------------------------ *
     AUDIT 1 — the keys this repair is FORBIDDEN to touch.

     On 2026-08-10 backfill-ac-line-keys.mjs wrote 275 purchase-order line keys
     against production by the (DocNo, ERP code) rule. The IS NULL guard means
     this repair skips every one of them, which is correct — it must not
     overwrite a value it did not write — but silence about them would be a
     choice to not look. A stored key that disagrees with the derived one is a
     live wrong value: AcSyncService dereferences it on the edit path and a
     wrong DtlKey makes it APPEND a line to the account book rather than edit
     the operator's. So: compare, never write, and print every disagreement.
   * ------------------------------------------------------------------ */
  const docNoByPoId = new Map(headers.map((h) => [h.id, h.linked_ac_docno]));
  const poNoByPoId = new Map(headers.map((h) => [h.id, h.po_number]));
  const already = rows.filter((r) => r.linked_ac_dtlkey != null);
  const keyVerdicts = { agree: 0, disagree: 0, underived: 0, absent: 0 };
  const disagreements = [];
  for (const r of already) {
    const hit = acByRowId.get(r.id);
    const v = compareStoredKey(r.linked_ac_dtlkey, hit?.ac?.key ?? null);
    keyVerdicts[v]++;
    if (v === "disagree") {
      disagreements.push({
        poNo: poNoByPoId.get(r.purchase_order_id), code: r.item_code, id: r.id,
        stored: r.linked_ac_dtlkey, derived: hit.ac.key, how: hit.how,
        /* The evidence, inline. "split" means the ERP row's OWN (qty, Desc2) —
           copied verbatim by the import — partitioned this document's lines
           1:1, so the derived key is determined by the row's content rather
           than by an ordering. That is the difference that makes a
           disagreement actionable instead of a matter of opinion: the other
           rule had no such evidence, because it selected line_no as
           `NULL::int` and zipped in whatever order postgres returned. */
        desc2: (r.description2 ?? "").trim(),
        acDesc2: (hit.ac.desc2 ?? "").trim(),
        fromSoKey: hit.ac.fromSoKey ?? null,
      });
    }
  }
  log("");
  log(`ALREADY-KEYED LINES — written by backfill-ac-line-keys.mjs on 2026-08-10 (prod run 31416597720, APPLY). This repair NEVER overwrites them; it only checks them: ${already.length}`);
  log(`   agree with the key this repair derives: ${keyVerdicts.agree}; DISAGREE: ${keyVerdicts.disagree}; this repair derives no key for them (cannot check): ${keyVerdicts.underived}`);
  if (disagreements.length) {
    log("   EVERY DISAGREEMENT — each is a stored DtlKey this repair believes names a DIFFERENT AutoCount line.");
    log("   Nothing here is written or reverted by this script. A wrong key makes AcSyncService APPEND instead of edit, so each needs an owner ruling.");
    log("   match=split means the ERP row's own (qty, Desc2) — copied verbatim by the import — picked the derived line 1:1, so it is evidence, not an ordering.");
    for (const d of disagreements) {
      log(`   ${d.poNo}  ${d.code ?? "-"}  row ${d.id}: stored ${d.stored} vs derived ${d.derived}  [match=${d.how}]`);
      log(`         ERP row Desc2 "${d.desc2}"  ==  AutoCount ${d.derived} Desc2 "${d.acDesc2}"  (FromSODtlKey ${d.fromSoKey ?? "-"})`);
    }
  } else if (already.length) {
    log("   No disagreement. Where both rules reach a line they name the same AutoCount row.");
  }

  /* ------------------------------------------------------------------ *
     AUDIT 2 — the composition of the lines the code match could not reach.

     That run's "no AC match 589" is a count, and a count cannot be acted on.
     Each of those lines is classified here against the same two files and the
     same CSV that script reads, so the numbers are comparable, and cross-cut
     by item_group because the standing hypothesis is about sofas.
   * ------------------------------------------------------------------ */
  const gapRows = [];
  for (const r of rows) {
    const doc = docNoByPoId.get(r.purchase_order_id);
    const codeMatched = codeMatchIndex.has(`${doc}|${norm(r.item_code)}`);
    const ac = acByRowId.get(r.id)?.ac ?? null;
    const reason = codeMatchGapReason({
      codeMatched,
      docInOutstandingPo: docsInOutstanding.has(doc),
      docInSoLinkedPos: docsInSoLinked.has(doc),
      skuBeyondItemCode: ac ? isCompartmentSku(r.supplier_sku, ac.itemCode) : false,
      acItemMapped: ac ? Boolean(byAc.get(norm(ac.itemCode))) : false,
    });
    if (reason) {
      gapRows.push({
        r, reason, reachable: Boolean(ac),
        /* Measured independently of which reason won. codeMatchGapReason()
           returns the FIRST cause that applies, and the document-level ones are
           checked first on purpose — a line on a document the script never
           opens fails whatever its item code is. That ordering makes the
           "compartment" tally in the reason list a LOWER BOUND, not the answer
           to "how many of these are decomposed sofa compartments". This flag is
           the answer: it asks the question of every row, whatever reason was
           reported for it. `null` where the row cannot be reached at all, which
           is not the same as false and must not be counted as one. */
        compartment: ac ? isCompartmentSku(r.supplier_sku, ac.itemCode) : null,
      });
    }
  }
  const gapByReason = new Map();
  const gapByGroup = new Map();
  for (const g of gapRows) {
    gapByReason.set(g.reason, (gapByReason.get(g.reason) ?? 0) + 1);
    const k = g.r.item_group ?? "(none)";
    if (!gapByGroup.has(k)) gapByGroup.set(k, { total: 0, reachable: 0, compartment: 0 });
    const e = gapByGroup.get(k);
    e.total++; if (g.reachable) e.reachable++; if (g.compartment === true) e.compartment++;
  }
  const reachable = gapRows.filter((g) => g.reachable).length;
  const isComp = gapRows.filter((g) => g.compartment === true).length;
  const notComp = gapRows.filter((g) => g.compartment === false).length;
  const unknownComp = gapRows.filter((g) => g.compartment === null).length;
  log("");
  log(`THE LINES THE (DocNo, ERP code) MATCH COULD NOT REACH — its "no AC match" count, re-derived here: ${gapRows.length}`);
  log("   by reason (FIRST cause that applies; the document-level ones are tested first, because a line on a document the script never opens fails whatever its item code is):");
  for (const [reason, n] of [...gapByReason.entries()].sort((a, b) => b[1] - a[1])) log(`      ${n} x  ${reason}`);
  log("   by item_group (reachable = this repair DOES find the AutoCount line for it):");
  for (const [g, e] of [...gapByGroup.entries()].sort((a, b) => b[1].total - a[1].total)) {
    log(`      ${g}: ${e.total} line(s), of which this repair reaches ${e.reachable}, and ${e.compartment} are decomposed compartments`);
  }
  /* The standing hypothesis was that this gap IS the decomposed sofa
     compartments. Asked of every row rather than only the ones no earlier cause
     already claimed, so the answer is a measurement and not an artefact of the
     order the reasons are tested in. */
  log(`   DECOMPOSED COMPARTMENT? asked of every row, independent of the reason above:`);
  log(`      yes ${isComp}; no ${notComp}; unanswerable because this repair cannot reach the AutoCount line either ${unknownComp}`);
  log(`   TOTAL this repair reaches that the code match cannot: ${reachable} of ${gapRows.length}`);

  if (!APPLY) {
    log("");
    log("DRY-RUN — nothing was written. Re-run with apply=1. Every UPDATE re-asserts the column is still NULL, so this is safe to repeat.");
    await sql.end();
    return;
  }

  /* Three separate counters. The old log reported plan.length as the RESULT,
     which is the PLAN — an UPDATE whose IS NULL guard did not match still
     counted. Only what the database says it changed is reported. */
  let nSoWritten = 0, nDateWritten = 0, nKeyWritten = 0, hdrs = 0;
  for (let i = 0; i < plan.length; i += 200) {
    const batch = plan.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const p of batch) {
        if (p.soItemId) nSoWritten += (await tx`UPDATE scm.purchase_order_items SET so_item_id = ${p.soItemId}
          WHERE id = ${p.id} AND so_item_id IS NULL`).count;
        if (p.deliveryDate) nDateWritten += (await tx`UPDATE scm.purchase_order_items SET delivery_date = ${p.deliveryDate}
          WHERE id = ${p.id} AND delivery_date IS NULL`).count;
        if (has_dtlkey && p.dtlKey != null) nKeyWritten += (await tx`UPDATE scm.purchase_order_items SET linked_ac_dtlkey = ${p.dtlKey}
          WHERE id = ${p.id} AND linked_ac_dtlkey IS NULL`).count;
      }
    });
    log(`  ..${Math.min(i + 200, plan.length)}/${plan.length}`);
  }
  for (const f of headerFill) {
    hdrs += (await sql`UPDATE scm.purchase_orders SET expected_at = ${f.eta}
      WHERE id = ${f.id} AND expected_at IS NULL`).count;
  }
  log(`DONE — rows the database reports as changed (planned in brackets):`);
  log(`   so_item_id ${nSoWritten} [${nSo}]; delivery_date ${nDateWritten} [${nDate}]; linked_ac_dtlkey ${nKeyWritten} [${has_dtlkey ? nKey : 0}]; headers given a date ${hdrs} [${headerFill.length}]`);
  if (nSoWritten !== nSo || nDateWritten !== nDate || (has_dtlkey && nKeyWritten !== nKey) || hdrs !== headerFill.length) {
    log("   a written count below its planned count means the column stopped being NULL between the plan and the write — the guard did its job, nothing was overwritten.");
  }
  log("no inventory movements written — this repair is paperwork on rows that already exist.");
  await sql.end();

  /* VERIFY ON A SECOND CONNECTION, and assert the VALUES rather than the
     counts. The session that did the writing is the worst possible witness
     that they landed: it can report "written: N of N" while the rows read back
     wrong — that is exactly how seven variants blocks were reported repaired
     on 2026-08-13 while they had actually been turned into jsonb strings.
     A count is not a shape. */
  const check = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  try {
    log("");
    log("VERIFY (fresh connection) — reading the rows back, not the counters:");
    const ids = plan.filter((p) => p.soItemId || p.deliveryDate || (has_dtlkey && p.dtlKey != null)).slice(0, 200).map((p) => p.id);
    if (!ids.length) { log("  nothing was planned, so there is nothing to read back."); return; }
    const seen = await check`SELECT id::text AS id, so_item_id::text AS so_item_id, delivery_date::text AS delivery_date
                               FROM scm.purchase_order_items WHERE id = ANY(${ids})`;
    const by = new Map(seen.map((r) => [r.id, r]));
    let ok = 0, wrong = 0;
    for (const p of plan.slice(0, 200)) {
      const r = by.get(String(p.id));
      if (!r) continue;
      const soOk = !p.soItemId || r.so_item_id === String(p.soItemId);
      const dtOk = !p.deliveryDate || isoDate(r.delivery_date) === isoDate(p.deliveryDate);
      if (soOk && dtOk) ok++;
      else { wrong++; log(`  MISMATCH ${p.id}: so_item_id=${r.so_item_id} (wanted ${p.soItemId ?? "-"}), delivery_date=${r.delivery_date} (wanted ${p.deliveryDate ?? "-"})`); }
    }
    log(`  read back ${ok + wrong} row(s): ${ok} hold the intended values, ${wrong} do not.`);
    /* A header the repair filled must actually carry a date now. */
    if (headerFill.length) {
      const hids = headerFill.slice(0, 200).map((f) => f.id);
      const [{ blank }] = await check`SELECT count(*)::int AS blank FROM scm.purchase_orders
                                       WHERE id = ANY(${hids}) AND expected_at IS NULL`;
      log(`  headers still blank among the ${hids.length} this run filled: ${blank}`);
      if (blank) wrong += blank;
    }
    if (wrong) { console.error("VERIFY FAILED — the rows do not read back as intended."); process.exitCode = 1; }
    else log("  VERIFY PASS");
  } finally {
    await check.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
