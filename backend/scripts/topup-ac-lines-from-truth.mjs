#!/usr/bin/env node
/* A BOOK LINE THE ERP DOES NOT HOLD, added — over the population the ERP HOLDS.
 *
 * ── WHY A SECOND TOP-UP TOOL, AND WHY IT IS NOT topup-ac-so-lines.mjs ───────
 *
 * `topup-ac-so-lines.mjs` reads `data/ac-outstanding-so.json.gz`. That file is
 * the OUTSTANDING cut, and it carries ZERO lines for a document that has been
 * delivered since the import — so for those documents the tool cannot see a
 * missing line at all, however many it has. Six sales orders sat in exactly
 * that blind spot on go-live morning (docs/bugs/0694, and section A of
 * docs/cutover-so-do-remainder-2026-09-08.md). The remedy that document names
 * is this file: the same comparison, run against `ac-reconcile-truth.json.gz`
 * — every header and every line of the whole book, unfiltered — with the
 * population taken from what the ERP actually holds.
 *
 * The second difference is that a PRICED line is written here.
 * `topup-ac-so-lines.mjs` refuses one by design, because it does not re-sum the
 * header and an unsummed header disagrees with its own lines. This one re-sums
 * `local_total_sen` and the five category buckets from the lines, which is the
 * write `repair-so-line-discount.mjs` already performs and the invariant the
 * app's own SO routes maintain (scm/routes/mfg-sales-orders.ts:4321). There is
 * one re-summing rule and this is not a second copy of it: the BUCKET map and
 * the recompute below are byte-identical to that script's, and named as such.
 *
 * ── WHAT IT WRITES ─────────────────────────────────────────────────────────
 *
 * SO lane — general, keyed, and it refuses far more than it writes:
 *   * the population is every ERP sales order carrying `linked_ac_docno`, NOT
 *     the outstanding scope (docs/bugs/0694);
 *   * a document holding ANY line with a NULL `linked_ac_dtlkey` is
 *     UNJUDGEABLE and left alone — the key is nullable and a document whose
 *     rows cannot be told apart cannot be topped up without risking a
 *     duplicate. Under-repair, never duplicate;
 *   * a book line whose DtlKey sits on no ERP row of that document is missing.
 *     Nothing else is this script's business, and an ERP row the book does NOT
 *     have is REPORTED and never deleted — removing a line from a live order is
 *     the owner's decision, and this repo never deletes, only cancels;
 *   * REFUSED: a book line with no ItemCode (the book names no product and
 *     inventing one is forbidden — section F); a SOFA line (one book line
 *     becomes one ERP row per compartment and which compartment carries the
 *     money is a decision, not a copy — that belongs to the sofa tooling);
 *     a line whose target code is not in `scm.mfg_products`; quantity 0 (a
 *     zero-quantity row is an annotation, and `|| 1` on it is the bug that
 *     once made seven of them a unit of goods); a document that is not MYR at
 *     rate 1 (docs/bugs/0665: a rate is not distinguishable from a discount);
 *     and a line whose own `SubTotal` does not equal qty x UnitPrice, because
 *     that gap is a LINE DISCOUNT and `repair-so-line-discount.mjs` owns it.
 *   * BEDFRAME lines are decoded by IMPORTING lib/parse-bedframe.mjs —
 *     `parseBedframe` plus `bedframeVariants`, the same two calls
 *     `import-ac-outstanding-so.mjs` makes. No import rule is re-implemented
 *     here; the block those writers used to spell out is now stated once, in
 *     that module, and all four callers read it.
 *
 * DO lane — NOT general, and that is the finding, not a shortcut.
 *   The delivery-order side has no rule that can find a missing line on its own.
 *   `delivery_order_items.linked_ac_dtlkey` was NULL on every migrated delivery
 *   order until `backfill-ac-downstream-line-keys.mjs` began stamping it, and
 *   that stamping is PARTIAL and moving — this lane COUNTS and prints how many
 *   rows of the target document carry a key on each run rather than asserting a
 *   state that changes under it. A tool that decided "the missing line" from the
 *   reconcile's own value-then-order fallback would be writing on a guess. So
 *   this lane repairs only the documents NAMED in DO_TARGETS below, and each
 *   target is asserted against the book — document, DtlKey, quantity, unit
 *   price, line subtotal — and against the ERP — no row already answering it —
 *   before anything is written. As of 2026-09-09 that list is SEVEN lines:
 *   section G of the remainder doc, the four lines on DO-001953 / DO-004903
 *   whose item code was changed on the delivery order AFTER it was converted
 *   from its sales order (docs/bugs/0711), and the two RM 0.00 lines the
 *   alignment lane found on DO-011465 and DO-010332. Those four are written in
 *   the SUBSTITUTED shape
 *   docs/modules/delivery-order.md declares — `ac_substituted = true`,
 *   `so_item_id` NULL, `item_group` blank — never linked to an ordered line,
 *   because which ordered line each answers is a human judgement the book does
 *   not record.
 *
 * ── WHAT IT NEVER TOUCHES ──────────────────────────────────────────────────
 *   `paid_sen` and the header `balance_sen`. What a customer paid is a fact
 *     about the business, not an arithmetic consequence of a corrected total.
 *     Where adding a line leaves total != paid + balance the document is NAMED
 *     and the owner rules on it — the same treatment repair-so-line-discount
 *     gives HC-SO-000021.
 *   `unit_price_sen` on any line that already exists, and no existing row's
 *     money: this script only INSERTs lines and re-sums the header over them.
 *   inventory. No movement is written and none is implied: the units these
 *     documents carry came in with the AutoCount balance snapshot
 *     (0276_scm_migrated_documents.sql), and a sales-order line is DEMAND, not
 *     stock. A new line does, however, become demand MRP has not planned — run
 *     `recompute-so-allocation.mjs` afterwards so it gets a stock verdict.
 *
 * MODE=plan (the default) writes nothing and IS the census.
 * MODE=apply needs CONFIRM="I HAVE REVIEWED THE BOOK LINE TOP-UP PLAN".
 * ONLY_DOCS="SO-007144,DO-001604" narrows the APPLY to the documents you read
 *   in the plan; the plan itself is always the whole population.
 * MAX_WRITES (default 25) refuses an apply that turned out wider than the plan
 *   you read — the failure mode a plan-then-apply pair exists to catch.
 *
 * RE-RUN: idempotent. Every SO line it writes carries its AutoCount DtlKey, so
 * a second run finds the key already present and plans nothing; the apply path
 * re-reads that document's live keys INSIDE the transaction as well, so two
 * runs racing cannot double a line. The DO line carries its DtlKey too, plus a
 * marker in `notes`, and a re-run claims it by EITHER — the key is the identity
 * AcSyncService addresses a detail row by (mig 0280), and the marker survives a
 * tool that later rewrites keys.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { buildScope, currencyVerdict, decodeSnapshot } from "./lib/ac-scope.mjs";
import { buildFabricColourIndex } from "./lib/fabric-colour-match.mjs";
import { bedframeVariants, parseBedframe } from "./lib/parse-bedframe.mjs";
import { DO_TARGETS } from "./lib/do-topup-targets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRUTH = path.join(HERE, "data", "ac-reconcile-truth.json.gz");
const MAPPING = path.join(HERE, "data", "autocount-erp-mapping-1561.csv");

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const TOP = Number(process.env.TOP || 60);
const LANES = new Set(String(process.env.LANES || "so,do").toLowerCase().split(/[,\s]+/).filter(Boolean));
/* An APPLY-time narrowing, empty by default. The PLAN is always the whole
   population — a census that hides part of itself answers nothing — but an
   apply may be restricted to the AutoCount document numbers that were actually
   read and agreed. A repair whose scope is decided by reading the plan is a
   different, smaller promise than one whose scope is decided by a rule. */
