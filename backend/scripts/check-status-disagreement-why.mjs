#!/usr/bin/env node
// WHY the 104 — cause analysis for every stock-status disagreement between
// AutoCount's Remark2 and the ERP's per-line stock_status.
//
// Owner, 2026-08-11: "Remark 2 = Stock Status 对了 404 张, 一致 284 / 不一致 104
// — 为什么不是齐完?"  He wants every one of the 104 explained BY CAUSE, with
// numbers, so he can decide what to fix. This does not fix anything.
//
// It re-derives the SAME 104 that check-autocount-parity.mjs reports (identical
// lens, identical claimedGroups reader — copied verbatim below so the two can be
// diffed line for line), then, for every BLOCKING line on those orders, gathers
// the evidence the allocator itself would have looked at and assigns a cause.
//
// The allocator (src/scm/lib/so-stock-allocation.ts) decides stock_status by
// exactly four mechanisms, and every cause below names which one fired:
//
//   GATE   an SO with no proceeded_at is forced PENDING and never claims stock
//          (owner 2026-08-10 "有 processing date 才来分配") — nothing else matters
//   BOUND  bedframe + sofa settle from their OWN dedicated PO's received_qty,
//          found via purchase_order_items.so_item_id
//   POOL   everything else fills from the bucket (warehouse_id, item_code,
//          variant_key) in delivery-date -> doc-no priority order
//   BATCH  sofa sets need ONE open lot batch covering EVERY module of the set
//
// Read-only: SELECTs only, no DDL, no writes, no transaction.
// Run under tsx so the REAL computeVariantKey is used, never a copy of it:
//   npx tsx scripts/check-status-disagreement-why.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { computeVariantKey } from "../src/scm/shared/variant-key.ts";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

/* VERBATIM from check-autocount-parity.mjs — if these two ever disagree the
   populations diverge and every number below stops being about the same 104. */
function claimedGroups(remark) {
  const r = (remark || "").toUpperCase();
  if (!r) return null;
  if (/PARTIAL/.test(r)) return { partial: true, groups: [] };
  const groups = [];
  if (/\bACC\b/.test(r)) groups.push("accessory");
  if (/BEDFRAME|B\/?FRAME/.test(r)) groups.push("bedframe");
  if (/MATTRESS|MATT\b/.test(r)) groups.push("mattress");
  if (/\bSOFA\b/.test(r)) groups.push("sofa");
  if (/^READY$|^READY\b/.test(r) && !groups.length) return { all: true, groups: [] };
  return groups.length ? { groups } : { unreadable: r };
}

/* The allocator's own live-SO lens (so-stock-allocation.ts step 1). The parity
   script's lens is NARROWER (it also drops CANCELLED/CLOSED/DELIVERED/SHIPPED/
   INVOICED but keeps DRAFT); competing claims must be counted with the
   ALLOCATOR's lens, because those are the lines that really take the stock. */
const ALLOC_EXCLUDED = ["CANCELLED", "CLOSED", "SHIPPED", "DELIVERED", "INVOICED", "DRAFT"];
const WH_NONE = "NOWH";
const FAR_FUTURE = "9999-12-31";
const dateKey = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ""));
const stampKey = (v) => (v instanceof Date ? v.toISOString() : String(v ?? ""));

