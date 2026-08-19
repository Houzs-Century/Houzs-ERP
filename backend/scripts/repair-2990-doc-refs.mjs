// Tier 0 repair: 2990-import doc references that name a PRE-IMPORT document,
// so string equality fails and the UI shows a dash.
//
// EVIDENCE (production, 2026-07-31). migrate-2990-into-houzs.mjs prefixed
// document numbers (DOCNO_COL) and a fixed list of reference columns
// (PREFIX_REF_COLS). These two were in neither list, because they are free text
// inside another column:
//
//   A1  purchase_orders.notes         "From SOs: SO-2606-005"   44 of 49 tokens
//   A2  inventory_lots.batch_no  +    "PO-2606-001"             24 of 32 batches
//       inventory_movements.batch_no
//
//   A3  inventory_lot_consumptions.source_doc_no + source_doc_id, and the same
//       pair on inventory_movements (2026-08-01, from the costing audit, run
//       30694120826): 5 consumed units whose movement names a delivery order
//       that does not exist (section 10b), 5 movements whose parent document is
//       missing (section 4), 1 GRN whose line qty disagrees with its IN
//       movements (section 3a). source_doc_no WAS in PREFIX_REF_COLS, but the
//       importer copied source_doc_id VERBATIM and inserted parents with
//       ON CONFLICT DO NOTHING — so a parent dropped or remapped on PK
//       collision leaves the ledger row pointing at a document id that does not
//       exist, and rows written before the importer's repair pass can still
//       carry a bare number. The audit reads the ID (sections 4/10b), so the
//       number and the id must BOTH end up right; the id is only ever written
//       from the same resolution the number rule proves (see
//       classifySourceRef in lib/doc-ref-repair-core.mjs), and an id that
//       names a DIFFERENT real document refuses the whole group.
//       Only source_doc_type DO and GRN are in scope — the two types the audit
//       implicated, with unambiguous parent tables (delivery_orders / grns).
//       The A3 dry run also reports, read-only: (a) rows whose number RESOLVES
//       while their id dangles — the shape a repaired-number-with-dropped-
//       parent import leaves, which this part deliberately does NOT rewrite —
//       and (b) the audit's 3a GRN line-vs-movement mismatches, with a probe
//       for movements carrying the GRN's bare pre-import number, so the owner
//       can see whether 3a is this same class before anything is applied.
//
//   A4  PART=ids (2026-08-01, ledger-perfection W1). The id-heal for shape (a)
//       above, now its own reviewed rule (classifyIdRestamp in
//       lib/doc-ref-repair-core.mjs): when a group's NUMBER resolves to exactly
//       ONE same-company document of its type but the stored source_doc_id
//       matches NOTHING (the verbatim-copied pre-import id of a dropped or
//       remapped parent), the id is restamped from that unique number
//       resolution — both tables in one transaction, per-row old -> new in the
//       dry run. A stored id naming a DIFFERENT real document refuses the
//       whole group; NULL ids are counted but never written (the audit's
//       sections 4 and 10b read only non-NULL ids). Evidence: run 30695536709
//       — e.g. company-2 DO 2990-DO-2607-016 resolves to a real document while
//       its ledger rows store two ids that resolve to nothing.
//
//   A5  PART=grn-gap (2026-08-01, ledger-perfection W2). The 3a inbound gap
//       itself: a posted GRN whose accepted qty (net of returns) EXCEEDS the
//       qty its IN movements booked — the missing units never entered the
//       ledger, so on-hand and lot value understate reality. Evidence:
//       2990-GRN-2606-001, 501 accepted vs one IN movement of 500. The repair
//       INSERTS the missing IN movement THROUGH THE NORMAL PATH (a plain
//       INSERT, so the AFTER-INSERT FIFO trigger opens the lot exactly as a
//       live GRN post would) into the bucket its OWN sibling movement proves —
//       exactly one (warehouse, variant, batch, company) group and exactly one
//       sibling unit cost, or the GRN is refused and reported
//       (classifyGrnInboundGap in lib/ledger-repair-core.mjs). GRN movements
//       carry NO uq_inv_mov_* unique index (verified by
//       check-duplicate-movements.mjs section 0), so the insert cannot be
//       rejected; idempotency is the live recomputed delta (a repaired GRN
//       plans zero) plus a notes marker that refuses a re-insert if the delta
//       somehow still reads short. Movements created now are timestamped now —
//       the lot enters FIFO at the repair date; backdating would rewrite the
//       consumption chronology the audit reads.
//
// The safety rule, and why a blanket `'2990-' || col` would corrupt the costing
// trail, are documented in lib/doc-ref-repair-core.mjs. In one line: a token is
// rewritten ONLY when it currently resolves to nothing, prefixing it with the
// owning row's OWN company code resolves it to exactly one document, and that
// document belongs to the same company. Everything else is left alone and
// reported.
//
// A2 IS THE MONEY PATH. inventory_lots.batch_no and inventory_movements.batch_no
// are joined to each other by fn_reconcile_dropship_batch (mig 0088/0155) and by
// FIFO batch-scoped consumption (inventory-fifo-trigger.sql), so the two columns
// MUST move together or those see a split world. Every A2 write therefore runs
// inside ONE transaction covering both tables.
//
// The FIFO trigger is `AFTER INSERT ON inventory_movements` only, so updating
// batch_no does NOT re-run allocation, does NOT create or consume a lot, and
// does not move a cent of value. This repair relabels; it never re-posts.
//
// Timestamps are deliberately NOT touched. updated_at on a ledger row records
// when the goods moved, not when a label was corrected; rewriting it would
// destroy the only chronology the costing audit has.
//
// DRY-RUN by default. APPLY=1 to write. Idempotent: a repaired reference
// resolves, so a re-run classifies it "already-resolves" and plans zero rows.
//
//   A6  PART=dedupe (2026-08-01, owner authorization "继续 全部可以"). DELETE
//       the movement+consumption pairs part=ids classifies duplicate-of-real
//       — only when the real document carries a FULL-ROW twin (same company,
//       product, variant, warehouse, movement_type, qty; the index key alone
//       is not proof — it excludes movement_type). The delete reverses the
//       duplicate's WHOLE ledger effect in one transaction: consumptions go
//       with the movement and each consumed lot's qty_remaining is RESTORED,
//       so 2a conservation holds by construction. Every deleted row's old
//       values print in dry run AND apply, plus the per-bucket movement-sum
//       impact (duplicate OUTs double-decrement on-hand — the audit-2b
//       linkage the owner asked to see either way).
//
//   A7  PART=fifo-attribute (2026-08-01, document-evidence round — owner's
//       stated rule, verbatim: "为什么要手动分配的 你根据FIFO 就没问题了啊？").
//       The contended consolidated-PO lines the 2026-08-01 backfill REFUSED
//       (two or more named SOs still wanting the same code) are attributed
//       automatically by FIFO instead of waiting for a manual split: the named
//       SOs' free lines sort by (delivery date ASC — line date falling back to
//       the header promise — then doc_no ASC, the SAME deterministic order
//       computeMrp allocates in), the PO's unlinked lines by document order
//       (created_at, id), and a quantity-aware FIFO walk pairs them — a qty-2
//       line covers a qty-2 demand, a qty-5 line SPLITS, the remainder books
//       as STOCK. The result is written as purchase_order_item_allocations
//       rows (mig 0235; so_item_id NULL = stock) — NEVER as so_item_id, so
//       the provenance stays visibly "allocation" and the existing 1:1 links
//       keep their meaning. Idempotent: lines already linked or already
//       carrying allocations are skipped. planFifoAttribution in
//       lib/doc-evidence-core.mjs holds the rule; POS names the target POs
//       (default: the two contended ones, 2990-PO-2606-019 + -023).
//
//   A8  PART=so-warehouse (2026-08-01, document-evidence round). The
//       NULL-warehouse SO lines whose HEADER also resolves nothing (the
//       check-backfillable-gaps section-1 hard core — 54 NULL lines, 24
//       resolving nothing on the 2026-08-01 run) get warehouse_id stamped
//       from document evidence, strongest first: (a) the line's own DO OUT
//       movement — where the goods PHYSICALLY left; (b) whole-SO sibling
//       agreement — every explicitly-warehoused sibling names ONE warehouse.
//       NOTE this deliberately does NOT contradict lib/so-warehouse.ts's
//       "never borrow a sibling's warehouse" read-path rule: that rule guards
//       against pooling across warehouse boundaries, and a UNANIMOUS SO has
//       no boundary to pool across — disagreeing siblings still refuse;
//       (c) the company's single ACTIVE warehouse. Everything else is
//       reported needs-owner. MIRROR GUARD: company-2990 SO items are
//       maintained by so-mirror.ts (drain = DELETE-then-INSERT per SO), so a
//       local stamp would be wiped on the next drain — those rows verdict
//       mirror-source and are REPORTED with the exact stamp the 2990 SOURCE
//       database needs, never written here. classifySoLineWarehouse in
//       lib/doc-evidence-core.mjs holds the rule.
//
//   A9  PART=do-line-link (2026-08-01, trace-check class `no-do-line-link`:
//       10 DELIVERED lines whose SO has DOs but no DO line carries their
//       so_item_id — the old convert path / import never stamped the link, so
//       the delivered trace dead-ends). Within one (SO, its non-cancelled
//       DOs): an unlinked DO line whose item code names EXACTLY ONE
//       still-unlinked SO line is DETERMINED — no other line of that order
//       could have been the one delivered — and every unlinked DO line of
//       that code stamps it (split deliveries), provided their total fits the
//       SO line's qty. Two candidate SO lines refuse (which-served-which is
//       recorded nowhere); quantity guards, never discriminates.
//       planDoLineLink in lib/doc-evidence-core.mjs holds the rule.
//
//   A10 PART=fifo-attribute-repair (2026-08-02, the 023/024 incident). The A7
//       run's taken-set read stored links/allocations ONLY, so SO lines whose
//       demand ANOTHER PO's delivered chain had already served (consumptions →
//       lot batch → PO) were re-claimed — never-received 2990-PO-2606-023
//       carries allocations naming the SAME SOs {036, 029} that received+
//       shipped -024 delivered (GRN-2607-010/-017 → DO-2607-008/-011/-018).
//       A7 itself now applies delivered precedence (a served line is TAKEN,
//       regardless of which PO served it); THIS part re-evaluates the
//       allocations already written:
//         * PO confirmed an UNEXECUTED DUPLICATE of an executed same-supplier
//           multiset twin (lib/duplicate-docs-core.mjs fingerprint, ±3 days)
//           → REMOVE its allocation rows entirely and RECOMMEND cancelling
//           the PO (owner decision — never executed here; cancelling also
//           deflates the phantom MRP incoming supply, dead statuses being
//           excluded from PO Outstanding).
//         * otherwise, per SO-linked row: demand fully served by OTHER PO(s)
//           → flip so_item_id to NULL (STOCK), printed as
//           `PO-2606-023-NN: SO-036 -> STOCK (served by ... via DO-...)`;
//           served by THIS PO → kept (documents a delivered fact); partial →
//           refused + reported.
//       planAllocationDeliveredRepair in lib/doc-evidence-core.mjs holds the
//       rule. POS names the target POs (default: the incident pair's suspect).
//       2026-08-02 addendum (source verdict): 023 was CANCELLED in the source
//       system (operator re-creation, 9 min before 024) and imported verbatim
//       — a CANCELLED PO's allocations are removed regardless of the duplicate
//       gate, NO owner cancel action is needed, and MRP was never inflated
//       (CANCELLED is PO_DEAD). A non-cancelled status where the verdict says
//       CANCELLED is reported as IMPORT DRIFT, never changed here.
//
//   A11 PART=service-lot-reverse (2026-08-02, SELF-CAUGHT regression of A5).
//       The grn-gap APPLY on 2990-GRN-2606-001 counted the SVC-TRANS.CHARGES
//       freight line into accepted qty and INSERTED a phantom 1-unit IN
//       movement + lot for a SERVICE — the app itself never stocks service
//       lines (grns.ts posts filter isServiceLine; the source GRN confirms
//       goods accepted = 500 exactly). This part DELETES that movement + lot
//       in one transaction, guarded: IN + service-coded product only, lot
//       untouched (received == remaining) and ZERO consumptions on lot AND
//       movement — anything else refuses with the facts printed. The planner
//       (A5) and the costing audit's 3a lens now EXCLUDE service lines, so
//       the class cannot recur. planServiceLotReversal in
//       lib/ledger-repair-core.mjs holds the rule.
//       REVERSE_MOVEMENT_ID / REVERSE_LOT_ID name the rows (defaults: the
//       incident's 205e9f06... / d264f343...).
//
//   DATABASE_URL   required (env, or .dev.vars for local use)
//   APPLY=1        write. Anything else is a dry run.
//   PART           all (default) | notes | batches | consumptions | ids | grn-gap | dedupe
//                  | fifo-attribute | so-warehouse | do-line-link
//                  (`all` = the three original parts; everything later is
//                  deliberately DISPATCH-ONLY so the widest-reaching writes
//                  are each an explicit, single-purpose run)
//   GRNS           part grn-gap only: comma-separated GRN numbers to repair
//                  (default 2990-GRN-2606-001 — the one 3a implicated)
//   POS            part fifo-attribute only: comma-separated PO numbers
//                  (default 2990-PO-2606-019,2990-PO-2606-023 — the 8
//                  contended lines' POs). Never open-ended.
//   MAX_ROWS       per-batch row ids to print in the plan (default 200)
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  companyPrefix,
  classifyToken,
  classifySourceRef,
  classifyIdRestamp,
  parseFromSosTokens,
  rewriteFromSosNote, provenanceNoteSqlPattern,
} from "./lib/doc-ref-repair-core.mjs";
import {
  classifyGrnInboundGap,
  deriveGrnLineBasis,
  classifyDuplicateMovement,
  projectDedupeBucketImpact,
  isServiceLineMirror,
  planServiceLotReversal,
} from "./lib/ledger-repair-core.mjs";
import {
  planFifoAttribution,
  planAllocationDeliveredRepair,
  classifySoLineWarehouse,
  planDoLineLink,
} from "./lib/doc-evidence-core.mjs";
import { docLineMultisetKey, dateGapDays } from "./lib/duplicate-docs-core.mjs";
import { variantKeyMirror } from "./lib/ledger-repair-core.mjs";
import { execIdRestamp, printIdRestampExec, execDedupe } from "./lib/id-restamp-exec.mjs";

const APPLY = process.env.APPLY === "1";
const PART = (process.env.PART || "all").trim().toLowerCase();
const MAX_ROWS = Number(process.env.MAX_ROWS || 200);
const GRNS = (process.env.GRNS || "2990-GRN-2606-001")
  .split(",").map((s) => s.trim()).filter(Boolean);
