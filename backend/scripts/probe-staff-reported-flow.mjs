#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. THE THREE THINGS THE SHOP FLOOR REPORTED ON 2026-09-08, EACH SIZED
// OVER ITS WHOLE CLASS INSTEAD OF ITS ONE DOCUMENT.
//
// The staff reported three sales orders. Each is an instance of a class, and
// fixing three documents while twenty of the same shape stay unfound is not the
// job. This probe measures the classes. It writes nothing.
//
//   A  A SOFA'S COMPARTMENTS DISAGREE WITH THE BOOK'S OWN TEXT.
//      check-sofa-bedframe-completeness.mjs already finds these — this section
//      does NOT re-derive them, it answers the question that checker cannot:
//      is the order still LIVE? A disagreement on a 2024 order nobody will ever
//      build is not the same work as one on an order in the factory, and the
//      owner plans against the live number ("blank is OK until an order is
//      proceeded"). Pass DOCS_A to re-point it at a fresh audit's list.
//
//   B  A HARD-BOUND SALES LINE HAS NO PURCHASE ORDER IN THE ERP, AND THE BOOK
//      NAMES ONE. isHardBoundLine (src/scm/lib/so-stock-allocation.ts): a
//      company-1 bedframe / sofa / (SP) mattress line reads READY ONLY through
//      its own dedicated purchase-order line. A line whose real purchase order
//      is not linked can never light up, and MRP will tell purchasing to raise
//      a SECOND one for goods already on the way. The number that matters is
//      how many of these are on a LIVE order, because that is a customer
//      waiting.
//
//   C  THE BOOK STATES THE SO->PO EDGE AND THE ERP CANNOT RESOLVE IT.
//      PODTL.FromSODtlKey names a sales-order LINE. repair-po-so-link-from-
//      book.mjs copies that edge, but refuses whenever either key resolves to
//      more than one ERP row — which is EVERY SOFA, because one book line is
//      one ERP row per compartment. This section asks whether those refusals
//      are resolvable at COMPARTMENT grain: inside one book-line pair, does
//      every item code appear exactly once on each side? If it does, the
//      pairing is a copy plus an exact identity match, not a guess. If it does
//      not, it stays refused and is counted.
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Document numbers,
// item codes and statuses only — no customer names, no addresses, no money.
//
// NOTHING IS WRITTEN. Every statement is a SELECT. There is no APPLY path.
//
//   DATABASE_URL           required
//   COMPANY_ID             default 1 (AED_HOUZS)
//   MAX_SNAPSHOT_AGE_DAYS  default 2 — refuses rather than answer from a stale book
//   DOCS_A                 comma-separated sales orders for section A;
//                          blank = the 2026-09-08 compartment audit's own list
//   TOP                    max rows printed per list (default 60)
//
// RE-RUN: idempotent and side-effect free. Safe to run any number of times.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { loadCorrections } from "./lib/sofa-corrections-source.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const TOP = Number(process.env.TOP || 60);
const here = path.dirname(fileURLToPath(import.meta.url));

const out = (m = "") => console.log(m);
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The same normaliser repair-po-so-link-from-book.mjs uses, deliberately: the
   probe and any repair built from it must not disagree about what "the same
   product" means. */
