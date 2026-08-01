// Stamp the PROVABLE purchase_order_items.so_item_id links — the hard PO<->SO
// binding the sofa drop-ship guard needs (resolveExpectedBatchBySoItem) and the
// one po-so-coverage.ts calls layer (b) STORED ORIGIN.
//
// RUN THIS AFTER repair-2990-doc-refs.mjs. Tier 1 below joins on
// inventory_movements.batch_no / inventory_lots.batch_no = purchase_orders
// .po_number. While the 2990 batches still name PRE-IMPORT numbers that join
// misses entirely, so Tier 1 silently finds nothing. The repair is what makes
// the delivered chain visible; this is what turns it into stored links.
//
// TWO TIERS, both provable, in precedence order — the same order
// po-so-coverage.ts resolves an Assigned SO in:
//
//   Tier 1  DELIVERED (layer a).  The goods physically shipped: a DO consumed a
//           lot stamped batch_no = this PO number, or its OUT movement carries
//           that batch. The SO comes from the ACTUAL DO->SO linkage
//           (delivery_order_items.so_item_id). This is a record of what
//           happened, not an inference.
//
//   Tier 2  NOTE NAMES EXACTLY ONE SO (layer b).  The PO's own "From SOs: …"
//           note — written at raise time by the SO->PO convert
//           (mfg-purchase-orders.ts) — names ONE valid, company-owned Sales
//           Order. With one SO there is no question which order a line served.
//
// In BOTH tiers a line is written only when the item code pairs 1:1 (exactly
// one still-unlinked PO line and one still-free SO line carry it) — the shared
// rule in lib/po-so-line-pairing.mjs, the same one link-po-to-so.mjs applies by
// hand.
//
// WHAT THIS DELIBERATELY DOES NOT WRITE, and why:
//   · A PO whose note names TWO OR MORE SOs. Which line served which order is
//     recorded NOWHERE — not in the note, not on the line. Any split would be a
//     guess, and a guess stamped into so_item_id is indistinguishable from a
//     fact afterwards. Reported, never written.
//   · A PO line with no delivered chain and no note. There is no evidence.
//   · Anything MRP-derived (po-so-coverage layer (c)). That allocation is
//     FLOATING by design — it shifts as demand moves and evaporates on
//     delivery. Freezing today's allocation into a stored link would turn a
//     live computation into a permanent, wrong record. This script never even
//     calls the MRP engine.
//
// DRY-RUN by default. APPLY=1 to write. Idempotent: a stamped line is no longer
// unlinked, so a re-run plans zero rows.
//
//   DATABASE_URL  required (env, or .dev.vars for local use)
//   APPLY=1       write. Anything else is a dry run.
//   TIER          all (default) | 1 | 2
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { pairPoLinesToSoLines } from "./lib/po-so-line-pairing.mjs";
import { parseFromSosTokens } from "./lib/doc-ref-repair-core.mjs";

const APPLY = process.env.APPLY === "1";
const TIER = (process.env.TIER || "all").trim().toLowerCase();
if (!["all", "1", "2"].includes(TIER)) {
  console.error(`TIER must be all | 1 | 2 (got "${TIER}")`);
  process.exit(2);
}
const doTier1 = TIER === "all" || TIER === "1";
const doTier2 = TIER === "all" || TIER === "2";

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