const POS = (process.env.POS || "2990-PO-2606-019,2990-PO-2606-023")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (!["all", "notes", "batches", "consumptions", "ids", "grn-gap", "dedupe", "fifo-attribute", "fifo-attribute-repair", "so-warehouse", "do-line-link", "service-lot-reverse"].includes(PART)) {
  console.error(`PART must be all | notes | batches | consumptions | ids | grn-gap | dedupe | fifo-attribute | fifo-attribute-repair | so-warehouse | do-line-link | service-lot-reverse (got "${PART}")`);
  process.exit(2);
}
const doNotes = PART === "all" || PART === "notes";
const doBatches = PART === "all" || PART === "batches";
const doConsumptions = PART === "all" || PART === "consumptions";
const doIds = PART === "ids";
const doGrnGap = PART === "grn-gap";
const doDedupe = PART === "dedupe";
const doFifoAttribute = PART === "fifo-attribute";
const doFifoAttrRepair = PART === "fifo-attribute-repair";
const doSoWarehouse = PART === "so-warehouse";
const doDoLineLink = PART === "do-line-link";
const doServiceLotReverse = PART === "service-lot-reverse";
/* A11 targets — the 2990-GRN-2606-001 phantom service receipt (2026-08-02). */
const REVERSE_MOVEMENT_ID = (process.env.REVERSE_MOVEMENT_ID || "205e9f06-a5a3-4b04-bc60-47ba469cb547").trim();
const REVERSE_LOT_ID = (process.env.REVERSE_LOT_ID || "d264f343-5657-4318-876f-01bce3d84717").trim();

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

const log = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* Tally of every verdict, so the summary reports what was LEFT ALONE as
   precisely as what was changed — a repair that silently skips is a repair
   nobody can check. */
const newTally = () => ({
  repair: 0,
  "already-resolves": 0,
  "no-prefix": 0,
  "prefixed-missing": 0,
  "prefixed-ambiguous": 0,
});
const printTally = (label, t, unit) => {
  log(`  ${label}`);
  log(`    to repair                                 : ${t.repair}`);
  log(`    skipped — already resolves as stored      : ${t["already-resolves"]}`);
  log(`    skipped — owning company mints bare nos   : ${t["no-prefix"]}`);
  log(`    skipped — prefixed form matches NOTHING   : ${t["prefixed-missing"]}`);
  log(`    skipped — prefixed form matches >1 doc    : ${t["prefixed-ambiguous"]}`);
  if ("doc-id-conflict" in t) {
    log(`    REFUSED — stored doc id names a DIFFERENT real document : ${t["doc-id-conflict"]}`);
  }
  log(`    (unit: ${unit})`);
};

async function loadCompanies() {
  const rows = await pg`SELECT id, code FROM public.companies ORDER BY id`;
  const codeById = new Map(rows.map((r) => [Number(r.id), String(r.code ?? "")]));
  log(`companies: ${rows.map((r) => `${r.id}=${r.code}`).join(", ")}`);
  return codeById;
}

// ── A1 — purchase_orders.notes "From SOs: …" ────────────────────────────────
async function planNotes(codeById) {
  const pos = await pg`
    SELECT id, po_number, company_id, notes
      FROM scm.purchase_orders
     WHERE notes IS NOT NULL
       AND notes ~* ${provenanceNoteSqlPattern()}
     ORDER BY po_number`;
  log("");
  log(`=== A1  purchase_orders.notes — POs carrying a "From SOs:" note: ${pos.length} ===`);
  if (pos.length === 0) return { plan: [], tally: newTally() };

  // Every doc number the rule may need to look up: the token as stored, and the
  // token prefixed with its own PO's company code. One round trip.
  const wanted = new Set();
  for (const po of pos) {
    const prefix = companyPrefix(codeById.get(Number(po.company_id)));
    for (const tok of parseFromSosTokens(po.notes)) {
      wanted.add(tok);
      if (prefix) wanted.add(`${prefix}${tok}`);
    }
  }
  const soRows = wanted.size
    ? await pg`
        SELECT doc_no, company_id
          FROM scm.mfg_sales_orders
         WHERE doc_no = ANY(${[...wanted]})`
    : [];
  // doc_no -> company_ids that own a document with exactly that number.
  const ownersByDoc = new Map();
  for (const r of soRows) {
    const arr = ownersByDoc.get(String(r.doc_no)) ?? [];
    arr.push(Number(r.company_id));
    ownersByDoc.set(String(r.doc_no), arr);
  }
  const countIn = (doc, cid) => (ownersByDoc.get(doc) ?? []).filter((x) => x === cid).length;
  const countNotIn = (doc, cid) => (ownersByDoc.get(doc) ?? []).filter((x) => x !== cid).length;

  const tally = newTally();
  const plan = [];
  const skipped = [];
  for (const po of pos) {
    const cid = Number(po.company_id);
    const prefix = companyPrefix(codeById.get(cid));
    const replacements = new Map();
    for (const token of parseFromSosTokens(po.notes)) {
      const prefixed = prefix ? `${prefix}${token}` : token;
      const v = classifyToken({
        token,
        prefix,
        ownCompanyMatches: countIn(token, cid),
        prefixedOwnCompanyMatches: prefix ? countIn(prefixed, cid) : 0,
        foreignMatches: countNotIn(token, cid),
      });
      tally[v.verdict] += 1;
      if (v.verdict === "repair") replacements.set(token, v.prefixed);
      else if (v.verdict !== "already-resolves") {
        skipped.push(`    ${po.po_number}: "${token}" -> ${v.verdict}` +
          (v.foreignMatches > 0 ? ` (a document with this exact number exists in ANOTHER company)` : ""));
      }
    }
    if (replacements.size === 0) continue;
    const next = rewriteFromSosNote(po.notes, replacements);
    if (next === po.notes) continue;
    plan.push({ id: po.id, poNumber: po.po_number, companyId: cid, before: po.notes, after: next, tokens: [...replacements.entries()] });
  }

  printTally("tokens", tally, "one 'From SOs:' token");
  if (skipped.length) {
    log("  --- tokens left alone, with the reason ---");
    for (const s of skipped.slice(0, 200)) log(s);
    if (skipped.length > 200) log(`    … and ${skipped.length - 200} more`);
  }
  log(`  POs whose note would be rewritten: ${plan.length}`);
  for (const p of plan) {
    log(`    ${p.poNumber} (company ${p.companyId})`);
    for (const [from, to] of p.tokens) log(`      ${from}  ->  ${to}`);
    log(`      note before: ${JSON.stringify(p.before)}`);
    log(`      note after : ${JSON.stringify(p.after)}`);
  }
  return { plan, tally };
}

async function applyNotes(plan) {
  if (plan.length === 0) return 0;
  // Notes are annotation, not the money path, so each PO stands alone: a
  // failure on one must not roll back the ones already corrected. The guard on
  // `notes = before` makes each write a compare-and-set — if anyone edited the
  // note between the plan and the write, this row is skipped, not clobbered.
  let done = 0;
  for (const p of plan) {
    const res = await pg`
      UPDATE scm.purchase_orders
         SET notes = ${p.after}
       WHERE id = ${p.id}
         AND notes = ${p.before}`;
    if (res.count === 1) done += 1;
    else log(`  SKIPPED ${p.poNumber}: the note changed since the plan was built — re-run.`);
  }
  return done;
}

// ── A2 — inventory_lots.batch_no + inventory_movements.batch_no ─────────────
async function planBatches(codeById) {
  const lotRows = await pg`
    SELECT company_id, batch_no, count(*)::int AS n
      FROM scm.inventory_lots
     WHERE batch_no IS NOT NULL
     GROUP BY company_id, batch_no`;
  const movRows = await pg`
    SELECT company_id, batch_no, count(*)::int AS n
      FROM scm.inventory_movements
     WHERE batch_no IS NOT NULL
     GROUP BY company_id, batch_no`;

  // Keyed on (company_id, batch_no) — the SAME key the UPDATE will use, so a
  // planned pair and a written pair are the same set of rows by construction.
  const pairs = new Map();
  const bump = (r, field) => {
    const cid = Number(r.company_id);
    const batch = String(r.batch_no);
    const key = `${cid}::${batch}`;
    const p = pairs.get(key) ?? { companyId: cid, batch, lots: 0, movements: 0 };
    p[field] += Number(r.n);
    pairs.set(key, p);
  };
  for (const r of lotRows) bump(r, "lots");
  for (const r of movRows) bump(r, "movements");

  log("");
  log(`=== A2  batch_no — distinct (company, batch) pairs: ${pairs.size} ===`);
  if (pairs.size === 0) return { plan: [], tally: newTally() };

  const wanted = new Set();
  for (const p of pairs.values()) {
    const prefix = companyPrefix(codeById.get(p.companyId));
    wanted.add(p.batch);
    if (prefix) wanted.add(`${prefix}${p.batch}`);
  }
  const poRows = await pg`
    SELECT id, po_number, company_id, status
      FROM scm.purchase_orders
     WHERE po_number = ANY(${[...wanted]})`;
  const posByNumber = new Map();
  for (const r of poRows) {
    const arr = posByNumber.get(String(r.po_number)) ?? [];
    arr.push({ id: r.id, companyId: Number(r.company_id), status: r.status });
    posByNumber.set(String(r.po_number), arr);
  }
  const inCompany = (num, cid) => (posByNumber.get(num) ?? []).filter((p) => p.companyId === cid);
  const otherCompany = (num, cid) => (posByNumber.get(num) ?? []).filter((p) => p.companyId !== cid);

  const tally = newTally();
  const plan = [];
  const skipped = [];
  for (const p of [...pairs.values()].sort((a, b) => a.batch.localeCompare(b.batch))) {
    const prefix = companyPrefix(codeById.get(p.companyId));
    const prefixed = prefix ? `${prefix}${p.batch}` : p.batch;
    const v = classifyToken({
      token: p.batch,
      prefix,
      ownCompanyMatches: inCompany(p.batch, p.companyId).length,
      prefixedOwnCompanyMatches: prefix ? inCompany(prefixed, p.companyId).length : 0,
      foreignMatches: otherCompany(p.batch, p.companyId).length,
    });
    tally[v.verdict] += 1;
    if (v.verdict === "repair") {
      const po = inCompany(prefixed, p.companyId)[0];
      plan.push({ ...p, newBatch: prefixed, poId: po.id, poStatus: po.status });
    } else if (v.verdict !== "already-resolves") {
      skipped.push(
        `    company ${p.companyId}  "${p.batch}"  lots=${p.lots} movements=${p.movements}  -> ${v.verdict}` +
          (v.foreignMatches > 0 ? "  (a purchase order with this exact number exists in ANOTHER company)" : ""),
      );
    }
  }

  printTally("batches", tally, "one (company_id, batch_no) pair");
  if (skipped.length) {
    log("  --- batches left alone, with the reason ---");
    for (const s of skipped) log(s);
  }

  // Per-row old -> new with the resolved purchase order, because this is the
  // costing trail and a summary line is not evidence.
  log(`  (company, batch) pairs to repair: ${plan.length}`);
  let lotTotal = 0;
  let movTotal = 0;
  for (const p of plan) {
    lotTotal += p.lots;
    movTotal += p.movements;
    log(`    company ${p.companyId}:  ${p.batch}  ->  ${p.newBatch}`);
    log(`      resolved purchase order: id=${p.poId} status=${p.poStatus}`);
    log(`      rows: inventory_lots=${p.lots}  inventory_movements=${p.movements}`);
    const lots = await pg`
      SELECT id FROM scm.inventory_lots
       WHERE company_id = ${p.companyId} AND batch_no = ${p.batch}
       ORDER BY id LIMIT ${MAX_ROWS}`;
    for (const r of lots) log(`        lot      ${r.id}`);
    if (p.lots > lots.length) log(`        … and ${p.lots - lots.length} more lots`);
    const movs = await pg`
      SELECT id, movement_type, source_doc_type, source_doc_no
        FROM scm.inventory_movements
       WHERE company_id = ${p.companyId} AND batch_no = ${p.batch}
       ORDER BY id LIMIT ${MAX_ROWS}`;
    for (const r of movs) {
      log(`        movement ${r.id}  ${r.movement_type}  ${r.source_doc_type ?? "-"} ${r.source_doc_no ?? "-"}`);
    }
    if (p.movements > movs.length) log(`        … and ${p.movements - movs.length} more movements`);
  }
  log(`  TOTAL rows that would change: inventory_lots=${lotTotal}  inventory_movements=${movTotal}`);
  return { plan, tally };
}

async function applyBatches(plan) {
  if (plan.length === 0) return { lots: 0, movements: 0 };
  // ONE transaction across BOTH tables. fn_reconcile_dropship_batch and the
  // batch-scoped FIFO consumption join lots to movements on batch_no; a partial
  // rename would leave them disagreeing, which is a costing fault, not a
  // cosmetic one.
  return pg.begin(async (tx) => {
    let lots = 0;
    let movements = 0;
    for (const p of plan) {
      const l = await tx`
        UPDATE scm.inventory_lots
           SET batch_no = ${p.newBatch}
         WHERE company_id = ${p.companyId} AND batch_no = ${p.batch}`;
      const m = await tx`
        UPDATE scm.inventory_movements
           SET batch_no = ${p.newBatch}
         WHERE company_id = ${p.companyId} AND batch_no = ${p.batch}`;
      lots += l.count;
      movements += m.count;
      log(`  APPLIED company ${p.companyId}: ${p.batch} -> ${p.newBatch}  (lots ${l.count}, movements ${m.count})`);
    }
    return { lots, movements };
  });
}

// ── A3 — inventory_lot_consumptions + inventory_movements source_doc_no/_id ──
// Only the two doc types the audit implicated, each with an unambiguous parent
// table. Everything else (PURCHASE_RETURN / DR / STOCK_TRANSFER / STOCK_TAKE)
// stays out of scope; the audit's section 4 is the discovery tool for those.
const A3_TYPES = ["DO", "GRN"];
const A3_LABEL = { DO: "delivery order", GRN: "GRN" };

async function fetchDocsByNumbers(docType, numbers) {
  if (numbers.length === 0) return [];
  return docType === "DO"
    ? pg`SELECT id::text AS id, do_number AS doc_no, company_id, status::text AS status
           FROM scm.delivery_orders WHERE do_number = ANY(${numbers})`
    : pg`SELECT id::text AS id, grn_number AS doc_no, company_id, status::text AS status
           FROM scm.grns WHERE grn_number = ANY(${numbers})`;
}
async function fetchExistingDocIds(docType, ids) {
  if (ids.length === 0) return new Set();
  const rows = docType === "DO"
    ? await pg`SELECT id::text AS id FROM scm.delivery_orders WHERE id::text = ANY(${ids})`
    : await pg`SELECT id::text AS id FROM scm.grns WHERE id::text = ANY(${ids})`;
  return new Set(rows.map((r) => r.id));
}

