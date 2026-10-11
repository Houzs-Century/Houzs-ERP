// Stamp inventory_lots.batch_no (= source PO number) from DOCUMENT EVIDENCE,
// for lots that carry none — the durable half of the owner's traceability rule
// (2026-08-01): "系统里只要显示 Ready，肯定就代表有货；既然有货，Inventory 里就
// 绝对会有记录，写明这批货对应的是哪一个 PO。" The read path GRN-heals at query
// time (scm/lib/source-po-trace.ts); THIS makes the answer durable so every
// consumer — including raw SQL and the audit scripts — sees it.
//
// EVIDENCE CLASSES (a lot is stamped ONLY from a document trail it itself
// names; nothing is inferred from demand, MRP, or quantity):
//
//   grn         source_doc_type='GRN' → grns.purchase_order_id →
//               purchase_orders.po_number. The exact stamp migration 0120
//               applies at receipt time, applied retroactively from the same
//               join. The lot's own IN movement (movement_id, else the GRN's
//               movement in the same bucket) is stamped IN THE SAME
//               TRANSACTION — a lot/movement batch split is the partial-rename
//               fault docs/modules/document-traceability.md forbids.
//
//   basis-seed  notes LIKE 'repair:uncosted-out-basis%' — the W3 reference-
//               cost lots seeded by backfill-fifo-divergence.mjs MODE=basis-cost.
//               Their INSERT wrote batch_no NULL (verified in source), but the
//               seed PRINTED its basis into the notes: "(basis GRN <doc> @ …)"
//               or "(basis PO <doc> @ …)". Basis PO → that po_number; basis
//               GRN → that GRN's PO. This is what makes e.g. 2990-DO-2607-009's
//               TRION-(K) resolve: its OUT consumed a basis-seeded lot, so the
//               delivered trace ends here until this stamp lands. These lots
//               have no movement (movement_id NULL) — lot-only stamp.
//
//   adjustment  source_doc_type='ADJUSTMENT' — free gifts / cancel add-backs.
//               Legitimately PO-less BY DESIGN: never stamped. The UI shows
//               "STOCK ADJ" for these (source-po-trace classifies them), so
//               they are explained, not blank. Counted per company.
//
//   unbatchable everything else (NULL source, TRANSFER, PCR, DR, pre-import
//               receipts with no resolvable GRN). Counted and listed with the
//               reason — the check-so-source-trace.mjs report carries the
//               owner-facing classification.
//
// REFUSALS (per row, printed): GRN row unresolvable / resolving to 0 or >1
// documents, GRN with no purchase_order_id, resolved PO in a DIFFERENT company
// than the lot, the lot's movement already carrying a DIFFERENT batch, or a
// basis marker whose doc no longer resolves. Refused rows are never written.
//
// For every planned stamp the script prints the DELIVERY ORDERS whose source
// trace the stamp completes (consumptions of that lot), so the effect is
// visible before APPLY.
//
// DRY-RUN by default; APPLY=1 to write. Idempotent: a stamped lot no longer has
// NULL batch_no, so a re-run plans zero rows. Ledger timestamps untouched.
// PART=all|grn|basis-seed limits which evidence class is stamped.
//
//   DATABASE_URL  required (env, or .dev.vars for local use)
//   APPLY=1       write. Anything else is a dry run.
//   PART          all (default) | grn | basis-seed
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const PART = (process.env.PART || "all").trim().toLowerCase();
if (!["all", "grn", "basis-seed"].includes(PART)) {
  console.error(`PART must be all | grn | basis-seed (got "${PART}")`);
  process.exit(2);
}
const doGrn = PART === "all" || PART === "grn";
const doBasis = PART === "all" || PART === "basis-seed";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const BASIS_RE = /\(basis (GRN|PO) (\S+) @ /;

try {
  log(`=== backfill-lot-batch-from-docs  mode=${APPLY ? "APPLY" : "DRY-RUN"}  part=${PART} ===`);

  // Every lot with no batch — OPEN AND CONSUMED both: a fully-consumed lot
  // still carries the delivered trace (consumption → lot → batch_no).
  const lots = await pg`
    SELECT l.id::text AS id, l.company_id, l.warehouse_id::text AS warehouse_id,
           l.product_code, COALESCE(l.variant_key,'') AS variant_key,
           l.qty_received, l.qty_remaining, l.received_at,
           l.source_doc_type, l.source_doc_id::text AS source_doc_id, l.source_doc_no,
           l.movement_id::text AS movement_id, l.notes
      FROM scm.inventory_lots l
     WHERE l.batch_no IS NULL OR btrim(l.batch_no) = ''
     ORDER BY l.received_at, l.id`;
  log(`lots with NULL/empty batch_no: ${lots.length}`);

  // Company code map, purely for readable output.
  const companies = await pg`SELECT id, code FROM public.companies`;
  const companyCode = new Map(companies.map((r) => [Number(r.id), r.code]));
  const co = (id) => companyCode.get(Number(id)) ?? `company#${id}`;

  const classes = { grn: [], "basis-seed": [], adjustment: [], unbatchable: [] };
  for (const l of lots) {
    const src = (l.source_doc_type ?? "").toUpperCase();
    const notes = l.notes ?? "";
    if (src === "GRN") classes.grn.push(l);
    else if (notes.startsWith("repair:uncosted-out-basis")) classes["basis-seed"].push(l);
    else if (src === "ADJUSTMENT") classes.adjustment.push(l);
    else classes.unbatchable.push(l);
  }
  log(`classes: grn=${classes.grn.length}  basis-seed=${classes["basis-seed"].length}  adjustment=${classes.adjustment.length} (PO-less by design, never stamped)  unbatchable=${classes.unbatchable.length}`);

  // ── Resolve evidence per stampable lot ────────────────────────────────────
  // plans: { lot, poNumber, evidence, movementIds: string[] }
  const plans = [];
  const refusals = []; // { lot, reason }

  if (doGrn && classes.grn.length > 0) {
    // GRN → PO join, by the lot's own source_doc_id (preferred) then by
    // (company, grn_number = source_doc_no) requiring EXACTLY one match.
    const grnIds = [...new Set(classes.grn.map((l) => l.source_doc_id).filter(Boolean))];
    const grnById = new Map();
    if (grnIds.length > 0) {
      const rows = await pg`
        SELECT g.id::text AS id, g.grn_number, g.company_id, g.purchase_order_id::text AS purchase_order_id,
               p.po_number, p.company_id AS po_company_id
          FROM scm.grns g
          LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
         WHERE g.id::text = ANY(${grnIds})`;
      for (const r of rows) grnById.set(r.id, r);
    }
    for (const l of classes.grn) {
      let g = l.source_doc_id ? grnById.get(l.source_doc_id) : undefined;
      if (!g && l.source_doc_no) {
        const rows = await pg`
          SELECT g.id::text AS id, g.grn_number, g.company_id, g.purchase_order_id::text AS purchase_order_id,
                 p.po_number, p.company_id AS po_company_id
            FROM scm.grns g
            LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
           WHERE g.company_id = ${l.company_id} AND g.grn_number = ${l.source_doc_no}`;
        if (rows.length === 1) g = rows[0];
        else if (rows.length > 1) { refusals.push({ lot: l, reason: `grn-ambiguous: ${rows.length} GRNs named ${l.source_doc_no} in ${co(l.company_id)}` }); continue; }
      }
      if (!g) { refusals.push({ lot: l, reason: `grn-unresolved: source ${l.source_doc_no ?? l.source_doc_id ?? "?"} matches no GRN` }); continue; }
      if (!g.purchase_order_id || !g.po_number) { refusals.push({ lot: l, reason: `grn-no-po: GRN ${g.grn_number} carries no purchase_order_id (manual receipt)` }); continue; }
      if (Number(g.po_company_id) !== Number(l.company_id)) { refusals.push({ lot: l, reason: `cross-company: lot is ${co(l.company_id)} but PO ${g.po_number} is ${co(g.po_company_id)}` }); continue; }
      plans.push({ lot: l, poNumber: g.po_number, evidence: `GRN ${g.grn_number} -> PO ${g.po_number}` });
    }
  }

  if (doBasis && classes["basis-seed"].length > 0) {
    for (const l of classes["basis-seed"]) {
      const m = BASIS_RE.exec(l.notes ?? "");
      if (!m) { refusals.push({ lot: l, reason: "basis-marker-unparseable: notes carry the marker but no '(basis GRN|PO <doc> @' clause" }); continue; }
      const [, kind, docNo] = m;
      if (kind === "PO") {
        const rows = await pg`
          SELECT id, po_number, company_id FROM scm.purchase_orders
           WHERE company_id = ${l.company_id} AND po_number = ${docNo}`;
        if (rows.length !== 1) { refusals.push({ lot: l, reason: `basis-po-unresolved: PO ${docNo} matches ${rows.length} documents in ${co(l.company_id)}` }); continue; }
        plans.push({ lot: l, poNumber: rows[0].po_number, evidence: `basis PO ${docNo} (seed log)` });
      } else {
        const rows = await pg`
          SELECT g.grn_number, g.purchase_order_id, p.po_number, p.company_id AS po_company_id
            FROM scm.grns g
            LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
           WHERE g.company_id = ${l.company_id} AND g.grn_number = ${docNo}`;
        if (rows.length !== 1) { refusals.push({ lot: l, reason: `basis-grn-unresolved: GRN ${docNo} matches ${rows.length} documents in ${co(l.company_id)}` }); continue; }
        const g = rows[0];
        if (!g.po_number) { refusals.push({ lot: l, reason: `basis-grn-no-po: GRN ${docNo} carries no purchase_order_id` }); continue; }
        if (Number(g.po_company_id) !== Number(l.company_id)) { refusals.push({ lot: l, reason: `cross-company: basis GRN ${docNo}'s PO ${g.po_number} is ${co(g.po_company_id)}` }); continue; }
        plans.push({ lot: l, poNumber: g.po_number, evidence: `basis GRN ${docNo} -> PO ${g.po_number} (seed log)` });
      }
    }
  }

  // ── Movement pairing + affected-DO evidence per plan ─────────────────────
  for (const p of plans) {
    const l = p.lot;
    p.movementIds = [];
    if (l.movement_id) {
      const mv = await pg`
        SELECT id::text AS id, batch_no FROM scm.inventory_movements WHERE id::text = ${l.movement_id}`;
      const row = mv[0];
      if (row) {
        if (row.batch_no && row.batch_no !== p.poNumber) {
          p.conflict = `movement ${row.id} already carries batch '${row.batch_no}' != '${p.poNumber}'`;
        } else if (!row.batch_no) {
          p.movementIds.push(row.id);
        } // equal batch → movement already right, lot-only stamp
      }
    } else if ((l.source_doc_type ?? "").toUpperCase() === "GRN" && l.source_doc_id) {
      // No movement_id on the lot — pair by the GRN's IN movement in the SAME
      // bucket, only when exactly one NULL-batch candidate exists.
      const mv = await pg`
        SELECT id::text AS id, batch_no FROM scm.inventory_movements
         WHERE movement_type = 'IN' AND source_doc_type = 'GRN'
           AND source_doc_id::text = ${l.source_doc_id}
           AND warehouse_id::text = ${l.warehouse_id}
           AND product_code = ${l.product_code}
           AND COALESCE(variant_key,'') = ${l.variant_key}
           AND company_id = ${l.company_id}`;
      const conflicting = mv.find((r) => r.batch_no && r.batch_no !== p.poNumber);
      const nullBatch = mv.filter((r) => !r.batch_no);
      if (conflicting) p.conflict = `sibling movement ${conflicting.id} carries batch '${conflicting.batch_no}' != '${p.poNumber}'`;
      else if (nullBatch.length === 1) p.movementIds.push(nullBatch[0].id);
      else if (nullBatch.length > 1) p.note = `${nullBatch.length} NULL-batch IN movements in the bucket — lot-only stamp (movement pairing ambiguous)`;
    }
    // Which DOs' delivered trace this stamp completes (visible effect).
    const dos = await pg`
      SELECT DISTINCT c.source_doc_no
        FROM scm.inventory_lot_consumptions c
       WHERE c.lot_id::text = ${l.id} AND c.source_doc_type = 'DO'`;
    p.affectedDos = dos.map((d) => d.source_doc_no).filter(Boolean).sort();
  }
  const conflicted = plans.filter((p) => p.conflict);
  for (const p of conflicted) refusals.push({ lot: p.lot, reason: `batch-conflict: ${p.conflict}` });
  const writable = plans.filter((p) => !p.conflict);

  // ── Report ────────────────────────────────────────────────────────────────
  log("");
  log(`PLANNED STAMPS: ${writable.length}  (grn part ${doGrn ? "on" : "off"}, basis part ${doBasis ? "on" : "off"})`);
  for (const p of writable) {
    const l = p.lot;
    log(`  lot ${l.id}  ${co(l.company_id)}  ${l.product_code}${l.variant_key ? ` [${l.variant_key}]` : ""}  recv=${l.qty_received} rem=${l.qty_remaining}  batch NULL -> '${p.poNumber}'`);
    log(`      evidence: ${p.evidence}${p.movementIds.length ? `; also stamps IN movement ${p.movementIds.join(", ")}` : "; lot-only (no NULL-batch movement to pair)"}${p.note ? `; ${p.note}` : ""}`);
    if (p.affectedDos.length > 0) log(`      completes the delivered trace of: ${p.affectedDos.join(", ")}`);
  }
  log("");
  log(`REFUSED: ${refusals.length}`);
  for (const r of refusals) {
    log(`  lot ${r.lot.id}  ${co(r.lot.company_id)}  ${r.lot.product_code}  ${r.reason}`);
  }
  log("");
  log(`CLASSIFIED, NEVER STAMPED:`);
  log(`  adjustment (PO-less by design — UI shows STOCK ADJ): ${classes.adjustment.length}`);
  for (const l of classes.adjustment) {
    log(`    lot ${l.id}  ${co(l.company_id)}  ${l.product_code}  recv=${l.qty_received} rem=${l.qty_remaining}  src=${l.source_doc_no ?? "-"}`);
  }
  log(`  unbatchable (no document evidence): ${classes.unbatchable.length}`);
  for (const l of classes.unbatchable) {
    log(`    lot ${l.id}  ${co(l.company_id)}  ${l.product_code}  recv=${l.qty_received} rem=${l.qty_remaining}  src_type=${l.source_doc_type ?? "NULL"} src=${l.source_doc_no ?? "-"}${(l.notes ?? "").startsWith("repair:") ? `  notes=${(l.notes ?? "").slice(0, 60)}...` : ""}`);
  }

  // ── APPLY ─────────────────────────────────────────────────────────────────
  if (!APPLY) {
    log("");
    log(`DRY-RUN complete — ${writable.length} stamp(s) planned, ${refusals.length} refused. APPLY=1 to write.`);
  } else {
    let stamped = 0;
    for (const p of writable) {
      const l = p.lot;
      await pg.begin(async (sql) => {
        // Re-check inside the transaction — idempotent + race-safe.
        const cur = await sql`
          SELECT batch_no FROM scm.inventory_lots WHERE id::text = ${l.id} FOR UPDATE`;
        const nowBatch = cur[0]?.batch_no ?? null;
        if (nowBatch && btrimmed(nowBatch) !== "") {
          if (nowBatch !== p.poNumber) throw new Error(`lot ${l.id} batch changed underneath to '${nowBatch}' — refusing`);
          return; // already stamped (re-run)
        }
        await sql`
          UPDATE scm.inventory_lots SET batch_no = ${p.poNumber} WHERE id::text = ${l.id}`;
        for (const mid of p.movementIds) {
          await sql`
            UPDATE scm.inventory_movements SET batch_no = ${p.poNumber}
             WHERE id::text = ${mid} AND (batch_no IS NULL OR btrim(batch_no) = '')`;
        }
      });
      stamped += 1;
      log(`APPLIED  lot ${l.id} -> '${p.poNumber}'${p.movementIds.length ? ` (+ movement ${p.movementIds.join(", ")})` : ""}`);
    }
    log("");
    log(`APPLY complete — ${stamped} lot(s) stamped, ${refusals.length} refused (untouched).`);
  }
} finally {
  await pg.end({ timeout: 5 });
}

function btrimmed(s) {
  return String(s ?? "").trim();
}