const norm = (s) => (s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/* An order that no longer creates demand. Mirrors SO_TERMINAL_STATES in
   src/scm/shared/so-terminal-states.ts; a line on one of these is not a
   customer waiting, whatever its compartments say. */
const TERMINAL = new Set(["CANCELLED", "CLOSED", "SHIPPED", "DELIVERED", "INVOICED", "DRAFT"]);

/* isHardBoundLine, src/scm/lib/so-stock-allocation.ts, in SQL-free form. Kept
   as ONE predicate here for the same reason the TypeScript keeps it as one
   function: two copies of this rule drift and the readiness answer changes
   with them. */
const HARD_BOUND_GROUPS = new Set(["bedframe", "sofa"]);
const isHardBound = (group, code) => {
  const g = (group ?? "").toLowerCase();
  if (HARD_BOUND_GROUPS.has(g)) return true;
  return g === "mattress" && /\(SP\)\s*$/i.test(code ?? "");
};

/* The 35 sales orders the 2026-09-08 whole-population compartment audit (run
   34199783580, check-sofa-bedframe-completeness with all_so=1) reported as
   holding a build whose compartments do not match the book's own decoded
   Desc2. Overridable with DOCS_A so the next round needs no code change. */
const DEFAULT_DOCS_A = [
  "HC-SO-001895", "HC-SO-001896", "HC-SO-002961", "HC-SO-003100", "HC-SO-003189",
  "HC-SO-003772", "HC-SO-003939", "HC-SO-004281", "HC-SO-004692", "HC-SO-004718",
  "HC-SO-004751", "HC-SO-005013", "HC-SO-005082", "HC-SO-005862", "HC-SO-006269",
  "HC-SO-006448", "HC-SO-006752", "HC-SO-006890", "HC-SO-006941", "HC-SO-007195",
  "HC-SO-007949", "HC-SO-008403", "HC-SO-008683", "HC-SO-008769", "HC-SO-008794",
  "HC-SO-008821", "HC-SO-010457", "HC-SO-011221", "HC-SO-011756", "HC-SO-012008",
  "HC-SO-013226", "HC-SO-010209", "HC-SO-011099", "HC-SO-013327", "HC-SO-013329",
];
const DOCS_A = (process.env.DOCS_A ? process.env.DOCS_A.split(",") : DEFAULT_DOCS_A)
  .map((s) => s.trim()).filter(Boolean);

/* ── the book ────────────────────────────────────────────────────────────── */
const SNAP = path.join(here, "data", "ac-reconcile-truth.json.gz");
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is not present. Every verdict below is a comparison against the book.`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (!(ageDays <= MAX_AGE_DAYS)) {
  console.error(`REFUSED: the AutoCount snapshot is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE_DAYS}). `
    + "A stale book would report edges that have since been created or cancelled.");
  process.exit(2);
}

/* THE SNAPSHOT'S ROWS ARE ARRAYS, NOT OBJECTS (docs/bugs/0674): reading r.dtlKey
   off one returns undefined, every filter matches nothing, and an empty result
   reads exactly like "there is nothing to report". Assert the field positions
   rather than trusting the order. */
const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
for (const f of ["docNo", "dtlKey", "itemKey", "fromSoDtlKey"]) {
  if (L[f] == null) {
    console.error(`REFUSED: the snapshot's line_fields has no "${f}". Its shape has changed and every `
      + "index below would read a different column.");
    process.exit(2);
  }
}
const H = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));

const bookPoCancelled = new Map(snap.types.PO.headers.map((r) => [String(r[H.docNo]), String(r[H.cancelled]) === "T"]));
/** book SO line key -> [{ poDocNo, poDtlKey, itemKey }] — every purchase line the book raised off it. */
const bookPoBySoKey = new Map();
/** book PO line key -> { docNo, itemKey, fromSoDtlKey } */
const bookPoByKey = new Map();
for (const r of snap.types.PO.lines) {
  const rec = {
    docNo: String(r[L.docNo]), dtlKey: String(r[L.dtlKey]), itemKey: String(r[L.itemKey] ?? ""),
    fromSoDtlKey: String(r[L.fromSoDtlKey] ?? ""),
  };
  bookPoByKey.set(rec.dtlKey, rec);
  if (!rec.fromSoDtlKey) continue;
  if (bookPoCancelled.get(rec.docNo)) continue;
  if (!bookPoBySoKey.has(rec.fromSoDtlKey)) bookPoBySoKey.set(rec.fromSoDtlKey, []);
  bookPoBySoKey.get(rec.fromSoDtlKey).push(rec);
}
const bookSoByKey = new Map(snap.types.SO.lines.map((r) => [
  String(r[L.dtlKey]), { docNo: String(r[L.docNo]), itemKey: String(r[L.itemKey] ?? "") },
]));

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const PDATE = soProcessingDateFragment(sql);

/** Documents any owner-approved corrections file already speaks for. */
const correctedDocs = (() => {
  const { builds, held } = loadCorrections(path.join(here, "data"));
  const s = new Set();
  for (const b of builds) for (const d of b.docs ?? []) s.add(d);
  for (const h of held) for (const d of h.docs ?? []) s.add(d);
  return s;
})();

