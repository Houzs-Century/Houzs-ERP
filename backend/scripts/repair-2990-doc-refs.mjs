// Tier 0 repair: the two 2990-import doc references that name a PRE-IMPORT
// document number, so string equality fails and the UI shows a dash.
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
//   PART           all (default) | notes | batches
//   MAX_ROWS       per-batch row ids to print in the plan (default 200)
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  companyPrefix,
  classifyToken,
  parseFromSosTokens,
  rewriteFromSosNote,
} from "./lib/doc-ref-repair-core.mjs";

const APPLY = process.env.APPLY === "1";
const PART = (process.env.PART || "all").trim().toLowerCase();
const MAX_ROWS = Number(process.env.MAX_ROWS || 200);
if (!["all", "notes", "batches"].includes(PART)) {
  console.error(`PART must be all | notes | batches (got "${PART}")`);
  process.exit(2);
}
const doNotes = PART === "all" || PART === "notes";
const doBatches = PART === "all" || PART === "batches";

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

try {
  log(`=== repair-2990-doc-refs  mode=${APPLY ? "APPLY" : "DRY-RUN"}  part=${PART} ===`);
  const codeById = await loadCompanies();

  const notes = doNotes ? await planNotes(codeById) : { plan: [] };
  const batches = doBatches ? await planBatches(codeById) : { plan: [] };

  log("");
  log("================ summary ================");
  if (doNotes) log(`A1 notes   : ${notes.plan.length} PO note(s) would be rewritten`);
  if (doBatches) log(`A2 batches : ${batches.plan.length} (company, batch) pair(s) would be renamed`);

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
    log("Done. Re-run in DRY-RUN to confirm the plan is now empty (the idempotence check).");
  }
} finally {
  await pg.end({ timeout: 5 });
}