const ONLY_DOCS = new Set(String(process.env.ONLY_DOCS || "").toUpperCase().split(/[,\s]+/).filter(Boolean));
/* A HARD CEILING on the apply, because "wider than I thought" is the failure
   mode a plan-then-apply pair exists to catch and a number is the cheapest way
   to catch it. Raising it is a deliberate act with the plan in front of you. */
const MAX_WRITES = Number(process.env.MAX_WRITES || 25);
const CONFIRM_PHRASE = "I HAVE REVIEWED THE BOOK LINE TOP-UP PLAN";

const note = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m = "") => console.log(m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (s) => `RM ${(Number(s) / 100).toFixed(2)}`;

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}

/* Byte-identical to repair-so-line-discount.mjs:76 and
   repair-so-price-from-autocount.mjs:58 — the header's five category buckets
   are DEFINED as the sum of their lines' `total_sen`, and there is one
   statement of which group falls in which bucket. */
const BUCKET = {
  mattress: "mattress_sofa_sen", sofa: "mattress_sofa_sen", bedframe: "bedframe_sen",
  accessory: "accessories_sen", service: "service_sen", others: "others_sen",
};
/* The mapping sheet's own category vocabulary folded to the ERP's item_group.
   Copied from import-ac-outstanding-so.mjs:68 / topup-ac-so-lines.mjs:89 and
   named as a copy: three small literals, and exporting them out of a 480-line
   one-shot importer buys nothing. If that file's tables change, this is the
   pointer back. */
const CATG = { MATTRESS: "mattress", BEDFRAME: "bedframe", ACC: "accessory", ACCESSORY: "accessory", BEDLINES: "accessory", DIFFUSER: "others", CARPET: "others", DINING: "others", OTHER: "others", SERVICE: "service", TRANS: "service", SOFA: "sofa" };
const C1_ALIAS = { "SVC-DELIVERY": "TRANSPORTATION CHARGES", "SVC-DELIVERY-ADD": "TRANSPORTATION CHARGES", "SVC-DELIVERY-CROSS": "TRANSPORTATION CHARGES" };
/* The SO-LINE location table, identical to backfill-so-line-warehouse.mjs:65
   and topup-ac-so-lines.mjs:98 — the tool that OWNS a migrated SO line's
   warehouse. Four selling branches, and deliberately not the display / service
   locations: a showroom has never been a sales location. */
const SO_LINE_LOC = { KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE" };
/* The two groups whose lines carry a decoded variant. Bedframe is decoded here
   (by importing the decoder); sofa is refused. */
const SOFA_GROUP = "sofa";

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const uomOf = (g) => (g === "bedframe" ? "SET" : "UNIT");
/* AutoCount hands DtlKey back through sqlcmd, a JSON dump and a gzip; the ERP
   column is a bigint the pg driver may return as a string. Compare them as
   canonical decimal strings so "4711", 4711 and "4711.0" are one key.
   (topup-ac-so-lines.mjs:102, same reason.) */
const keyOf = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim().replace(/\.0+$/, "");
  return /^-?\d+$/.test(s) ? s : null;
};

/* ── THE DELIVERY-ORDER TARGETS ───────────────────────────────────────────────
 * One entry per delivery-note line this script may add, because no delivery
 * order carries a line key and a general rule there would be writing on the
 * reconcile's own guess (see the DO lane in the header).
 *
 * `erpCode` / `group` are a DECLARED choice and the only value here that is not
 * copied from the book: `delivery_order_items.item_code` is NOT NULL, the book
 * states no ItemCode on this row, and the reconcile does not compare a delivery
 * order's item codes at all — `delivery_order_items.item_code is taken from the
 * SALES ORDER line by design` (lib/ac-reconcile-erp-sql.mjs:196). The book's own
 * text for the row is `* DISPOSE 3S L SHAPE SOFA + CONSOLE TABLE`, AutoCount's
 * own `DISPOSE` item code binds to ERP `DISPOSE` in the mapping sheet, and the
 * line is a service charge — so DISPOSE is what it is called. The book's text
 * is written verbatim into `description`, so nothing the book said is lost, and
 * the money is copied to the sen.
 *
 * The line was NOT converted from a sales-order line: SO-002115's own
 * `TRANSPORTATION CHARGES` line reads TransferedQty 0 in the book, so there is
 * no sales-order line to link and `so_item_id` is NULL — which is legal
 * (nullable since the table was created) and honest.
 *
 * `linked_ac_dtlkey` IS stamped, and that is a CORRECTION of the decision this
 * script was first written with. It was left NULL on the reasoning that every
 * migrated delivery order is keyless, so keying one row would flip that document
 * out of the reconcile's keyless-multiset comparison into keyed pairing — a
 * wider change than adding a line. Plan run `34201640955` read the live rows and
 * refuted it: HC-DO-001604's three sofa compartments ALREADY carry DtlKey
 * 199269. The document is keyed today, so there is no comparison left to flip,
 * and the honest value for this row is its own key. A WRONG key is worse than
 * NULL (mig 0280 — NULL means "create"), which is why the target asserts the
 * book's row before the key is used.
 */