async function planConsumptions(codeById) {
  // Grouped WITH the distinct stored source_doc_id, because the id is the other
  // half of the reference: the plan must know, per group, every id the rows
  // assert, so a row claiming a DIFFERENT real document refuses the group.
  const consRows = await pg`
    SELECT company_id, source_doc_type, source_doc_no, source_doc_id::text AS doc_id, count(*)::int AS n
      FROM scm.inventory_lot_consumptions
     WHERE source_doc_no IS NOT NULL AND source_doc_type IN ('DO','GRN')
     GROUP BY company_id, source_doc_type, source_doc_no, source_doc_id`;
  const movRows = await pg`
    SELECT company_id, source_doc_type, source_doc_no, source_doc_id::text AS doc_id, count(*)::int AS n
      FROM scm.inventory_movements
     WHERE source_doc_no IS NOT NULL AND source_doc_type IN ('DO','GRN')
     GROUP BY company_id, source_doc_type, source_doc_no, source_doc_id`;

  // Keyed on (company_id, source_doc_type, source_doc_no) — the SAME key the
  // UPDATE will use, so a planned group and a written group are the same set of
  // rows by construction (the applyBatches argument, verbatim).
  const groups = new Map();
  const bump = (r, field) => {
    const cid = Number(r.company_id);
    const key = `${cid}::${r.source_doc_type}::${r.source_doc_no}`;
    const g = groups.get(key) ?? {
      companyId: cid,
      docType: String(r.source_doc_type),
      docNo: String(r.source_doc_no),
      consumptions: 0,
      movements: 0,
      ids: new Map(), // stored source_doc_id (or null) -> row count across both tables
    };
    g[field] += Number(r.n);
    const idKey = r.doc_id ?? null;
    g.ids.set(idKey, (g.ids.get(idKey) ?? 0) + Number(r.n));
    groups.set(key, g);
  };
  for (const r of consRows) bump(r, "consumptions");
  for (const r of movRows) bump(r, "movements");

  log("");
  log(`=== A3  ledger source_doc refs — distinct (company, type, doc no) groups: ${groups.size} (types: ${A3_TYPES.join(", ")}) ===`);
  if (groups.size === 0) {
    await report3aGrnMismatch(codeById);
    return { plan: [], tally: { ...newTally(), "doc-id-conflict": 0 } };
  }

  // One round trip per doc type: every number the rule may need (as stored +
  // prefixed with the owning row's company code), and every stored id.
  const docsByType = {};
  const idSetByType = {};
  for (const t of A3_TYPES) {
    const wanted = new Set();
    const storedIds = new Set();
    for (const g of groups.values()) {
      if (g.docType !== t) continue;
      const prefix = companyPrefix(codeById.get(g.companyId));
      wanted.add(g.docNo);
      if (prefix) wanted.add(`${prefix}${g.docNo}`);
      for (const id of g.ids.keys()) if (id != null) storedIds.add(id);
    }
    docsByType[t] = await fetchDocsByNumbers(t, [...wanted]);
    idSetByType[t] = await fetchExistingDocIds(t, [...storedIds]);
  }
  const docsByNo = new Map(); // `${type}::${doc_no}` -> [{id, companyId, status}]
  for (const t of A3_TYPES) {
    for (const d of docsByType[t]) {
      const key = `${t}::${d.doc_no}`;
      const arr = docsByNo.get(key) ?? [];
      arr.push({ id: d.id, companyId: Number(d.company_id), status: d.status });
      docsByNo.set(key, arr);
    }
  }
  const inCompany = (t, num, cid) => (docsByNo.get(`${t}::${num}`) ?? []).filter((d) => d.companyId === cid);
  const otherCompany = (t, num, cid) => (docsByNo.get(`${t}::${num}`) ?? []).filter((d) => d.companyId !== cid);

  const tally = { ...newTally(), "doc-id-conflict": 0 };
  const plan = [];
  const skipped = [];
  const resolvedButDangling = []; // report-only: number resolves, id does not
  for (const g of [...groups.values()].sort((a, b) => a.docType.localeCompare(b.docType) || a.docNo.localeCompare(b.docNo))) {
    const prefix = companyPrefix(codeById.get(g.companyId));
    const prefixed = prefix ? `${prefix}${g.docNo}` : g.docNo;
    const own = inCompany(g.docType, g.docNo, g.companyId);
    const prefixedOwn = prefix ? inCompany(g.docType, prefixed, g.companyId) : [];
    const storedDocIds = [...g.ids.entries()].map(([id, rows]) => ({
      id,
      rows,
      exists: id != null && idSetByType[g.docType].has(id),
    }));
    const v = classifySourceRef({
      token: g.docNo,
      prefix,
      ownCompanyMatches: own.length,
      prefixedOwnCompanyMatches: prefixedOwn.length,
      foreignMatches: otherCompany(g.docType, g.docNo, g.companyId).length,
      resolvedDocId: prefixedOwn[0]?.id ?? null,
      storedDocIds,
    });
    tally[v.verdict] += 1;
    if (v.verdict === "repair") {
      plan.push({ ...g, newNo: prefixed, resolvedDocId: v.resolvedDocId, resolvedStatus: prefixedOwn[0].status, idWrites: v.idWrites });
    } else if (v.verdict === "already-resolves") {
      // The number names a real same-company document — but does the id? A
      // dangling id here is the dropped/remapped-parent import shape; this part
      // does not rewrite it (the prefix rule proves nothing about it), so it is
      // REPORTED for the owner instead of silently passing as healthy.
      const dangling = storedDocIds.filter((d) => d.id != null && !d.exists);
      const nulls = storedDocIds.filter((d) => d.id == null);
      if (dangling.length || nulls.length) {
        resolvedButDangling.push({ ...g, resolvesToId: own[0].id, dangling, nulls });
      }
    } else {
      skipped.push(
        `    company ${g.companyId}  ${g.docType} "${g.docNo}"  consumptions=${g.consumptions} movements=${g.movements}  -> ${v.verdict}` +
          (v.foreignMatches > 0 ? `  (a ${A3_LABEL[g.docType]} with this exact number exists in ANOTHER company)` : "") +
          (v.verdict === "doc-id-conflict"
            ? `  [stored ids: ${v.idWrites.map((w) => `${w.id ?? "NULL"}=${w.action}(${w.rows})`).join(", ")}]`
            : ""),
      );
    }
  }

  printTally("groups", tally, "one (company_id, source_doc_type, source_doc_no) group across both tables");
  if (skipped.length) {
    log("  --- groups left alone, with the reason ---");
    for (const s of skipped) log(s);
  }

  const danglingGroups = resolvedButDangling.filter((r) => r.dangling.length > 0);
  const nullOnlyGroups = resolvedButDangling.filter((r) => r.dangling.length === 0);
  if (resolvedButDangling.length) {
    log("");
    log(`  REPORT-ONLY — number resolves but source_doc_id does not (${resolvedButDangling.length} group(s)); NOT repaired by this part:`);
    log("  (this is the shape a PK-collision-dropped or remapped parent leaves: the importer's repair");
    log("   pass prefixed the number, but the verbatim-copied id points at nothing. The audit's");
    log("   sections 4 and 10b count these by ID. Repairing them is an id-heal, not a prefix repair —");
    log("   that reviewed rule is PART=ids; dispatch it to plan exactly these groups.)");
    for (const r of danglingGroups.slice(0, MAX_ROWS)) {
      log(`    company ${r.companyId}  ${r.docType} "${r.docNo}"  resolves to id=${r.resolvesToId}`);
      for (const d of r.dangling) log(`      stored source_doc_id=${d.id} matches NO ${A3_LABEL[r.docType]} (${d.rows} row(s))`);
      for (const d of r.nulls) log(`      stored source_doc_id is NULL (${d.rows} row(s))`);
    }
    if (danglingGroups.length > MAX_ROWS) log(`    … and ${danglingGroups.length - MAX_ROWS} more dangling-id groups`);
    if (nullOnlyGroups.length) {
      const nullRows = nullOnlyGroups.reduce((a, r) => a + r.nulls.reduce((x, d) => x + d.rows, 0), 0);
      log(`    (plus ${nullOnlyGroups.length} group(s) whose only gap is a NULL source_doc_id — ${nullRows} row(s); listed as a count because a NULL asserts nothing and may predate id stamping)`);
    }
  }

  // Per-row old -> new with the resolved document, because this is the costing
  // trail and a summary line is not evidence.
  log(`  (company, type, doc no) groups to repair: ${plan.length}`);
  let consTotal = 0;
  let movTotal = 0;
  for (const p of plan) {
    consTotal += p.consumptions;
    movTotal += p.movements;
    log(`    company ${p.companyId}:  ${p.docType}  ${p.docNo}  ->  ${p.newNo}`);
    log(`      resolved ${A3_LABEL[p.docType]}: id=${p.resolvedDocId} status=${p.resolvedStatus}`);
    log(`      rows: inventory_lot_consumptions=${p.consumptions}  inventory_movements=${p.movements}`);
    for (const w of p.idWrites) {
      log(`      source_doc_id ${w.id ?? "NULL"} (${w.rows} row(s)) -> ${w.action === "keep" ? "kept (already the resolved document)" : `${p.resolvedDocId} (${w.action})`}`);
    }
    // Movements ALREADY attached to the resolved document by id: after the
    // repair these groups' rows join them, so any double-posting risk must be
    // visible in the plan, not discovered in the next audit run.
    const attached = await pg`
      SELECT count(*)::int AS rows,
             COALESCE(SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty ELSE qty END), 0)::int AS net_qty
        FROM scm.inventory_movements
       WHERE source_doc_type = ${p.docType} AND source_doc_id::text = ${p.resolvedDocId}`;
    log(`      movements already attached to the resolved document by id: rows=${attached[0].rows} netQty=${attached[0].net_qty}`);
    const cons = await pg`
      SELECT id, source_doc_id::text AS doc_id, qty_consumed
        FROM scm.inventory_lot_consumptions
       WHERE company_id = ${p.companyId} AND source_doc_type = ${p.docType} AND source_doc_no = ${p.docNo}
       ORDER BY id LIMIT ${MAX_ROWS}`;
    for (const r of cons) log(`        consumption ${r.id}  qty=${r.qty_consumed}  doc_id=${r.doc_id ?? "NULL"}`);
    if (p.consumptions > cons.length) log(`        … and ${p.consumptions - cons.length} more consumptions`);
    const movs = await pg`
      SELECT id, movement_type, qty, source_doc_id::text AS doc_id
        FROM scm.inventory_movements
       WHERE company_id = ${p.companyId} AND source_doc_type = ${p.docType} AND source_doc_no = ${p.docNo}
       ORDER BY id LIMIT ${MAX_ROWS}`;
    for (const r of movs) log(`        movement ${r.id}  ${r.movement_type}  qty=${r.qty}  doc_id=${r.doc_id ?? "NULL"}`);
    if (p.movements > movs.length) log(`        … and ${p.movements - movs.length} more movements`);
  }
  log(`  TOTAL rows that would change: inventory_lot_consumptions=${consTotal}  inventory_movements=${movTotal}`);

  await report3aGrnMismatch(codeById);
  return { plan, tally };
}

/* The costing audit's 3a finding, reproduced read-only so the owner can see in
   THIS dry run whether the mismatching GRN is the same bare-reference class.
   Same definitions as audit-inventory-costing.mjs section 3a: posted GRNs,
   accepted qty net of returns, movements keyed by source_doc_id. */
async function report3aGrnMismatch(codeById) {
  log("");
  log("  --- audit 3a reproduction: GRN line qty vs its IN movements (read-only report) ---");
  const rows = await pg`
    WITH lines AS (
      SELECT gi.grn_id, SUM(GREATEST(0, COALESCE(gi.qty_accepted, 0) - COALESCE(gi.returned_qty, 0)))::int AS line_qty
        FROM scm.grn_items gi GROUP BY gi.grn_id
    ), movs AS (
      SELECT source_doc_id::text AS doc_id,
             SUM(CASE WHEN movement_type = 'IN' THEN qty ELSE -qty END)::int AS mov_qty,
             count(*)::int AS mov_rows
        FROM scm.inventory_movements
       WHERE source_doc_type = 'GRN' AND source_doc_id IS NOT NULL
       GROUP BY source_doc_id
    )
    SELECT g.id::text AS id, g.grn_number, g.company_id, g.status::text AS status,
           COALESCE(l.line_qty, 0) AS line_qty, COALESCE(m.mov_qty, 0) AS mov_qty,
           COALESCE(m.mov_rows, 0) AS mov_rows
      FROM scm.grns g
      LEFT JOIN lines l ON l.grn_id = g.id
      LEFT JOIN movs m ON m.doc_id = g.id::text
     WHERE UPPER(g.status::text) NOT IN ('DRAFT','CANCELLED')
       AND COALESCE(l.line_qty, 0) <> COALESCE(m.mov_qty, 0)
     ORDER BY g.grn_number`;
  log(`  posted GRNs whose accepted line qty != IN movement qty (by id): ${rows.length}`);
  for (const r of rows) {
    log(`    ${r.grn_number}  company=${r.company_id}  status=${r.status}  lines=${r.line_qty}  movements=${r.mov_qty} (${r.mov_rows} row(s))  delta=${Number(r.line_qty) - Number(r.mov_qty)}  id=${r.id}`);
    // Probe: do movements exist under this GRN's number instead of its id —
    // full or bare pre-import form? That is what "same class" looks like.
    const prefix = companyPrefix(codeById.get(Number(r.company_id)));
    const bare = prefix && String(r.grn_number).startsWith(prefix) ? String(r.grn_number).slice(prefix.length) : null;
    const probeNos = bare ? [r.grn_number, bare] : [r.grn_number];
    const probes = await pg`
      SELECT id::text AS id, company_id, movement_type, qty, source_doc_no, source_doc_id::text AS doc_id
        FROM scm.inventory_movements
       WHERE source_doc_type = 'GRN' AND source_doc_no = ANY(${probeNos})
       ORDER BY created_at, id`;
    const probeIds = [...new Set(probes.map((x) => x.doc_id).filter((x) => x != null))];
    const existing = await fetchExistingDocIds("GRN", probeIds);
    if (probes.length === 0) {
      log(`      no movements carry this GRN's number${bare ? ` (or its bare form "${bare}")` : ""} — the gap is NOT a doc-no mislabel; the movements are absent or carry another reference`);
    }
    for (const x of probes) {
      const idNote = x.doc_id == null ? "doc_id=NULL" : existing.has(x.doc_id) ? (x.doc_id === r.id ? "doc_id=THIS GRN" : `doc_id=ANOTHER real GRN (${x.doc_id})`) : `doc_id=${x.doc_id} (DANGLING)`;
      log(`      movement ${x.id}  company=${x.company_id}  ${x.movement_type}  qty=${x.qty}  source_doc_no="${x.source_doc_no}"  ${idNote}`);
    }
  }
  if (rows.length === 0) log("    none — 3a is clean at plan time");
}

async function applyConsumptions(plan) {
  if (plan.length === 0) return { consumptions: 0, movements: 0 };
  // ONE transaction across BOTH tables — a movement and its consumptions carry
  // the same source_doc reference (fn_consume_fifo copies the movement's), so a
  // partial rewrite would leave the OUT and its lot consumptions naming
  // different documents, which is a costing fault, not a cosmetic one.
  //
  // Writing source_doc_id together with source_doc_no is safe by construction:
  // a group reaches here only when every stored id is NULL, dangling, or
  // already the resolved id (classifySourceRef refuses anything else), so this
  // SET restamps nothing that currently asserts a different real document.
  // The FIFO trigger is AFTER INSERT only (verified against the live catalog by
  // the costing audit, section 0a: zero UPDATE-firing triggers on the ledger
  // tables), so these UPDATEs re-run no allocation and move no value.
  return pg.begin(async (tx) => {
    let consumptions = 0;
    let movements = 0;
    for (const p of plan) {
      const k = await tx`
        UPDATE scm.inventory_lot_consumptions
           SET source_doc_no = ${p.newNo},
               source_doc_id = ${p.resolvedDocId}::uuid
         WHERE company_id = ${p.companyId}
           AND source_doc_type = ${p.docType}
           AND source_doc_no = ${p.docNo}`;
      const m = await tx`
        UPDATE scm.inventory_movements
           SET source_doc_no = ${p.newNo},
               source_doc_id = ${p.resolvedDocId}::uuid
         WHERE company_id = ${p.companyId}
           AND source_doc_type = ${p.docType}
           AND source_doc_no = ${p.docNo}`;
      consumptions += k.count;
      movements += m.count;
      log(`  APPLIED company ${p.companyId}: ${p.docType} ${p.docNo} -> ${p.newNo} (doc id ${p.resolvedDocId})  (consumptions ${k.count}, movements ${m.count})`);
    }
    return { consumptions, movements };
  });
}

