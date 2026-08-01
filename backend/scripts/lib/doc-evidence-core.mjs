// PURE core of the 2026-08 DOCUMENT-EVIDENCE resolution round (owner rejection
// of "stocktake/manual" for the audit residuals, 2026-08-01: "为什么你不看
// SO PO DO GR 去解决呢？" / "为什么要手动分配的 你根据FIFO 就没问题了啊？").
// No database, no I/O — every rule that decides whether a ledger row, a PO
// allocation, or an SO line may be written is unit-testable here, and the
// scripts that talk to production carry no judgement of their own (the
// doc-ref-repair-core.mjs / ledger-repair-core.mjs discipline, verbatim).
//
// THE EVIDENCE LAYER these rules exploit, which every earlier repair ignored:
// the DOCUMENT LINES. SO/PO/DO/GRN lines carry their OWN variants JSON (and
// the SO line its warehouse), so a ledger row's TRUE variant key is computable
// from the paperwork that moved the goods — independently of the (import-
// damaged) ledger labels the earlier relabel had to rely on:
//
//   OUT movement -> its DO -> delivery_order_items (variants, so_item_id)
//                          -> mfg_sales_order_items (variants, warehouse_id)
//   IN movement / lot -> its GRN -> grn_items (variants, purchase_order_item_id)
//                               -> purchase_order_items (variants)
//
// Three rule families:
//   R1  planDocKeyAlignment / resolveDocLineKey — relabel ledger rows to the
//       key their OWN document lines prove (MODE=doc-relabel), and
//       planOverConsumedCorrection — re-point over-attributed consumptions to
//       the sibling receipt the documents prove covered them (audit 2a's
//       over-consumed arm, which reconstruct rightly refused).
//   R2  planFifoAttribution — the owner's stated rule for consolidated POs
//       whose lines could not pair 1:1: identical-product attribution is
//       FIFO by SO delivery date (the same deterministic order computeMrp
//       allocates in), written as purchase_order_item_allocations rows so the
//       provenance is visibly "allocation", never a fabricated so_item_id.
//   R3  classifySoLineWarehouse — document-evidence order for the SO lines
//       whose header resolves no warehouse: the line's own DO movement, else
//       whole-SO sibling agreement, else the company's single active
//       warehouse; mirror-owned (company-2990) rows are REPORTED, not written,
//       because so-mirror.ts drains delete-then-insert and would wipe them.

import { variantKeyMirror } from "./ledger-repair-core.mjs";

/* Shared with computeMrp's greedy allocator (mrp.ts byDateAsc): dates ascend,
 * NULL sorts LAST — an undated demand never queue-jumps a dated one. */
export function byDateAscNullsLast(a, b) {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
}

const cmpStr = (a, b) => String(a ?? "").localeCompare(String(b ?? ""));

// ─────────────────────────────────────────────────────────────────────────────
// R1a — the document-line key, with corroboration.
// ─────────────────────────────────────────────────────────────────────────────

/** VARIANT-KEY QUOTE DOUBLING (live doc-relabel run, 2026-08-01): the residual
 *  family's keys carry a DOUBLED inch mark — `legheight=1""` where the
 *  document (and the sibling receipts) say `1"`. The mint is hand-keyed
 *  option-pool DATA (every editor in this repo and in the 2990 POS is
 *  pool-driven; no code path appends a quote), imported verbatim, so the same
 *  physical goods split across two keys that differ only by the doubling.
 *  Two keys are treated as EQUIVALENT when identical after collapsing any run
 *  of double-quote marks to a single mark and trimming trailing whitespace.
 *  The CANONICAL form is the collapsed one — a relabel that matches only
 *  under this normalization lands on the canonical key, never the doubled
 *  one, so the split converges instead of persisting under a new spelling.
 *  computeVariantKey itself is deliberately NOT changed: rewriting its norm()
 *  would silently re-key every existing bucket. */