/* The named delivery-note lines, extracted so a test can resolve every one of
   them against the book — see lib/do-topup-targets.mjs. */
const DO_MARK = (dtlKey) => `topped up from AutoCount DtlKey ${dtlKey}`;

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/* ── the plan ─────────────────────────────────────────────────────────────── */

function planSoLine({ l, mapping, prodByCode, findColour }) {
  /* Order matters: the cheapest refusal that is also the most specific comes
     first, so the report says WHY rather than "unmapped". */
  if (!l.hasCode) {
    return { refuse: "the book states NO item code for this row — there is no product to point at and inventing one is forbidden" };
  }
  const hit = mapping.get(normCode(l.itemKey));
  let erpCode = hit ? hit.erp : null;
  if (erpCode && !prodByCode.has(norm(erpCode)) && C1_ALIAS[norm(erpCode)]) erpCode = C1_ALIAS[norm(erpCode)];
  const grp = (hit && CATG[hit.cat]) || "others";
  if (grp === SOFA_GROUP) {
    return { refuse: "SOFA — one book line becomes one ERP row per compartment and which compartment carries the money is a decision, not a copy (lib/parse-sofa.mjs owns it)" };
  }
  if (!erpCode) return { refuse: `the mapping sheet does not carry the book's code "${l.itemKey}"` };
  if (!prodByCode.has(norm(erpCode))) return { refuse: `"${erpCode}" is not in scm.mfg_products — bind it first, never invent a product` };
  const qty = Math.round(Number(l.qty ?? 0));
  if (!(qty > 0)) return { refuse: "the book records quantity 0 — a zero-quantity row is an annotation, not goods" };
  const unitSen = Number(l.unitPriceSen ?? 0);
  const lineTotal = unitSen * qty;
  const bookSub = Number(l.subTotalSen ?? 0);
  if (bookSub !== lineTotal) {
    return {
      refuse: `the book's own SubTotal ${rm(bookSub)} != qty ${qty} x unit ${rm(unitSen)} = ${rm(lineTotal)} — that gap is a LINE DISCOUNT and repair-so-line-discount.mjs owns it`,
    };
  }
  const prod = prodByCode.get(norm(erpCode));
  let bf = null; let variants = null;
  if (grp === "bedframe") {
    /* THE DECODER IS IMPORTED, NEVER RE-IMPLEMENTED. These are the same two
       calls import-ac-outstanding-so.mjs:261/269 makes, on the same text. */
    bf = parseBedframe(l.desc2);
    variants = bedframeVariants(bf, findColour);
  }
  return {
    dtlKey: keyOf(l.dtlKey), erpCode: prod.code, grp, qty, unitSen, lineTotal,
    desc: prod.name || prod.code, desc2: l.desc2 || null,
    loc: l.location || null, bf, variants,
    specials: variants && variants.specials && variants.specials.length ? variants.specials : null,
  };
}