async function sectionA() {
  out("");
  out("==============================================================================");
  out("A.  THE COMPARTMENT DISAGREEMENTS - which of them are on a LIVE order");
  out("==============================================================================");
  out("");
  out("  A build whose compartments disagree with the book's own decoded Desc2 is not");
  out("  automatically a defect: where the owner has RULED on the drawing, the ERP is");
  out("  meant to disagree with the text and the ruling lives in");
  out("  scripts/data/sofa-compartment-corrections-*.json. What is left after those is");
  out("  the question, and only the LIVE half of it is work anybody is waiting on.");
  out("");
  const rows = await sql`
    SELECT h.doc_no, UPPER(COALESCE(h.status::text, '')) AS status,
           (h.${PDATE} IS NOT NULL) AS proceeded,
           count(*) FILTER (WHERE i.item_group = 'sofa' AND i.cancelled IS NOT TRUE)::int AS sofa_lines
      FROM scm.mfg_sales_orders h
      LEFT JOIN scm.mfg_sales_order_items i ON i.doc_no = h.doc_no
     WHERE h.company_id = ${CO} AND h.doc_no = ANY(${DOCS_A})
     GROUP BY h.doc_no, h.status, h.${PDATE}
     ORDER BY h.doc_no`;
  const found = new Set(rows.map((r) => r.doc_no));
  const missing = DOCS_A.filter((d) => !found.has(d));

  let live = 0, terminal = 0, owner = 0;
  for (const r of rows) {
    const isOwner = correctedDocs.has(r.doc_no);
    const isTerminal = TERMINAL.has(r.status);
    if (isOwner) owner++;
    else if (isTerminal) terminal++;
    else live++;
  }
  out(`  ${DOCS_A.length} document(s) asked about; ${rows.length} found on company ${CO}`
    + (missing.length ? `; NOT FOUND: ${missing.join(", ")}` : ""));
  out(`    an OWNER-APPROVED override - the ERP is meant to differ from the text   ${String(owner).padStart(4)}`);
  out(`    the order is TERMINAL (${[...TERMINAL].join("/")}) - nobody is waiting   ${String(terminal).padStart(4)}`);
  out(`    LIVE and NOT ruled on - this is the work                                ${String(live).padStart(4)}`);
  out("");
  let shown = 0;
  for (const r of rows) {
    if (correctedDocs.has(r.doc_no)) continue;
    if (shown++ >= TOP) { out(`    ... and ${rows.length - shown} more - raise TOP`); break; }
    out(`    ${r.doc_no}  status ${String(r.status).padEnd(14)} ${r.proceeded ? "PROCEEDED" : "not proceeded"}  ${r.sofa_lines} live sofa line(s)`
      + `   ${TERMINAL.has(r.status) ? "" : "<-- LIVE"}`);
  }
  return { asked: DOCS_A.length, found: rows.length, owner, terminal, live };
}