export function normalizeVariantKeyQuotes(key) {
  return String(key ?? "").replace(/"{2,}/g, '"').replace(/\s+$/, "");
}

/** Compute ONE document line's TRUE variant key, corroborated by the line it
 *  references upstream (DO line -> its SO line; GRN line -> its PO line).
 *
 *  Both sides are quote-normalized (normalizeVariantKeyQuotes) BEFORE any
 *  comparison, and the returned key IS the canonical (normalized) form — a
 *  document whose own variants carry the doubling still proves the canonical
 *  key, it does not propagate the damage.
 *
 *  Empty keys are "unclassified", not a claim (variant-key.ts: legacy rows
 *  carry ''), so a line whose own variants compute '' DEFERS to a non-empty
 *  corroborating key — the SO/PO is the origin document the variants were
 *  copied from. Two NON-empty keys disagreeing is a real documents-disagree:
 *  the paperwork itself names two different physical items, and no relabel
 *  rule may pick a side.
 *    corroborated       both sides non-empty and equal, or one side empty and
 *                       the other supplied the key
 *    uncorroborated     no upstream line to check against (weaker, still a
 *                       document); also both-empty (key '')
 *    doc-conflict       both non-empty and different — REFUSE, report both */
export function resolveDocLineKey({ itemGroup, variants, corroborating = null }) {
  const ownKey = normalizeVariantKeyQuotes(variantKeyMirror(itemGroup, variants ?? null));
  if (!corroborating) return { key: ownKey, corroboratingKey: null, verdict: "uncorroborated" };
  const cKey = normalizeVariantKeyQuotes(variantKeyMirror(corroborating.itemGroup ?? itemGroup, corroborating.variants ?? null));
  if (ownKey !== "" && cKey !== "" && ownKey !== cKey) {
    return { key: ownKey, corroboratingKey: cKey, verdict: "doc-conflict" };
  }
  const key = ownKey !== "" ? ownKey : cKey;
  return { key, corroboratingKey: cKey, verdict: key === "" || (ownKey !== "" && cKey !== "") ? "corroborated" : (ownKey === "" ? "corroborated-by-upstream" : "uncorroborated-upstream-empty") };
}

/** Repair-seeded lots are EXPECTED to resolve no purchase document: the
 *  basis-cost seed writes a reference-cost lot with no GRN at all (its own
 *  notes carry the `repair:uncosted-out-basis` marker) and the grn-gap insert
 *  writes an IN movement whose notes carry `repair:grn-inbound-gap` (the
 *  trigger-opened lot copies no notes, so the MOVEMENT's marker is the
 *  evidence). Classifying them `repair-seeded` instead of `no-document` keeps
 *  the stocktake list to TRUE unknowns. */
export function isRepairSeeded({ lotNotes = null, movementNotes = null }) {
  const has = (v) => String(v ?? "").includes("repair:");
  return has(lotNotes) || has(movementNotes);
}

// ─────────────────────────────────────────────────────────────────────────────
// R1b — align one document's ledger rows to that document's own line keys.
// ─────────────────────────────────────────────────────────────────────────────

/** Per (document, product): match the document's LEDGER rows (movements, or
 *  lots) against the document's own LINE keys. A row whose key a clean line
 *  documents is `consistent`. A row whose key NO line documents relabels ONLY
 *  when exactly one documented key is left unclaimed by every row — the same
 *  "unique after removing the matched" discipline as pairPoLinesToSoLines;
 *  quantity is deliberately not a discriminator there and is not one here.
 *
 *  rows:  [{ id, ledgerKey }]
 *  lines: [{ ref, key, conflict }]  — conflict = resolveDocLineKey said
 *         doc-conflict; such a line can prove nothing (poisoned evidence).
 *         Line keys arrive CANONICAL (resolveDocLineKey normalizes).
 *
 *  QUOTE-DOUBLING equivalence: a ledger key equal to a documented key only
 *  after normalizeVariantKeyQuotes is NOT `consistent` — it is a `relabel`
 *  to the document's canonical key, flagged `normalized: true`, so the
 *  doubled spelling converges instead of surviving as "close enough". The
 *  claiming logic runs in normalized space throughout: a `1""` row claims
 *  the `1"` line, so a sibling cannot also take it via the unclaimed path.
 *
 *  Verdicts per row:
 *    consistent         a clean line documents this row's exact key
 *    relabel            newKey = the document's canonical key — either this
 *                       row's key normalized-matches it (normalized: true)
 *                       or it is the single unclaimed documented key; the
 *                       citation is the line that proves it
 *    no-document        the document has no lines at all for this product
 *    ambiguous-doc-keys >1 unclaimed documented key — which is this row's is
 *                       not recorded; refused
 *    doc-conflict       the only unexplained lines are corroboration-
 *                       conflicted — the documents THEMSELVES disagree
 *    extra-vs-doc       every documented key is already claimed by other rows
 *                       — this row is extra against the paperwork */
export function planDocKeyAlignment({ rows = [], lines = [] }) {
  const cleanLines = lines.filter((l) => !l.conflict);
  const conflictLines = lines.filter((l) => l.conflict);
  const lineKeys = new Set(cleanLines.map((l) => l.key ?? ""));
  const lineByNorm = new Map();
  for (const l of cleanLines) {
    const norm = normalizeVariantKeyQuotes(l.key ?? "");
    if (!lineByNorm.has(norm)) lineByNorm.set(norm, l);
  }
  const rowNormKeys = new Set(rows.map((r) => normalizeVariantKeyQuotes(r.ledgerKey ?? "")));
  return rows.map((r) => {
    const ledgerKey = r.ledgerKey ?? "";
    if (lines.length === 0) return { ...r, ledgerKey, verdict: "no-document" };
    if (lineKeys.has(ledgerKey)) {
      return { ...r, ledgerKey, verdict: "consistent", citation: cleanLines.find((l) => (l.key ?? "") === ledgerKey) ?? null };
    }
    const normLine = lineByNorm.get(normalizeVariantKeyQuotes(ledgerKey));
    if (normLine) {
      // Same key up to quote doubling: relabel to the document's CANONICAL key.
      return {
        ...r,
        ledgerKey,
        verdict: "relabel",
        newKey: normLine.key ?? "",
        normalized: true,
        citation: { ...normLine, cite: `key-normalized ("${ledgerKey}" -> "${normLine.key ?? ""}") — ${normLine.cite ?? normLine.ref ?? ""}` },
      };
    }
    // Claiming runs in normalized space: a documented key is unclaimed only
    // when NO row matches it exactly or up to quote doubling.
    const unclaimed = [...lineKeys].filter((k) => !rowNormKeys.has(normalizeVariantKeyQuotes(k)));
    if (unclaimed.length === 1) {
      return { ...r, ledgerKey, verdict: "relabel", newKey: unclaimed[0], citation: cleanLines.find((l) => (l.key ?? "") === unclaimed[0]) ?? null };
    }
    if (unclaimed.length > 1) return { ...r, ledgerKey, verdict: "ambiguous-doc-keys", candidates: unclaimed };
    return { ...r, ledgerKey, verdict: conflictLines.length > 0 ? "doc-conflict" : "extra-vs-doc", conflictLines };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// R1c — the over-consumed lot (audit 2a: consumed > received), corrected from
// the documents. reconstruct classified these and REFUSED (rightly: no
// decrement conserves them). The document chain now proves what happened:
// the excess consumption was ATTRIBUTED to the wrong receipt — the DO really
// shipped those units (its lines say so, net of delivery returns), and a
// sibling lot the documents prove holds the SAME goods still carries the
// unconsumed remainder. The correction re-points the newest excess
// consumption rows onto that sibling (FIFO by receipt date), decrements the
// sibling's qty_remaining (it is now truly consumed), and keeps the 0154
// convention movement.total_cost_sen === Sigma(its consumptions' cost) —
// stamping (and reporting) the RM delta when donor cost differs, refusing
// when the stored cost never followed the convention to begin with.
// ─────────────────────────────────────────────────────────────────────────────

/** lot:          { lotId, qtyReceived, consumed, qtyRemaining }
 *  consumptions: rows ON this lot [{ id, movementId, qty, unitCostSen, consumedAt }]
 *  movements:    the movements those rows belong to, each with its DOCUMENT
 *                verdict: [{ movementId, absQty, storedTotalCostSen,
 *                consumedCostSen (Sigma over ALL its consumption rows),
 *                docNetQty (Sigma DO line qty for the product net of delivery
 *                returns; null = no document found),
 *                ledgerShippedQty (Sigma |qty| of ALL the DO's OUT movements
 *                for the product — the doc-vs-ledger overship test) }]
 *  donors:       sibling lots the DOCUMENTS prove hold the same goods
 *                [{ lotId, qtyRemaining, unitCostSen, receivedAt, docKeyMatches,
 *                   finalKeyMatches }] — docKeyMatches: its GRN line key equals
 *                the consuming movement's document key; finalKeyMatches: after
 *                this run's relabels both sides sit under one ledger key.
 *
 *  Verdicts:
 *    conserves     excess <= 0 — not over-consumed (idempotent re-run)
 *    no-document   a consuming movement resolves NO document — the shipment
 *                  itself is unverifiable; owner/stocktake
 *    doc-overship  the DO's ledger movements EXCEED the document's net qty —
 *                  the document refutes the ledger (duplicate DO line /
 *                  amended qty territory); repointing cannot fix a phantom
 *                  shipment; owner/stocktake with both numbers printed
 *    no-donor      documents back the shipment but no same-goods sibling lot
 *                  has capacity — genuinely no receipt; stocktake list
 *    cost-conflict a movement's stored cost disagrees with its own
 *                  consumption rows BEFORE the move — money already
 *                  contradicts itself; refused
 *    repoint       moves + donorTakes + stamps, rmDeltaSen reported */
export function planOverConsumedCorrection({ lot, consumptions = [], movements = [], donors = [] }) {
  const received = Number(lot.qtyReceived ?? 0);
  const consumed = Number(lot.consumed ?? 0);
  const remaining = Number(lot.qtyRemaining ?? 0);
  const excess = consumed - (received - remaining);
  const base = { lotId: lot.lotId, received, consumed, remaining, excess };
  if (excess <= 0) return { ...base, verdict: "conserves" };

  const noDoc = movements.filter((m) => m.docNetQty == null);
  if (noDoc.length > 0) return { ...base, verdict: "no-document", movements: noDoc.map((m) => m.movementId) };
  const over = movements.filter((m) => Number(m.ledgerShippedQty ?? 0) > Number(m.docNetQty ?? 0));
  if (over.length > 0) {
    return {
      ...base,
      verdict: "doc-overship",
      overships: over.map((m) => ({ movementId: m.movementId, ledgerShippedQty: Number(m.ledgerShippedQty), docNetQty: Number(m.docNetQty) })),
    };
  }

  // Cost honesty must hold BEFORE we touch anything (0154 convention).
  const movById = new Map(movements.map((m) => [m.movementId, m]));
  const conflicts = movements.filter((m) => Number(m.storedTotalCostSen ?? 0) !== Number(m.consumedCostSen ?? 0));
  if (conflicts.length > 0) {
    return {
      ...base,
      verdict: "cost-conflict",
      conflicts: conflicts.map((m) => ({ movementId: m.movementId, storedTotalCostSen: Number(m.storedTotalCostSen ?? 0), consumedCostSen: Number(m.consumedCostSen ?? 0) })),
    };
  }

  const eligible = donors
    .filter((d) => d.docKeyMatches && d.finalKeyMatches !== false && Number(d.qtyRemaining ?? 0) > 0)
    .sort((a, b) => byDateAscNullsLast(a.receivedAt, b.receivedAt) || cmpStr(a.lotId, b.lotId));
  const capacity = eligible.reduce((a, d) => a + Number(d.qtyRemaining ?? 0), 0);
  if (capacity < excess) {
    return { ...base, verdict: "no-donor", donorCapacity: capacity, shortfall: excess - capacity };
  }

  // The excess is the NEWEST-attributed units: FIFO filled the lot oldest-
  // first, so what the lot could not physically cover is the tail. Deterministic:
  // consumed_at DESC, id DESC. Donors are walked FIFO (oldest receipt first).
  const tail = [...consumptions].sort((a, b) => byDateAscNullsLast(b.consumedAt, a.consumedAt) || cmpStr(b.id, a.id));
  const moves = [];
  const donorTakes = new Map();
  let need = excess;
  let di = 0;
  let donorLeft = eligible.map((d) => Number(d.qtyRemaining));
  for (const row of tail) {
    if (need <= 0) break;
    let rowLeft = Math.min(Number(row.qty ?? 0), need);
    while (rowLeft > 0) {
      while (di < eligible.length && donorLeft[di] <= 0) di += 1;
      if (di >= eligible.length) return { ...base, verdict: "no-donor", donorCapacity: capacity, shortfall: rowLeft };
      const take = Math.min(rowLeft, donorLeft[di]);
      const donor = eligible[di];
      moves.push({
        consumptionId: row.id,
        movementId: row.movementId,
        qty: take,
        rowQty: Number(row.qty ?? 0), // the row's stored qty; the caller derives the split remainder as rowQty - Sigma(moves for this consumptionId)
        fromLotId: lot.lotId,
        toLotId: donor.lotId,
        oldUnitCostSen: Number(row.unitCostSen ?? 0),
        newUnitCostSen: Number(donor.unitCostSen ?? 0),
      });
      donorTakes.set(donor.lotId, (donorTakes.get(donor.lotId) ?? 0) + take);
      donorLeft[di] -= take;
      rowLeft -= take;
      need -= take;
    }
  }

  // Movement cost stamps: after the move each movement's Sigma(consumption
  // cost) may change; stored total follows it (the convention held before, so
  // it must hold after) and the RM delta is REPORTED, never silent.
  const deltaByMovement = new Map();
  for (const mv of moves) {
    const d = mv.qty * (mv.newUnitCostSen - mv.oldUnitCostSen);
    deltaByMovement.set(mv.movementId, (deltaByMovement.get(mv.movementId) ?? 0) + d);
  }
  const stamps = [];
  let rmDeltaSen = 0;
  for (const [movementId, delta] of deltaByMovement) {
    if (delta === 0) continue;
    const m = movById.get(movementId);
    stamps.push({ movementId, newTotalCostSen: Number(m?.consumedCostSen ?? 0) + delta, deltaSen: delta });
    rmDeltaSen += delta;
  }
  return {
    ...base,
    verdict: "repoint",
    moves,
    donorTakes: [...donorTakes.entries()].map(([lotId, qty]) => ({ lotId, qty })),
    stamps,
    rmDeltaSen,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// R2 — FIFO attribution for consolidated PO lines (owner's stated rule:
// "为什么要手动分配的 你根据FIFO 就没问题了啊？"). Identical-product
// consolidation attributes by FIFO — the named SOs' free lines in the SAME
// deterministic order computeMrp allocates in (delivery date ASC with NULL
// last, then doc_no ASC — mrp.ts "deterministic same-day allocation"), the PO
// lines in document order (created_at, id — purchase_order_items has no
// line_no). Quantity-aware: a qty-2 PO line covers a qty-2 demand; a qty-5
// line SPLITS across demands and books its remainder as STOCK (so_item_id
// NULL). The result is written as purchase_order_item_allocations rows so the
// provenance is visibly "allocation" — never stamped into so_item_id, where a
// FIFO inference would be indistinguishable from a recorded fact.
// ─────────────────────────────────────────────────────────────────────────────

/** poLines: [{ id, itemCode, qty, soItemId, allocationCount, createdAt }]
 *  soLines: [{ id, doc, itemCode, qty, deliveryDate, lineNo, taken }] — the
 *           note-named SOs' active lines; taken = already claimed by ANY
 *           so_item_id link or allocation row anywhere (never double-served).
 *  Returns { plans, skippedLinked, skippedAllocated, unfilled }:
 *    plans   [{ poLineId, itemCode, lineQty, slices: [{ seq, qty, soItemId,
 *            soDoc }] }] — Sigma(slice qty) === lineQty ALWAYS (the remainder
 *            slice is soItemId null = stock), seq 1-based dense.
 *    skipped*  idempotence: lines already linked (so_item_id) or already
 *            carrying allocations are untouched and reported.
 *    unfilled  named demand no PO line could cover (reported, not an error). */
export function planFifoAttribution({ poLines = [], soLines = [] }) {
  const skippedLinked = poLines.filter((l) => l.soItemId != null).map((l) => l.id);
  const skippedAllocated = poLines
    .filter((l) => l.soItemId == null && Number(l.allocationCount ?? 0) > 0)
    .map((l) => l.id);
  const eligible = poLines
    .filter((l) => l.soItemId == null && Number(l.allocationCount ?? 0) === 0)
    .slice()
    .sort((a, b) => byDateAscNullsLast(a.createdAt, b.createdAt) || cmpStr(a.id, b.id));
  const free = soLines
    .filter((l) => !l.taken)
    .slice()
    .sort((a, b) =>
      byDateAscNullsLast(a.deliveryDate, b.deliveryDate)
      || cmpStr(a.doc, b.doc)
      || (Number(a.lineNo ?? Number.MAX_SAFE_INTEGER) - Number(b.lineNo ?? Number.MAX_SAFE_INTEGER))
      || cmpStr(a.id, b.id));

  const norm = (s) => String(s ?? "").trim().toUpperCase();
  const plans = [];
  const unfilled = [];
  const codes = [...new Set(eligible.map((l) => norm(l.itemCode)))];
  for (const code of codes) {
    if (!code) continue;
    const supply = eligible.filter((l) => norm(l.itemCode) === code);
    const demands = free
      .filter((l) => norm(l.itemCode) === code)
      .map((l) => ({ ...l, need: Math.max(0, Number(l.qty ?? 0)) }));
    let di = 0;
    for (const s of supply) {
      let cap = Math.max(0, Number(s.qty ?? 0));
      const slices = [];
      while (cap > 0) {
        while (di < demands.length && demands[di].need <= 0) di += 1;
        if (di >= demands.length) break;
        const take = Math.min(cap, demands[di].need);
        slices.push({ qty: take, soItemId: demands[di].id, soDoc: demands[di].doc });
        demands[di].need -= take;
        cap -= take;
      }
      if (cap > 0) slices.push({ qty: cap, soItemId: null, soDoc: null });
      plans.push({
        poLineId: s.id,
        itemCode: s.itemCode,
        lineQty: Math.max(0, Number(s.qty ?? 0)),
        slices: slices.map((sl, i) => ({ seq: i + 1, ...sl })),
      });
    }
    for (const d of demands) {
      if (d.need > 0) unfilled.push({ soDoc: d.doc, soItemId: d.id, itemCode: d.itemCode, qty: d.need });
    }
  }
  // Named demand whose code NO eligible PO line carries at all — reported too,
  // or the note would silently over-promise what this PO covered.
  const supplyCodes = new Set(codes);
  for (const d of free) {
    const c = norm(d.itemCode);
    if (!c || supplyCodes.has(c)) continue;
    if (Number(d.qty ?? 0) > 0) unfilled.push({ soDoc: d.doc, soItemId: d.id, itemCode: d.itemCode, qty: Number(d.qty ?? 0) });
  }
  return { plans, skippedLinked, skippedAllocated, unfilled };
}

// ─────────────────────────────────────────────────────────────────────────────
// R3 — warehouse for the SO lines whose header resolves nothing. Document-
// evidence order, strongest first; every arm single-valued or refused:
//   (a) the line's own DO movement — the warehouse the goods PHYSICALLY left
//   (b) whole-SO sibling agreement — every explicitly-warehoused sibling on
//       the SO names ONE warehouse (a single-warehouse SO; no cross-WH
//       pooling risk). Disagreeing siblings REFUSE — they prove the SO is
//       multi-warehouse, so no default is safe.
//   (c) the company's single ACTIVE warehouse — when a company has exactly
//       one, every line can only mean it.
// Mirror guard: company-2990 SO items are maintained by so-mirror.ts, which
// drains DELETE-then-INSERT per SO — a locally stamped warehouse_id would be
// silently wiped on the next drain. Stampable mirror rows therefore verdict
// `mirror-source`: the exact stamp is REPORTED (for the 2990-side fix) and
// never written here.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// R4 — the delivered SO lines no DO line points back at (trace check class
// `no-do-line-link`, 2026-08-01: 10 DELIVERED lines, e.g. 2990-SO-2606-031
// NTYR pillow). The SO HAS delivery orders, but their lines carry no
// so_item_id for these SO lines — the old convert path / the import never
// stamped the link, so the delivered trace dead-ends. Within ONE SO and its
// own non-cancelled DOs, an unlinked DO line whose item code names EXACTLY ONE
// still-unlinked SO line is DETERMINED, not guessed (the pairPoLinesToSoLines
// discipline): no other line of that order could have been the one delivered.
// Several unlinked DO lines of the same code may all stamp that one SO line
// (split deliveries), provided their quantity fits. TWO candidate SO lines of
// one code is a coin flip and refuses — and quantity is deliberately NOT a
// discriminator (house rule), it only guards the total.
// ─────────────────────────────────────────────────────────────────────────────

/** soLines: the SO's active lines with NO DO line pointing at them
 *           [{ id, itemCode, qty }]
 *  doLines: the SO's DOs' lines with so_item_id NULL
 *           [{ id, doNumber, itemCode, qty }]
 *  Returns { pairs, ambiguous, qtyIncompatible, unmatchedDoLines }:
 *    pairs            [{ doLineId, doNumber, soLineId, code, doQty }] — every
 *                     unlinked DO line of a code stamps the single free SO
 *                     line carrying it
 *    ambiguous        [{ code, freeSoLines, unlinkedDoLines }] — >1 candidate
 *                     SO line; refused, printed for the owner
 *    qtyIncompatible  [{ code, soLineId, soQty, doQtySum }] — the DO lines
 *                     claim more units than the SO line ordered; refused
 *    unmatchedDoLines [{ code, unlinkedDoLines }] — no free SO line at all */
export function planDoLineLink({ soLines = [], doLines = [] }) {
  const norm = (s) => String(s ?? "").trim().toUpperCase();
  const soByCode = new Map();
  for (const l of soLines) {
    const code = norm(l.itemCode);
    if (!code) continue;
    const arr = soByCode.get(code) ?? [];
    arr.push(l);
    soByCode.set(code, arr);
  }
  const doByCode = new Map();
  for (const l of doLines) {
    const code = norm(l.itemCode);
    if (!code) continue;
    const arr = doByCode.get(code) ?? [];
    arr.push(l);
    doByCode.set(code, arr);
  }
  const pairs = [];
  const ambiguous = [];
  const qtyIncompatible = [];
  const unmatchedDoLines = [];
  for (const [code, dls] of doByCode.entries()) {
    const sos = soByCode.get(code) ?? [];
    if (sos.length === 0) {
      unmatchedDoLines.push({ code, unlinkedDoLines: dls.length });
      continue;
    }
    if (sos.length > 1) {
      ambiguous.push({ code, freeSoLines: sos.length, unlinkedDoLines: dls.length });
      continue;
    }
    const so = sos[0];
    const doQtySum = dls.reduce((a, d) => a + Number(d.qty ?? 0), 0);
    if (doQtySum > Number(so.qty ?? 0)) {
      qtyIncompatible.push({ code, soLineId: so.id, soQty: Number(so.qty ?? 0), doQtySum });
      continue;
    }
    for (const d of dls) {
      pairs.push({ doLineId: d.id, doNumber: d.doNumber ?? null, soLineId: so.id, code, doQty: Number(d.qty ?? 0) });
    }
  }
  return { pairs, ambiguous, qtyIncompatible, unmatchedDoLines };
}

export function classifySoLineWarehouse({
  companyId,
  mirrorCompanyId = null,
  doWarehouseIds = [],
  siblingWarehouseIds = [],
  activeWarehouseIds = [],
}) {
  const dos = [...new Set(doWarehouseIds.filter(Boolean))];
  const sib = [...new Set(siblingWarehouseIds.filter(Boolean))];
  const act = [...new Set(activeWarehouseIds.filter(Boolean))];
  let inner;
  if (dos.length === 1) inner = { verdict: "stamp", source: "do-movement", warehouseId: dos[0] };
  else if (dos.length > 1) inner = { verdict: "do-ambiguous", warehouseIds: dos };
  else if (sib.length === 1) inner = { verdict: "stamp", source: "sibling-agreement", warehouseId: sib[0] };
  else if (sib.length > 1) inner = { verdict: "siblings-disagree", warehouseIds: sib };
  else if (act.length === 1) inner = { verdict: "stamp", source: "single-active-warehouse", warehouseId: act[0] };
  else inner = { verdict: "needs-owner", activeWarehouses: act.length };
  const mirror = mirrorCompanyId != null && Number(companyId) === Number(mirrorCompanyId);
  if (mirror && inner.verdict === "stamp") return { ...inner, verdict: "mirror-source", mirror: true };
  return { ...inner, mirror };
}
