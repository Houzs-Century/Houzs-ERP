#!/usr/bin/env node
// LANE D — WHY DOES STOCK STATUS DIVERGE, UNDER THE OWNER'S OWN TEST.
//
// Owner, 2026-08-11: "目前如果我讲说 bedframe 跟 sofa 都是直接绑定的话呢,那它应该是跟
// AutoCount 一模一样的,就要看为什么不准了."  Under BOUND allocation the ERP's answer MUST
// equal AutoCount's; any divergence is a bug in us. This check measures that, per line,
// and attributes every divergence to a NAMED rule difference. It fixes nothing.
//
// ── AutoCount's rule, established read-only against the live book (AED_HOUZS) ──
// AutoCount has NO computed readiness. Every candidate field is dead on open lines:
//   SODTL.StockReceived  = 'F'  on all 13,351   (never used)
//   SODTL.PurchaseStatus = NULL on all 13,351   (never used)
//   SODTL.DeliveryStatus = NULL on all 13,351   (never used)
// The readiness signal is SO.Remark2, free text a human types — its distinct values
// include "PREFER WEEKEND", "TIME 10AM-12PM", "TRANSPORT RM150". But the humans type it
// to ONE rule, and the rule is exact: of the 3,080 open bedframe/sofa lines, 242 sit on a
// Remark2~READY order and ALL 242 are bound (SODTL.UDF_PONo / TransferedPOQty>0) AND that
// bound PO has a GR. Zero exceptions, both directions.
//   => AutoCount READY(line) == the PO raised from that line by "Convert to PO" has been
//      received (GRDTL.FromDocNo = SODTL.UDF_PONo).
// That is the same shape as the ERP's BOUND mode, so bedframe divergence is DATA.
//
// ── The ERP's rule (src/scm/lib/so-stock-allocation.ts, read at 501f9a1f) ──
// A line is READY when, in priority order (customer_delivery_date, then doc_no):
//   GATE   proceeded_at IS NULL on the SO  -> forced PENDING, nothing else is consulted
//   BOUND  group in {bedframe, sofa}: its own PO line (purchase_order_items.so_item_id)
//          has received_qty >= need  -> READY  (step 6b)
//   BATCH  sofa: ONE open lot batch must cover EVERY module of the SO's whole set at one
//          warehouse, else PENDING  (step 7b)
//   POOL   everything else: warehouse_id::item_code::variant_key bucket must hold the need
//
// Read-only: SELECTs only, no DDL, no writes, no transaction.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const CO = 1;
const gz = (f) => JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

const pad = (n, w = 5) => String(n).padStart(w);