// ── A4 — PART=ids: restamp dangling source_doc_id from the resolving number ──
// The mirror image of A3: there the NUMBER was broken and the id was written
// from its repair; here the number already resolves and only the id dangles.
// Same key (company, type, doc no), same two tables, same one-transaction
// apply. The rule lives in classifyIdRestamp (lib/doc-ref-repair-core.mjs).
async function planIdRestamp(codeById) {
  const consRows = await pg`
    SELECT company_id, source_doc_type, source_doc_no, source_doc_id::text AS doc_id, count(*)::int AS n
      FROM scm.inventory_lot_consumptions
     WHERE source_doc_no IS NOT NULL AND source_doc_type IN ('DO','GRN')
     GROUP BY company_id, source_doc_type, source_doc_no, source_doc_id`;
  const movRows = await pg`
    SELECT company_id, source_doc_type, source_doc_no, source_doc_id::text AS doc_id, count(*)::int AS n
      FROM scm.inventory_movements
     WHERE source_doc_no IS NOT NULL AND source_doc_type IN ('DO','GRN')
     GROUP BY company_id, source_doc_type, source_doc_no, source_doc_id`;

  const groups = new Map();
  const bump = (r, field) => {
    const cid = Number(r.company_id);
    const key = `${cid}::${r.source_doc_type}::${r.source_doc_no}`;
    const g = groups.get(key) ?? {
      companyId: cid,
      docType: String(r.source_doc_type),
      docNo: String(r.source_doc_no),
      consumptions: 0,
      movements: 0,
      ids: new Map(),
      // per-table row counts PER stored id, so the plan's totals are exact
      // even when the per-row listing is capped at MAX_ROWS.
      idsByTable: { consumptions: new Map(), movements: new Map() },
    };
    g[field] += Number(r.n);
    const idKey = r.doc_id ?? null;
    g.ids.set(idKey, (g.ids.get(idKey) ?? 0) + Number(r.n));
    const t = g.idsByTable[field];
    t.set(idKey, (t.get(idKey) ?? 0) + Number(r.n));
    groups.set(key, g);
  };
  for (const r of consRows) bump(r, "consumptions");
  for (const r of movRows) bump(r, "movements");

  log("");
  log(`=== A4  id-heal — distinct (company, type, doc no) groups scanned: ${groups.size} (types: ${A3_TYPES.join(", ")}) ===`);
  const emptyTally = { restamp: 0, "no-dangling-id": 0, "number-unresolved": 0, "number-ambiguous": 0, "doc-id-conflict": 0 };
  if (groups.size === 0) return { plan: [], tally: emptyTally };

  // One round trip per doc type: the numbers AS STORED, and every stored id.
  const docsByType = {};
  const idSetByType = {};
  for (const t of A3_TYPES) {
    const wanted = new Set();
    const storedIds = new Set();
    for (const g of groups.values()) {
      if (g.docType !== t) continue;
      wanted.add(g.docNo);
      for (const id of g.ids.keys()) if (id != null) storedIds.add(id);
    }
    docsByType[t] = await fetchDocsByNumbers(t, [...wanted]);
    idSetByType[t] = await fetchExistingDocIds(t, [...storedIds]);
  }
  const docsByNo = new Map();
  for (const t of A3_TYPES) {
    for (const d of docsByType[t]) {
      const key = `${t}::${d.doc_no}`;
      const arr = docsByNo.get(key) ?? [];
      arr.push({ id: d.id, companyId: Number(d.company_id), status: d.status });
      docsByNo.set(key, arr);
    }
  }
  const inCompany = (t, num, cid) => (docsByNo.get(`${t}::${num}`) ?? []).filter((d) => d.companyId === cid);
  const otherCompany = (t, num, cid) => (docsByNo.get(`${t}::${num}`) ?? []).filter((d) => d.companyId !== cid);

  const tally = { ...emptyTally };
  const plan = [];
  const refused = [];
  let nullRowsTotal = 0;
  for (const g of [...groups.values()].sort((a, b) => a.docType.localeCompare(b.docType) || a.docNo.localeCompare(b.docNo))) {
    const own = inCompany(g.docType, g.docNo, g.companyId);
    const storedDocIds = [...g.ids.entries()].map(([id, rows]) => ({
      id,
      rows,
      exists: id != null && idSetByType[g.docType].has(id),
    }));
    const v = classifyIdRestamp({
      token: g.docNo,
      ownCompanyMatches: own.length,
      foreignMatches: otherCompany(g.docType, g.docNo, g.companyId).length,
      resolvedDocId: own.length === 1 ? own[0].id : null,
      storedDocIds,
    });
    tally[v.verdict] += 1;
    nullRowsTotal += storedDocIds.filter((d) => d.id == null).reduce((a, d) => a + d.rows, 0);
    if (v.verdict === "restamp") {
      plan.push({ ...g, resolvedDocId: v.resolvedDocId, resolvedStatus: own[0].status, idWrites: v.idWrites });
    } else if (v.verdict === "doc-id-conflict" || v.verdict === "number-ambiguous") {
      refused.push(
        `    company ${g.companyId}  ${g.docType} "${g.docNo}"  consumptions=${g.consumptions} movements=${g.movements}  -> ${v.verdict}` +
          (v.verdict === "doc-id-conflict"
            ? `  [stored ids: ${v.idWrites.map((w) => `${w.id ?? "NULL"}=${w.action}(${w.rows})`).join(", ")}]`
            : `  [${own.length} same-company documents share this number]`),
      );
    }
    // number-unresolved is PART=consumptions territory and no-dangling-id is
    // healthy; both are tallied, neither is listed row by row.
  }

  log("  groups by verdict:");
  log(`    to restamp (number resolves uniquely, id dangles)  : ${tally.restamp}`);
  log(`    healthy — no dangling id                           : ${tally["no-dangling-id"]}`);
  log(`    number unresolved (PART=consumptions territory)    : ${tally["number-unresolved"]}`);
  log(`    REFUSED — number ambiguous in its own company      : ${tally["number-ambiguous"]}`);
  log(`    REFUSED — stored id names a DIFFERENT real document: ${tally["doc-id-conflict"]}`);
  log(`    rows whose stored id is NULL (counted, NEVER written by this part): ${nullRowsTotal}`);
  if (refused.length) {
    log("  --- groups refused, with the reason ---");
    for (const s of refused) log(s);
  }

  log(`  (company, type, doc no) groups to restamp: ${plan.length}`);
  let consTotal = 0;
  let movTotal = 0;
  for (const p of plan) {
    const danglingIds = p.idWrites.filter((w) => w.action === "restamp").map((w) => w.id);
    log(`    company ${p.companyId}:  ${p.docType}  ${p.docNo}`);
    log(`      number resolves to ${A3_LABEL[p.docType]} id=${p.resolvedDocId} status=${p.resolvedStatus}`);
    for (const w of p.idWrites) {
      log(`      stored source_doc_id ${w.id ?? "NULL"} (${w.rows} row(s)) -> ${
        w.action === "restamp" ? `${p.resolvedDocId} (RESTAMP — stored id matches no ${A3_LABEL[p.docType]})`
        : w.action === "keep" ? "kept (already the resolved document)"
        : "left NULL (report-only)"}`);
    }
    // Per-row old -> new, both tables — the costing trail deserves row-level
    // evidence, and the apply UPDATE is scoped to exactly these ids.
    const cons = await pg`
      SELECT id, source_doc_id::text AS doc_id, qty_consumed
        FROM scm.inventory_lot_consumptions
       WHERE company_id = ${p.companyId} AND source_doc_type = ${p.docType} AND source_doc_no = ${p.docNo}
         AND source_doc_id::text = ANY(${danglingIds})
       ORDER BY id LIMIT ${MAX_ROWS}`;
    for (const r of cons) log(`        consumption ${r.id}  qty=${r.qty_consumed}  doc_id ${r.doc_id} -> ${p.resolvedDocId}`);
    const movs = await pg`
      SELECT id, movement_type, qty, source_doc_id::text AS doc_id
        FROM scm.inventory_movements
       WHERE company_id = ${p.companyId} AND source_doc_type = ${p.docType} AND source_doc_no = ${p.docNo}
         AND source_doc_id::text = ANY(${danglingIds})
       ORDER BY id LIMIT ${MAX_ROWS}`;
    for (const r of movs) log(`        movement ${r.id}  ${r.movement_type}  qty=${r.qty}  doc_id ${r.doc_id} -> ${p.resolvedDocId}`);
    const consExact = danglingIds.reduce((a, id) => a + (p.idsByTable.consumptions.get(id) ?? 0), 0);
    const movExact = danglingIds.reduce((a, id) => a + (p.idsByTable.movements.get(id) ?? 0), 0);
    if (cons.length < consExact) log(`        … and ${consExact - cons.length} more consumptions (listing capped at MAX_ROWS)`);
    if (movs.length < movExact) log(`        … and ${movExact - movs.length} more movements (listing capped at MAX_ROWS)`);
    consTotal += consExact;
    movTotal += movExact;
    // Rows already attached to the resolved document by id — the set these
    // rows JOIN after the restamp, so double-posting risk is visible now.
    const attached = await pg`
      SELECT count(*)::int AS rows,
             COALESCE(SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty ELSE qty END), 0)::int AS net_qty
        FROM scm.inventory_movements
       WHERE source_doc_type = ${p.docType} AND source_doc_id::text = ${p.resolvedDocId}`;
    log(`      movements already attached to the resolved document by id: rows=${attached[0].rows} netQty=${attached[0].net_qty}`);
  }
  log(`  TOTAL rows in scope: inventory_lot_consumptions=${consTotal}  inventory_movements=${movTotal}`);

  // Exercise the identical writes in a rolled-back transaction, so collisions
  // with the ledger's own unique indexes (the duplicate-of-real class the
  // 2026-08-01 live APPLY hit) are part of the PLAN, not a surprise at apply.
  if (plan.length > 0) {
    log("");
    log("  --- collision preview (writes exercised, then ROLLED BACK — nothing persisted) ---");
    const preview = await execIdRestamp(pg, plan, { commit: false });
    printIdRestampExec(preview, false, log);
  }
  return { plan, tally };
}

/* The collision-aware executor lives in lib/id-restamp-exec.mjs so the REAL
   code — pair-wise savepoints, self-collision classification, the poisoned-
   transaction probe — runs under tests-pg against a real Postgres with a real
   unique index (two live APPLY failures, 2026-08-01, are the reason: see the
   lib header and BUG-HISTORY). The script keeps only the wiring. */
async function applyIdRestamp(plan) {
  const out = await execIdRestamp(pg, plan, { commit: true });
  printIdRestampExec(out, true, log);
  return out;
}

// ── A6 — PART=dedupe: DELETE the duplicate-of-real pairs (owner authorization
// 2026-08-01, "继续 全部可以"). Only a movement whose restamp collides on the
// ledger's unique index AND whose real counterpart carries the same
// (company, product, variant, warehouse, movement_type, qty) — a FULL-ROW
// twin — is deleted, together with its consumptions, RESTORING each consumed
// lot's qty_remaining so 2a conservation holds. execDedupe +
// classifyDuplicateMovement do the work; this wiring prints the evidence and
// the movement-ledger bucket impact (the owner's 2b question: duplicate OUTs
// double-decrement on-hand, so negative buckets should shrink).
async function bucketSums(deletable) {
  const sums = new Map();
  for (const c of deletable) {
    const m = c.movement;
    const key = `${m.company_id}::${m.warehouse_id}::${m.item_code}::${m.variant_key}`;
    if (sums.has(key)) continue;
    const r = await pg`
      SELECT COALESCE(SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty ELSE qty END), 0)::int AS s
        FROM scm.inventory_movements
       WHERE company_id = ${m.company_id} AND warehouse_id::text = ${m.warehouse_id}
         AND item_code = ${m.item_code} AND COALESCE(variant_key, '') = ${m.variant_key}`;
    sums.set(key, Number(r[0].s));
  }
  return sums;
}

function printDedupe(res, committed) {
  const verb = committed ? "DELETED" : "WOULD DELETE";
  log(`  duplicate candidates found: ${res.candidates.length}  (deletable: ${res.deletable.length}, refused: ${res.refused.length})`);
  for (const c of res.deletable) {
    const m = c.movement;
    log(`  ${verb} movement ${m.id}  (${c.dup.group}) — full-row twin on the real document: ${c.verdict.matches.join(", ")}`);
    log(`    old values: ${m.movement_type} qty=${m.qty} unit_cost_sen=${m.unit_cost_sen} total_cost_sen=${m.total_cost_sen} co=${m.company_id} wh=${m.warehouse_id} product=${m.item_code} variant="${m.variant_key}" batch=${m.batch_no ?? "-"} source=${m.source_doc_type} ${m.source_doc_no} dangling_id=${m.doc_id} created_at=${m.created_at?.toISOString?.() ?? m.created_at}`);
    for (const k of c.consumptions) {
      log(`    ${verb} consumption ${k.id}: qty=${k.qty_consumed} @ ${k.unit_cost_sen} sen (total ${k.total_cost_sen}) from lot ${k.lot_id}${k.lot_exists ? ` — lot qty_remaining ${k.lot_remaining} += ${k.qty_consumed} (RESTORED; the duplicate had double-decremented it)` : " — LOT MISSING, nothing to restore (reported)"}`);
    }
    if (c.consumptions.length === 0) log("    (no consumption rows — the duplicate consumed nothing; movement row only)");
  }
  for (const c of res.refused) {
    const m = c.movement;
    log(`  REFUSED movement ${m.id} (${c.verdict.verdict}) — collides on the index but NO full-row twin (type/qty differ); owner review, not deleted.`);
    log(`    row: ${m.movement_type} qty=${m.qty} product=${m.item_code} variant="${m.variant_key}"; counterparts on the real doc: ${c.counterparts.map((x) => `${x.id} ${x.movement_type} qty=${x.qty}`).join("; ") || "(none)"}`);
  }
}

