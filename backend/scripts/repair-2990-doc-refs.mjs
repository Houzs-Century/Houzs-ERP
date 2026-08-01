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
//   DATABASE_URL   required (env, or .dev.vars for local use)
//   APPLY=1        write. Anything else is a dry run.
//   PART           all (default) | notes | batches | consumptions | ids | grn-gap
//                  (`all` = the three original parts; `ids` and `grn-gap` are
//                  deliberately DISPATCH-ONLY so the widest-reaching writes are
//                  each an explicit, single-purpose run)
//   GRNS           part grn-gap only: comma-separated GRN numbers to repair
//                  (default 2990-GRN-2606-001 — the one 3a implicated)
//   MAX_ROWS       per-batch row ids to print in the plan (default 200)
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  companyPrefix,
  classifyToken,
  classifySourceRef,
  classifyIdRestamp,
  parseFromSosTokens,
  rewriteFromSosNote,
} from "./lib/doc-ref-repair-core.mjs";
import { classifyGrnInboundGap, deriveGrnLineBasis } from "./lib/ledger-repair-core.mjs";
import { execIdRestamp, printIdRestampExec } from "./lib/id-restamp-exec.mjs";

const APPLY = process.env.APPLY === "1";
const PART = (process.env.PART || "all").trim().toLowerCase();
const MAX_ROWS = Number(process.env.MAX_ROWS || 200);
const GRNS = (process.env.GRNS || "2990-GRN-2606-001")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (!["all", "notes", "batches", "consumptions", "ids", "grn-gap"].includes(PART)) {
  console.error(`PART must be all | notes | batches | consumptions | ids | grn-gap (got "${PART}")`);
  process.exit(2);
}
const doNotes = PART === "all" || PART === "notes";
const doBatches = PART === "all" || PART === "batches";
const doConsumptions = PART === "all" || PART === "consumptions";
const doIds = PART === "ids";
const doGrnGap = PART === "grn-gap";

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
       AND notes ~* 'From SOs?:'
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
      SELECT gi.id, gi.material_code, gi.material_name, gi.qty_accepted,
             COALESCE(gi.returned_qty, 0)::int AS returned_qty,
             gi.unit_price_centi, gi.variants, gi.item_group
        FROM scm.grn_items gi WHERE gi.grn_id = ${g.id}::uuid ORDER BY gi.material_code, gi.id`;
    // The GRN's own IN movements, grouped into the DISTINCT buckets + costs
    // that prove (or refuse) the insert.
    const movs = await pg`
      SELECT id::text AS id, movement_type, warehouse_id::text AS warehouse_id, product_code, product_name,
             COALESCE(variant_key, '') AS variant_key, batch_no, qty, unit_cost_sen, company_id, notes, created_at
        FROM scm.inventory_movements
       WHERE source_doc_type = 'GRN' AND source_doc_id = ${g.id}::uuid
       ORDER BY created_at, id`;

    const byProduct = new Map();
    for (const l of lines) {
      const p = byProduct.get(l.material_code) ?? { lineQty: 0, lines: [], buckets: new Map(), marker: false };
      p.lineQty += Math.max(0, Number(l.qty_accepted ?? 0) - Number(l.returned_qty ?? 0));
      p.lines.push(l);
      byProduct.set(l.material_code, p);
    }
    for (const m of movs) {
      const p = byProduct.get(m.product_code) ?? { lineQty: 0, lines: [], buckets: new Map(), marker: false };
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
      byProduct.set(m.product_code, p);
    }

    for (const [code, p] of byProduct) {
      const buckets = [...p.buckets.values()].map((b) => ({ ...b, unitCosts: [...b.unitCosts] }));
      const v = classifyGrnInboundGap({ productCode: code, lineQty: p.lineQty, buckets });
      log(`    product ${code}: accepted-net=${v.lineQty}  movements=${v.movQty}  delta=${v.delta}  -> ${v.verdict}`);
      for (const l of p.lines) {
        log(`      line ${l.id}  accepted=${l.qty_accepted} returned=${l.returned_qty}  unit_price_centi=${l.unit_price_centi}  group=${l.item_group ?? "-"}`);
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
        // cost — round(unit_price_centi x GRN exchange_rate), the same
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
        grnId: g.id, grnNumber: g.grn_number, productCode: code,
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
            FROM scm.grn_items WHERE grn_id = ${p.grnId}::uuid AND material_code = ${p.productCode}
        ), m AS (
          SELECT COALESCE(SUM(CASE WHEN movement_type = 'IN' THEN qty ELSE -qty END), 0)::int AS mov_qty
            FROM scm.inventory_movements
           WHERE source_doc_type = 'GRN' AND source_doc_id = ${p.grnId}::uuid AND product_code = ${p.productCode}
        )
        SELECT l.line_qty - m.mov_qty AS delta FROM l, m`;
      const delta = Number(fresh[0]?.delta ?? 0);
      if (delta !== p.qty) {
        log(`  SKIPPED ${p.grnNumber} ${p.productCode}: delta is now ${delta}, plan said ${p.qty} — re-run the dry run.`);
        return;
      }
      const inserted = await tx`
        INSERT INTO scm.inventory_movements (
          movement_type, warehouse_id, product_code, product_name, variant_key,
          qty, unit_cost_sen, source_doc_type, source_doc_id, source_doc_no,
          batch_no, notes, performed_by, company_id
        ) VALUES (
          'IN', ${p.warehouseId}::uuid, ${p.productCode}, ${p.productName}, ${p.variantKey},
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
      log(`  APPLIED ${p.grnNumber} ${p.productCode}: movement ${inserted[0].id} qty=${p.qty} @ ${p.unitCostSen} sen; lot ${lot[0].id} opened (received=${lot[0].qty_received}, remaining=${lot[0].qty_remaining})`);
      done += 1;
    });
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

  log("");
  log("================ summary ================");
  if (doNotes) log(`A1 notes        : ${notes.plan.length} PO note(s) would be rewritten`);
  if (doBatches) log(`A2 batches      : ${batches.plan.length} (company, batch) pair(s) would be renamed`);
  if (doConsumptions) log(`A3 consumptions : ${consumptions.plan.length} (company, type, doc no) group(s) would be repaired on the ledger source refs`);
  if (doIds) log(`A4 ids          : ${ids.plan.length} (company, type, doc no) group(s) would have dangling source_doc_id restamped`);
  if (doGrnGap) log(`A5 grn-gap      : ${grnGap.plan.length} missing IN movement(s) would be inserted (FIFO trigger opens the lot)`);

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
    log("Done. Re-run in DRY-RUN to confirm the plan is now empty (the idempotence check).");
  }
} finally {
  await pg.end({ timeout: 5 });
}