async function sectionB() {
  out("");
  out("==============================================================================");
  out("B.  A HARD-BOUND SALES LINE WITH NO PURCHASE ORDER - and what the book says");
  out("==============================================================================");
  out("");
  out("  isHardBoundLine (src/scm/lib/so-stock-allocation.ts): a company-1 bedframe /");
  out("  sofa / (SP) mattress line reads READY ONLY through its own dedicated purchase");
  out("  line, never through the pooled walk. So a missing link is not cosmetic - the");
  out("  line cannot light up whatever the warehouse holds, and MRP will ask purchasing");
  out("  for a SECOND purchase order for goods that are already coming.");
  out("");
  const lines = await sql`
    SELECT i.id::text AS id, i.doc_no, i.item_code, i.item_group, i.stock_status,
           i.linked_ac_dtlkey::text AS dtl,
           UPPER(COALESCE(h.status::text, '')) AS so_status,
           (h.${PDATE} IS NOT NULL) AS proceeded,
           EXISTS (SELECT 1 FROM scm.purchase_order_items p WHERE p.so_item_id = i.id) AS has_po
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${CO}
     WHERE i.company_id = ${CO} AND i.cancelled IS NOT TRUE`;

  const bound = lines.filter((r) => isHardBound(r.item_group, r.item_code));
  const liveBound = bound.filter((r) => !TERMINAL.has(r.so_status));
  const noPo = liveBound.filter((r) => !r.has_po);

  /* The book's own answer for each: does a purchase order exist over there that
     names THIS sales line? Only FromSODtlKey can say so - it is the one edge
     the book keys at line grain (check-ac-convert-symmetry.mjs, TRAP 1). */
  const bookNames = [], bookSilent = [], noKey = [];
  for (const r of noPo) {
    if (!r.dtl) { noKey.push(r); continue; }
    const pos = bookPoBySoKey.get(String(r.dtl));
    if (pos && pos.length) bookNames.push({ ...r, pos });
    else bookSilent.push(r);
  }
  const pending = (rs) => rs.filter((r) => String(r.stock_status ?? "").toUpperCase() !== "READY").length;

  out(`  company-${CO} sales lines, not cancelled                         ${String(lines.length).padStart(6)}`);
  out(`  of them HARD-BOUND (bedframe / sofa / (SP) mattress)            ${String(bound.length).padStart(6)}`);
  out(`  of those, on an order that is NOT terminal                      ${String(liveBound.length).padStart(6)}`);
  out(`  of those, carrying NO dedicated purchase-order line             ${String(noPo.length).padStart(6)}  <- cannot reach READY`);
  out("");
  out("  WHAT THE BOOK SAYS ABOUT EACH OF THOSE, and the split is the whole point:");
  out(`    the ERP row carries no AutoCount line key - unanswerable      ${String(noKey.length).padStart(6)}`);
  out(`    the book has NO purchase order for this line either           ${String(bookSilent.length).padStart(6)}  the absence is CORRECT`);
  out(`    the book HAS one and we do not hold the link                  ${String(bookNames.length).padStart(6)}  <- THE FINDING`);
  out("");
  out(`  of the ${bookNames.length} the book names, ${pending(bookNames)} are not READY today - that is the number with a customer behind it`);
  out("");
  const byDoc = new Map();
  for (const r of bookNames) {
    if (!byDoc.has(r.doc_no)) byDoc.set(r.doc_no, []);
    byDoc.get(r.doc_no).push(r);
  }
  let shown = 0;
  for (const [doc, rs] of byDoc) {
    if (shown++ >= TOP) { out(`    ... and ${byDoc.size - shown} more document(s) - raise TOP`); break; }
    for (const r of rs) {
      const pos = [...new Set(r.pos.map((p) => p.docNo))].join(", ");
      out(`    ${doc}  ${String(r.item_code).padEnd(24)} ${String(r.item_group).padEnd(9)} ${String(r.stock_status).padEnd(8)}`
        + ` SO line ${r.dtl} -> the book raised ${pos}`);
    }
  }
  return { bound: bound.length, liveBound: liveBound.length, noPo: noPo.length, noKey: noKey.length,
    bookSilent: bookSilent.length, bookNames: bookNames.length, bookNamesPending: pending(bookNames) };
}

