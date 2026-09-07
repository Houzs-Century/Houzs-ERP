#!/usr/bin/env node
/* check-ac-erp-reconcile — "确保全部 SO PO GR DO SI PI 都是对的,并且里面的数据
 * 都是对的" (owner, 2026-09-07, go-live day).  Six document types, both
 * directions, document level AND line level AND money.
 *
 * READ-ONLY.  One Postgres connection, SELECTs only.  Every legitimate answer
 * — including a large gap — exits 0, because the ANSWER is the output and a
 * red job reads as "the check broke" (CLAUDE.md, the check-soak-gate rules).
 * Non-zero is reserved for the check being UNABLE TO ANSWER: unreachable DB,
 * a missing or stale AutoCount snapshot, or a matcher that proves itself
 * broken at startup.
 *
 * ── WHAT IT COMPARES ────────────────────────────────────────────────────────
 *   1. DOCUMENT LEVEL   AutoCount doc numbers absent from the ERP, and ERP
 *                       documents claiming an AutoCount number the book does
 *                       not have.  Counts plus the first 20 each way.
 *   2. LINE LEVEL       for documents present on both sides: line COUNT, and
 *                       per line the item code, quantity, unit price, keyed on
 *                       the AutoCount line key (DtlKey) where the ERP carries
 *                       one and on document order where it does not.
 *   3. MONEY            document total on each side.
 *
 * ── THE DO RULE (the owner's; NOT a bug to fix) ─────────────────────────────
 * Outstanding = NOT yet transferred to a DO.  The migration carried the
 * OUTSTANDING population, so a fully-delivered sales order absent from the ERP
 * is CORRECT, not a gap.  Every "missing" figure is therefore split: IN-SCOPE
 * MISSING (a real gap) and OUT-OF-SCOPE ABSENT (the rule working).  The scope
 * predicates are not invented here — they are the ones export-ac-reimport.py
 * runs against the book, restated over the raw columns in the snapshot:
 *
 *   SO  Cancelled='F', DocNo NOT LIKE 'HC-%'/'ZZ%', >=1 line with
 *       Qty > TransferedQty, and NOT invoiced direct (no IVDTL with
 *       FromDocType='SO' pointing at it — the completed cash sale the owner
 *       excluded 2026-08-10).
 *   PO  Cancelled='F', not a test doc, and either >=1 line with
 *       Qty > TransferedQty (lane 1) or raised for a line of an outstanding SO
 *       (lane 2, FromSODtlKey or FromDocNo).
 *   GR  stamped onto an in-scope PO by stamp-ac-grn-refs.mjs.
 *   DO  Cancelled='F', >=1 line with FromDocType='SO' pointing at an
 *       outstanding SO — the mirror set of ac-partial-dos.json.gz.
 *   IV  no population: the owner declined the historical import ("这个不要",
 *   PI  DECLARED_DIFFERENCES in check-migration-fidelity.mjs).  What the ERP
 *       holds is post-cutover mirroring, so an absent historical invoice is a
 *       DECISION, and is counted apart from the gaps.
 *
 * ── THE THREE TRAPS THIS CHECK IS BUILT AROUND ──────────────────────────────
 * 1. scm.grns.linked_ac_docno holds the PO's AutoCount number, NOT the GR's —
 *    by design (check-migration-fidelity.mjs: "one ERP GRN per PURCHASE ORDER;
 *    an AutoCount receipt can span several").  The AutoCount GR numbers live
 *    in purchase_orders.linked_ac_grn_docnos.  Matching GR the obvious way
 *    reported all 216 as missing once already (check-ac-erp-doc-links.mjs:104).
 *    GR LINE data is not compared at all: grn_items.qty_received is DERIVED
 *    from the PO line, so a comparison against GRDTL would measure the
 *    derivation, not the book.
 * 2. Item codes are TRANSLATED through data/autocount-erp-mapping-1561.csv.
 *    An untranslated comparison reports the whole catalogue as wrong.
 * 3. SOFA lines decompose: one AutoCount line becomes one ERP line per
 *    compartment, price riding the lead piece.  Line count and per-line unit
 *    price are then not commensurable, so for any document whose ERP lines
 *    carry a compartment suffix those two findings are counted as DECLARED,
 *    not as gaps — the document TOTAL still has to match to the cent, and it
 *    is checked.
 *
 * ── SELF-TEST ───────────────────────────────────────────────────────────────
 * A checker that cannot match must refuse, never report a clean run.  Before
 * comparing anything it proves, per type, that its doc-number matcher and its
 * DtlKey matcher actually hit the snapshot, and that the item-code map loaded;
 * a type whose ERP rows carry links of which NONE resolve exits 2.
 *
 * RE-RUN: read-only, so a second run answers again from current state — which
 * is the point: it runs again after the delta migration.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { buildScope, decodeBook, isTestDoc } from "./lib/ac-scope.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const SNAP = path.join(DATA, "ac-reconcile-truth.json.gz");
const MAP_CSV = path.join(DATA, "autocount-erp-mapping-1561.csv");
const CO = Number(process.env.COMPANY_ID || 1); // AED_HOUZS is company 1
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const SHOW = 20; // the owner asked for the first 20 offenders each way

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSED: DATABASE_URL not set.");
  process.exit(2);
}
if (!fs.existsSync(SNAP)) {
  console.error(
    `REFUSED: ${SNAP} is missing. Run backend/scripts/export-ac-reconcile-truth.mjs against the book first.`,
  );
  process.exit(2);
}

const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
plain(`AutoCount snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)`);
plain(`source=${snap.source}`);
plain(`book rows: ${JSON.stringify(snap.counts)}`);
if (!(ageDays <= MAX_AGE_DAYS)) {
  console.error(
    `REFUSED: the AutoCount snapshot is ${ageDays.toFixed(1)} days old (limit ${MAX_AGE_DAYS}). ` +
      "Re-run export-ac-reconcile-truth.mjs — a verdict against a stale book would read as coverage we do not have. " +
      "The file mtime is a checkout artifact and is deliberately not consulted (bugs 0560/0561/0563 are that class).",
  );
  process.exit(2);
}

/* ── item-code translation (trap 2) ──────────────────────────────────────── */
const codeMap = new Map();
{
  const rows = fs.readFileSync(MAP_CSV, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  rows.shift();
  for (const line of rows) {
    const [ac, erp] = line.split(",");
    if (ac && erp) codeMap.set(ac.trim().toUpperCase(), erp.trim().toUpperCase());
  }
}

/* ── snapshot -> typed rows ──────────────────────────────────────────────── */
const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const mapped = (s) => codeMap.get(norm(s)) ?? norm(s);
/* Trap 3.  An AutoCount sofa line is one ERP line PER COMPARTMENT, so the
   codes are "DSL-8051 SOFA" against "8051-1A(LHF)" and only the MODEL is
   commensurable — which is exactly what check-migration-fidelity.mjs declares
   ("item_code beyond the model prefix" is not compared).  The model is the
   first run of 3+ digits on each side; "AMN-SF9028 SOFA" and "9028-1A(LHF)"
   both yield 9028, and "DSL-8030 SOFA" against "9058-1A(LHF)" does NOT — that
   one is a real finding and stays one. */
const isSofaCode = (s) => /SOFA/i.test(String(s ?? ""));
const modelOf = (s) => (String(s ?? "").match(/\d{3,}/) || [null])[0];

const book = decodeBook(snap);

/* ── scope: the population the migration was defined to carry ────────────── */
/* The definition itself lives in scripts/lib/ac-scope.mjs and is stated ONCE.
   It used to be restated here, over the snapshot columns, while
   export-ac-reimport.py stated it as SQL against the book — and two statements
   of one rule is how a checker comes to measure a population no importer ever
   carried.  check-ac-gap-attribution.mjs reads the same module, so the check
   and the attribution can never disagree about who is in scope. */
const SCOPE = buildScope(book);
const soScope = SCOPE.SO;
/* Diagnostic only, NOT part of the definition: the orders the DO rule keeps
   out, reported at the end so the exclusion stays visible. */
const soFullyDelivered = new Set();
const soInvoicedDirect = new Set();
for (const ls of book.IV.lines.values()) {
  for (const l of ls) if (l.fromDocType === "SO" && l.fromDocNo) soInvoicedDirect.add(l.fromDocNo);
}
for (const [docNo, h] of book.SO.headers) {
  if (!docNo || h.cancelled || isTestDoc(docNo)) continue;
  const ls = book.SO.lines.get(docNo) || [];
  if (ls.length && ls.every((l) => (l.qty ?? 0) <= (l.transferedQty ?? 0))) soFullyDelivered.add(docNo);
}

/* ── ERP side ────────────────────────────────────────────────────────────── */
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
const refuse = async (msg) => {
  console.error(`REFUSED: ${msg}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
};

/* One config per type.  `docs`/`lines` are whole SELECTs because every table
   names its columns differently (grn_items.qty_received, not qty; the SO line
   table joins on doc_no, not on a numeric parent id).  `absenceIs` says how to
   report an in-scope AutoCount document the ERP does not have. */
const TYPES = [
  {
    t: "SO",
    label: "Sales Order",
    absenceIs: "GAP",
    docs: () => sql`SELECT doc_no AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(local_total_sen, subtotal_sen) AS total_sen
      FROM scm.mfg_sales_orders WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.created_at, i.id::text AS id
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "PO",
    label: "Purchase Order",
    absenceIs: "GAP",
    docs: () => sql`SELECT po_number AS erp_no, linked_ac_docno AS ac_no, total_sen
      FROM scm.purchase_orders WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        0 AS line_no, i.created_at, i.id::text AS id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "GR",
    label: "Goods Received",
    absenceIs: "GAP",
    /* The GR numbers live on the PO row, not on scm.grns — trap 1. Presence
       only: there is no ERP GR document to compare lines or money against. */
    pointers: () => sql`SELECT DISTINCT g AS ac_no, p.po_number AS erp_no
      FROM scm.purchase_orders p, unnest(p.linked_ac_grn_docnos) g
      WHERE p.company_id = ${CO}`,
    linesNotComparable:
      "grn_items.qty_received/unit_price are DERIVED from the PO line (check-migration-fidelity.mjs), " +
      "and one ERP GRN covers a whole PO while an AutoCount receipt can span several — comparing them " +
      "would measure the derivation, not the book.",
  },
  {
    t: "DO",
    label: "Delivery Order",
    absenceIs: "DECISION", // historical DO import declined by the owner
    sofaAware: true,
    itemCodeDeclared:
      "delivery_order_items.item_code is taken from the SALES ORDER line by design, not from DODTL.ItemCode",
    docs: () => sql`SELECT do_number AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(local_total_sen, 0) AS total_sen
      FROM scm.delivery_orders WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.created_at, i.id::text AS id
      FROM scm.delivery_order_items i
      JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "IV",
    label: "Sales Invoice",
    absenceIs: "DECISION",
    sofaAware: true,
    docs: () => sql`SELECT invoice_number AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(total_sen, local_total_sen) AS total_sen
      FROM scm.sales_invoices WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.created_at, i.id::text AS id
      FROM scm.sales_invoice_items i
      JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "PI",
    label: "Purchase Invoice",
    absenceIs: "DECISION",
    docs: () => sql`SELECT invoice_number AS erp_no, linked_ac_docno AS ac_no, total_sen
      FROM scm.purchase_invoices WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        0 AS line_no, i.created_at, i.id::text AS id
      FROM scm.purchase_invoice_items i
      JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    /* The other half of the purchase-invoice link: pointers stamped on the PO
       by stamp-ac-grn-refs.mjs, which carry no ERP document. */
    pointers: () => sql`SELECT DISTINCT g AS ac_no, p.po_number AS erp_no
      FROM scm.purchase_orders p, unnest(p.linked_ac_pinv_docnos) g
      WHERE p.company_id = ${CO}`,
  },
];

const erp = {};
try {
  for (const cfg of TYPES) {
    erp[cfg.t] = {
      docs: cfg.docs ? await cfg.docs() : [],
      lines: cfg.lines ? await cfg.lines() : [],
      pointers: cfg.pointers ? await cfg.pointers() : [],
    };
  }
} catch (e) {
  await refuse(`the ERP database could not be read: ${e.message}`);
}

/* ── self-test: prove the matchers hit before trusting any verdict ───────── */
{
  const problems = [];
  if (codeMap.size < 100) {
    problems.push(`the item-code map loaded only ${codeMap.size} rows from ${MAP_CSV}`);
  }
  for (const { t } of TYPES) {
    const claims = [
      ...erp[t].docs.filter((d) => d.ac_no).map((d) => String(d.ac_no).trim()),
      ...erp[t].pointers.map((d) => String(d.ac_no).trim()),
    ];
    if (claims.length === 0) continue;
    const hit = claims.filter((a) => book[t].headers.has(a)).length;
    if (hit === 0) {
      problems.push(
        `${t}: ${claims.length} ERP rows claim an AutoCount number and NOT ONE resolves against ` +
          `${book[t].headers.size} ${t} headers in the snapshot — the doc-number matcher is broken, not the data.`,
      );
    }
    const keyed = erp[t].lines.filter((l) => l.ac_dtlkey != null);
    if (keyed.length) {
      const kHit = keyed.filter((l) => book[t].byDtlKey.has(String(l.ac_dtlkey).trim())).length;
      if (kHit === 0) {
        problems.push(
          `${t}: ${keyed.length} ERP lines carry linked_ac_dtlkey and NOT ONE resolves against the ` +
            "snapshot's DtlKeys — the line-key matcher is broken.",
        );
      }
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`SELF-TEST FAILED — ${p}`);
    await refuse("the matchers do not match; refusing to report a clean run.");
  }
  plain(
    `self-test: item-code map ${codeMap.size} rows; doc-number and DtlKey matchers resolve for every ` +
      "type that claims one. Proceeding.",
  );
}

/* ── compare ─────────────────────────────────────────────────────────────── */
const rm = (s) => (s == null ? "null" : (Number(s) / 100).toFixed(2));
const first = (a) => a.slice(0, SHOW);
const summary = [];

for (const cfg of TYPES) {
  const t = cfg.t;
  const B = book[t];
  const scope = SCOPE[t];

  plain("");
  plain(`═══════════ ${t} — ${cfg.label} ═══════════`);
  plain(
    `AutoCount: ${B.headers.size} documents in the book; ${scope.size} in the expected ERP population` +
      (scope.size === 0 ? " (none expected — the owner declined the historical import)" : ""),
  );

  const erpByAc = new Map();
  const dupes = [];
  let erpBorn = 0;
  for (const d of erp[t].docs) {
    const ac = d.ac_no ? String(d.ac_no).trim() : null;
    if (!ac) {
      erpBorn++;
      continue;
    }
    if (erpByAc.has(ac)) dupes.push(`${ac} -> ${erpByAc.get(ac).erp_no} AND ${d.erp_no}`);
    else erpByAc.set(ac, d);
  }
  const pointerByAc = new Map();
  for (const p of erp[t].pointers) pointerByAc.set(String(p.ac_no).trim(), p);
  const claimed = new Set([...erpByAc.keys(), ...pointerByAc.keys()]);

  plain(
    `ERP: ${erp[t].docs.length} documents (company ${CO}); ${erpByAc.size} mirror an AutoCount document; ` +
      `${pointerByAc.size} more are referenced by a pointer on a purchase order; ` +
      `${erpBorn} are ERP-born and claim no AutoCount number`,
  );

  /* 1. document level, both directions */
  const missingInScope = [];
  const absentOutOfScope = [];
  for (const docNo of B.headers.keys()) {
    if (claimed.has(docNo)) continue;
    (scope.has(docNo) ? missingInScope : absentOutOfScope).push(docNo);
  }
  const phantom = [];
  const outOfScopeMirrored = [];
  for (const ac of claimed) {
    if (!B.headers.has(ac)) phantom.push(`${ac} (ERP ${(erpByAc.get(ac) || pointerByAc.get(ac)).erp_no})`);
    else if (!scope.has(ac)) outOfScopeMirrored.push(ac);
  }

  const absenceWord = cfg.absenceIs === "GAP" ? "GAP" : "owner-declined";
  log(
    `${t} DOCUMENTS — in-scope AutoCount documents absent from the ERP: ${missingInScope.length} (${absenceWord}); ` +
      `ERP claims a document the book does not have: ${phantom.length}`,
  );
  plain(
    `   out-of-scope and absent (CORRECT by the population rule): ${absentOutOfScope.length}; ` +
      `present though out of scope: ${outOfScopeMirrored.length}; duplicate claims: ${dupes.length}`,
  );
  if (missingInScope.length) plain(`   absent (first ${SHOW}): ${first(missingInScope).join(", ")}`);
  if (phantom.length) plain(`   phantom (first ${SHOW}): ${first(phantom).join(", ")}`);
  if (dupes.length) plain(`   duplicate (first ${SHOW}): ${first(dupes).join(" | ")}`);

  if (cfg.linesNotComparable) {
    log(`${t} DATA — line and money comparison NOT APPLICABLE. ${cfg.linesNotComparable}`);
    summary.push({
      t, acDocs: B.headers.size, scope: scope.size, erpLinked: claimed.size,
      missing: missingInScope.length, absenceIs: cfg.absenceIs, phantom: phantom.length,
      bothSides: 0, lineCount: "-", item: "-", qty: "-", price: "-", money: "-", gaps: missingInScope.length * (cfg.absenceIs === "GAP" ? 1 : 0) + phantom.length,
    });
    continue;
  }

  /* 2 + 3. line level and money for documents present on both sides */
  const erpLinesByAc = new Map();
  for (const l of erp[t].lines) {
    const ac = String(l.ac_no).trim();
    if (!erpLinesByAc.has(ac)) erpLinesByAc.set(ac, []);
    erpLinesByAc.get(ac).push(l);
  }

  const F = {
    lineCount: [], money: [], item: [], qty: [], price: [],
    keyOrphan: [], unmatchedErp: [], unmatchedAc: [],
  };
  const D = { lineCount: 0, item: 0, price: 0 }; // declared, not gaps
  let descOnly = 0;
  let bothSides = 0;
  let comparedLines = 0;
  let sofaDocs = 0;
  const unpairableDocs = [];
  let zeroMoneyDocs = 0;

  for (const [ac, d] of erpByAc) {
    const h = B.headers.get(ac);
    if (!h) continue;
    bothSides++;

    const acLines = (B.lines.get(ac) || [])
      .slice()
      .sort((a, b) => a.seq - b.seq || (a.dtlKey > b.dtlKey ? 1 : -1));
    const erpLines = (erpLinesByAc.get(ac) || [])
      .slice()
      .sort(
        (a, b) =>
          a.line_no - b.line_no ||
          String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
          (a.id > b.id ? 1 : -1),
      );
    /* Trap 3: a sofa line on either side means this document was decomposed,
       so its line count and per-line price are not commensurable.  Detected
       three ways because no single one is reliable across the import rounds:
       AutoCount's own "... SOFA" code, the ERP's compartment suffix, and one
       AutoCount DtlKey claimed by more than one ERP line. */
    const dupKeyed = new Set();
    let splitSeen = false;
    for (const l of erpLines) {
      const k = l.ac_dtlkey == null ? null : String(l.ac_dtlkey).trim();
      if (!k) continue;
      if (dupKeyed.has(k)) splitSeen = true;
      dupKeyed.add(k);
    }
    const sofa =
      splitSeen || erpLines.some((l) => l.line_suffix) || acLines.some((l) => isSofaCode(l.itemKey));
    if (sofa) sofaDocs++;

    if (acLines.length !== erpLines.length) {
      const msg = `${ac}: AutoCount ${acLines.length} vs ERP ${erpLines.length} (ERP ${d.erp_no})`;
      if (sofa) D.lineCount++;
      else F.lineCount.push(msg);
    }
    const erpTotal = d.total_sen == null ? null : Number(d.total_sen);
    if (h.totalSen !== erpTotal) {
      /* An ERP side that is zero while the book is not is a POPULATION
         property, not per-document drift — the migrated delivery orders carry
         no money at all. Counted apart so 55 documents do not read as 55
         separate defects. */
      if (!erpTotal && h.totalSen) zeroMoneyDocs++;
      F.money.push(`${ac}: AutoCount RM ${rm(h.totalSen)} vs ERP RM ${rm(erpTotal)} (ERP ${d.erp_no})`);
    }

    /* When NO ERP line on this document carries a DtlKey and the two sides do
       not even agree on how many lines there are, ordinal pairing would invent
       mismatches for every line after the first divergence.  Say so and stop
       for this document — a checker that cannot match must refuse rather than
       report. */
    if (!erpLines.some((l) => l.ac_dtlkey != null) && acLines.length !== erpLines.length) {
      unpairableDocs.push(`${ac}: no line key on either side and the counts differ (ERP ${d.erp_no})`);
      continue;
    }

    /* Pair on DtlKey where the ERP carries one — it is the only key the two
       systems genuinely share — then fall back to document order. */
    const acByKey = new Map(acLines.map((l) => [l.dtlKey, l]));
    const usedAc = new Set();
    const pairs = [];
    const unkeyedErp = [];
    for (const el of erpLines) {
      const k = el.ac_dtlkey == null ? null : String(el.ac_dtlkey).trim();
      if (k) {
        const al = acByKey.get(k);
        if (al && !usedAc.has(k)) {
          usedAc.add(k);
          pairs.push([al, el, false]);
          continue;
        }
        if (!al) {
          F.keyOrphan.push(`${ac}: ERP line ${el.id} claims DtlKey ${k}, not a line of this document`);
          continue;
        }
        /* a second ERP line on the same AutoCount line = the sofa split */
        pairs.push([al, el, true]);
        continue;
      }
      unkeyedErp.push(el);
    }
    /* The keyless fallback pairs on VALUE before position.  grn/do/si/pi items
       carry no line key at all, and their insert order is not AutoCount's Seq —
       PI-007893 measured 2026-09-07 held the same four prices rotated by one
       position, which pure ordinal pairing reported as four price defects and
       zero of them were real.  So: exact (qty, unit price) first, then qty
       alone, then whatever is left in document order.  A genuine difference
       survives all three passes; a reordering does not. */
    let freeAc = acLines.filter((l) => !usedAc.has(l.dtlKey));
    let freeErp = unkeyedErp;
    for (const keyOf of [
      (q, p) => `${q}|${p}`,
      (q) => `${q}`,
    ]) {
      const bucket = new Map();
      for (const al of freeAc) {
        const k = keyOf(al.qty ?? 0, al.unitPriceSen ?? 0);
        if (!bucket.has(k)) bucket.set(k, []);
        bucket.get(k).push(al);
      }
      const stillFreeErp = [];
      const taken = new Set();
      for (const el of freeErp) {
        const k = keyOf(el.qty == null ? 0 : Number(el.qty), el.unit_price_sen == null ? 0 : Number(el.unit_price_sen));
        const cand = bucket.get(k);
        const al = cand && cand.shift();
        if (al) {
          taken.add(al.dtlKey);
          pairs.push([al, el, false]);
        } else stillFreeErp.push(el);
      }
      freeAc = freeAc.filter((l) => !taken.has(l.dtlKey));
      freeErp = stillFreeErp;
    }
    for (let i = 0; i < Math.max(freeAc.length, freeErp.length); i++) {
      if (i < freeAc.length && i < freeErp.length) pairs.push([freeAc[i], freeErp[i], false]);
      else if (i < freeAc.length) F.unmatchedAc.push(`${ac}: AutoCount DtlKey ${freeAc[i].dtlKey} has no ERP line`);
      else F.unmatchedErp.push(`${ac}: ERP line ${freeErp[i].id} has no AutoCount line`);
    }

    for (const [al, el, split] of pairs) {
      comparedLines++;
      if (!al.hasCode) descOnly++;
      else if (isSofaCode(al.itemKey)) {
        /* compartment codes: only the model is comparable */
        const am = modelOf(al.itemKey);
        const em = modelOf(el.item_code);
        if (am && em && am === em) D.item++;
        else if (cfg.itemCodeDeclared) D.item++;
        else {
          F.item.push(
            `${ac} DtlKey ${al.dtlKey}: AutoCount model ${am ?? "?"} ("${al.itemKey}") vs ERP model ` +
              `${em ?? "?"} ("${el.item_code ?? ""}")`,
          );
        }
      } else if (mapped(al.itemKey) !== norm(el.item_code)) {
        const msg = `${ac} DtlKey ${al.dtlKey}: AutoCount "${al.itemKey}" vs ERP "${el.item_code ?? ""}"`;
        if (cfg.itemCodeDeclared || split) D.item++;
        else F.item.push(msg);
      }
      const aq = al.qty ?? 0;
      const eq = el.qty == null ? 0 : Number(el.qty);
      if (Math.abs(aq - eq) > 1e-4) F.qty.push(`${ac} DtlKey ${al.dtlKey}: AutoCount qty ${aq} vs ERP qty ${eq}`);
      const ap = al.unitPriceSen ?? 0;
      const ep = el.unit_price_sen == null ? 0 : Number(el.unit_price_sen);
      if (ap !== ep) {
        const msg = `${ac} DtlKey ${al.dtlKey}: AutoCount unit price RM ${rm(ap)} vs ERP RM ${rm(ep)}`;
        if (split || sofa) D.price++;
        else F.price.push(msg);
      }
    }
  }

  log(
    `${t} DATA (${bothSides} documents on both sides, ${comparedLines} lines paired) — ` +
      `line-count differs: ${F.lineCount.length}; item code: ${F.item.length}; quantity: ${F.qty.length}; ` +
      `unit price: ${F.price.length}; document total: ${F.money.length}`,
  );
  plain(
    `   unpaired: ${F.unmatchedAc.length} AutoCount lines, ${F.unmatchedErp.length} ERP lines; ` +
      `DtlKey on the wrong document: ${F.keyOrphan.length}; ` +
      `AutoCount lines with no ItemCode (description-only, not comparable): ${descOnly}`,
  );
  if (zeroMoneyDocs) {
    log(
      `${t} — ${zeroMoneyDocs} of the ${bothSides} documents on both sides carry ZERO money in the ERP ` +
        "while the book carries a value. That is one systematic cause, not that many separate defects.",
    );
  }
  if (unpairableDocs.length) {
    log(
      `${t} — ${unpairableDocs.length} documents could NOT be line-matched (no line key on either side and ` +
        "the line counts differ). Their line data is UNVERIFIED, not verified-clean.",
    );
    for (const row of first(unpairableDocs)) plain(`      ${row}`);
  }
  plain(
    `   DECLARED, not counted as gaps: sofa-decomposed documents ${sofaDocs} ` +
      `(line count ${D.lineCount}, unit price ${D.price}); item code by design ${D.item}` +
      (cfg.itemCodeDeclared ? ` — ${cfg.itemCodeDeclared}` : ""),
  );
  for (const [name, arr] of [
    ["line count", F.lineCount],
    ["item code", F.item],
    ["quantity", F.qty],
    ["unit price", F.price],
    ["document total", F.money],
    ["orphan DtlKey", F.keyOrphan],
    ["AutoCount line with no ERP line", F.unmatchedAc],
    ["ERP line with no AutoCount line", F.unmatchedErp],
  ]) {
    if (!arr.length) continue;
    plain(`   ${name} (first ${Math.min(SHOW, arr.length)} of ${arr.length}):`);
    for (const row of first(arr)) plain(`      ${row}`);
  }

  summary.push({
    t,
    acDocs: B.headers.size,
    scope: scope.size,
    erpLinked: claimed.size,
    missing: missingInScope.length,
    absenceIs: cfg.absenceIs,
    phantom: phantom.length,
    bothSides,
    unpairable: unpairableDocs.length,
    lineCount: F.lineCount.length,
    item: F.item.length,
    qty: F.qty.length,
    price: F.price.length,
    money: F.money.length,
    gaps:
      (cfg.absenceIs === "GAP" ? missingInScope.length : 0) +
      phantom.length + F.lineCount.length + F.item.length + F.qty.length + F.price.length + F.money.length,
  });
}

/* ── the DO rule, stated so nobody "fixes" it ────────────────────────────── */
plain("");
plain("═══════════ THE DO RULE (owner's; not a defect) ═══════════");
log(
  `${soFullyDelivered.size} un-cancelled AutoCount sales orders have EVERY line already transferred to a ` +
    "delivery order. Their absence from the ERP is CORRECT — outstanding means not yet transferred to a DO.",
);
plain(
  `   sales orders in the book: ${book.SO.headers.size}; outstanding (expected in the ERP): ${soScope.size}; ` +
    `fully delivered: ${soFullyDelivered.size}; invoiced direct with no DO (owner-excluded 2026-08-10): ` +
    `${[...soInvoicedDirect].filter((d) => book.SO.headers.has(d)).length}`,
);

/* ── one-screen verdict ──────────────────────────────────────────────────── */
plain("");
plain("═══════════ SUMMARY ═══════════");
plain("type  book  scope    erp  absent  phantom   both  lineCnt   item    qty  price  money");
for (const s of summary) {
  plain(
    [
      s.t.padEnd(4),
      String(s.acDocs).padStart(5),
      String(s.scope).padStart(6),
      String(s.erpLinked).padStart(6),
      String(s.missing).padStart(7),
      String(s.phantom).padStart(8),
      String(s.bothSides).padStart(6),
      String(s.lineCount).padStart(8),
      String(s.item).padStart(6),
      String(s.qty).padStart(6),
      String(s.price).padStart(6),
      String(s.money).padStart(6),
    ].join(" "),
  );
}
plain("absent = in the expected population but not in the ERP; for DO/IV/PI the population is empty by owner decision.");
const totalGaps = summary.reduce((a, s) => a + s.gaps, 0);
log(
  totalGaps === 0
    ? "CLEAN — every in-scope AutoCount document is in the ERP and every comparable field agrees."
    : `${totalGaps} disagreements that are NOT covered by a declared design difference. Detail above.`,
);

await sql.end({ timeout: 5 });