async function planDedupe(codeById) {
  log("");
  log("=== A6  dedupe — remove the duplicate-of-real pairs part=ids classified (owner-authorized) ===");
  const ids = await planIdRestamp(codeById);
  log("");
  log("  --- dedupe plan (detection exercised + rolled back; deletes are planned, not executed) ---");
  const res = await execDedupe(pg, ids.plan, classifyDuplicateMovement, { commit: false });
  printDedupe(res, false);

  // The 2b linkage: per affected bucket, movement-ledger on-hand before -> after.
  if (res.deletable.length > 0) {
    const sums = await bucketSums(res.deletable);
    const projected = projectDedupeBucketImpact(
      res.deletable.map((c) => ({
        bucketKey: `${c.movement.company_id}::${c.movement.warehouse_id}::${c.movement.item_code}::${c.movement.variant_key}`,
        movementType: c.movement.movement_type,
        qty: c.movement.qty,
      })),
      sums,
    );
    log("");
    log("  movement-ledger on-hand per affected bucket (the audit-2b linkage — duplicate OUTs double-decrement, so negatives should shrink):");
    for (const [key, before] of sums) {
      const after = projected.get(key);
      const [co, wh, product, ...vk] = key.split("::");
      log(`    co=${co} ${product} "${vk.join("::")}" wh=${wh}: ${before} -> ${after}${before < 0 ? (after >= before ? "  (negative bucket shrinks/clears)" : "  (UNEXPECTED: negative bucket worsens — review before APPLY)") : ""}`);
    }
    const cogsRemoved = res.deletable.reduce((a, c) => a + Number(c.movement.total_cost_sen ?? 0), 0);
    log(`  COGS carried by the deleted movements (removed with them): ${cogsRemoved} sen; lots restored: ${res.deletable.reduce((a, c) => a + c.consumptions.filter((k) => k.lot_exists).length, 0)} consumption(s) worth`);
  }
  return { plan: res.deletable, ids };
}

async function applyDedupe(idsPlan) {
  const res = await execDedupe(pg, idsPlan, classifyDuplicateMovement, { commit: true });
  printDedupe(res, true);
  log(`  APPLIED: movements deleted=${res.deletedMovements}, consumptions deleted=${res.deletedConsumptions}, lots restored=${res.lotsRestored}, in one transaction.`);
  // Observed after-state for the 2b linkage.
  if (res.deletable.length > 0) {
    const after = await bucketSums(res.deletable);
    log("  movement-ledger on-hand per affected bucket AFTER (observed):");
    for (const [key, s] of after) {
      const [co, wh, product, ...vk] = key.split("::");
      log(`    co=${co} ${product} "${vk.join("::")}" wh=${wh}: ${s}${s < 0 ? "  (still negative — the remainder is not duplicate-born; see reconstruct/relabel)" : ""}`);
    }
  }
  return res;
}

// ── A5 — PART=grn-gap: insert the missing IN movement a posted GRN is short ──
// (Constant restored 2026-08-01: PR #1490's refactor dropped this definition
// while three usages below survived, so part=grn-gap would die with a
// ReferenceError on its first movement-carrying GRN. The doc-relabel
// repair-seeded classification reads the same marker string.)
const GRN_GAP_MARKER = "repair:grn-inbound-gap";

async function planGrnGap() {
  log("");
  log(`=== A5  GRN inbound gap — target GRNs: ${GRNS.join(", ")} ===`);
  const grns = await pg`
    SELECT id::text AS id, grn_number, company_id, status::text AS status, warehouse_id::text AS warehouse_id,
           exchange_rate
      FROM scm.grns WHERE grn_number = ANY(${GRNS})`;
  for (const want of GRNS) {
    if (!grns.some((g) => g.grn_number === want)) log(`  "${want}" matches NO GRN — skipped (check the number).`);
  }
  const plan = [];
  for (const g of grns) {
    log(`  ${g.grn_number}  company=${g.company_id}  status=${g.status}  id=${g.id}`);
    if (["DRAFT", "CANCELLED"].includes(String(g.status).toUpperCase())) {
      log("    SKIP — not a posted GRN (DRAFT/CANCELLED writes no movements).");
      continue;
    }
    // Per-line accepted (net of returns), with the line facts the owner needs
    // to see WHICH line is short.
    const lines = await pg`
      SELECT gi.id, gi.item_code, gi.material_name, gi.qty_accepted,
             COALESCE(gi.returned_qty, 0)::int AS returned_qty,
             gi.unit_price_sen, gi.variants, gi.item_group
        FROM scm.grn_items gi WHERE gi.grn_id = ${g.id}::uuid ORDER BY gi.item_code, gi.id`;
    // The GRN's own IN movements, grouped into the DISTINCT buckets + costs
    // that prove (or refuse) the insert.
    const movs = await pg`
      SELECT id::text AS id, movement_type, warehouse_id::text AS warehouse_id, item_code, product_name,
             COALESCE(variant_key, '') AS variant_key, batch_no, qty, unit_cost_sen, company_id, notes, created_at
        FROM scm.inventory_movements
       WHERE source_doc_type = 'GRN' AND source_doc_id = ${g.id}::uuid
       ORDER BY created_at, id`;

    const byProduct = new Map();
    for (const l of lines) {
      /* SERVICE lines NEVER enter inventory (grns.ts posts filter
         isServiceLine) — counting them into accepted qty is exactly how the
         2026-08-02 regression inserted a phantom SVC-TRANS.CHARGES lot on
         2990-GRN-2606-001. Excluded here AND in the audit's 3a lens. */
      if (isServiceLineMirror({ itemGroup: l.item_group, itemCode: l.item_code })) {
        log(`    line ${l.id} ${l.item_code} (group=${l.item_group ?? "-"}) — SERVICE line, never stocked; EXCLUDED from the gap math.`);
        continue;
      }
      const p = byProduct.get(l.item_code) ?? { lineQty: 0, lines: [], buckets: new Map(), marker: false };
      p.lineQty += Math.max(0, Number(l.qty_accepted ?? 0) - Number(l.returned_qty ?? 0));
      p.lines.push(l);
      byProduct.set(l.item_code, p);
    }
    for (const m of movs) {
      if (isServiceLineMirror({ itemCode: m.item_code })) {
        log(`    WARNING movement ${m.id} is a SERVICE-coded receipt (${m.item_code}, ${m.movement_type} qty=${m.qty}) — a defect this part must not plan around; reverse it via part=service-lot-reverse.`);
        continue;
      }
      const p = byProduct.get(m.item_code) ?? { lineQty: 0, lines: [], buckets: new Map(), marker: false };
      const key = `${m.warehouse_id}::${m.variant_key}::${m.batch_no ?? ""}::${m.company_id}`;
      const b = p.buckets.get(key) ?? {
        warehouseId: m.warehouse_id, variantKey: m.variant_key, batchNo: m.batch_no ?? null,
        companyId: Number(m.company_id), productName: m.product_name, movQty: 0, unitCosts: new Set(), rows: [],
      };
      b.movQty += m.movement_type === "IN" ? Number(m.qty) : -Number(m.qty);
      b.unitCosts.add(Number(m.unit_cost_sen ?? 0));
      b.rows.push(m);
      p.buckets.set(key, b);
      if ((m.notes ?? "").includes(GRN_GAP_MARKER)) p.marker = true;
      byProduct.set(m.item_code, p);
    }

    for (const [code, p] of byProduct) {
      const buckets = [...p.buckets.values()].map((b) => ({ ...b, unitCosts: [...b.unitCosts] }));
      const v = classifyGrnInboundGap({ itemCode: code, lineQty: p.lineQty, buckets });
      log(`    product ${code}: accepted-net=${v.lineQty}  movements=${v.movQty}  delta=${v.delta}  -> ${v.verdict}`);
      for (const l of p.lines) {
        log(`      line ${l.id}  accepted=${l.qty_accepted} returned=${l.returned_qty}  unit_price_sen=${l.unit_price_sen}  group=${l.item_group ?? "-"}`);
      }
      for (const b of buckets) {
        log(`      movement bucket wh=${b.warehouseId} variant="${b.variantKey}" batch=${b.batchNo ?? "-"} co=${b.companyId}: qty=${b.movQty} unitCosts=[${b.unitCosts.join(", ")}]`);
        for (const r of b.rows) log(`        movement ${r.id}  ${r.movement_type}  qty=${r.qty}  unit_cost_sen=${r.unit_cost_sen}  at ${r.created_at?.toISOString?.() ?? r.created_at}`);
      }
      let ins = null;
      let costNote = "the sibling movement's landed cost";
      if (v.verdict === "insert") {
        ins = v.insert;
      } else if (v.verdict === "no-sibling") {
        // Live run 2026-08-01: the short line wrote NO movement at all, so
        // there is no sibling to copy. Fall back to the LINE'S OWN landed
        // cost — round(unit_price_sen x GRN exchange_rate), the same
        // toMyrSen path grns.ts uses — and to the GRN's own single-valued
        // facts for the bucket (deriveGrnLineBasis: refused when the product
        // has several lines, no warehouse resolves, or the cost is zero).
        const d = deriveGrnLineBasis({
          lines: p.lines,
          qty: v.delta,
          headerWarehouseId: g.warehouse_id,
          exchangeRate: g.exchange_rate ?? 1,
          grnMovementWarehouses: movs.map((m) => m.warehouse_id),
          grnMovementBatches: movs.map((m) => m.batch_no),
          companyId: Number(g.company_id),
        });
        if (d.verdict === "line-insert") {
          ins = d.insert;
          costNote = `the LINE'S OWN landed cost (${d.costSource})`;
          log(`      no sibling movement — falling back to the line's own landed cost (${d.costSource})`);
          if (ins.batchNo == null) log("      (no single batch across the GRN's movements — inserting UNBATCHED; plain-FIFO consumable)");
        } else {
          log(`      REFUSED (no-sibling, line-basis ${d.verdict}) — nothing will be inserted for this product; owner review.`);
          continue;
        }
      } else {
        if (v.verdict !== "balanced") log(`      REFUSED (${v.verdict}) — nothing will be inserted for this product; owner review.`);
        continue;
      }
      if (p.marker) {
        log(`      REFUSED — a movement already carries the ${GRN_GAP_MARKER} marker yet the delta still reads ${v.delta}; manual review, not a second insert.`);
        continue;
      }
      log(`      PLAN: INSERT IN movement qty=${ins.qty} at unit_cost_sen=${ins.unitCostSen} (${costNote})`);
      log(`            bucket: warehouse=${ins.warehouseId} variant="${ins.variantKey}" batch=${ins.batchNo ?? "NULL"} company=${ins.companyId}`);
      log(`            source: GRN ${g.grn_number} (${g.id}); created_at=now — the FIFO trigger opens a ${ins.qty}-unit lot at this cost on insert`);
      plan.push({
        grnId: g.id, grnNumber: g.grn_number, itemCode: code,
        productName: buckets[0]?.productName ?? p.lines[0]?.material_name ?? code,
        ...ins,
      });
    }
  }
  log(`  IN movements to insert: ${plan.length}`);
  return { plan };
}