async function main() {
  log("=== LANE D — bedframe + sofa readiness: the ERP vs AutoCount, under the owner's BOUND test ===");
  log("read-only; AutoCount side is a frozen export of the live book, ERP side is live prod");
  log("");

  /* ── 1. AutoCount's answer, per line ─────────────────────────────────────── */
  const ac = gz("ac-bedframe-sofa-readiness.json.gz");
  const acBound = ac.filter((r) => Number(r.TransferedPOQty) > 0);
  const acBoundRecv = acBound.filter((r) => Number(r.BoundPoReceived) === 1);
  log("--- AutoCount side (frozen export, open bedframe/sofa lines) ---");
  log(`open bedframe/sofa lines in AutoCount: ${ac.length}  (bedframe ${ac.filter((r) => r.ItemGroup === "BEDFRAME").length}, sofa ${ac.filter((r) => r.ItemGroup === "SOFA").length})`);
  log(`  bound via Convert-to-PO (UDF_PONo / TransferedPOQty>0): ${acBound.length}`);
  log(`    of those, the bound PO HAS a GR  -> AutoCount READY:  ${acBoundRecv.length}`);
  log(`    of those, bound PO NOT received  -> AutoCount PENDING: ${acBound.length - acBoundRecv.length}`);
  log(`  NOT bound at all -> the owner's BOUND model does not apply: ${ac.length - acBound.length}`);
  log("");

  /* AutoCount's answer. Only defined where the bind exists; a line with no bind has no
     bound answer at all, and inventing one would be a wrong value where a blank is honest. */
  const acAnswer = (r) => (Number(r.TransferedPOQty) > 0
    ? (Number(r.BoundPoReceived) === 1 && Number(r.BoundPoGrQty) >= Number(r.Need) ? "READY" : "PENDING")
    : null);

  /* ── 2. The ERP's answer, per line, joined on the exact line key ──────────── */
  const dtlKeys = ac.map((r) => Number(r.DtlKey));
  const erpRows = await sql`
    SELECT i.id::text id, i.doc_no, i.linked_ac_dtlkey::text dtlkey,
           i.item_code, LOWER(COALESCE(i.item_group,'')) item_group,
           i.stock_status, i.qty::numeric qty,
           i.stock_qty_ready::numeric stock_qty_ready,
           i.warehouse_id::text warehouse_id,
           i.variants,
           h.proceeded_at, h.status::text so_status, h.linked_ac_docno,
           h.customer_delivery_date
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND COALESCE(i.cancelled,false) = false
       AND i.linked_ac_dtlkey = ANY(${dtlKeys}::bigint[])`;
  const erpByKey = new Map(erpRows.map((r) => [String(r.dtlkey), r]));
  log("--- join ---");
  log(`ERP lines matched by linked_ac_dtlkey: ${erpByKey.size} of ${ac.length} AutoCount lines`);
  const unmatched = ac.filter((r) => !erpByKey.has(String(r.DtlKey)));
  log(`UNMATCHED (no ERP line carries this AutoCount DtlKey): ${unmatched.length}`);
  if (unmatched.length) {
    const byG = new Map();
    for (const r of unmatched) byG.set(r.ItemGroup, (byG.get(r.ItemGroup) ?? 0) + 1);
    log(`   by group: ${[...byG].map(([g, n]) => `${g}=${n}`).join(", ")}`);
    log(`   these are REPORTED, never guessed at — a line the ERP does not hold has no ERP answer`);
  }
  log("");

  /* ── 3. Evidence the ERP's own rule would have consulted ─────────────────── */
  const erpIds = erpRows.map((r) => r.id);
  // BOUND: the line's own dedicated PO receipt (step 6b's exact read)
  const ded = erpIds.length ? await sql`
    SELECT pi.so_item_id::text so_item_id,
           SUM(COALESCE(pi.received_qty,0))::numeric got,
           SUM(pi.qty)::numeric ordered, COUNT(*)::int n
      FROM scm.purchase_order_items pi
     WHERE pi.so_item_id::text = ANY(${erpIds})
     GROUP BY 1` : [];
  const dedById = new Map(ded.map((r) => [r.so_item_id, r]));

  // delivered / returned, so "need" matches the allocator's deliverable_remaining
  const delivered = erpIds.length ? await sql`
    SELECT di.so_item_id::text so_item_id, SUM(di.qty)::numeric q
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id::text = ANY(${erpIds})
       AND UPPER(COALESCE(d.status::text,'')) NOT IN ('CANCELLED','DRAFT')
     GROUP BY 1` : [];
  const delById = new Map(delivered.map((r) => [r.so_item_id, Number(r.q)]));

  // BATCH: open batched lots, what sofa set-coverage reads
  const lots = await sql`
    SELECT warehouse_id::text warehouse_id, product_code,
           COALESCE(variant_key,'') variant_key, batch_no,
           SUM(qty_remaining)::numeric qty
      FROM scm.inventory_lots
     WHERE company_id = ${CO} AND batch_no IS NOT NULL AND qty_remaining > 0
     GROUP BY 1,2,3,4`;
  const openBatchedByCode = new Map();
  for (const l of lots) openBatchedByCode.set(l.product_code, (openBatchedByCode.get(l.product_code) ?? 0) + Number(l.qty));

  /* ── 4. Classify every line ──────────────────────────────────────────────── */
  /* Precedence = "what would have to change FIRST for the two to agree". Every line lands
     in exactly ONE class so the classes sum to the population. */
  const PRECEDENCE = [
    "AGREE",
    "AC_HAS_NO_BOUND_ANSWER",
    "ERP_LINE_MISSING",
    "GATE_NO_PROCESSING_DATE",
    "SOFA_BOUND_MODE_UNREACHABLE",
    "BOUND_LINK_MISSING_IN_ERP",
    "BOUND_RECEIPT_QTY_SHORT",
    "SO_STATUS_LENS",
    "UNEXPLAINED",
  ];
  const tally = new Map();
  const samples = new Map();
  const bump = (cls, line) => {
    tally.set(cls, (tally.get(cls) ?? 0) + 1);
    if (!samples.has(cls)) samples.set(cls, []);
    if (samples.get(cls).length < 6) samples.get(cls).push(line);
  };

  const ALLOC_EXCLUDED = new Set(["CANCELLED", "CLOSED", "SHIPPED", "DELIVERED", "INVOICED", "DRAFT"]);
  let comparable = 0, agreeN = 0, divergeN = 0;

  for (const r of ac) {
    const key = String(r.DtlKey);
    const e = erpByKey.get(key);
    const acA = acAnswer(r);
    const grp = r.ItemGroup === "SOFA" ? "sofa" : "bedframe";

    if (acA === null) { bump("AC_HAS_NO_BOUND_ANSWER", `${r.DocNo} ${r.ItemCode} (${grp}) — no Convert-to-PO bind in AutoCount either`); continue; }
    if (!e) { bump("ERP_LINE_MISSING", `${r.DocNo} DtlKey ${key} ${r.ItemCode} — AutoCount says ${acA}, the ERP holds no line with this key`); continue; }

    const erpA = e.stock_status === "READY" ? "READY" : "PENDING";
    comparable += 1;
    if (erpA === acA) { agreeN += 1; bump("AGREE", `${r.DocNo} ${r.ItemCode} both ${acA}`); continue; }
    divergeN += 1;

    // ---- attribute the divergence to a NAMED rule difference ----
    const d = dedById.get(e.id);
    const got = d ? Number(d.got) : 0;
    const need = Number(r.Need);

    if (ALLOC_EXCLUDED.has(String(e.so_status ?? "").toUpperCase())) {
      bump("SO_STATUS_LENS", `${r.DocNo} (${e.doc_no}) ${r.ItemCode} — AutoCount ${acA}, ERP ${erpA}; the ERP order is ${e.so_status}, which the allocator excludes entirely`);
      continue;
    }
    if (!e.proceeded_at) {
      bump("GATE_NO_PROCESSING_DATE", `${r.DocNo} (${e.doc_no}) ${r.ItemCode} — AutoCount ${acA}, ERP ${erpA}; proceeded_at IS NULL so the ERP forces PENDING whatever the stock says. AutoCount has no such gate.`);
      continue;
    }
    if (acA === "READY" && erpA === "PENDING" && grp === "sofa") {
      const openB = openBatchedByCode.get(e.item_code) ?? 0;
      bump("SOFA_BOUND_MODE_UNREACHABLE", `${r.DocNo} (${e.doc_no}) ${r.ItemCode} — bound PO received in AutoCount (GR ${r.BoundPoGrQty}/${need}); the ERP routes sofa to whole-set BATCH coverage instead of BOUND (open batched units for this code: ${openB})`);
      continue;
    }
    if (acA === "READY" && erpA === "PENDING" && !d) {
      bump("BOUND_LINK_MISSING_IN_ERP", `${r.DocNo} (${e.doc_no}) ${r.ItemCode} — AutoCount binds it to PO ${r.BoundPo} (received ${r.BoundPoGrQty}); NO scm.purchase_order_items row carries so_item_id = this line, so the ERP's BOUND mode sees nothing`);
      continue;
    }
    if (acA === "READY" && erpA === "PENDING" && got < need) {
      bump("BOUND_RECEIPT_QTY_SHORT", `${r.DocNo} (${e.doc_no}) ${r.ItemCode} — AutoCount GR ${r.BoundPoGrQty} of ${need}; the ERP's dedicated PO records received_qty ${got} of need ${need}`);
      continue;
    }
    bump("UNEXPLAINED", `${r.DocNo} (${e.doc_no}) ${r.ItemCode} (${grp}) — AutoCount ${acA}, ERP ${erpA}; dedicated received ${got}, need ${need}, warehouse ${e.warehouse_id ?? "(none)"}`);
  }

  /* ── 5. Report ───────────────────────────────────────────────────────────── */
  log("--- THE COMPARISON ---");
  log(`lines where BOTH systems have an answer (comparable): ${comparable}`);
  log(`   AGREE:    ${agreeN}`);
  log(`   DIVERGE:  ${divergeN}`);
  log("");
  log("--- EVERY LINE CLASSIFIED (one class each; they sum to the AutoCount population) ---");
  let sum = 0;
  for (const cls of PRECEDENCE) {
    const n = tally.get(cls) ?? 0;
    if (!n) continue;
    sum += n;
    log(`   ${pad(n)}  ${cls}`);
  }
  log(`   ${pad(sum)}  TOTAL (AutoCount population was ${ac.length}) — ${sum === ac.length ? "they sum" : "MISMATCH, do not trust the split"}`);
  log("");
  for (const cls of PRECEDENCE) {
    const s = samples.get(cls);
    if (!s || cls === "AGREE") continue;
    log(`--- ${cls} (${tally.get(cls)}) ---`);
    for (const line of s) log(`      ${line}`);
  }

  log("");
  log("--- CROSS-CHECK: does the ERP hold the bind at all? ---");
  const boundKeys = acBound.map((r) => String(r.DtlKey));
  const boundErp = boundKeys.map((k) => erpByKey.get(k)).filter(Boolean);
  const withDed = boundErp.filter((e) => dedById.has(e.id)).length;
  log(`AutoCount-bound lines the ERP holds: ${boundErp.length}`);
  log(`   of those, an ERP purchase_order_items row carries so_item_id = the line: ${withDed}`);
  log(`   MISSING the bind in the ERP: ${boundErp.length - withDed}  <- BOUND mode is blind on these`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