async function main() {
  log("═══ WHY THE 104 — cause analysis for every AutoCount-vs-ERP stock-status disagreement ═══");
  log("read-only; the population is re-derived with check-autocount-parity.mjs's exact lens");
  log("");

  /* ── 1. Re-derive the disagreeing population, exactly as the parity check does ── */
  const acStatus = gz("ac-so-status.json.gz");
  const parityLines = await sql`SELECT h.linked_ac_docno ac, h.doc_no, i.item_group, i.stock_status,
      COUNT(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
      AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
    GROUP BY 1,2,3,4`;
  const erp = new Map();
  for (const r of parityLines) {
    if (!erp.has(r.ac)) erp.set(r.ac, { doc: r.doc_no, g: new Map() });
    const g = erp.get(r.ac).g;
    if (!g.has(r.item_group)) g.set(r.item_group, {});
    g.get(r.item_group)[r.stock_status ?? "(null)"] = r.n;
  }
  const groupReady = (e, group) => {
    const s = e.g.get(group);
    if (!s) return null;
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    return (s.READY ?? 0) === total;
  };

  const disagreeing = [];   // { ac, doc, remark, badGroups[] }
  let agree = 0, partial = 0, noLines = 0, unreadable = 0;
  for (const r of acStatus) {
    const claim = claimedGroups(r.Remark2);
    if (!claim) continue;
    if (claim.unreadable) { unreadable++; continue; }
    const e = erp.get(r.DocNo);
    if (!e) { noLines++; continue; }
    if (claim.partial) { partial++; continue; }
    const groups = claim.all ? [...e.g.keys()].filter((g) => g !== "service") : claim.groups;
    const bad = [];
    for (const g of groups) {
      const ready = groupReady(e, g);
      if (ready === null) continue;
      if (!ready) bad.push(g);
    }
    if (bad.length) disagreeing.push({ ac: r.DocNo, doc: e.doc, remark: r.Remark2, toPo: r.ToPONo || null, badGroups: bad });
    else agree++;
  }
  log(`population re-derived: agrees ${agree}; DISAGREES ${disagreeing.length}; "READY (PARTIAL)" ${partial}; not an open ERP order ${noLines}; unreadable ${unreadable}`);
  if (disagreeing.length === 0) { log("nothing to explain"); await sql.end(); return; }
  const docNos = [...new Set(disagreeing.map((d) => d.doc))];

  /* ── 2. The blocking lines themselves ─────────────────────────────────────── */
  const badGroupsByDoc = new Map(disagreeing.map((d) => [d.doc, new Set(d.badGroups)]));
  const blockRows = await sql`SELECT i.id::text id, i.doc_no, i.item_code, i.item_group,
      i.variants, i.qty::numeric qty, i.warehouse_id::text warehouse_id,
      i.stock_status, i.stock_qty_ready::numeric stock_qty_ready,
      h.proceeded_at, h.status::text so_status, h.customer_delivery_date, h.created_at
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE i.doc_no = ANY(${docNos}) AND COALESCE(i.cancelled,false) = false`;
  const blocking = blockRows.filter((r) =>
    badGroupsByDoc.get(r.doc_no)?.has(r.item_group) && r.stock_status !== "READY");
  log(`blocking lines on those orders (the line the group is NOT READY on): ${blocking.length}`);

  /* ── 3. What the allocator would have seen ────────────────────────────────── */
  // 3a. Every live line's competing claim on the pooled buckets (ALLOCATOR lens).
  const claimRows = await sql`SELECT i.id::text id, i.doc_no, i.item_code, i.item_group,
      i.variants, i.qty::numeric qty, i.warehouse_id::text warehouse_id,
      h.customer_delivery_date, h.created_at, h.proceeded_at
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND UPPER(h.status::text) <> ALL(${ALLOC_EXCLUDED})`;
  // delivered/returned per line, so "need" matches the allocator's deliverable_remaining
  const delivered = await sql`SELECT di.so_item_id::text so_item_id, SUM(di.qty)::numeric q
    FROM scm.delivery_order_items di JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
    WHERE di.so_item_id IS NOT NULL AND UPPER(COALESCE(d.status::text,'')) NOT IN ('CANCELLED','DRAFT')
    GROUP BY 1`;
  const returned = await sql`SELECT di.so_item_id::text so_item_id, SUM(ri.qty_returned)::numeric q
    FROM scm.delivery_return_items ri
    JOIN scm.delivery_order_items di ON di.id = ri.do_item_id
    JOIN scm.delivery_returns r ON r.id = ri.delivery_return_id
    WHERE di.so_item_id IS NOT NULL AND UPPER(COALESCE(r.status::text,'')) <> 'CANCELLED'
    GROUP BY 1`;
  const delById = new Map(delivered.map((r) => [r.so_item_id, Number(r.q)]));
  const retById = new Map(returned.map((r) => [r.so_item_id, Number(r.q)]));

  // 3b. Live on-hand, per the allocator's bucket key and per looser lenses.
  const balances = await sql`SELECT warehouse_id::text warehouse_id, product_code,
      COALESCE(variant_key,'') variant_key, SUM(qty)::numeric qty
    FROM scm.inventory_balances WHERE company_id = ${CO}
    GROUP BY 1,2,3`;
  const onHandExact = new Map();   // wh::code::variant -> qty
  const onHandWh = new Map();      // wh::code -> qty (any variant)
  const onHandCode = new Map();    // code -> qty (anywhere, any variant)
  const variantsSeen = new Map();  // wh::code -> Set(variant_key with qty>0)
  for (const b of balances) {
    const q = Number(b.qty ?? 0);
    onHandExact.set(`${b.warehouse_id}::${b.product_code}::${b.variant_key}`,
      (onHandExact.get(`${b.warehouse_id}::${b.product_code}::${b.variant_key}`) ?? 0) + q);
    onHandWh.set(`${b.warehouse_id}::${b.product_code}`, (onHandWh.get(`${b.warehouse_id}::${b.product_code}`) ?? 0) + q);
    onHandCode.set(b.product_code, (onHandCode.get(b.product_code) ?? 0) + q);
    if (q > 0) {
      const k = `${b.warehouse_id}::${b.product_code}`;
      if (!variantsSeen.has(k)) variantsSeen.set(k, new Set());
      variantsSeen.get(k).add(b.variant_key);
    }
  }

  // 3c. Open BATCHED lots — what the sofa set-coverage path actually reads.
  const sofaLots = await sql`SELECT warehouse_id::text warehouse_id, product_code,
      COALESCE(variant_key,'') variant_key, batch_no, SUM(qty_remaining)::numeric qty
    FROM scm.inventory_lots
    WHERE company_id = ${CO} AND batch_no IS NOT NULL AND qty_remaining > 0
    GROUP BY 1,2,3,4`;
  const batchStock = new Map();    // wh|batch|code|variant -> qty
  const lotsByCode = new Map();    // code -> total open batched qty
  const anyLotByCode = new Map();  // code -> total open qty incl. un-batched
  for (const l of sofaLots) {
    batchStock.set(`${l.warehouse_id}|${l.batch_no}|${l.product_code}|${l.variant_key}`, Number(l.qty));
    lotsByCode.set(l.product_code, (lotsByCode.get(l.product_code) ?? 0) + Number(l.qty));
  }
  const allLots = await sql`SELECT product_code, SUM(qty_remaining)::numeric qty
    FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0 GROUP BY 1`;
  for (const l of allLots) anyLotByCode.set(l.product_code, Number(l.qty));

  // 3d. BOUND mode: each blocking line's own dedicated PO (so_item_id) receipt.
  const blockIds = blocking.map((b) => b.id);
  const dedicated = blockIds.length ? await sql`SELECT i.so_item_id::text so_item_id,
      SUM(COALESCE(i.received_qty,0))::numeric got, SUM(i.qty)::numeric ordered,
      COUNT(*)::int n, MAX(p.po_number) po_number, MAX(p.linked_ac_docno) ac_po
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE i.so_item_id::text = ANY(${blockIds}) GROUP BY 1` : [];
  const dedById = new Map(dedicated.map((r) => [r.so_item_id, r]));

  // 3e. The AutoCount-named PO (UDF_ToPONo) as the ERP holds it, and whether
  //     AutoCount itself received it — this is the H2 dedication-gap evidence.
  const acPoNos = [...new Set(disagreeing.map((d) => d.toPo).filter(Boolean))];
  const erpPoByAc = acPoNos.length ? await sql`SELECT p.linked_ac_docno ac_po, p.po_number,
      COUNT(i.id)::int lines,
      COUNT(i.so_item_id)::int lines_dedicated,
      SUM(COALESCE(i.received_qty,0))::numeric received
    FROM scm.purchase_orders p LEFT JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno = ANY(${acPoNos})
    GROUP BY 1,2` : [];
  const poByAc = new Map(erpPoByAc.map((r) => [r.ac_po, r]));
  const acGrRefs = gz("ac-gr-refs.json.gz");
  const acReceivedPo = new Set(acGrRefs.filter((r) => r.GrNo).map((r) => r.PoNo));

  /* ── 4. Replay the pooled walk, per bucket, in the allocator's priority order ── */
  const needOf = (r) => Number(r.qty ?? 0) - (delById.get(r.id) ?? 0) + (retById.get(r.id) ?? 0);
  const bucketOf = (r) => `${r.warehouse_id ?? WH_NONE}::${r.item_code}::${computeVariantKey(r.item_group ?? null, r.variants ?? null)}`;
  const prio = (a, b) => {
    const ad = dateKey(a.customer_delivery_date) || FAR_FUTURE;
    const bd = dateKey(b.customer_delivery_date) || FAR_FUTURE;
    if (ad !== bd) return ad.localeCompare(bd);
    if (a.doc_no !== b.doc_no) return a.doc_no.localeCompare(b.doc_no);
    return stampKey(a.created_at).localeCompare(stampKey(b.created_at)) || a.id.localeCompare(b.id);
  };
  const claimants = new Map();  // bucket -> ordered live lines competing for it
  for (const r of claimRows) {
    if ((r.item_group ?? "").toLowerCase() === "service") continue;
    if ((r.item_group ?? "").toLowerCase() === "sofa") continue;   // sofa is BATCH, not POOL
    if (needOf(r) <= 0) continue;
    const k = bucketOf(r);
    if (!claimants.has(k)) claimants.set(k, []);
    claimants.get(k).push(r);
  }
  for (const arr of claimants.values()) arr.sort(prio);
  /** qty of the bucket already claimed by lines that sort STRICTLY BEFORE this one */
  const claimedBefore = (line) => {
    const arr = claimants.get(bucketOf(line)) ?? [];
    let sum = 0;
    for (const r of arr) { if (r.id === line.id) break; sum += needOf(r); }
    return sum;
  };

  /* ── 5. Classify every blocking line ──────────────────────────────────────── */
  // sofa set need, per (doc, warehouse) — the BATCH path's unit of coverage
  const sofaSets = new Map();
  for (const r of claimRows) {
    if ((r.item_group ?? "").toLowerCase() !== "sofa") continue;
    if (needOf(r) <= 0) continue;
    const k = `${r.warehouse_id ?? WH_NONE}|${r.doc_no}`;
    if (!sofaSets.has(k)) sofaSets.set(k, []);
    sofaSets.get(k).push({ code: r.item_code, vk: computeVariantKey("sofa", r.variants ?? null), need: needOf(r) });
  }
  const coveringBatchExists = (line) => {
    const wh = line.warehouse_id ?? WH_NONE;
    const set = sofaSets.get(`${wh}|${line.doc_no}`) ?? [];
    if (!set.length || wh === WH_NONE) return false;
    const batches = new Set();
    for (const [k] of batchStock) { const p = k.split("|"); if (p[0] === wh) batches.add(p[1]); }
    for (const b of batches) {
      if (set.every((m) => (batchStock.get(`${wh}|${b}|${m.code}|${m.vk}`) ?? 0) >= m.need)) return true;
    }
    return false;
  };

  const causeOfLine = (line) => {
    const grp = (line.item_group ?? "").toLowerCase();
    const need = needOf(line);
    /* The parity check's lens keeps DRAFT orders; the ALLOCATOR's lens drops
       them, so a DRAFT order's lines are never even considered for stock. That
       is a complete explanation and outranks everything below it. */
    if ((line.so_status ?? "").toUpperCase() === "DRAFT") return { cause: "SO_IS_DRAFT", note: `the SO is still DRAFT; the allocator excludes DRAFT orders from its population entirely` };
    // GATE — the allocator forces PENDING before it looks at anything else.
    if (!line.proceeded_at) return { cause: "GATE_NO_PROCESSING_DATE", note: `SO has no Processing Date (proceeded_at NULL); the allocator forces every line PENDING whatever the stock says` };
    /* MISC is a charge posted as a goods line — it has no stock and never will.
       Any OTHER `others` code is a real good and is judged on stock like the rest. */
    if (grp === "others" && /^MISC|MISCELLANEOUS/i.test(line.item_code ?? "")) return { cause: "CLASSIFICATION_MISC", note: `${line.item_code} is a charge posted as an item_group=others goods line, so it can never read READY` };
    if (need <= 0) return { cause: "CANNOT_DETERMINE", note: `deliverable_remaining ${need} <= 0 yet the line is ${line.stock_status}` };

    const ded = dedById.get(line.id);
    if (grp === "sofa") {
      const openBatched = lotsByCode.get(line.item_code) ?? 0;
      const openAny = anyLotByCode.get(line.item_code) ?? 0;
      if (openAny <= 0) return { cause: "SOFA_NO_STOCK_IMPORTED", note: `${line.item_code}: ZERO open inventory lots anywhere in company ${CO} (whole-sofa balances were excluded from the AutoCount import)` };
      if (openBatched <= 0) return { cause: "SOFA_STOCK_UNBATCHED", note: `${line.item_code}: ${openAny} open unit(s) exist but NONE carry a batch_no, so no batch can cover the set` };
      if (!coveringBatchExists(line)) return { cause: "SOFA_NO_COVERING_BATCH", note: `${line.item_code}: ${openBatched} batched unit(s) open, but no single batch at warehouse ${line.warehouse_id ?? "(none)"} covers every module of this SO's set` };
      return { cause: "CANNOT_DETERMINE", note: `${line.item_code}: a covering batch appears to exist yet the line reads ${line.stock_status}` };
    }

    // BOUND (bedframe) — settles from its own dedicated PO before the pool.
    if (grp === "bedframe") {
      if (ded && Number(ded.got) >= need) return { cause: "CANNOT_DETERMINE", note: `dedicated PO ${ded.po_number} received ${ded.got} >= need ${need}, yet the line reads ${line.stock_status}` };
      if (ded && Number(ded.got) > 0) return { cause: "DEDICATED_PO_PARTIAL", note: `dedicated PO ${ded.po_number} received only ${ded.got} of ${need}` };
      // no dedication (or nothing received): does its AutoCount PO exist + received?
      const acPo = line.__acPo;
      if (!ded && acPo) {
        const p = poByAc.get(acPo);
        if (p && p.lines_dedicated === 0 && acReceivedPo.has(acPo)) {
          return { cause: "DEDICATION_GAP", note: `AutoCount received ${acPo}; the ERP holds it as ${p.po_number} with ${p.lines} line(s), NONE carrying so_item_id, so BOUND mode sees no receipt` };
        }
      }
    }

    // POOL — the bucket walk. Report exactly which of the allocator's tests failed.
    const vk = computeVariantKey(line.item_group ?? null, line.variants ?? null);
    const anywhere = onHandCode.get(line.item_code) ?? 0;
    if (anywhere <= 0) {
      if (ded && Number(ded.got) > 0) return { cause: "CANNOT_DETERMINE", note: `no on-hand anywhere yet its PO reports received ${ded.got}` };
      return { cause: "NO_STOCK_ANYWHERE", note: `${line.item_code}: on-hand across every warehouse of company ${CO} is ${anywhere}` };
    }
    if (!line.warehouse_id) return { cause: "LINE_HAS_NO_WAREHOUSE", note: `${line.item_code}: ${anywhere} on hand, but the SO line has NO warehouse_id, so it draws from the empty NOWH bucket` };
    const inWh = onHandWh.get(`${line.warehouse_id}::${line.item_code}`) ?? 0;
    if (inWh <= 0) return { cause: "STOCK_IN_ANOTHER_WAREHOUSE", note: `${line.item_code}: ${anywhere} on hand, none of it in this line's warehouse` };
    const exact = onHandExact.get(`${line.warehouse_id}::${line.item_code}::${vk}`) ?? 0;
    if (exact <= 0) {
      const have = [...(variantsSeen.get(`${line.warehouse_id}::${line.item_code}`) ?? [])].map((v) => v || "(blank)").join(" , ");
      return { cause: "VARIANT_KEY_MISMATCH", note: `${line.item_code}: ${inWh} in this warehouse but under variant_key [${have}]; the line wants [${vk || "(blank)"}]` };
    }
    const before = claimedBefore(line);
    if (exact < before + need) return { cause: "CLAIMED_BY_EARLIER_ORDER", note: `${line.item_code}: bucket holds ${exact}; ${before} already claimed by higher-priority orders, this line needs ${need}` };
    return { cause: "STALE_STATUS_SHOULD_BE_READY", note: `${line.item_code}: bucket holds ${exact}, only ${before} claimed ahead, need ${need} — the allocator has not run since the stock arrived` };
  };

  const acPoByDoc = new Map(disagreeing.map((d) => [d.doc, d.toPo]));
  for (const l of blocking) l.__acPo = acPoByDoc.get(l.doc_no) ?? null;

  /* Order-level cause = the cause of its blocking lines, taken in a fixed
     precedence so every order lands in exactly ONE bucket and they sum to the
     population. Precedence = "what would have to be fixed FIRST": a gated order
     cannot be judged on stock at all, and so on down. */
  const PRECEDENCE = [
    "SO_IS_DRAFT",
    "GATE_NO_PROCESSING_DATE",
    "CLASSIFICATION_MISC",
    "SOFA_NO_STOCK_IMPORTED",
    "SOFA_STOCK_UNBATCHED",
    "SOFA_NO_COVERING_BATCH",
    "DEDICATION_GAP",
    "DEDICATED_PO_PARTIAL",
    "NO_STOCK_ANYWHERE",
    "LINE_HAS_NO_WAREHOUSE",
    "STOCK_IN_ANOTHER_WAREHOUSE",
    "VARIANT_KEY_MISMATCH",
    "CLAIMED_BY_EARLIER_ORDER",
    "STALE_STATUS_SHOULD_BE_READY",
    "CANNOT_DETERMINE",
    "NO_BLOCKING_LINE_FOUND",
  ];
  const byDoc = new Map();
  for (const l of blocking) {
    const c = causeOfLine(l);
    if (!byDoc.has(l.doc_no)) byDoc.set(l.doc_no, []);
    byDoc.get(l.doc_no).push({ ...c, group: (l.item_group ?? "").toLowerCase(), code: l.item_code, status: l.stock_status });
  }
  const orderCause = new Map();
  for (const d of disagreeing) {
    const cs = byDoc.get(d.doc) ?? [];
    if (!cs.length) { orderCause.set(d.doc, { cause: "NO_BLOCKING_LINE_FOUND", note: "the group is not all READY yet no non-READY line was returned", all: [] }); continue; }
    let best = cs[0];
    for (const c of cs) if (PRECEDENCE.indexOf(c.cause) < PRECEDENCE.indexOf(best.cause)) best = c;
    orderCause.set(d.doc, { ...best, all: cs });
  }

  /* ── 6. Report ────────────────────────────────────────────────────────────── */
  log("");
  log("═══ CAUSE OF EVERY DISAGREEING ORDER (one bucket each; they sum to the population) ═══");
  const tally = new Map();
  for (const d of disagreeing) {
    const c = orderCause.get(d.doc);
    tally.set(c.cause, (tally.get(c.cause) ?? 0) + 1);
  }
  let sum = 0;
  for (const cause of PRECEDENCE) {
    const n = tally.get(cause) ?? 0;
    if (!n) continue;
    sum += n;
    log(`   ${String(n).padStart(4)}  ${cause}`);
  }
  log(`   ${String(sum).padStart(4)}  TOTAL (population was ${disagreeing.length}) — ${sum === disagreeing.length ? "they sum" : "MISMATCH, do not trust the split"}`);

  log("");
  log("═══ CROSS-CUTTING FACTS (these OVERLAP the buckets above; they do not sum) ═══");
  const gatedDocs = new Set(blocking.filter((l) => !l.proceeded_at).map((l) => l.doc_no));
  const othersDocs = new Set(blocking.filter((l) => (l.item_group ?? "").toLowerCase() === "others").map((l) => l.doc_no));
  const noWhDocs = new Set(blocking.filter((l) => !l.warehouse_id).map((l) => l.doc_no));
  log(`   orders with NO Processing Date (proceeded_at NULL) — allocation is switched off for them: ${gatedDocs.size}`);
  log(`   orders with a blocking item_group=others line (MISC, a charge not a good):               ${othersDocs.size}`);
  log(`   orders with a blocking line carrying NO warehouse_id (draws from the empty NOWH bucket): ${noWhDocs.size}`);
  const gatedTotal = await sql`SELECT COUNT(*)::int n FROM scm.mfg_sales_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL AND proceeded_at IS NULL
      AND status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')`;
  log(`   (for scale: ${gatedTotal[0].n} migrated open orders in total have no Processing Date)`);

  log("");
  log("═══ SAME 104 SPLIT BY BLOCKING GROUP (an order can block on several) ═══");
  const byGroup = new Map();
  for (const l of blocking) {
    const g = (l.item_group ?? "").toLowerCase();
    const c = causeOfLine(l);
    const k = `${g} / ${c.cause}`;
    if (!byGroup.has(k)) byGroup.set(k, new Set());
    byGroup.get(k).add(l.doc_no);
  }
  for (const k of [...byGroup.keys()].sort()) log(`   ${String(byGroup.get(k).size).padStart(4)} order(s)  ${k}`);

  log("");
  log("═══ H1 — was sofa stock deliberately not imported? ═══");
  const sofaBlock = blocking.filter((l) => (l.item_group ?? "").toLowerCase() === "sofa");
  const sofaCodes = [...new Set(sofaBlock.map((l) => l.item_code))];
  let sofaNoStock = 0, sofaSomeStock = 0;
  for (const code of sofaCodes) ((anyLotByCode.get(code) ?? 0) > 0 ? sofaSomeStock++ : sofaNoStock++);
  const sofaDocsNoStock = new Set(sofaBlock.filter((l) => (anyLotByCode.get(l.item_code) ?? 0) <= 0).map((l) => l.doc_no));
  const sofaDocsSomeStock = new Set(sofaBlock.filter((l) => (anyLotByCode.get(l.item_code) ?? 0) > 0).map((l) => l.doc_no));
  log(`sofa-blocked orders: ${new Set(sofaBlock.map((l) => l.doc_no)).size}; blocking sofa lines: ${sofaBlock.length}; distinct compartment SKUs: ${sofaCodes.length}`);
  log(`   SKUs with ZERO open lots anywhere (nothing in our system to allocate): ${sofaNoStock}`);
  log(`   SKUs that DO have open lots (stock exists; the allocator did not give it to this line): ${sofaSomeStock}`);
  log(`   orders where EVERY blocking sofa line has zero stock: ${[...sofaDocsNoStock].filter((d) => !sofaDocsSomeStock.has(d)).length}`);
  log(`   orders with at least one blocking sofa line whose SKU has stock: ${sofaDocsSomeStock.size}`);
  const poForSofa = sofaBlock.filter((l) => dedById.has(l.id));
  log(`   blocking sofa lines that DO have a dedicated ERP PO line: ${poForSofa.length} (of which received>0: ${poForSofa.filter((l) => Number(dedById.get(l.id).got) > 0).length})`);

  log("");
  log("═══ H2 — the so_item_id dedication gap ═══");
  const poItemStats = await sql`SELECT COALESCE(i.item_group,'(null)') g,
      COUNT(*)::int lines, COUNT(*) FILTER (WHERE i.so_item_id IS NULL)::int undedicated,
      COUNT(*) FILTER (WHERE i.so_item_id IS NULL AND COALESCE(i.received_qty,0) > 0)::int undedicated_received
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`;
  for (const r of poItemStats) log(`   imported PO lines, ${r.g}: ${r.lines} total, ${r.undedicated} with so_item_id NULL, of those ${r.undedicated_received} already RECEIVED`);
  let h2Hit = 0; const h2Docs = [];
  for (const d of disagreeing) {
    if (!d.toPo) continue;
    const p = poByAc.get(d.toPo);
    if (!p) continue;
    if (p.lines_dedicated === 0 && acReceivedPo.has(d.toPo)) { h2Hit++; if (h2Docs.length < 40) h2Docs.push(`${d.ac} (${d.doc}) -> ${d.toPo} = ERP ${p.po_number}, ${p.lines} line(s), 0 dedicated, AutoCount received it`); }
  }
  log(`   of the ${disagreeing.length}: ${h2Hit} name a PO that AutoCount HAS received but whose ERP lines carry NO so_item_id`);
  for (const s of h2Docs) log(`      ${s}`);

  log("");
  log("═══ H3 — the accessory / mattress seam (the groups whose stock WAS imported) ═══");
  for (const grp of ["accessory", "mattress", "bedframe"]) {
    const ls = blocking.filter((l) => (l.item_group ?? "").toLowerCase() === grp);
    if (!ls.length) continue;
    const t = new Map(); const docs = new Map();
    for (const l of ls) {
      const c = causeOfLine(l);
      t.set(c.cause, (t.get(c.cause) ?? 0) + 1);
      if (!docs.has(c.cause)) docs.set(c.cause, new Set());
      docs.get(c.cause).add(l.doc_no);
    }
    log(`   ${grp}: ${new Set(ls.map((l) => l.doc_no)).size} order(s), ${ls.length} blocking line(s)`);
    for (const k of [...t.keys()].sort()) log(`      ${String(t.get(k)).padStart(4)} line(s) across ${docs.get(k).size} order(s)  ${k}`);
  }

  log("");
  log("═══ EVERY DISAGREEING ORDER, WITH ITS CAUSE ═══");
  const ordered = [...disagreeing].sort((a, b) => {
    const ca = PRECEDENCE.indexOf(orderCause.get(a.doc).cause);
    const cb = PRECEDENCE.indexOf(orderCause.get(b.doc).cause);
    return ca - cb || a.ac.localeCompare(b.ac);
  });
  for (const d of ordered) {
    const c = orderCause.get(d.doc);
    log(`   [${c.cause}] ${d.ac} (${d.doc}) says "${d.remark}", blocks on ${d.badGroups.join("+")} — ${c.note}`);
  }

  log("");
  log("═══ WHAT DISAPPEARS ON ITS OWN ═══");
  const willGo = (cs) => (tally.get(cs) ?? 0);
  log(`   once the so_item_id backfill runs:      ${willGo("DEDICATION_GAP")} order(s) (DEDICATION_GAP)`);
  log(`   once the sofa compartment round lands:  ${willGo("SOFA_NO_STOCK_IMPORTED") + willGo("SOFA_STOCK_UNBATCHED") + willGo("SOFA_NO_COVERING_BATCH")} order(s) (the three SOFA_* causes)`);
  log(`   once an allocator recompute runs:       ${willGo("STALE_STATUS_SHOULD_BE_READY")} order(s) (STALE_STATUS_SHOULD_BE_READY)`);
  log(`   needs a HUMAN decision, will not self-heal: ${willGo("SO_IS_DRAFT") + willGo("GATE_NO_PROCESSING_DATE") + willGo("CLASSIFICATION_MISC") + willGo("NO_STOCK_ANYWHERE") + willGo("LINE_HAS_NO_WAREHOUSE") + willGo("STOCK_IN_ANOTHER_WAREHOUSE") + willGo("VARIANT_KEY_MISMATCH") + willGo("CLAIMED_BY_EARLIER_ORDER") + willGo("DEDICATED_PO_PARTIAL")} order(s)`);
  log(`   cannot yet be explained by this check:  ${willGo("CANNOT_DETERMINE") + willGo("NO_BLOCKING_LINE_FOUND")} order(s)`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