async function applyGrnGap(plan) {
  if (plan.length === 0) return 0;
  let done = 0;
  for (const p of plan) {
    // Guarded compare-and-set against a concurrent post: recompute the delta
    // inside the transaction; insert only while the gap still exists. The
    // AFTER-INSERT FIFO trigger opens the lot — the normal path, not a bypass.
    await pg.begin(async (tx) => {
      const fresh = await tx`
        WITH l AS (
          SELECT SUM(GREATEST(0, COALESCE(qty_accepted, 0) - COALESCE(returned_qty, 0)))::int AS line_qty
            FROM scm.grn_items WHERE grn_id = ${p.grnId}::uuid AND item_code = ${p.itemCode}
        ), m AS (
          SELECT COALESCE(SUM(CASE WHEN movement_type = 'IN' THEN qty ELSE -qty END), 0)::int AS mov_qty
            FROM scm.inventory_movements
           WHERE source_doc_type = 'GRN' AND source_doc_id = ${p.grnId}::uuid AND item_code = ${p.itemCode}
        )
        SELECT l.line_qty - m.mov_qty AS delta FROM l, m`;
      const delta = Number(fresh[0]?.delta ?? 0);
      if (delta !== p.qty) {
        log(`  SKIPPED ${p.grnNumber} ${p.itemCode}: delta is now ${delta}, plan said ${p.qty} — re-run the dry run.`);
        return;
      }
      const inserted = await tx`
        INSERT INTO scm.inventory_movements (
          movement_type, warehouse_id, item_code, product_name, variant_key,
          qty, unit_cost_sen, source_doc_type, source_doc_id, source_doc_no,
          batch_no, notes, performed_by, company_id
        ) VALUES (
          'IN', ${p.warehouseId}::uuid, ${p.itemCode}, ${p.productName}, ${p.variantKey},
          ${p.qty}, ${p.unitCostSen}, 'GRN', ${p.grnId}::uuid, ${p.grnNumber},
          ${p.batchNo}, ${`${GRN_GAP_MARKER}: ${p.grnNumber} accepted ${p.qty} more than its IN movements booked (audit 3a); inserted at the sibling movement's landed cost`},
          NULL, ${p.companyId}
        ) RETURNING id::text AS id`;
      const lot = await tx`
        SELECT id::text AS id, qty_received, qty_remaining, unit_cost_sen
          FROM scm.inventory_lots WHERE movement_id = ${inserted[0].id}::uuid`;
      if (lot.length !== 1 || Number(lot[0].qty_remaining) !== p.qty || Number(lot[0].unit_cost_sen) !== p.unitCostSen) {
        throw new Error(`FIFO trigger did not open the expected lot for movement ${inserted[0].id} (got ${JSON.stringify(lot)}) — rolled back`);
      }
      log(`  APPLIED ${p.grnNumber} ${p.itemCode}: movement ${inserted[0].id} qty=${p.qty} @ ${p.unitCostSen} sen; lot ${lot[0].id} opened (received=${lot[0].qty_received}, remaining=${lot[0].qty_remaining})`);
      done += 1;
    });
  }
  return done;
}

// ── A11 — PART=service-lot-reverse: reverse ONE phantom service-line receipt ─
// (2026-08-02 self-caught regression: the grn-gap APPLY on 2990-GRN-2606-001
// counted the SVC-TRANS.CHARGES freight line into accepted qty and inserted a
// 1-unit IN movement + lot for a SERVICE — which the app never stocks). Guards
// live in planServiceLotReversal (pure): IN + service-coded product only, lot
// belongs to the movement's doc+product, UNTOUCHED (received==remaining, zero
// consumptions on lot AND movement) — anything else refuses with the facts.
async function planServiceLotReverse() {
  log("");
  log(`=== A11 service-lot-reverse — movement ${REVERSE_MOVEMENT_ID}, lot ${REVERSE_LOT_ID} ===`);
  const movRows = await pg`
    SELECT m.id::text AS id, m.movement_type, m.item_code, m.qty, m.unit_cost_sen,
           m.source_doc_type, m.source_doc_id::text AS source_doc_id, m.source_doc_no,
           m.warehouse_id::text AS warehouse_id, m.company_id, m.notes, m.created_at
      FROM scm.inventory_movements m WHERE m.id = ${REVERSE_MOVEMENT_ID}::uuid`;
  const lotRows = await pg`
    SELECT l.id::text AS id, l.item_code, l.qty_received, l.qty_remaining, l.unit_cost_sen,
           l.source_doc_type, l.source_doc_id::text AS source_doc_id, l.batch_no,
           l.movement_id::text AS movement_id, l.received_at
      FROM scm.inventory_lots l WHERE l.id = ${REVERSE_LOT_ID}::uuid`;
  const mov = movRows[0] ?? null;
  const lot = lotRows[0] ?? null;
  if (mov) log(`  movement: ${mov.movement_type} ${mov.item_code} qty=${mov.qty} @ ${mov.unit_cost_sen} sen  src=${mov.source_doc_type} ${mov.source_doc_no ?? mov.source_doc_id}  wh=${mov.warehouse_id} co=${mov.company_id}  notes=${JSON.stringify(mov.notes ?? null)}`);
  else log(`  movement ${REVERSE_MOVEMENT_ID}: NOT FOUND`);
  if (lot) log(`  lot: ${lot.item_code} received=${lot.qty_received} remaining=${lot.qty_remaining} @ ${lot.unit_cost_sen} sen  src=${lot.source_doc_type} ${lot.source_doc_id}  batch=${lot.batch_no ?? "-"}  movement_id=${lot.movement_id ?? "-"}`);
  else log(`  lot ${REVERSE_LOT_ID}: NOT FOUND`);
  const [lotCons, movCons] = await Promise.all([
    pg`SELECT COUNT(*)::int AS n FROM scm.inventory_lot_consumptions WHERE lot_id = ${REVERSE_LOT_ID}::uuid`,
    pg`SELECT COUNT(*)::int AS n FROM scm.inventory_lot_consumptions WHERE movement_id = ${REVERSE_MOVEMENT_ID}::uuid`,
  ]);
  const v = planServiceLotReversal({
    movement: mov ? {
      id: mov.id, movementType: mov.movement_type, itemCode: mov.item_code,
      qty: Number(mov.qty), unitCostSen: Number(mov.unit_cost_sen ?? 0),
      sourceDocType: mov.source_doc_type, sourceDocId: mov.source_doc_id,
    } : null,
    lot: lot ? {
      id: lot.id, itemCode: lot.item_code,
      qtyReceived: Number(lot.qty_received), qtyRemaining: Number(lot.qty_remaining),
      sourceDocType: lot.source_doc_type, sourceDocId: lot.source_doc_id,
    } : null,
    lotConsumptions: Number(lotCons[0]?.n ?? 0),
    movementConsumptions: Number(movCons[0]?.n ?? 0),
  });
  if (v.verdict === "reverse") log(`  PLAN: ${v.print}`);
  else log(`  REFUSED (${v.verdict}): ${JSON.stringify(v)} — nothing will be deleted; owner review.`);
  return { plan: v.verdict === "reverse" ? [{ movementId: REVERSE_MOVEMENT_ID, lotId: REVERSE_LOT_ID, print: v.print }] : [] };
}

async function applyServiceLotReverse(plan) {
  let done = 0;
  for (const p of plan) {
    await pg.begin(async (tx) => {
      // Re-verify inside the transaction: still zero consumptions, lot untouched.
      const fresh = await tx`
        SELECT (SELECT COUNT(*)::int FROM scm.inventory_lot_consumptions WHERE lot_id = ${p.lotId}::uuid) AS lot_cons,
               (SELECT COUNT(*)::int FROM scm.inventory_lot_consumptions WHERE movement_id = ${p.movementId}::uuid) AS mov_cons,
               (SELECT qty_received - qty_remaining FROM scm.inventory_lots WHERE id = ${p.lotId}::uuid) AS consumed`;
      if (Number(fresh[0]?.lot_cons ?? 1) !== 0 || Number(fresh[0]?.mov_cons ?? 1) !== 0 || Number(fresh[0]?.consumed ?? 1) !== 0) {
        throw new Error(`service-lot-reverse: lot/movement gained consumption since the plan (${JSON.stringify(fresh[0])}) — rolled back; re-run the dry run`);
      }
      const delLot = await tx`DELETE FROM scm.inventory_lots WHERE id = ${p.lotId}::uuid`;
      const delMov = await tx`DELETE FROM scm.inventory_movements WHERE id = ${p.movementId}::uuid`;
      if (delLot.count !== 1 || delMov.count !== 1) {
        throw new Error(`service-lot-reverse: expected 1 lot + 1 movement, deleted ${delLot.count}+${delMov.count} — rolled back`);
      }
      log(`  APPLIED (deleted): ${p.print}`);
      done += 1;
    });
  }
  return done;
}

// ── A7 — PART=fifo-attribute: FIFO attribution for consolidated PO lines ─────
// (owner rule: identical-product consolidation attributes by FIFO — no manual
// split). Named POs only (POS env). Writes purchase_order_item_allocations
// rows; the mig-0235 triggers guard SUM(alloc) <= line qty underneath us.
const subNo = (poNumber, seq) => `${poNumber}-${String(seq).padStart(2, "0")}`;

/* DELIVERED-LEDGER service per SO line (the precedence evidence for A7 + A10):
   so_item_id -> { soQty, servedQty, servingPos:[po numbers], servingDos:[do
   numbers] }. A line is "served" by the goods that physically LEFT for it —
   its non-cancelled DO lines whose (do, code) ledger bucket resolves at least
   one source PO (consumption -> lot batch_no, GRN-healed; ∪ batched OUT
   movements for the sofa/drop-ship path). servedQty is the DO-line qty (the
   documented delivered amount), the same definition the app's delivered trace
   uses; matching is (do, code) — the check-so-source-trace loose-bucket rule. */
async function deliveredServiceBySoItem(soLineIds) {
  const out = new Map();
  if (!soLineIds || soLineIds.length === 0) return out;
  const doLines = await pg`
    SELECT di.so_item_id::text AS so_item_id, di.delivery_order_id::text AS do_id,
           di.item_code, di.qty, d.do_number
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id::text = ANY(${soLineIds})
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'`;
  if (doLines.length === 0) return out;
  const doIds = [...new Set(doLines.map((r) => r.do_id))];
  const cons = await pg`
    SELECT c.source_doc_id::text AS do_id, c.item_code,
           COALESCE(l.batch_no, p.po_number) AS po
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_lots l ON l.id = c.lot_id
      LEFT JOIN scm.grns g ON UPPER(COALESCE(l.source_doc_type,'')) = 'GRN' AND g.id = l.source_doc_id
      LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
     WHERE c.source_doc_type = 'DO' AND c.source_doc_id::text = ANY(${doIds})`;
  const movs = await pg`
    SELECT source_doc_id::text AS do_id, item_code, batch_no AS po
      FROM scm.inventory_movements
     WHERE source_doc_type = 'DO' AND movement_type = 'OUT'
       AND source_doc_id::text = ANY(${doIds}) AND batch_no IS NOT NULL`;
  const posByDoCode = new Map();
  for (const r of [...cons, ...movs]) {
    if (!r.po) continue;
    const k = `${r.do_id}::${String(r.item_code ?? "").trim().toUpperCase()}`;
    const set = posByDoCode.get(k) ?? new Set();
    set.add(r.po);
    posByDoCode.set(k, set);
  }
  for (const dl of doLines) {
    const pos = posByDoCode.get(`${dl.do_id}::${String(dl.item_code ?? "").trim().toUpperCase()}`);
    if (!pos || pos.size === 0) continue; // DO line with no ledger evidence — not proof of service
    const cur = out.get(dl.so_item_id) ?? { servedQty: 0, servingPos: new Set(), servingDos: new Set() };
    cur.servedQty += Number(dl.qty ?? 0);
    for (const po of pos) cur.servingPos.add(po);
    if (dl.do_number) cur.servingDos.add(dl.do_number);
    out.set(dl.so_item_id, cur);
  }
  return out;
}

async function planFifoAttribute() {
  log("");
  log(`=== A7  fifo-attribute — target POs: ${POS.join(", ")} ===`);
  const pos = await pg`
    SELECT id::text AS id, po_number, company_id, status::text AS status, notes
      FROM scm.purchase_orders WHERE po_number = ANY(${POS})`;
  for (const want of POS) {
    if (!pos.some((p) => p.po_number === want)) log(`  "${want}" matches NO purchase order — skipped (check the number).`);
  }
  if (pos.length === 0) return { plans: [] };

  // The named SOs come from each PO's OWN note (the A1-repaired "From SOs:"
  // list) — the same evidence tier the pairing backfill used; a token that
  // does not resolve to a same-company SO is reported and contributes nothing.
  const allTokens = new Set();
  for (const p of pos) for (const t of parseFromSosTokens(p.notes)) allTokens.add(t);
  const soHeaders = allTokens.size
    ? await pg`
        SELECT so.doc_no, so.company_id, so.customer_delivery_date
          FROM scm.mfg_sales_orders so WHERE so.doc_no = ANY(${[...allTokens]})`
    : [];
  const headerByDocCo = new Map();
  for (const h of soHeaders) headerByDocCo.set(`${h.company_id}::${h.doc_no}`, h);

  // One SO line is never double-served: lines already claimed by ANY PO line's
  // so_item_id or ANY allocation row are taken everywhere.
  const takenLinks = await pg`
    SELECT DISTINCT so_item_id FROM scm.purchase_order_items WHERE so_item_id IS NOT NULL`;
  const takenAllocs = await pg`
    SELECT DISTINCT so_item_id FROM scm.purchase_order_item_allocations WHERE so_item_id IS NOT NULL`;
  const taken = new Set([...takenLinks, ...takenAllocs].map((r) => String(r.so_item_id)));

  const plans = [];
  for (const p of pos) {
    const cid = Number(p.company_id);
    log("");
    log(`  ${p.po_number} (company ${cid}, status ${p.status})`);
    const tokens = parseFromSosTokens(p.notes);
    const namedSos = tokens.filter((t) => headerByDocCo.has(`${cid}::${t}`));
    for (const t of tokens) {
      if (!namedSos.includes(t)) log(`    note token "${t}" resolves to NO same-company Sales Order — ignored (run part=notes first if it is unprefixed).`);
    }
    if (namedSos.length < 2) {
      log(`    note names ${namedSos.length} resolvable SO(s) — this part exists for CONSOLIDATED POs (2+); the 1:1 backfill owns the rest. Skipped.`);
      continue;
    }
    log(`    named SOs: ${namedSos.join(", ")}`);

    const poLines = await pg`
      SELECT i.id::text AS id, i.item_code, i.qty, i.so_item_id::text AS so_item_id, i.created_at,
             COALESCE(a.n, 0)::int AS allocation_count
        FROM scm.purchase_order_items i
        LEFT JOIN (SELECT purchase_order_item_id, count(*)::int AS n
                     FROM scm.purchase_order_item_allocations GROUP BY purchase_order_item_id) a
          ON a.purchase_order_item_id = i.id
       WHERE i.purchase_order_id = ${p.id}::uuid
       ORDER BY i.created_at, i.id`;
    const soLines = await pg`
      SELECT si.id::text AS id, si.doc_no, si.item_code, si.qty, si.line_no,
             si.line_delivery_date, si.cancelled
        FROM scm.mfg_sales_order_items si
       WHERE si.doc_no = ANY(${namedSos}) AND si.company_id = ${cid} AND si.cancelled = false
       ORDER BY si.doc_no, si.line_no NULLS LAST, si.id`;
    /* DELIVERED PRECEDENCE (2026-08-02): a named SO line whose demand the
       delivered ledger proves already shipped — from ANY PO — is TAKEN. This is
       what the 023/024 incident was missing: the stored-link/allocation
       taken-set cannot see goods that already left under another PO's batch. */
    const servedMap = await deliveredServiceBySoItem(soLines.map((l) => l.id));

    const res = planFifoAttribution({
      // Status guard (2026-08-02, the 023 verdict): a CANCELLED/DRAFT PO is
      // never an attribution target — the pure core refuses and says so.
      poStatus: p.status,
      poLines: poLines.map((l) => ({
        id: l.id,
        itemCode: l.item_code,
        qty: Number(l.qty),
        soItemId: l.so_item_id,
        allocationCount: Number(l.allocation_count),
        createdAt: l.created_at?.toISOString?.() ?? String(l.created_at),
      })),
      soLines: soLines.map((l) => ({
        id: l.id,
        doc: l.doc_no,
        itemCode: l.item_code,
        qty: Number(l.qty),
        lineNo: l.line_no,
        // The MRP demand date rule verbatim: line date, else the header promise.
        deliveryDate: l.line_delivery_date ?? headerByDocCo.get(`${cid}::${l.doc_no}`)?.customer_delivery_date ?? null,
        taken: taken.has(l.id),
        servedQty: servedMap.get(l.id)?.servedQty ?? 0,
        servingPos: [...(servedMap.get(l.id)?.servingPos ?? [])],
      })),
    });
    if (res.refusedPoStatus) {
      log(`    REFUSED — PO status ${res.refusedPoStatus}: a dead PO supplies nothing and must never receive allocations. Skipped.`);
      continue;
    }

    log(`    PO lines: ${poLines.length} (already so_item_id-linked: ${res.skippedLinked.length}, already allocated: ${res.skippedAllocated.length}, planned now: ${res.plans.length})`);
    for (const id of res.skippedLinked) log(`      SKIP line ${id} — carries so_item_id (the 1:1 fast path; not touched)`);
    for (const id of res.skippedAllocated) log(`      SKIP line ${id} — already has allocations (idempotent re-run)`);
    for (const s of res.skippedServed ?? []) {
      log(`      TAKEN (delivered precedence) ${s.soDoc} line ${s.soItemId} ${s.itemCode} qty ${s.qty} — already served by ${s.servingPos.join("+") || "?"}; not re-claimed`);
    }
    let li = 0;
    for (const plan of res.plans) {
      li += 1;
      log(`    line ${plan.poLineId}  ${plan.itemCode}  qty ${plan.lineQty}:`);
      for (const s of plan.slices) {
        log(`      ${subNo(p.po_number, s.seq)} -> ${s.soItemId ? `${s.soDoc} (so line ${s.soItemId})` : "STOCK"} (qty ${s.qty})`);
      }
      const sum = plan.slices.reduce((a, s) => a + s.qty, 0);
      if (sum !== plan.lineQty) log(`      !! slice sum ${sum} != line qty ${plan.lineQty} — this plan would be refused at apply`);
    }
    for (const u of res.unfilled) log(`    UNFILLED named demand: ${u.soDoc} line ${u.soItemId} ${u.itemCode} qty ${u.qty} — no eligible PO line covers it (reported only)`);
    if (res.plans.length > 0) plans.push({ po: p, res });
  }
  log("");
  log(`  A7 total: ${plans.reduce((a, x) => a + x.res.plans.length, 0)} PO line(s) across ${plans.length} PO(s) would receive allocations.`);
  return { plans };
}

async function applyFifoAttribute(planned) {
  let lines = 0, rows = 0;
  for (const { po, res } of planned) {
    // One transaction per PO; per line a FOR UPDATE lock + live re-check (no
    // so_item_id, still zero allocations) so a concurrent writer aborts the PO
    // cleanly rather than double-allocating. The 0235 trigger re-locks the
    // parent line and enforces SUM(alloc) <= qty underneath us either way.
    await pg.begin(async (tx) => {
      for (const plan of res.plans) {
        const fresh = await tx`
          SELECT i.qty, i.so_item_id::text AS so_item_id,
                 (SELECT count(*)::int FROM scm.purchase_order_item_allocations a WHERE a.purchase_order_item_id = i.id) AS alloc_n
            FROM scm.purchase_order_items i WHERE i.id = ${plan.poLineId}::uuid FOR UPDATE OF i`;
        if (fresh.length !== 1) throw new Error(`PO line ${plan.poLineId} vanished since the plan — PO rolled back; re-run the dry run`);
        if (fresh[0].so_item_id != null || Number(fresh[0].alloc_n) !== 0 || Number(fresh[0].qty) !== plan.lineQty) {
          throw new Error(`PO line ${plan.poLineId} changed since the plan (so_item_id=${fresh[0].so_item_id}, allocations=${fresh[0].alloc_n}, qty=${fresh[0].qty}) — PO rolled back; re-run the dry run`);
        }
        for (const s of plan.slices) {
          await tx`
            INSERT INTO scm.purchase_order_item_allocations
              (company_id, purchase_order_item_id, seq, qty, so_item_id, created_by)
            VALUES (${Number(po.company_id)}, ${plan.poLineId}::uuid, ${s.seq}, ${s.qty}, ${s.soItemId ?? null}::uuid, NULL)`;
          rows += 1;
          log(`  APPLIED ${subNo(po.po_number, s.seq)} (line ${plan.poLineId}) -> ${s.soItemId ? s.soDoc : "STOCK"} (qty ${s.qty})`);
        }
        lines += 1;
      }
    });
  }
  return { lines, rows };
}

// ── A10 — PART=fifo-attribute-repair: re-evaluate EXISTING allocations against
// the delivered chain (the 023/024 corrective). Named POs only (POS env).
// Dry-run by default; APPLY=1 deletes/flips inside one transaction per PO.
async function planFifoAttrRepair() {
  log("");
  log(`=== A10 fifo-attribute-repair — target POs: ${POS.join(", ")} ===`);
  const pos = await pg`
    SELECT id::text AS id, po_number, company_id, supplier_id::text AS supplier_id,
           po_date, status::text AS status
      FROM scm.purchase_orders WHERE po_number = ANY(${POS})`;
  for (const want of POS) {
    if (!pos.some((p) => p.po_number === want)) log(`  "${want}" matches NO purchase order — skipped (check the number).`);
  }
  if (pos.length === 0) return { plans: [] };

  const plans = [];
  for (const p of pos) {
    log("");
    log(`  ${p.po_number} (company ${p.company_id}, status ${p.status})`);
    // The PO's lines + allocation rows (SO doc resolved for the prints).
    const lineRows = await pg`
      SELECT i.id::text AS id, i.item_code, i.item_group, i.variants, i.qty, i.unit_price_sen
        FROM scm.purchase_order_items i
       WHERE i.purchase_order_id = ${p.id}::uuid
       ORDER BY i.created_at, i.id`;
    const allocRows = await pg`
      SELECT a.id::text AS id, a.purchase_order_item_id::text AS po_line_id, a.seq, a.qty,
             a.so_item_id::text AS so_item_id, si.doc_no AS so_doc
        FROM scm.purchase_order_item_allocations a
        LEFT JOIN scm.mfg_sales_order_items si ON si.id = a.so_item_id
       WHERE a.purchase_order_item_id IN
             (SELECT id FROM scm.purchase_order_items WHERE purchase_order_id = ${p.id}::uuid)
       ORDER BY a.purchase_order_item_id, a.seq`;
    if (allocRows.length === 0) {
      log(`    no allocation rows — nothing to re-evaluate.`);
      continue;
    }
    // Execution state of THIS PO: any non-cancelled GRN, or any delivered ledger row.
    const [selfGrns, selfDelivered] = await Promise.all([
      pg`SELECT COUNT(*)::int AS n FROM scm.grns
          WHERE purchase_order_id = ${p.id}::uuid AND UPPER(COALESCE(status::text,'')) <> 'CANCELLED'`,
      pg`SELECT COUNT(*)::int AS n FROM scm.inventory_lots l
          JOIN scm.inventory_lot_consumptions c ON c.lot_id = l.id
         WHERE l.batch_no = ${p.po_number}`,
    ]);
    const selfExecuted = Number(selfGrns[0]?.n ?? 0) > 0 || Number(selfDelivered[0]?.n ?? 0) > 0;
    /* The 023 source verdict (2026-08-02): the PO was CANCELLED in the source
       system and imported verbatim. A cancelled PO's allocations are removed
       regardless of the duplicate gate — and the owner needs NO cancel action.
       If the status is NOT cancelled where the verdict says it should be,
       that is import drift: REPORT it (below), never change status here. */
    const selfCancelled = String(p.status ?? "").toUpperCase() === "CANCELLED";
    if (p.po_number === "2990-PO-2606-023") {
      log(selfCancelled
        ? `    source-verdict check: 2990-PO-2606-023 status=CANCELLED in Houzs — matches the source system's own cancel (operator re-creation, cancelled there; import carried it, same UUID). No owner cancel action needed; MRP was never inflated (CANCELLED is PO_DEAD).`
        : `    source-verdict check: 2990-PO-2606-023 status=${p.status} — the source system says CANCELLED; this is IMPORT DRIFT. Reported only — this part never changes a document status; owner decision.`);
    }
    // Duplicate twin: same company + supplier, multiset-identical lines, ±3 days,
    // EXECUTED (received or delivered). The same fingerprint the read-only
    // detector (check-duplicate-documents.mjs) prints.
    const selfKey = docLineMultisetKey(lineRows.map((l) => ({
      itemCode: l.item_code,
      variantKey: variantKeyMirror(l.item_group, l.variants ?? null),
      qty: Number(l.qty ?? 0),
      unitPriceSen: l.unit_price_sen == null ? null : Number(l.unit_price_sen),
    })));
    let duplicateOf = null;
    if (p.supplier_id) {
      const twins = await pg`
        SELECT o.id::text AS id, o.po_number, o.po_date,
               (SELECT COUNT(*)::int FROM scm.grns g
                 WHERE g.purchase_order_id = o.id AND UPPER(COALESCE(g.status::text,'')) <> 'CANCELLED') AS grn_n
          FROM scm.purchase_orders o
         WHERE o.company_id = ${p.company_id} AND o.supplier_id = ${p.supplier_id}::uuid
           AND o.id <> ${p.id}::uuid AND UPPER(COALESCE(o.status::text,'')) <> 'CANCELLED'`;
      for (const t of twins) {
        const gap = dateGapDays(p.po_date, t.po_date);
        if (gap == null || gap > 3) continue;
        const tLines = await pg`
          SELECT item_code, item_group, variants, qty, unit_price_sen
            FROM scm.purchase_order_items WHERE purchase_order_id = ${t.id}::uuid`;
        const tKey = docLineMultisetKey(tLines.map((l) => ({
          itemCode: l.item_code,
          variantKey: variantKeyMirror(l.item_group, l.variants ?? null),
          qty: Number(l.qty ?? 0),
          unitPriceSen: l.unit_price_sen == null ? null : Number(l.unit_price_sen),
        })));
        if (tKey !== selfKey) continue;
        const tDelivered = await pg`
          SELECT COUNT(*)::int AS n FROM scm.inventory_lots l
            JOIN scm.inventory_lot_consumptions c ON c.lot_id = l.id
           WHERE l.batch_no = ${t.po_number}`;
        const executed = Number(t.grn_n ?? 0) > 0 || Number(tDelivered[0]?.n ?? 0) > 0;
        if (!duplicateOf || (executed && !duplicateOf.executed)) {
          duplicateOf = { poNumber: t.po_number, executed };
        }
      }
    }
    log(`    executed(self): ${selfExecuted}; multiset twin: ${duplicateOf ? `${duplicateOf.poNumber} (executed: ${duplicateOf.executed})` : "none"}`);

    // Delivered service for every SO line the allocations name.
    const soItemIds = [...new Set(allocRows.map((a) => a.so_item_id).filter(Boolean))];
    const servedMap = await deliveredServiceBySoItem(soItemIds);
    const soQtyRows = soItemIds.length
      ? await pg`SELECT id::text AS id, qty FROM scm.mfg_sales_order_items WHERE id::text = ANY(${soItemIds})`
      : [];
    const soQtyById = new Map(soQtyRows.map((r) => [r.id, Number(r.qty ?? 0)]));
    const served = {};
    for (const id of soItemIds) {
      const s = servedMap.get(id);
      if (!s) continue;
      served[id] = {
        soQty: soQtyById.get(id) ?? 0,
        servedQty: s.servedQty,
        servingPos: [...s.servingPos],
        servingDos: [...s.servingDos].sort(),
      };
    }

    const byLine = new Map();
    for (const a of allocRows) {
      const arr = byLine.get(a.po_line_id) ?? [];
      arr.push({ id: a.id, seq: Number(a.seq), qty: Number(a.qty), soItemId: a.so_item_id, soDoc: a.so_doc });
      byLine.set(a.po_line_id, arr);
    }
    const res = planAllocationDeliveredRepair({
      poNumber: p.po_number,
      selfExecuted,
      selfCancelled,
      duplicateOf,
      lines: [...byLine.entries()].map(([poLineId, allocations]) => ({ poLineId, allocations })),
      served,
    });
    log(`    mode: ${res.mode} — removals: ${res.removals.length}, flips: ${res.flips.length}, keeps: ${res.keeps.length}, partial (refused): ${res.partials.length}`);
    for (const r of res.removals) log(`      ${r.print}`);
    for (const f of res.flips) log(`      ${f.print}`);
    for (const k of res.keeps) log(`      KEEP allocation ${k.allocationId} — ${k.reason}`);
    for (const x of res.partials) log(`      PARTIAL (refused, needs-owner) allocation ${x.allocationId} — ${x.soDoc}: served ${x.servedQty}/${x.soQty}`);
    if (res.recommendation) log(`    RECOMMENDATION: ${res.recommendation}`);
    if (res.removals.length > 0 || res.flips.length > 0) plans.push({ po: p, res });
  }
  log("");
  log(`  A10 total: ${plans.reduce((a, x) => a + x.res.removals.length, 0)} removal(s) + ${plans.reduce((a, x) => a + x.res.flips.length, 0)} flip(s) across ${plans.length} PO(s).`);
  return { plans };
}

async function applyFifoAttrRepair(planned) {
  let removed = 0, flipped = 0;
  for (const { po, res } of planned) {
    await pg.begin(async (tx) => {
      for (const r of res.removals) {
        const del = await tx`
          DELETE FROM scm.purchase_order_item_allocations
           WHERE id = ${r.allocationId}::uuid AND (so_item_id::text IS NOT DISTINCT FROM ${r.soItemId})`;
        if (del.count === 1) { removed += 1; log(`  APPLIED ${r.print}`); }
        else log(`  SKIPPED allocation ${r.allocationId} — changed since the plan; re-run the dry run.`);
      }
      for (const f of res.flips) {
        const upd = await tx`
          UPDATE scm.purchase_order_item_allocations
             SET so_item_id = NULL
           WHERE id = ${f.allocationId}::uuid AND so_item_id::text = ${f.soItemId}`;
        if (upd.count === 1) { flipped += 1; log(`  APPLIED ${f.print}`); }
        else log(`  SKIPPED allocation ${f.allocationId} — so_item_id changed since the plan; re-run the dry run.`);
      }
    });
    if (res.recommendation) log(`  RECOMMENDATION (owner decision, NOT executed): ${res.recommendation}`);
  }
  return { removed, flipped };
}

// ── A8 — PART=so-warehouse: stamp warehouse_id on the SO lines whose header
// resolves nothing, from document evidence (DO movement > unanimous siblings >
// single active warehouse). Mirror-owned rows are reported, never written.
async function planSoWarehouse(codeById) {
  log("");
  log("=== A8  so-warehouse — NULL-warehouse SO lines whose header resolves nothing ===");
  const mirrorCompanyId = [...codeById.entries()].find(([, code]) => String(code) === "2990")?.[0] ?? null;
  log(`  mirror company (code 2990, so-mirror-maintained): ${mirrorCompanyId ?? "NOT FOUND — mirror guard inactive"}`);

  // The check-backfillable-gaps section-1 lens, verbatim: live SO lines with
  // NULL warehouse whose header ALSO resolves nothing (no sales_location
  // match, no state mapping). Header-resolvable lines are LEAVE-ALONE there
  // (the read path serves them); this part must not widen that judgement.
  const rows = await pg`
    SELECT i.id::text AS id, i.doc_no, i.item_code, i.qty, COALESCE(i.item_group,'') AS item_group,
           so.company_id, so.status::text AS status, so.sales_location, so.customer_state
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
     WHERE i.warehouse_id IS NULL
       AND COALESCE(i.cancelled, FALSE) = FALSE
       AND UPPER(so.status::text) NOT IN ('CANCELLED','CLOSED')
       AND NOT EXISTS (SELECT 1 FROM scm.warehouses w
                        WHERE UPPER(TRIM(w.code)) = UPPER(TRIM(COALESCE(so.sales_location,'')))
                           OR UPPER(TRIM(w.name)) = UPPER(TRIM(COALESCE(so.sales_location,''))))
       AND NOT EXISTS (SELECT 1 FROM scm.state_warehouse_mappings sw
                        WHERE UPPER(TRIM(sw.state)) = UPPER(TRIM(COALESCE(so.customer_state, ''))))
     ORDER BY so.doc_no, i.item_code`;
  log(`  lines in scope (NULL warehouse + header resolves nothing): ${rows.length}`);
  if (rows.length === 0) return { plan: [], reported: [] };

  const lineIds = rows.map((r) => r.id);
  // (a) The line's own DO: where its goods PHYSICALLY left. The DO line links
  // back via so_item_id; the warehouse lives on the DO's OUT movements.
  const doEvidence = await pg`
    SELECT di.so_item_id::text AS so_item_id, m.warehouse_id::text AS warehouse_id,
           d.do_number, d.status::text AS do_status
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
      JOIN scm.inventory_movements m
        ON m.source_doc_type = 'DO' AND m.source_doc_id = d.id
       AND m.movement_type = 'OUT' AND m.item_code = di.item_code
     WHERE di.so_item_id::text = ANY(${lineIds})
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'`;
  const doWhByLine = new Map();
  for (const r of doEvidence) {
    const arr = doWhByLine.get(r.so_item_id) ?? [];
    arr.push(r);
    doWhByLine.set(r.so_item_id, arr);
  }
  // (b) Sibling lines of the same SOs with an explicit warehouse.
  const docNos = [...new Set(rows.map((r) => r.doc_no))];
  const siblings = await pg`
    SELECT doc_no, warehouse_id::text AS warehouse_id
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ANY(${docNos}) AND warehouse_id IS NOT NULL
       AND COALESCE(cancelled, FALSE) = FALSE`;
  const sibByDoc = new Map();
  for (const s of siblings) {
    const arr = sibByDoc.get(s.doc_no) ?? [];
    arr.push(s.warehouse_id);
    sibByDoc.set(s.doc_no, arr);
  }
  // (c) Active warehouses per company.
  const companies = [...new Set(rows.map((r) => Number(r.company_id)))];
  const whRows = await pg`
    SELECT id::text AS id, code, name, company_id FROM scm.warehouses
     WHERE is_active = TRUE AND company_id = ANY(${companies})`;
  const activeByCompany = new Map();
  const whName = new Map(whRows.map((w) => [w.id, `${w.code} (${w.name})`]));
  for (const w of whRows) {
    const arr = activeByCompany.get(Number(w.company_id)) ?? [];
    arr.push(w.id);
    activeByCompany.set(Number(w.company_id), arr);
  }

  const plan = [];
  const reported = [];
  const tally = new Map();
  for (const r of rows) {
    const doRows = doWhByLine.get(r.id) ?? [];
    const v = classifySoLineWarehouse({
      companyId: Number(r.company_id),
      mirrorCompanyId,
      doWarehouseIds: doRows.map((x) => x.warehouse_id),
      siblingWarehouseIds: sibByDoc.get(r.doc_no) ?? [],
      activeWarehouseIds: activeByCompany.get(Number(r.company_id)) ?? [],
    });
    tally.set(v.verdict, (tally.get(v.verdict) ?? 0) + 1);
    const evid = v.source === "do-movement"
      ? `DO ${[...new Set(doRows.map((x) => x.do_number))].join(", ")} OUT movement warehouse`
      : v.source === "sibling-agreement"
        ? `every warehoused sibling of ${r.doc_no} names it`
        : v.source === "single-active-warehouse"
          ? "the company's only active warehouse"
          : "";
    if (v.verdict === "stamp") {
      log(`  STAMP ${r.doc_no} line ${r.id} (${r.item_code}, co=${r.company_id}): warehouse -> ${whName.get(v.warehouseId) ?? v.warehouseId}  [${v.source}: ${evid}]`);
      plan.push({ ...r, warehouseId: v.warehouseId, source: v.source });
    } else if (v.verdict === "mirror-source") {
      log(`  MIRROR-SOURCE ${r.doc_no} line ${r.id} (${r.item_code}, co=${r.company_id}): the evidence stamps ${whName.get(v.warehouseId) ?? v.warehouseId} [${v.source}: ${evid}],`);
      log("    but this row is maintained by the 2990 -> Houzs SO mirror (so-mirror.ts drains DELETE-then-INSERT), so a local write");
      log("    would be silently wiped on the next drain. The fix belongs in the 2990 SOURCE database (same line id, ids mirror verbatim);");
      log("    until then this line stays read-time-only unresolvable HERE by design.");
      reported.push({ ...r, verdict: v.verdict, warehouseId: v.warehouseId, source: v.source });
    } else {
      log(`  ${v.verdict.toUpperCase()} ${r.doc_no} line ${r.id} (${r.item_code}, co=${r.company_id})${v.warehouseIds ? ` — candidates [${v.warehouseIds.map((w) => whName.get(w) ?? w).join(" | ")}]` : ""}${v.verdict === "needs-owner" ? ` — no DO, no warehoused sibling, ${v.activeWarehouses} active warehouse(s); only a human can pick` : ""}`);
      reported.push({ ...r, verdict: v.verdict });
    }
  }
  log(`  verdicts: ${[...tally.entries()].map(([k, n]) => `${k}=${n}`).join("  ")}`);
  log(`  lines to stamp: ${plan.length}; reported (mirror-source / ambiguous / needs-owner): ${reported.length}`);
  return { plan, reported };
}

async function applySoWarehouse(plan) {
  // Independent rows, not the money path — each line stands alone (the
  // applyNotes discipline): CAS on warehouse_id IS NULL so a concurrently
  // resolved line is skipped, never clobbered.
  let done = 0;
  for (const p of plan) {
    const res = await pg`
      UPDATE scm.mfg_sales_order_items
         SET warehouse_id = ${p.warehouseId}::uuid
       WHERE id = ${p.id}::uuid AND warehouse_id IS NULL`;
    if (res.count === 1) {
      done += 1;
      log(`  APPLIED ${p.doc_no} line ${p.id}: warehouse_id = ${p.warehouseId} [${p.source}]`);
    } else {
      log(`  SKIPPED ${p.doc_no} line ${p.id}: warehouse_id was set since the plan — re-run the dry run.`);
    }
  }
  return done;
}

// ── A9 — PART=do-line-link: stamp delivery_order_items.so_item_id where the
// SO's own documents determine it (trace check class `no-do-line-link`,
// 2026-08-01: 10 DELIVERED lines whose SO has DOs but no DO line points back
// at them — the old convert path / the import never stamped the link, so the
// delivered trace dead-ends). Within one (SO, its non-cancelled DOs): an
// unlinked DO line whose code names EXACTLY ONE still-unlinked SO line is
// determined, not guessed; ambiguity refuses (planDoLineLink,
// lib/doc-evidence-core.mjs).
async function planDoLineLinkPart() {
  log("");
  log("=== A9  do-line-link — SO lines no DO line points back at, within their own SO's DOs ===");
  // The trace check's lens: live delivered/shipped SOs that HAVE DOs, with SO
  // lines carrying no inbound so_item_id from any of those DOs' lines.
  const soRows = await pg`
    SELECT DISTINCT so.doc_no, so.company_id
      FROM scm.mfg_sales_orders so
      JOIN scm.delivery_orders d
        ON d.so_doc_no = so.doc_no AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
      JOIN scm.mfg_sales_order_items i
        ON i.doc_no = so.doc_no AND COALESCE(i.cancelled, FALSE) = FALSE
     WHERE UPPER(so.status::text) IN ('SHIPPED','DELIVERED')
       AND NOT EXISTS (
         SELECT 1 FROM scm.delivery_order_items di
           JOIN scm.delivery_orders d2 ON d2.id = di.delivery_order_id
          WHERE di.so_item_id = i.id
            AND UPPER(COALESCE(d2.status::text,'')) <> 'CANCELLED')
     ORDER BY so.doc_no`;
  log(`  SOs with at least one unlinked line and at least one DO: ${soRows.length}`);
  if (soRows.length === 0) return { plan: [], report: [] };

  const plan = [];
  const report = [];
  for (const so of soRows) {
    // The SO's still-unlinked active lines...
    const soLines = await pg`
      SELECT i.id::text AS id, i.item_code, i.qty
        FROM scm.mfg_sales_order_items i
       WHERE i.doc_no = ${so.doc_no} AND COALESCE(i.cancelled, FALSE) = FALSE
         AND NOT EXISTS (
           SELECT 1 FROM scm.delivery_order_items di
             JOIN scm.delivery_orders d2 ON d2.id = di.delivery_order_id
            WHERE di.so_item_id = i.id
              AND UPPER(COALESCE(d2.status::text,'')) <> 'CANCELLED')
       ORDER BY i.line_no NULLS LAST, i.id`;
    // ... vs the SO's DOs' unlinked lines.
    const doLines = await pg`
      SELECT di.id::text AS id, d.do_number, di.item_code, di.qty
        FROM scm.delivery_order_items di
        JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
       WHERE d.so_doc_no = ${so.doc_no}
         AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
         AND di.so_item_id IS NULL
       ORDER BY d.do_number, di.line_no NULLS LAST, di.id`;
    if (soLines.length === 0 || doLines.length === 0) continue;
    const res = planDoLineLink({
      soLines: soLines.map((l) => ({ id: l.id, itemCode: l.item_code, qty: Number(l.qty) })),
      doLines: doLines.map((l) => ({ id: l.id, doNumber: l.do_number, itemCode: l.item_code, qty: Number(l.qty) })),
    });
    if (res.pairs.length || res.ambiguous.length || res.qtyIncompatible.length || res.unmatchedDoLines.length) {
      log(`  ${so.doc_no} (co=${so.company_id}): unlinked SO lines=${soLines.length}, unlinked DO lines=${doLines.length}`);
    }
    for (const p of res.pairs) {
      log(`    STAMP DO line ${p.doLineId} (${p.doNumber}, ${p.code}, qty ${p.doQty}) -> so_item_id ${p.soLineId} — the only unlinked ${p.code} line on ${so.doc_no}`);
      plan.push({ ...p, docNo: so.doc_no, companyId: Number(so.company_id) });
    }
    for (const a of res.ambiguous) {
      log(`    REFUSED "${a.code}": ${a.freeSoLines} unlinked SO lines vs ${a.unlinkedDoLines} DO line(s) — which was delivered is not recorded; owner review`);
      report.push({ docNo: so.doc_no, kind: "ambiguous", ...a });
    }
    for (const qi of res.qtyIncompatible) {
      log(`    REFUSED "${qi.code}": DO lines total ${qi.doQtySum} > SO line qty ${qi.soQty} — the documents disagree on quantity; owner review`);
      report.push({ docNo: so.doc_no, kind: "qty-incompatible", ...qi });
    }
    for (const u of res.unmatchedDoLines) {
      log(`    (no free SO line for "${u.code}" — ${u.unlinkedDoLines} DO line(s) left alone; nothing to pair)`);
      report.push({ docNo: so.doc_no, kind: "unmatched", ...u });
    }
  }
  log(`  A9 total: ${plan.length} DO line(s) would be stamped; refused/reported: ${report.length}.`);
  return { plan, report };
}

async function applyDoLineLink(plan) {
  // Per-row standalone CAS (the applyNotes discipline): a concurrently linked
  // DO line is skipped, never clobbered. Stamping so_item_id makes the
  // delivered-qty engines (soDeliverableRemaining, the allocator, coverage
  // layer (a)) finally see what physically shipped — which is the point.
  let done = 0;
  for (const p of plan) {
    const res = await pg`
      UPDATE scm.delivery_order_items
         SET so_item_id = ${p.soLineId}::uuid
       WHERE id = ${p.doLineId}::uuid AND so_item_id IS NULL`;
    if (res.count === 1) {
      done += 1;
      log(`  APPLIED ${p.doNumber} line ${p.doLineId} -> so_item_id ${p.soLineId} (${p.code})`);
    } else {
      log(`  SKIPPED ${p.doNumber} line ${p.doLineId}: so_item_id was set since the plan — re-run the dry run.`);
    }
  }
  return done;
}

try {
  log(`=== repair-2990-doc-refs  mode=${APPLY ? "APPLY" : "DRY-RUN"}  part=${PART} ===`);
  const codeById = await loadCompanies();

  const notes = doNotes ? await planNotes(codeById) : { plan: [] };
  const batches = doBatches ? await planBatches(codeById) : { plan: [] };
  const consumptions = doConsumptions ? await planConsumptions(codeById) : { plan: [] };
  const ids = doIds ? await planIdRestamp(codeById) : { plan: [] };
  const grnGap = doGrnGap ? await planGrnGap() : { plan: [] };
  const dedupe = doDedupe ? await planDedupe(codeById) : { plan: [], ids: { plan: [] } };
  const fifoAttr = doFifoAttribute ? await planFifoAttribute() : { plans: [] };
  const fifoRepair = doFifoAttrRepair ? await planFifoAttrRepair() : { plans: [] };
  const soWh = doSoWarehouse ? await planSoWarehouse(codeById) : { plan: [], reported: [] };
  const doLink = doDoLineLink ? await planDoLineLinkPart() : { plan: [], report: [] };
  const svcReverse = doServiceLotReverse ? await planServiceLotReverse() : { plan: [] };

  log("");
  log("================ summary ================");
  if (doNotes) log(`A1 notes        : ${notes.plan.length} PO note(s) would be rewritten`);
  if (doBatches) log(`A2 batches      : ${batches.plan.length} (company, batch) pair(s) would be renamed`);
  if (doConsumptions) log(`A3 consumptions : ${consumptions.plan.length} (company, type, doc no) group(s) would be repaired on the ledger source refs`);
  if (doIds) log(`A4 ids          : ${ids.plan.length} (company, type, doc no) group(s) would have dangling source_doc_id restamped`);
  if (doGrnGap) log(`A5 grn-gap      : ${grnGap.plan.length} missing IN movement(s) would be inserted (FIFO trigger opens the lot)`);
  if (doDedupe) log(`A6 dedupe       : ${dedupe.plan.length} duplicate movement(s) (+ their consumptions) would be DELETED, lots restored`);
  if (doFifoAttribute) log(`A7 fifo-attr    : ${fifoAttr.plans.reduce((a, x) => a + x.res.plans.length, 0)} PO line(s) would receive FIFO allocations (as purchase_order_item_allocations rows)`);
  if (doFifoAttrRepair) log(`A10 fifo-repair : ${fifoRepair.plans.reduce((a, x) => a + x.res.removals.length, 0)} allocation removal(s) + ${fifoRepair.plans.reduce((a, x) => a + x.res.flips.length, 0)} flip(s) to STOCK (delivered-precedence corrective)`);
  if (doSoWarehouse) log(`A8 so-warehouse : ${soWh.plan.length} SO line(s) would have warehouse_id stamped; ${soWh.reported.length} reported (mirror-source / needs-owner)`);
  if (doDoLineLink) log(`A9 do-line-link : ${doLink.plan.length} DO line(s) would have so_item_id stamped (the delivered trace completes); ${doLink.report.length} refused/reported`);
  if (doServiceLotReverse) log(`A11 svc-reverse : ${svcReverse.plan.length} phantom service receipt(s) (movement + lot) would be DELETED (zero-consumption guarded)`);

  if (!APPLY) {
    log("");
    log("DRY-RUN — nothing was written. Re-run with apply=1 to make these changes.");
  } else {
    if (doNotes) {
      const n = await applyNotes(notes.plan);
      log(`A1 APPLIED: ${n} purchase order note(s) rewritten.`);
    }
    if (doBatches) {
      const r = await applyBatches(batches.plan);
      log(`A2 APPLIED: inventory_lots=${r.lots} rows, inventory_movements=${r.movements} rows, in one transaction.`);
    }
    if (doConsumptions) {
      const r = await applyConsumptions(consumptions.plan);
      log(`A3 APPLIED: inventory_lot_consumptions=${r.consumptions} rows, inventory_movements=${r.movements} rows, in one transaction.`);
    }
    if (doIds) {
      const r = await applyIdRestamp(ids.plan);
      log(`A4 APPLIED: inventory_lot_consumptions=${r.consumptions} rows, inventory_movements=${r.movements} rows, in one transaction.`);
    }
    if (doGrnGap) {
      const n = await applyGrnGap(grnGap.plan);
      log(`A5 APPLIED: ${n} IN movement(s) inserted through the normal path (lots opened by the trigger).`);
    }
    if (doDedupe) {
      await applyDedupe(dedupe.ids.plan);
    }
    if (doFifoAttribute) {
      const r = await applyFifoAttribute(fifoAttr.plans);
      log(`A7 APPLIED: ${r.rows} allocation row(s) across ${r.lines} PO line(s), one transaction per PO.`);
    }
    if (doFifoAttrRepair) {
      const r = await applyFifoAttrRepair(fifoRepair.plans);
      log(`A10 APPLIED: ${r.removed} allocation row(s) removed + ${r.flipped} flipped to STOCK, one transaction per PO.`);
    }
    if (doSoWarehouse) {
      const n = await applySoWarehouse(soWh.plan);
      log(`A8 APPLIED: ${n} SO line(s) stamped (mirror-source rows deliberately untouched — see the plan).`);
    }
    if (doDoLineLink) {
      const n = await applyDoLineLink(doLink.plan);
      log(`A9 APPLIED: ${n} DO line(s) stamped with their determined so_item_id.`);
    }
    if (doServiceLotReverse) {
      const n = await applyServiceLotReverse(svcReverse.plan);
      log(`A11 APPLIED: ${n} phantom service receipt(s) deleted (movement + lot, one transaction, consumption-guarded).`);
    }
    log("Done. Re-run in DRY-RUN to confirm the plan is now empty (the idempotence check).");
  }
} finally {
  await pg.end({ timeout: 5 });
}