async function sectionC() {
  out("");
  out("==============================================================================");
  out("C.  THE SO->PO EDGES THE BOOK STATES AND THE KEY CANNOT RESOLVE");
  out("==============================================================================");
  out("");
  out("  repair-po-so-link-from-book.mjs refuses a pair whenever either AutoCount key");
  out("  resolves to more than one ERP row, because a Map keyed by DtlKey would keep");
  out("  ONE of them and the pairing would be a coin flip. Every sofa is in that");
  out("  bucket by construction: one book line, one ERP row per compartment.");
  out("");
  out("  This asks the narrower question the refusal does not: INSIDE one book-line");
  out("  pair, does every item code appear exactly once on each side? Where it does,");
  out("  the pairing is the book's own edge plus an exact identity match - a copy, not");
  out("  an inference. Where it does not, it stays refused and is counted here.");
  out("");
  const unlinked = await sql`
    SELECT i.id::text AS id, i.item_code, i.item_group, i.linked_ac_dtlkey::text AS dtl,
           h.po_number, UPPER(COALESCE(h.status::text, '')) AS po_status
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id AND h.company_id = ${CO}
     WHERE i.so_item_id IS NULL AND UPPER(COALESCE(h.status::text, '')) <> 'CANCELLED'`;

  const erpPoByKey = new Map();
  for (const r of unlinked) {
    if (!r.dtl) continue;
    if (!erpPoByKey.has(r.dtl)) erpPoByKey.set(r.dtl, []);
    erpPoByKey.get(r.dtl).push(r);
  }
  const erpSoByKey = new Map();
  for (const r of await sql`
    SELECT s.id::text AS id, s.item_code, s.item_group, s.linked_ac_dtlkey::text AS dtl, s.doc_no,
           s.stock_status, UPPER(COALESCE(o.status::text, '')) AS so_status
      FROM scm.mfg_sales_order_items s
      JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
     WHERE s.company_id = ${CO} AND s.linked_ac_dtlkey IS NOT NULL AND s.cancelled IS NOT TRUE
       AND UPPER(COALESCE(o.status::text, '')) <> 'CANCELLED'`) {
    if (!erpSoByKey.has(r.dtl)) erpSoByKey.set(r.dtl, []);
    erpSoByKey.get(r.dtl).push(r);
  }

  const verdicts = { noKey: 0, noBookRow: 0, bookHasNoSource: 0, soNotImported: 0,
    singleKeyPair: 0, compartmentUnique: 0, compartmentDuplicated: 0, itemMismatch: 0, countsDiffer: 0 };
  const resolvable = [], refusedDetail = [];
  const seenPairs = new Set();

  for (const r of unlinked) {
    if (!r.dtl) { verdicts.noKey++; continue; }
    const bookPo = bookPoByKey.get(r.dtl);
    if (!bookPo) { verdicts.noBookRow++; continue; }
    if (!bookPo.fromSoDtlKey) { verdicts.bookHasNoSource++; continue; }
    if (!bookSoByKey.has(bookPo.fromSoDtlKey)) { verdicts.noBookRow++; continue; }
    const soRows = erpSoByKey.get(bookPo.fromSoDtlKey) ?? [];
    if (!soRows.length) { verdicts.soNotImported++; continue; }
    const poRows = erpPoByKey.get(r.dtl) ?? [];
    if (poRows.length === 1 && soRows.length === 1) { verdicts.singleKeyPair++; continue; }

    /* One PAIR of book lines, judged once. Counting per ERP row would report the
       same verdict as many times as the sofa has compartments. */
    const pairId = `${r.dtl}|${bookPo.fromSoDtlKey}`;
    if (seenPairs.has(pairId)) continue;
    seenPairs.add(pairId);

    const tally = (rows) => {
      const m = new Map();
      for (const x of rows) m.set(norm(x.item_code), (m.get(norm(x.item_code)) ?? 0) + 1);
      return m;
    };
    const pT = tally(poRows), sT = tally(soRows);
    const dupPo = [...pT].filter(([, n]) => n > 1).map(([c]) => c);
    const dupSo = [...sT].filter(([, n]) => n > 1).map(([c]) => c);
    const unmatched = [...pT.keys()].filter((c) => !sT.has(c));

    if (unmatched.length) {
      verdicts.itemMismatch++;
      refusedDetail.push(`${r.po_number} <- ${bookSoByKey.get(bookPo.fromSoDtlKey).docNo}: `
        + `the purchase side carries ${unmatched.join(", ")} and the sales side does not`);
      continue;
    }
    if (dupPo.length || dupSo.length) {
      verdicts.compartmentDuplicated++;
      refusedDetail.push(`${r.po_number} <- ${bookSoByKey.get(bookPo.fromSoDtlKey).docNo}: `
        + `${[...new Set([...dupPo, ...dupSo])].join(", ")} appears more than once on one side - which row is which is a coin flip`);
      continue;
    }
    if (poRows.length !== soRows.length) {
      verdicts.countsDiffer++;
      refusedDetail.push(`${r.po_number} <- ${bookSoByKey.get(bookPo.fromSoDtlKey).docNo}: `
        + `${poRows.length} purchase row(s) against ${soRows.length} sales row(s)`);
      continue;
    }
    verdicts.compartmentUnique++;
    for (const p of poRows) {
      const s = soRows.find((x) => norm(x.item_code) === norm(p.item_code));
      resolvable.push({ poNumber: p.po_number, code: norm(p.item_code), group: p.item_group,
        soDocNo: s.doc_no, stockStatus: s.stock_status, soStatus: s.so_status,
        acPo: bookPo.docNo, acSo: bookSoByKey.get(bookPo.fromSoDtlKey).docNo });
    }
  }

  out(`  ${unlinked.length} live company-${CO} purchase-order line(s) carry no sales-order link`);
  out(`    no AutoCount line key on the ERP row                          ${String(verdicts.noKey).padStart(6)}`);
  out(`    the key names no line in the book                             ${String(verdicts.noBookRow).padStart(6)}`);
  out(`    the BOOK records no source order                              ${String(verdicts.bookHasNoSource).padStart(6)}  a link here would be INVENTED`);
  out(`    the source order was not imported                             ${String(verdicts.soNotImported).padStart(6)}`);
  out(`    both keys resolve to ONE row - repair-po-so-link-from-book's  ${String(verdicts.singleKeyPair).padStart(6)}  already its job, not this one`);
  out("");
  out("  THE MULTI-ROW PAIRS, judged once per PAIR of book lines:");
  out(`    every code unique on BOTH sides - PROVABLE at compartment grain ${String(verdicts.compartmentUnique).padStart(4)}`);
  out(`    a code appears twice on one side - REFUSED, a coin flip         ${String(verdicts.compartmentDuplicated).padStart(4)}`);
  out(`    the two sides carry DIFFERENT products - REFUSED                ${String(verdicts.itemMismatch).padStart(4)}`);
  out(`    the two sides hold a different NUMBER of rows - REFUSED         ${String(verdicts.countsDiffer).padStart(4)}`);
  out("");
  out(`  ${resolvable.length} purchase-order line(s) would be linked by the compartment-grain rule:`);
  for (const p of resolvable.slice(0, TOP)) {
    out(`    ${p.poNumber.padEnd(14)} ${p.code.padEnd(24)} ${String(p.group ?? "").padEnd(9)} -> ${p.soDocNo}`
      + `  [SO ${p.soStatus}, line ${p.stockStatus}]  book ${p.acPo} <- ${p.acSo}`);
  }
  if (resolvable.length > TOP) out(`    ... and ${resolvable.length - TOP} more - raise TOP`);
  if (refusedDetail.length) {
    out("");
    out("  REFUSED, each with the reason the book cannot settle:");
    for (const d of refusedDetail.slice(0, TOP)) out(`    ${d}`);
  }
  return { unlinked: unlinked.length, ...verdicts, resolvableRows: resolvable.length };
}

async function main() {
  out(`company=${CO}  AutoCount snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)`);
  out(`owner-approved sofa corrections cover ${correctedDocs.size} document(s)`);
  const a = await sectionA();
  const b = await sectionB();
  const c = await sectionC();
  out("");
  out("==============================================================================");
  out("VERDICT");
  out("==============================================================================");
  log(`A compartments: ${a.live} LIVE document(s) disagree with the book and carry no owner ruling `
    + `(${a.owner} are owner rulings, ${a.terminal} are on terminal orders).`);
  log(`B readiness: ${b.noPo} live hard-bound sales line(s) have no dedicated purchase order; `
    + `the book names one for ${b.bookNames} of them, ${b.bookNamesPending} of those not READY today. `
    + `For ${b.bookSilent} the book has no purchase order either - the absence is CORRECT.`);
  log(`C links: ${c.compartmentUnique} book-line pair(s) are provable at compartment grain `
    + `(${c.resolvableRows} purchase rows); ${c.compartmentDuplicated + c.itemMismatch + c.countsDiffer} pair(s) stay refused.`);
  out("");
  out("Every number above is an ANSWER, not a failure. This probe exits 0 unless it could not read.");
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
});