try {
  log(`=== backfill-po-so-item-links  mode=${APPLY ? "APPLY" : "DRY-RUN"}  tier=${TIER} ===`);

  // Every PO line, so the pairing sees the PO's WHOLE shape (a line that is
  // already linked still occupies its item code).
  const poLines = await pg`
    SELECT i.id, i.purchase_order_id, i.material_code AS item_code, i.so_item_id,
           p.po_number, p.company_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id`;
  const linesByPo = new Map();
  const poMeta = new Map();
  for (const l of poLines) {
    const arr = linesByPo.get(l.purchase_order_id) ?? [];
    arr.push({ id: l.id, item_code: l.item_code, so_item_id: l.so_item_id });
    linesByPo.set(l.purchase_order_id, arr);
    poMeta.set(l.purchase_order_id, { poNumber: l.po_number, companyId: Number(l.company_id) });
  }
  const totalLines = poLines.length;
  const unlinkedLines = poLines.filter((l) => !l.so_item_id).length;
  log(`purchase_order_items: ${totalLines} lines, ${unlinkedLines} without a so_item_id.`);

  // An SO line already claimed by SOME PO line is unavailable everywhere —
  // loaded once, and extended as this run plans links so two POs in the same
  // run can never both claim it.
  const takenRows = await pg`
    SELECT DISTINCT so_item_id FROM scm.purchase_order_items WHERE so_item_id IS NOT NULL`;
  const taken = new Set(takenRows.map((r) => r.so_item_id));

  /* poId -> Map(lineId -> soItemId) planned this run, and the tier that proved
     it. Tier 1 is filled first so Tier 2 can never overwrite a delivered fact
     with a note-derived one. */
  const planned = new Map();
  const tierOfPo = new Map();
  const claim = (poId, pairs, tier) => {
    if (pairs.length === 0) return 0;
    const m = planned.get(poId) ?? new Map();
    for (const p of pairs) {
      m.set(p.poLineId, p.soLineId);
      taken.add(p.soLineId);
    }
    planned.set(poId, m);
    tierOfPo.set(poId, tierOfPo.get(poId) ?? tier);
    return pairs.length;
  };
  /* A PO line planned by an earlier tier must look "already linked" to a later
     one, or Tier 2 would pair it a second time against a different SO. */
  const linesFor = (poId) => {
    const done = planned.get(poId);
    return (linesByPo.get(poId) ?? []).map((l) =>
      done?.has(l.id) ? { ...l, so_item_id: done.get(l.id) } : l);
  };

  const ambiguousReport = [];

  // ── Tier 1 — the DELIVERED chain ──────────────────────────────────────────
  let tier1Links = 0;
  let tier1Pos = 0;
  if (doTier1) {
    /* The (PO, DO, product_code) buckets whose goods actually shipped, from BOTH
       ledger shapes: the drop-ship / allocated-batch OUT movement carries the PO
       number on itself, while a plain-FIFO OUT is un-batched and its CONSUMED
       LOT carries it (GRN-stamped, mig 0120). Cancelled DOs are excluded: a
       cancelled DO delivered nothing. Everything is joined inside ONE company —
       the batch string alone is not identity, which is the whole reason the
       Tier 0 repair exists. */
    const chain = await pg`
      WITH mov AS (
        SELECT DISTINCT m.batch_no AS po_number, m.company_id, m.source_doc_id AS do_id,
               m.product_code
          FROM scm.inventory_movements m
         WHERE m.source_doc_type = 'DO'
           AND m.movement_type = 'OUT'
           AND m.batch_no IS NOT NULL
           AND m.source_doc_id IS NOT NULL
      ), con AS (
        SELECT DISTINCT l.batch_no AS po_number, c.company_id, c.source_doc_id AS do_id,
               c.product_code
          FROM scm.inventory_lot_consumptions c
          JOIN scm.inventory_lots l ON l.id = c.lot_id
         WHERE c.source_doc_type = 'DO'
           AND l.batch_no IS NOT NULL
           AND c.source_doc_id IS NOT NULL
      ), chain AS (
        SELECT * FROM mov UNION SELECT * FROM con
      )
      SELECT p.id AS po_id, p.po_number, p.company_id,
             di.so_item_id, si.item_code, si.doc_no
        FROM chain ch
        JOIN scm.purchase_orders p
          ON p.po_number = ch.po_number AND p.company_id = ch.company_id
        JOIN scm.delivery_orders d
          ON d.id = ch.do_id AND d.company_id = ch.company_id
         AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'
        JOIN scm.delivery_order_items di
          ON di.delivery_order_id = d.id
         AND di.item_code = ch.product_code
         AND di.so_item_id IS NOT NULL
        JOIN scm.mfg_sales_order_items si
          ON si.id = di.so_item_id AND si.company_id = p.company_id`;

    const soLinesByPo = new Map();
    for (const r of chain) {
      const m = soLinesByPo.get(r.po_id) ?? new Map();
      m.set(r.so_item_id, { id: r.so_item_id, item_code: r.item_code, doc_no: r.doc_no });
      soLinesByPo.set(r.po_id, m);
    }
    log("");
    log(`=== Tier 1 — DELIVERED chain: ${soLinesByPo.size} PO(s) whose goods shipped to a known SO line ===`);
    for (const [poId, soMap] of soLinesByPo) {
      const meta = poMeta.get(poId);
      if (!meta) continue;
      const res = pairPoLinesToSoLines(linesFor(poId), [...soMap.values()], taken);
      for (const a of res.ambiguous) {
        ambiguousReport.push(`    tier1 ${meta.poNumber}: "${a.code}" — ${a.unlinkedPoLines} unlinked PO line(s) vs ${a.freeSoLines} free SO line(s); which served which is not recorded.`);
      }
      const n = claim(poId, res.pairs, 1);
      if (n > 0) {
        tier1Pos += 1;
        tier1Links += n;
        log(`  ${meta.poNumber} (company ${meta.companyId}): ${n} line(s)`);
        for (const p of res.pairs) {
          const so = soMap.get(p.soLineId);
          log(`    ${p.code}: PO line ${p.poLineId} -> SO line ${p.soLineId} (${so?.doc_no ?? "?"})`);
        }
      }
    }
    log(`  Tier 1 total: ${tier1Links} link(s) across ${tier1Pos} PO(s).`);
  }

  // ── Tier 2 — the note names exactly ONE Sales Order ───────────────────────
  let tier2Links = 0;
  let tier2Pos = 0;
  const multiSoPos = [];
  if (doTier2) {
    const noted = await pg`
      SELECT id, po_number, company_id, notes
        FROM scm.purchase_orders
       WHERE notes IS NOT NULL AND notes ~* 'From SOs?:'
       ORDER BY po_number`;
    // Validate every token against a REAL, company-owned Sales Order. An
    // unresolvable token is not an SO — it is exactly what Tier 0 repairs, and
    // until it resolves it must not produce a link.
    const allTokens = new Set();
    for (const p of noted) for (const t of parseFromSosTokens(p.notes)) allTokens.add(t);
    const soHeaders = allTokens.size
      ? await pg`
          SELECT doc_no, company_id FROM scm.mfg_sales_orders
           WHERE doc_no = ANY(${[...allTokens]})`
      : [];
    const ownersByDoc = new Map();
    for (const h of soHeaders) {
      const arr = ownersByDoc.get(String(h.doc_no)) ?? [];
      arr.push(Number(h.company_id));
      ownersByDoc.set(String(h.doc_no), arr);
    }

    const singles = [];
    for (const p of noted) {
      const cid = Number(p.company_id);
      const valid = parseFromSosTokens(p.notes)
        .filter((t) => (ownersByDoc.get(t) ?? []).includes(cid));
      if (valid.length === 1) singles.push({ ...p, soDoc: valid[0] });
      else if (valid.length > 1) multiSoPos.push({ ...p, sos: valid });
    }

    log("");
    log(`=== Tier 2 — note names exactly ONE valid SO: ${singles.length} PO(s) ===`);
    const wantDocs = [...new Set(singles.map((s) => s.soDoc))];
    const soLineRows = wantDocs.length
      ? await pg`
          SELECT id, doc_no, item_code, company_id
            FROM scm.mfg_sales_order_items
           WHERE doc_no = ANY(${wantDocs}) AND cancelled = false`
      : [];
    const soLinesByDoc = new Map();
    for (const l of soLineRows) {
      const arr = soLinesByDoc.get(String(l.doc_no)) ?? [];
      arr.push({ id: l.id, item_code: l.item_code, companyId: Number(l.company_id) });
      soLinesByDoc.set(String(l.doc_no), arr);
    }
    for (const s of singles) {
      const cid = Number(s.company_id);
      const soLines = (soLinesByDoc.get(s.soDoc) ?? []).filter((l) => l.companyId === cid);
      if (soLines.length === 0) continue;
      const res = pairPoLinesToSoLines(linesFor(s.id), soLines, taken);
      for (const a of res.ambiguous) {
        ambiguousReport.push(`    tier2 ${s.po_number}: "${a.code}" — ${a.unlinkedPoLines} unlinked PO line(s) vs ${a.freeSoLines} free SO line(s) on ${s.soDoc}; which served which is not recorded.`);
      }
      const n = claim(s.id, res.pairs, 2);
      if (n > 0) {
        tier2Pos += 1;
        tier2Links += n;
        log(`  ${s.po_number} (company ${cid}) -> ${s.soDoc}: ${n} line(s)`);
        for (const p of res.pairs) log(`    ${p.code}: PO line ${p.poLineId} -> SO line ${p.soLineId}`);
      }
    }
    log(`  Tier 2 total: ${tier2Links} link(s) across ${tier2Pos} PO(s).`);
  }

  // ── What is deliberately NOT written ──────────────────────────────────────
  log("");
  log("=== REPORT ONLY — evidence exists but is not sufficient to write ===");
  log(`  POs whose note names 2 or more SOs: ${multiSoPos.length}`);
  for (const p of multiSoPos) {
    const unlinked = (linesFor(p.id) ?? []).filter((l) => !l.so_item_id).length;
    log(`    ${p.po_number} (company ${p.company_id}): ${p.sos.length} SOs [${p.sos.join(", ")}], ${unlinked} unlinked line(s)`);
  }
  log("  Which line served which of those orders is recorded nowhere — not in the note, not on the line. Splitting them would be a guess. Left for a human.");

  const plannedLineIds = new Set([...planned.values()].flatMap((m) => [...m.keys()]));
  const noEvidence = poLines.filter((l) => !l.so_item_id && !plannedLineIds.has(l.id));
  const noEvidenceInMulti = new Set(multiSoPos.map((p) => p.id));
  const trulyNoEvidence = noEvidence.filter((l) => !noEvidenceInMulti.has(l.purchase_order_id));
  log("");
  log(`  PO lines still unlinked after both tiers: ${noEvidence.length}`);
  log(`    of which on a multi-SO note PO (above)                 : ${noEvidence.length - trulyNoEvidence.length}`);
  log(`    of which have NO delivered chain and NO usable note    : ${trulyNoEvidence.length}`);
  for (const l of trulyNoEvidence.slice(0, 100)) {
    log(`      ${l.po_number} (company ${l.company_id})  ${l.item_code ?? "-"}  line ${l.id}`);
  }
  if (trulyNoEvidence.length > 100) log(`      … and ${trulyNoEvidence.length - 100} more`);
  if (ambiguousReport.length > 0) {
    log("");
    log(`  Item codes that did not pair 1:1 and were skipped: ${ambiguousReport.length}`);
    for (const a of ambiguousReport) log(a);
  }
  log("");
  log("  MRP-derived coverage (po-so-coverage layer (c)) is NOT considered at all.");
  log("  That allocation is floating by design: it shifts as demand moves and evaporates on delivery.");
  log("  Freezing it into a stored link would turn a live computation into a permanent, wrong record.");

  const totalPlanned = [...planned.values()].reduce((s, m) => s + m.size, 0);
  log("");
  log("================ summary ================");
  log(`  Tier 1 (delivered chain)      : ${tier1Links} link(s)`);
  log(`  Tier 2 (note names ONE SO)    : ${tier2Links} link(s)`);
  log(`  TOTAL purchase_order_items rows that would be stamped: ${totalPlanned}`);

  if (!APPLY) {
    log("");
    log("DRY-RUN — nothing was written. Re-run with apply=1 to stamp these links.");
  } else {
    /* One transaction: a half-applied set of links would leave the drop-ship
       guard offering some lines of an order and hard-blocking the rest. Each
       UPDATE re-asserts `so_item_id IS NULL`, so a link written by anyone else
       between the plan and the write is left alone rather than overwritten. */
    const written = await pg.begin(async (tx) => {
      let n = 0;
      for (const [poId, m] of planned) {
        for (const [lineId, soItemId] of m) {
          const res = await tx`
            UPDATE scm.purchase_order_items
               SET so_item_id = ${soItemId}
             WHERE id = ${lineId} AND so_item_id IS NULL`;
          n += res.count;
          if (res.count === 0) {
            log(`  SKIPPED PO ${poMeta.get(poId)?.poNumber ?? poId} line ${lineId}: already linked by someone else.`);
          }
        }
      }
      return n;
    });
    log(`APPLIED: ${written} purchase_order_items row(s) stamped, in one transaction.`);
    log("Re-run in DRY-RUN to confirm the plan is now empty (the idempotence check).");
  }
} finally {
  await pg.end({ timeout: 5 });
}