async function main() {
  note(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"} company=${CO} lanes=${[...LANES].join(",") || "(none)"}`);
  if (!fs.existsSync(TRUTH)) {
    bad("backend/scripts/data/ac-reconcile-truth.json.gz is missing. Cut it on a machine on the office network:");
    bad("  AC_CRED_FILE=<path> node backend/scripts/export-ac-reconcile-truth.mjs");
    process.exit(2);
  }
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(TRUTH)).toString("utf8").replace(/^﻿/, ""));
  const ageDays = (Date.now() - Date.parse(snap.exported_at)) / 86400000;
  note(`AutoCount snapshot ${snap.exported_at} (${ageDays.toFixed(2)} days old, limit ${MAX_AGE}), source ${snap.source}`);
  /* Negative age is a CLOCK problem: the exporter runs on a UTC+8 desktop and
     this runs on a UTC runner. Tolerate skew, refuse a real disagreement. */
  if (ageDays > MAX_AGE || ageDays < -0.5) {
    bad(`REFUSED: that snapshot is ${ageDays.toFixed(2)} days old. Re-cut it before writing lines against it.`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  if (!snap.desc2_fields) {
    bad("REFUSED: this snapshot carries no Desc2 projection, so a bedframe line's build text cannot be read. Re-cut it.");
    await sql.end({ timeout: 5 });
    process.exit(2);
  }

  const book = decodeSnapshot(snap);
  const scope = buildScope(book);
  const mapping = readMappingCsv(fs.readFileSync(MAPPING, "utf8"));
  note(`book: SO ${book.SO.headers.size} headers / ${snap.counts.SO.lines} lines; DO ${book.DO.headers.size} headers / ${snap.counts.DO.lines} lines; mapping rows ${mapping.size}`);

  const products = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = ${CO}`;
  const prodByCode = new Map(products.map((p) => [norm(p.code), p]));
  const whRows = await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`;
  const whByKey = new Map();
  for (const w of whRows) { whByKey.set(norm(w.code), w.id); whByKey.set(norm(w.name), w.id); }
  const whId = (loc) => whByKey.get(norm(SO_LINE_LOC[norm(loc)] ?? loc)) ?? whByKey.get(norm(loc)) ?? null;
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  note(`ERP masters: ${products.length} products, ${whRows.length} warehouses, ${fcRows.length} fabric colours`);

  const soPlan = LANES.has("so")
    ? await planSo({ book, scope, mapping, prodByCode, whId, findColour })
    : { docs: [], writes: [], refusals: [], unjudgeable: [], orphans: [] };
  const doPlan = LANES.has("do")
    ? await planDo({ book, prodByCode })
    : { writes: [], refusals: [] };

  note("");
  note(`TO WRITE — sales-order lines: ${soPlan.writes.length} across ${new Set(soPlan.writes.map((w) => w.docNo)).size} document(s); delivery-order lines: ${doPlan.writes.length}`);
  if (ONLY_DOCS.size) {
    note(`ONLY_DOCS is set to ${[...ONLY_DOCS].join(", ")} — the plan above is the WHOLE population; the apply is restricted to those documents.`);
  }
  if (!APPLY) {
    note("");
    note(`PLAN ONLY — nothing written. To apply: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (!soPlan.writes.length && !doPlan.writes.length) {
    note("nothing to write.");
    await sql.end({ timeout: 5 });
    return;
  }

  const total = soPlan.writes.length + doPlan.writes.length;
  if (total > MAX_WRITES) {
    bad(`REFUSED: the plan wants ${total} line(s) and MAX_WRITES is ${MAX_WRITES}. Read the plan, then raise MAX_WRITES deliberately or narrow it with ONLY_DOCS.`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  const wroteSo = await applySo(soPlan);
  const wroteDo = await applyDo(doPlan);
  note(`APPLIED — ${wroteSo.lines} sales-order line(s) on ${wroteSo.docs} document(s); ${wroteDo.lines} delivery-order line(s) on ${wroteDo.docs} document(s).`);

  await sql.end({ timeout: 5 });
  await verify(soPlan, doPlan, book);
}

/* ── SO lane ──────────────────────────────────────────────────────────────── */

async function planSo({ book, scope, mapping, prodByCode, whId, findColour }) {
  /* `lines_sum` is read BECAUSE THE APPLY RE-SUMS FROM THE LINES, not from the
     header. A migrated header can already disagree with its own rows — SO-012842
     is the live one — and a plan that predicts `header + what I add` would then
     print a number the apply does not produce. That is the "check that answers a
     different question" trap in CLAUDE.md, and it showed up in the first plan
     run of this script (34201640955) predicting RM 5,188.00 on a document the
     apply would leave at RM 4,888.00. */
  const heldDocs = await sql`SELECT h.doc_no, h.linked_ac_docno, h.status, h.line_count,
        h.local_total_sen::bigint AS hdr_total, h.paid_sen::bigint AS paid,
        h.balance_sen::bigint AS hdr_balance,
        (SELECT COALESCE(SUM(x.total_sen),0)::bigint FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no) AS lines_sum
      FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
  const items = await sql`SELECT i.doc_no, i.linked_ac_dtlkey, i.line_no, i.item_code, i.item_group,
        i.qty::float8 AS qty, i.unit_price_sen::bigint AS unit_price_sen, i.total_sen::bigint AS total_sen
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
  note(`ERP migrated sales orders: ${heldDocs.length}; their lines: ${items.length}`);

  const byDoc = new Map();
  for (const r of items) {
    if (!byDoc.has(r.doc_no)) byDoc.set(r.doc_no, { keys: new Set(), keyless: 0, maxLineNo: 0, rows: 0 });
    const g = byDoc.get(r.doc_no);
    g.rows += 1;
    const k = keyOf(r.linked_ac_dtlkey);
    if (k === null) g.keyless += 1; else g.keys.add(k);
    g.maxLineNo = Math.max(g.maxLineNo, Number(r.line_no ?? 0));
  }

  const writes = []; const refusals = []; const unjudgeable = []; const orphans = [];
  const docs = [];
  let considered = 0; let notInBook = 0;

  for (const d of heldDocs) {
    const ac = String(d.linked_ac_docno).trim();
    const h = book.SO.headers.get(ac);
    if (!h) { notInBook++; continue; }
    considered++;
    const bookLines = (book.SO.lines.get(ac) || [])
      .map((l) => ({ ...l, desc2: book.SO.desc2.get(l.dtlKey) ?? null }));
    const g = byDoc.get(d.doc_no) ?? { keys: new Set(), keyless: 0, maxLineNo: 0, rows: 0 };
    const missing = bookLines.filter((l) => keyOf(l.dtlKey) !== null && !g.keys.has(keyOf(l.dtlKey)));
    const extra = [...g.keys].filter((k) => !bookLines.some((l) => keyOf(l.dtlKey) === k));
    if (extra.length) {
      orphans.push(`${d.doc_no} (${ac}): ${extra.length} ERP row(s) claim a DtlKey the book does not have on this document (${extra.join(", ")}) — REPORTED, never deleted; removing a line from a live order is the owner's decision`);
    }
    if (!missing.length) continue;

    if (g.keyless > 0) {
      unjudgeable.push(`${d.doc_no} (${ac}): ${g.keyless} of ${g.rows} ERP row(s) carry NO AutoCount line key, so which of our rows answers which of the book's cannot be told — ${missing.length} book line(s) LEFT ALONE`);
      continue;
    }
    const cur = currencyVerdict(h);
    if (cur.kind !== "local") {
      refusals.push(`${d.doc_no} (${ac}): ${cur.why} — a rate and a discount are not distinguishable from a total alone (docs/bugs/0665); ${missing.length} book line(s) LEFT ALONE`);
      continue;
    }

    const planned = [];
    for (const l of missing) {
      const p = planSoLine({ l, mapping, prodByCode, findColour });
      if (p.refuse) { refusals.push(`${d.doc_no} (${ac}) DtlKey ${l.dtlKey} "${l.itemKey}": ${p.refuse}`); continue; }
      planned.push(p);
    }
    if (!planned.length) continue;

    let lineNo = g.maxLineNo;
    const rows = planned.map((p) => ({
      ...p, docNo: d.doc_no, acNo: ac, lineNo: ++lineNo, warehouseId: whId(p.loc),
    }));
    writes.push(...rows);
    const addSen = rows.reduce((s, r) => s + r.lineTotal, 0);
    docs.push({
      docNo: d.doc_no, acNo: ac, status: d.status, inScope: scope.SO.has(ac),
      erpHdr: Number(d.hdr_total ?? 0), linesSum: Number(d.lines_sum ?? 0),
      bookHdr: h.totalSen, add: addSen,
      paid: Number(d.paid ?? 0), hdrBalance: Number(d.hdr_balance ?? 0),
      erpRows: g.rows, bookRows: bookLines.length, lines: rows,
    });
  }

  plain("");
  plain("═══════════════════════ SO — WHAT THE BOOK HAS AND WE DO NOT ═══════════════════════");
  plain(`documents compared line by line: ${considered}; ERP claims a document the book does not have: ${notInBook}`);
  plain("");
  for (const t of docs) {
    plain(`${t.docNo} (${t.acNo})  status ${t.status}  ${t.erpRows} ERP row(s) vs ${t.bookRows} book line(s)  ${t.inScope ? "still in the outstanding scope" : "NO LONGER in the outstanding scope — the blind spot of docs/bugs/0694"}`);
    for (const w of t.lines) {
      plain(`     + DtlKey ${w.dtlKey}  ${String(w.erpCode).slice(0, 30).padEnd(30)} x${w.qty} @ ${rm(w.unitSen)} = ${rm(w.lineTotal)}  [${w.grp}] @ ${w.loc ?? "no location"}${w.warehouseId ? "" : " (NO WAREHOUSE — the location did not resolve)"}`);
      if (w.desc2) plain(`         book build text: "${String(w.desc2).replace(/\s+/g, " ").slice(0, 90)}"`);
      if (w.variants) plain(`         decoded: colour ${w.variants.colourId ?? "(none)"} gap ${w.variants.gap ?? "-"} divan ${w.variants.divanHeight ?? "-"} leg ${w.variants.legHeight ?? "-"} total ${w.variants.totalHeight ?? "-"} specials ${(w.variants.specials || []).join(" / ") || "-"}`);
    }
    /* The APPLY writes Sigma of the lines. So does this. */
    const after = t.linesSum + t.add;
    if (t.linesSum !== t.erpHdr) {
      plain(`     PRE-EXISTING: the header reads ${rm(t.erpHdr)} while its own lines sum to ${rm(t.linesSum)} — a difference of ${rm(t.erpHdr - t.linesSum)} that was there before this script. The re-sum below CORRECTS it, because the header is DEFINED as the sum of its lines.`);
    }
    plain(`     lines sum ${rm(t.linesSum)}  +${rm(t.add)}  ->  header becomes ${rm(after)} (was ${rm(t.erpHdr)})   the book says ${rm(t.bookHdr)}${after === t.bookHdr ? "  = MATCHES THE BOOK" : "  <-- STILL DIFFERS, and that remainder is not this script's business"}`);
    if (t.add === 0 && after !== t.bookHdr) {
      plain("     NOTE: every line added is RM 0.00, so the money on this document does not move; its difference has another cause.");
    }
    if (after !== t.erpHdr) {
      const wasConsistent = t.erpHdr === t.paid + t.hdrBalance;
      const nowConsistent = after === t.paid + t.hdrBalance;

      plain(`     PAID ${rm(t.paid)} + header balance ${rm(t.hdrBalance)} = ${rm(t.paid + t.hdrBalance)} — NOT touched (payment columns are the owner's call).` +
        ` Before: ${wasConsistent ? "equalled the total" : "did NOT equal the total"}. After: ${nowConsistent ? "equals the total" : "does NOT equal the total — NAMED for the owner"}.`);
    }
    plain("");
  }
  if (!docs.length) plain("   (no sales-order line to add)");

  const say = (label, rows) => {
    plain("");
    plain(`${label}: ${rows.length}`);
    for (const r of rows.slice(0, TOP)) plain(`   ${r}`);
    if (rows.length > TOP) plain(`   ... and ${rows.length - TOP} more — raise TOP to see them`);
  };
  say("REFUSED, per line or per document", refusals);
  say("UNJUDGEABLE — an ERP row carries no AutoCount line key, so the document is left whole", unjudgeable);
  say("EXTRA ERP rows the book does not have — REPORTED, NEVER DELETED", orphans);

  return { docs, writes, refusals, unjudgeable, orphans };
}

async function applySo(plan) {
  if (!plan.writes.length) return { lines: 0, docs: 0 };
  let lines = 0; let docs = 0;
  for (const t of plan.docs) {
    if (ONLY_DOCS.size && !ONLY_DOCS.has(t.acNo.toUpperCase())) continue;
    await sql.begin(async (tx) => {
      /* Re-read INSIDE the transaction. The plan was taken before the first
         insert of this run; a document topped up by a concurrent run would
         otherwise be doubled. */
      const live = await tx`SELECT linked_ac_dtlkey, line_no FROM scm.mfg_sales_order_items WHERE doc_no = ${t.docNo}`;
      const held = new Set(live.map((r) => keyOf(r.linked_ac_dtlkey)).filter((x) => x !== null));
      let lineNo = live.reduce((a, r) => Math.max(a, Number(r.line_no ?? 0)), 0);
      let n = 0;
      for (const w of t.lines) {
        if (held.has(w.dtlKey)) continue;
        lineNo += 1;
        await tx`INSERT INTO scm.mfg_sales_order_items
            (doc_no, line_no, item_group, item_code, description, description2, uom,
             location, warehouse_id, qty, unit_price_sen, discount_sen,
             total_sen, total_inc_sen, balance_sen, company_id,
             gap_inches, divan_height_inches, leg_height_inches,
             variants, custom_specials, remark, linked_ac_dtlkey)
          VALUES (${t.docNo}, ${lineNo}, ${w.grp}, ${w.erpCode}, ${w.desc}, ${w.desc2}, ${uomOf(w.grp)},
             ${w.loc}, ${w.warehouseId}, ${w.qty}, ${w.unitSen}, 0,
             ${w.lineTotal}, ${w.lineTotal}, ${w.lineTotal}, ${CO},
             ${w.bf && Number.isFinite(w.bf.gap) ? Math.round(w.bf.gap) : null},
             ${w.bf && Number.isFinite(w.bf.divan) ? Math.round(w.bf.divan) : null},
             ${w.bf && Number.isFinite(w.bf.leg) ? Math.round(w.bf.leg) : null},
             ${w.variants ? sql.json(w.variants) : null},
             ${w.specials ? sql.json(w.specials) : null},
             ${"topped up from AutoCount " + w.acNo + " DtlKey " + w.dtlKey + ": the book carries this line and the migrated document did not"},
             ${w.dtlKey})`;
        n += 1;
      }
      if (n === 0) return;
      /* The header is Sigma of its lines — the same recompute
         repair-so-line-discount.mjs:236 performs, over the same five buckets,
         and `line_count` is what the document now holds rather than an
         increment, so a re-run cannot drift it. */
      const rows = await tx`SELECT item_group, total_sen::bigint t FROM scm.mfg_sales_order_items WHERE doc_no = ${t.docNo}`;
      const b = { mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, service_sen: 0, others_sen: 0 };
      let total = 0;
      for (const r of rows) { total += Number(r.t); b[BUCKET[String(r.item_group)] ?? "others_sen"] += Number(r.t); }
      await tx`UPDATE scm.mfg_sales_orders SET local_total_sen = ${total}, line_count = ${rows.length},
              mattress_sofa_sen = ${b.mattress_sofa_sen}, bedframe_sen = ${b.bedframe_sen},
              accessories_sen = ${b.accessories_sen}, service_sen = ${b.service_sen},
              others_sen = ${b.others_sen}
            WHERE doc_no = ${t.docNo}`;
      lines += n; docs += 1;
    });
  }
  return { lines, docs };
}

/* ── DO lane ──────────────────────────────────────────────────────────────── */

async function planDo({ book, prodByCode }) {
  const writes = []; const refusals = [];
  plain("");
  plain("═══════════════════════ DO — THE NAMED DELIVERY-NOTE LINES ═══════════════════════");
  /* This banner used to ASSERT "no migrated delivery order carries a line key",
     and apply run 34204421089 printed it directly above a document whose three
     rows all carry DtlKey 199269 — a stale fact stated beside the measurement
     that refutes it. `backfill-ac-downstream-line-keys.mjs` is filling that
     column and the state moves between two dispatches, so the banner states the
     RULE and the per-document line states the MEASUREMENT. */
  plain("A delivery note's line keys are being backfilled and the state moves, so this lane is a NAMED list, not a rule.");
  plain("Each target prints how many of its ERP rows carry an AutoCount line key at the moment of this run.");
  for (const t of DO_TARGETS) {
    const l = (book.DO.lines.get(t.acDoc) || []).find((x) => keyOf(x.dtlKey) === t.dtlKey);
    if (!l) { refusals.push(`${t.acDoc} DtlKey ${t.dtlKey}: that line is not in this snapshot — REFUSED`); continue; }
    const e = t.expect;
    const got = { hasCode: l.hasCode, qty: Math.round(Number(l.qty ?? 0)), unitSen: Number(l.unitPriceSen ?? 0), subTotalSen: Number(l.subTotalSen ?? 0) };
    const drift = Object.keys(e).filter((k) => e[k] !== got[k]);
    if (drift.length) {
      refusals.push(`${t.acDoc} DtlKey ${t.dtlKey}: the book has MOVED on ${drift.join(", ")} (expected ${JSON.stringify(e)}, book says ${JSON.stringify(got)}) — REFUSED rather than adjusted to fit`);
      continue;
    }
    const h = book.DO.headers.get(t.acDoc);
    const cur = currencyVerdict(h);
    if (cur.kind !== "local") { refusals.push(`${t.acDoc}: ${cur.why} — REFUSED`); continue; }
    if (!prodByCode.has(norm(t.erpCode))) { refusals.push(`${t.acDoc}: "${t.erpCode}" is not in scm.mfg_products — bind it first, never invent a product`); continue; }

    const [hdr] = await sql`SELECT id::text AS id, do_number, status,
          COALESCE(local_total_sen, 0)::bigint AS hdr_total, line_count
        FROM scm.delivery_orders WHERE company_id = ${CO} AND linked_ac_docno = ${t.acDoc}`;
    if (!hdr) { refusals.push(`${t.acDoc}: the ERP holds no delivery order for it — a different lane (create-migrated-documents.mjs) owns that`); continue; }
    const rows = await sql`SELECT id::text AS id, item_code, qty::float8 AS qty,
          unit_price_sen::bigint AS unit_price_sen, line_total_sen::bigint AS line_total_sen,
          linked_ac_dtlkey, notes
        FROM scm.delivery_order_items WHERE delivery_order_id = ${hdr.id}`;
    /* The book's own words for the row. A text-only line HAS no code, so its
       itemKey IS its text; a coded line's text is the book's LineDesc, which
       this snapshot does not carry and the target declares. */
    const text = t.description ?? l.itemKey;
    /* The book's OWN Desc2 for this DtlKey, never a value typed into a target.
       It used to be written as NULL, which left a topped-up row silently
       missing the build text every other row on the note carries —
       「autocount怎么写我们就怎么写」. A book line with no Desc2 stays null. */
    const desc2 = book.DO.desc2.get(l.dtlKey) ?? null;
    const already = rows.some((r) => String(r.notes ?? "").includes(DO_MARK(t.dtlKey))
      || keyOf(r.linked_ac_dtlkey) === t.dtlKey
      || (norm(r.item_code) === norm(t.erpCode) && Number(r.unit_price_sen) === e.unitSen && Math.round(Number(r.qty)) === e.qty));
    const keyed = rows.filter((r) => keyOf(r.linked_ac_dtlkey) !== null).length;
    plain("");
    plain(`${hdr.do_number} (${t.acDoc})  status ${hdr.status}  ${rows.length} ERP row(s) (${keyed} carry an AutoCount line key), header ${rm(hdr.hdr_total)}; the book says ${rm(h.totalSen)}`);
    for (const r of rows) plain(`     have  ${String(r.item_code).slice(0, 34).padEnd(34)} x${r.qty} @ ${rm(r.unit_price_sen)} = ${rm(r.line_total_sen)}  key ${keyOf(r.linked_ac_dtlkey) ?? "(none)"}`);
    if (already) { refusals.push(`${hdr.do_number}: a row answering DtlKey ${t.dtlKey} is already there — nothing to do (this is what a re-run looks like)`); continue; }
    const lineTotal = e.unitSen * e.qty;
    const after = Number(hdr.hdr_total) + lineTotal;
    plain(`     + "${text}" x${e.qty} @ ${rm(e.unitSen)} = ${rm(lineTotal)}  [${t.group ?? "no item group"}] as ERP product ${t.erpCode}${t.substituted ? "  SUBSTITUTED (so_item_id stays NULL)" : ""}`);
    plain(`       build text (the book's own Desc2): ${desc2 === null ? "(the book states none)" : JSON.stringify(desc2)}`);
    plain(`       ${t.why}`);
    plain(`     header ${rm(hdr.hdr_total)} + ${rm(lineTotal)} -> ${rm(after)}   the book says ${rm(h.totalSen)}${after === h.totalSen ? "  = MATCHES THE BOOK" : "  <-- STILL DIFFERS"}`);
    writes.push({
      target: t, doId: hdr.id, doNo: hdr.do_number, text, desc2,
      qty: e.qty, unitSen: e.unitSen, lineTotal, bookHdr: h.totalSen, erpHdr: Number(hdr.hdr_total),
    });
  }
  if (refusals.length) {
    plain("");
    plain(`DO REFUSED / already done: ${refusals.length}`);
    for (const r of refusals) plain(`   ${r}`);
  }
  return { writes, refusals };
}

async function applyDo(plan) {
  if (!plan.writes.length) return { lines: 0, docs: 0 };
  let lines = 0;
  /* DISTINCT documents. Two targets on one delivery note are two writes and ONE
     document; counting a write per document read "4 line(s) on 4 document(s)"
     on apply run 34213756311, which is two. A count nobody can check is the
     shape that gets believed. */
  const touched = new Set();
  for (const w of plan.writes) {
    if (ONLY_DOCS.size && !ONLY_DOCS.has(w.target.acDoc.toUpperCase())) continue;
    await sql.begin(async (tx) => {
      const live = await tx`SELECT item_code, qty::float8 AS qty, unit_price_sen::bigint AS unit_price_sen,
            linked_ac_dtlkey, notes
          FROM scm.delivery_order_items WHERE delivery_order_id = ${w.doId}`;
      if (live.some((r) => String(r.notes ?? "").includes(DO_MARK(w.target.dtlKey))
        || keyOf(r.linked_ac_dtlkey) === w.target.dtlKey)) return;
      await tx`INSERT INTO scm.delivery_order_items
          (delivery_order_id, so_item_id, item_code, description, uom, qty, company_id,
           item_group, description2, unit_price_sen, discount_sen, line_total_sen,
           unit_cost_sen, line_cost_sen, ac_substituted, linked_ac_dtlkey, notes)
        VALUES (${w.doId}, NULL, ${w.target.erpCode}, ${w.text}, 'UNIT', ${w.qty}, ${CO},
           ${w.target.group}, ${w.desc2}, ${w.unitSen}, 0, ${w.lineTotal},
           0, 0, ${w.target.substituted === true}, ${w.target.dtlKey},
           ${DO_MARK(w.target.dtlKey) + " on " + w.target.acDoc + " — the book carries this line and the migrated note did not"
             + (w.target.substituted === true
               ? ". SUBSTITUTED AT DISPATCH: the account book's delivery note ships this code and its own sales order does not carry it,"
                 + " so this row is deliberately NOT linked to a sales-order line — which ordered item it answers is a human decision."
               : "")})`;
      /* Sigma line_total_sen, the same rule lib/migrated-do-writer.mjs:375 and
         delivery-orders-mfg.ts:461 keep. */
      const rows = await tx`SELECT line_total_sen::bigint t FROM scm.delivery_order_items WHERE delivery_order_id = ${w.doId}`;
      const total = rows.reduce((s, r) => s + Number(r.t), 0);
      await tx`UPDATE scm.delivery_orders SET local_total_sen = ${total}, line_count = ${rows.length} WHERE id = ${w.doId}`;
      lines += 1; touched.add(w.doId);
    });
  }
  return { lines, docs: touched.size };
}

/* ── verification, on a FRESH connection, asserting the SHAPE ─────────────── */

async function verify(soPlan, doPlan, book) {
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const wrong = [];
  let good = 0;

  for (const w of soPlan.writes) {
    if (ONLY_DOCS.size && !ONLY_DOCS.has(w.acNo.toUpperCase())) continue;
    const [r] = await fresh`SELECT i.item_code, i.item_group, i.qty::float8 q,
          i.unit_price_sen::bigint up, i.discount_sen::bigint disc,
          i.total_sen::bigint t, i.total_inc_sen::bigint ti, i.balance_sen::bigint bal,
          i.linked_ac_dtlkey::text key, i.warehouse_id::text wh,
          jsonb_typeof(i.variants) AS variants_kind,
          jsonb_typeof(i.custom_specials) AS specials_kind,
          i.variants->>'colourId' AS colour_id, i.variants->>'totalHeight' AS total_height,
          h.local_total_sen::bigint hdr, h.line_count::int lc,
          (SELECT COALESCE(SUM(x.total_sen),0)::bigint FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no) AS lines_sum,
          (SELECT COUNT(*)::int FROM scm.mfg_sales_order_items x WHERE x.doc_no = h.doc_no) AS lines_n
        FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE i.doc_no = ${w.docNo} AND i.linked_ac_dtlkey = ${w.dtlKey}`;
    if (!r) { wrong.push(`${w.docNo} DtlKey ${w.dtlKey}: the line is NOT there`); continue; }
    const f = [];
    if (norm(r.item_code) !== norm(w.erpCode)) f.push(`item_code ${r.item_code} != ${w.erpCode}`);
    if (String(r.item_group) !== w.grp) f.push(`item_group ${r.item_group} != ${w.grp}`);
    if (Number(r.q) !== w.qty) f.push(`qty ${r.q} != the book's ${w.qty}`);
    if (Number(r.up) !== w.unitSen) f.push(`unit_price_sen ${r.up} != the book's ${w.unitSen}`);
    if (Number(r.t) !== w.lineTotal) f.push(`total_sen ${r.t} != the book's ${w.lineTotal}`);
    if (Number(r.t) !== Math.round(Number(r.q) * Number(r.up)) - Number(r.disc)) f.push(`the ERP's own invariant is broken: ${r.t} != ${r.q} x ${r.up} - ${r.disc}`);
    if (Number(r.ti) !== Number(r.t)) f.push(`total_inc_sen ${r.ti} != total_sen ${r.t}`);
    if (Number(r.bal) !== Number(r.t)) f.push(`balance_sen ${r.bal} != total_sen ${r.t}`);
    if (Number(r.hdr) !== Number(r.lines_sum)) f.push(`header ${r.hdr} != the sum of its lines ${r.lines_sum}`);
    if (Number(r.lc) !== Number(r.lines_n)) f.push(`line_count ${r.lc} != the rows the document holds ${r.lines_n}`);
    /* THE SHAPE, not the count. A jsonb column written through a pre-serialized
       parameter reads back as a jsonb STRING: JavaScript parses it happily and
       `variants->>'colourId'` in the DATABASE returns NULL, so every consumer
       sees nothing while a row count says 1 of 1. That is the 2026-08-13
       recurrence (docs/jsonb-double-encoding-coe.md) and it is asserted here in
       the database's own vocabulary. */
    if (w.variants) {
      if (r.variants_kind !== "object") f.push(`variants is jsonb ${r.variants_kind ?? "NULL"}, not an object — the double-encoding shape`);
      if ((r.colour_id ?? null) !== (w.variants.colourId ?? null)) f.push(`variants->>'colourId' reads ${r.colour_id ?? "NULL"}, expected ${w.variants.colourId ?? "NULL"}`);
      if ((r.total_height ?? null) !== (w.variants.totalHeight ?? null)) f.push(`variants->>'totalHeight' reads ${r.total_height ?? "NULL"}, expected ${w.variants.totalHeight ?? "NULL"}`);
    } else if (r.variants_kind != null) f.push(`variants is jsonb ${r.variants_kind} on a line that should carry none`);
    if (w.specials) {
      if (r.specials_kind !== "array") f.push(`custom_specials is jsonb ${r.specials_kind ?? "NULL"}, not an array — the double-encoding shape`);
    } else if (r.specials_kind != null) f.push(`custom_specials is jsonb ${r.specials_kind} on a line that should carry none`);
    if (w.warehouseId && !r.wh) f.push("warehouse_id did not land");
    if (f.length) wrong.push(`${w.docNo} DtlKey ${w.dtlKey}: ${f.join("; ")}`); else good += 1;
  }

  let doGood = 0;
  for (const w of doPlan.writes) {
    if (ONLY_DOCS.size && !ONLY_DOCS.has(w.target.acDoc.toUpperCase())) continue;
    const [r] = await fresh`SELECT COUNT(*)::int n,
          COALESCE(SUM(i.line_total_sen),0)::bigint lines_sum,
          MAX(h.local_total_sen)::bigint hdr, MAX(h.line_count)::int lc
        FROM scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
       WHERE i.delivery_order_id = ${w.doId}`;
    const [mine] = await fresh`SELECT item_code, qty::float8 q, unit_price_sen::bigint up,
          line_total_sen::bigint lt, description, linked_ac_dtlkey::text key,
          ac_substituted, so_item_id::text so_item_id, item_group
        FROM scm.delivery_order_items
       WHERE delivery_order_id = ${w.doId} AND notes LIKE ${"%" + DO_MARK(w.target.dtlKey) + "%"}`;
    const f = [];
    if (!mine) f.push("the line is NOT there");
    else {
      if (norm(mine.item_code) !== norm(w.target.erpCode)) f.push(`item_code ${mine.item_code} != ${w.target.erpCode}`);
      if (Number(mine.q) !== w.qty) f.push(`qty ${mine.q} != ${w.qty}`);
      if (Number(mine.up) !== w.unitSen) f.push(`unit_price_sen ${mine.up} != the book's ${w.unitSen}`);
      if (Number(mine.lt) !== w.lineTotal) f.push(`line_total_sen ${mine.lt} != ${w.lineTotal}`);
      if (String(mine.description ?? "") !== String(w.text)) f.push(`description "${mine.description}" is not the book's own text "${w.text}"`);
      if (keyOf(mine.key) !== w.target.dtlKey) f.push(`linked_ac_dtlkey ${mine.key ?? "NULL"} != the book's ${w.target.dtlKey}`);
      /* THE SHAPE the substituted class is DEFINED by, asserted rather than
         assumed: the badge both surfaces render is driven by ac_substituted,
         and a link to an ordered line is the one thing this row must not have.
         docs/modules/delivery-order.md, "A delivery line can carry a
         SUBSTITUTED item code". */
      if (Boolean(mine.ac_substituted) !== (w.target.substituted === true)) f.push(`ac_substituted ${mine.ac_substituted} != ${w.target.substituted === true}`);
      if (mine.so_item_id !== null) f.push(`so_item_id ${mine.so_item_id} is set — a substituted line must carry NO link to an ordered line`);
      if ((mine.item_group ?? null) !== (w.target.group ?? null)) f.push(`item_group ${mine.item_group ?? "NULL"} != ${w.target.group ?? "NULL"}`);
    }
    if (r) {
      if (Number(r.hdr) !== Number(r.lines_sum)) f.push(`header ${r.hdr} != the sum of its lines ${r.lines_sum}`);
      if (Number(r.hdr) !== Number(w.bookHdr)) f.push(`header ${r.hdr} != the book's ${w.bookHdr}`);
      if (Number(r.lc) !== Number(r.n)) f.push(`line_count ${r.lc} != the rows the document holds ${r.n}`);
    }
    if (f.length) wrong.push(`${w.doNo} DtlKey ${w.target.dtlKey}: ${f.join("; ")}`); else doGood += 1;
  }

  note("");
  note(`VERIFIED ON A FRESH CONNECTION — ${good} of ${soPlan.writes.length} sales-order line(s) carry the book's item, quantity and money, the ERP's own line invariant, a jsonb OBJECT (not a string) in variants, and a header equal to the sum of its lines; ${doGood} of ${doPlan.writes.length} delivery-order line(s) the same.`);
  for (const x of wrong) bad(`   WRONG SHAPE ${x}`);

  /* The per-document read-out the owner actually reads: what the document now
     says against what the book says, and whether the payment columns still add
     up. Payment columns were not touched; where they no longer agree that is
     stated, not silently repaired. */
  for (const t of soPlan.docs) {
    if (ONLY_DOCS.size && !ONLY_DOCS.has(t.acNo.toUpperCase())) continue;
    const [h] = await fresh`SELECT local_total_sen::bigint t, paid_sen::bigint p, balance_sen::bigint b, line_count::int lc
        FROM scm.mfg_sales_orders WHERE doc_no = ${t.docNo}`;
    if (!h) continue;
    const bookHdr = book.SO.headers.get(t.acNo)?.totalSen ?? null;
    note(`   ${t.docNo}  ${h.lc} line(s), total ${rm(h.t)}${bookHdr == null ? "" : ` (book ${rm(bookHdr)}${Number(h.t) === bookHdr ? " = same" : " <-- differs"})`}   paid ${rm(h.p)} + balance ${rm(h.b)} = ${rm(Number(h.p) + Number(h.b))}${Number(h.t) === Number(h.p) + Number(h.b) ? " = the total" : " <-- does NOT equal the total; payment columns were not touched, the owner's call"}`);
  }
  await fresh.end();
  if (wrong.length) { bad("Some rows did not read back as written — do NOT run this again until that is understood."); process.exitCode = 1; }
  note("");
  note("A sales-order line is DEMAND. Run recompute-so-allocation.mjs so the new lines get a stock verdict; no inventory movement was written and none is implied.");
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* already closed */ } process.exit(1); });
