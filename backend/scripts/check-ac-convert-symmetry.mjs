#!/usr/bin/env node
/* check-ac-convert-symmetry — is the CONVERT relationship symmetric, both ways?
 *
 * The owner's question, 2026-09-07 (go-live day):
 *   "记得检查我们的 convert（也就是 transfer from 和 transfer to）的功能对称。
 *    你相互检查看一下，transfer to 和 transfer from 的功能全部都是准确的吗？
 *    数据是准确的吗？"
 *
 * Two directions, and whether they AGREE:
 *
 *   transfer FROM (child -> parent).  Every DO/IV/GR/PI/PO line that names a
 *   source: does that source document exist?  Does the source LINE exist?
 *   An orphan is a child pointing at a parent that is not there.
 *
 *   transfer TO (parent -> child).  Every SO/PO/DO/GR line carries AutoCount's
 *   own counter of how much of it was transferred away.  Does that counter
 *   equal what the children actually took?  A parent that says 5 transferred
 *   while its children total 2 is the failure mode this repo has already paid
 *   for: readConvertSourceKeys resolved line IDENTITY only, so
 *   AddPartialTransferDetail moved the whole outstanding quantity —
 *   "出 5 件里的 2 件，AutoCount 那边开了 5 件".
 *
 * Read-only.  SELECTs only against the ERP, and the AutoCount side does not
 * come from here at all: the book is reachable only over ZeroTier from the
 * office network, which a GitHub-hosted runner has no route to.  It comes from
 * the committed snapshot data/ac-convert-edges.json.gz, refreshed by running
 * export-ac-convert-edges.mjs on a machine on that network.
 *
 * EXIT CODES.  0 for every legitimate answer — including "there are 91
 * asymmetries", because the ANSWER is the output and a red job reads as "the
 * check broke".  Non-zero only when the check cannot be TRUSTED: an
 * unreachable database, a missing or stale snapshot, a self-test that fails, or
 * an ERP schema that no longer carries the columns the edges are defined on.
 *
 * ── THE FOUR TRAPS THIS CHECKER ENCODES, each measured on the live book ────
 *
 * TRAP 1 — SO->PO IS NOT RECORDED LIKE THE OTHERS.  AutoCount stores it as
 * `PODTL.FromSODtlKey` + `FromDocNo`, and `PODTL.FromDocType` is NULL on ALL
 * 10,789 real SO->PO rows — including a document the SDK created minutes
 * earlier.  Every OTHER edge (DO<-SO, IV<-DO, IV<-SO, GR<-PO, PI<-GR) does
 * carry FromDocType.  A check that tests FromDocType uniformly reports a false
 * failure on this one edge; qa-matrix.ps1's "5a link PO<-SO" did exactly that.
 * assertFromDocTypeShape() below PROVES the split from the snapshot instead of
 * trusting this comment, and REFUSES if the book ever stops behaving this way.
 *
 * TRAP 2 — SODTL HAS TWO TRANSFER COUNTERS, NOT ONE.  `TransferedQty` counts
 * DO/IV (47,750 lines > 0); `TransferedPOQty` counts PO (10,786 lines > 0).
 * Comparing PO children against TransferedQty reads the DELIVERY counter and
 * calls the difference a defect.
 *
 * TRAP 3 — `FromDocDtlKey` IS NULL ON ALL ~220,000 ROWS OF ALL SIX DETAIL
 * TABLES.  So "does the source LINE exist" is answerable ONLY for SO->PO, the
 * one edge with a real line key.  The other four edges are resolvable at
 * DOCUMENT grain, and no amount of wanting changes that.  This checker says so
 * out loud rather than quietly comparing at document grain and letting the
 * reader believe it checked lines.  It also re-measures the claim every run: if
 * FromDocDtlKey ever starts being populated, it says so.
 *
 * TRAP 4 — ITEM-CODE DRIFT IS NOT A QUANTITY ERROR.  A parent and child can
 * disagree at (document, item) grain while agreeing exactly at document grain,
 * when the child took the goods under a different item code.  Reporting only
 * the item-grain number inflates the finding.  Both grains are reported, and
 * the difference between them is named as its own class.
 *
 * Env:  DATABASE_URL (required)      COMPANY_ID (default 1, AED_HOUZS)
 *       MAX_SNAPSHOT_AGE_DAYS (default 2)
 *       SKIP_ERP=1 to answer the AutoCount half alone (no DB needed)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, "data", "ac-convert-edges.json.gz");
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const SKIP_ERP = process.env.SKIP_ERP === "1";
const SHOW = 20; // the owner asked for the first 20 offenders of each class

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m = "") => console.log(m);
const head = (m) => {
  out("");
  out("=".repeat(78));
  out(m);
  out("=".repeat(78));
};

/* Quantities are decimal(19,4) strings. Compare as scaled integers: 0.1+0.2 is
   not 0.3 in a float, and a checker that reports 1e-15 as an asymmetry is worse
   than no checker. */
const Q = (v) => Math.round(Number(v || 0) * 10000);
const fmtQ = (n) => (n / 10000).toString();

/* ══ the edge map ═══════════════════════════════════════════════════════════
 *
 * `counter` is the field on the PARENT line that AutoCount increments when a
 * transfer happens. `consumers` are the child edges that draw it down — SO's
 * delivery counter is drawn by BOTH DO and IV-direct, which is why it is a list
 * and not a single edge. */
const EDGES = [
  { id: "PO <- SO", child: "PO", parent: "SO", fromType: null, lineKeyed: true },
  { id: "DO <- SO", child: "DO", parent: "SO", fromType: "SO", lineKeyed: false },
  { id: "IV <- SO", child: "IV", parent: "SO", fromType: "SO", lineKeyed: false },
  { id: "IV <- DO", child: "IV", parent: "DO", fromType: "DO", lineKeyed: false },
  { id: "GR <- PO", child: "GR", parent: "PO", fromType: "PO", lineKeyed: false },
  { id: "PI <- GR", child: "PI", parent: "GR", fromType: "GR", lineKeyed: false },
];

const COUNTERS = [
  { id: "SO -> DO/IV", parent: "SO", counter: "transferedQty",
    consumers: [{ child: "DO", fromType: "SO" }, { child: "IV", fromType: "SO" }],
    note: "the DELIVERY counter (trap 2) - drawn by delivery orders AND invoices raised straight off the order" },
  { id: "SO -> PO", parent: "SO", counter: "transferedPoQty",
    consumers: [{ child: "PO", fromType: null }], lineKeyed: true,
    note: "the PURCHASE counter (trap 2) - the only LINE-KEYED edge in the book (trap 3)" },
  { id: "PO -> GR", parent: "PO", counter: "transferedQty",
    consumers: [{ child: "GR", fromType: "PO" }] },
  { id: "DO -> IV", parent: "DO", counter: "transferedQty",
    consumers: [{ child: "IV", fromType: "DO" }] },
  { id: "GR -> PI", parent: "GR", counter: "transferedQty",
    consumers: [{ child: "PI", fromType: "GR" }] },
];

/* ══ pure analysers — the same functions the self-test exercises ═════════════ */

/* A book is { TYPE: { headers: Map<docNo,{docNo,docDate,cancelled}>,
                       lines: Map<docNo,line[]>, byKey: Map<dtlKey,line> } } */
function loadBook(snap) {
  const H = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
  const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
  const book = {};
  for (const [t, payload] of Object.entries(snap.types)) {
    const headers = new Map();
    for (const r of payload.headers) {
      headers.set(r[H.docNo], {
        docNo: r[H.docNo],
        docDate: r[H.docDate],
        cancelled: r[H.cancelled] === "T",
      });
    }
    const lines = new Map();
    const byKey = new Map();
    for (const r of payload.lines) {
      const l = {
        docNo: r[L.docNo], dtlKey: r[L.dtlKey], seq: Number(r[L.seq]), itemKey: r[L.itemKey],
        qty: Q(r[L.qty]),
        transferedQty: r[L.transferedQty] === "" ? null : Q(r[L.transferedQty]),
        transferedPoQty: r[L.transferedPoQty] === "" ? null : Q(r[L.transferedPoQty]),
        transferable: r[L.transferable],
        fromDocType: r[L.fromDocType], fromDocNo: r[L.fromDocNo],
        fromDocDtlKey: r[L.fromDocDtlKey], fromSoDtlKey: r[L.fromSoDtlKey],
      };
      if (!lines.has(l.docNo)) lines.set(l.docNo, []);
      lines.get(l.docNo).push(l);
      byKey.set(l.dtlKey, l);
    }
    book[t] = { headers, lines, byKey };
  }
  return book;
}

const allLines = (book, t) => [...book[t].lines.values()].flat();

/* Every child line of this edge that actually names a source. For SO->PO the
   selector is FromSODtlKey (trap 1: FromDocType is NULL on that edge). */
function childrenOf(book, edge) {
  return allLines(book, edge.child).filter((l) =>
    edge.lineKeyed ? !!l.fromSoDtlKey : l.fromDocType === edge.fromType && !!l.fromDocNo,
  );
}

/* transfer FROM: a child naming a parent that is not there. */
function orphans(book, edge) {
  const docMissing = [];
  const lineMissing = [];
  for (const l of childrenOf(book, edge)) {
    if (edge.lineKeyed) {
      if (!book[edge.parent].byKey.has(l.fromSoDtlKey)) lineMissing.push(l);
      if (l.fromDocNo && !book[edge.parent].headers.has(l.fromDocNo)) docMissing.push(l);
    } else if (!book[edge.parent].headers.has(l.fromDocNo)) {
      docMissing.push(l);
    }
  }
  return { docMissing, lineMissing };
}

/* validity: a live child hanging off a CANCELLED parent. */
function cancelledParentLiveChild(book, edge) {
  const bad = [];
  for (const l of childrenOf(book, edge)) {
    const childHdr = book[edge.child].headers.get(l.docNo);
    if (!childHdr || childHdr.cancelled) continue;
    const pNo = edge.lineKeyed
      ? book[edge.parent].byKey.get(l.fromSoDtlKey)?.docNo ?? l.fromDocNo
      : l.fromDocNo;
    const p = book[edge.parent].headers.get(pNo);
    if (p && p.cancelled) bad.push({ ...l, parentDocNo: pNo });
  }
  return bad;
}

/* transfer TO, LINE grain. Only possible where a real line key exists. */
function counterVsChildrenByLine(book, spec) {
  const took = new Map();
  for (const c of spec.consumers) {
    for (const l of allLines(book, c.child)) {
      if (!l.fromSoDtlKey) continue;
      const kid = book[c.child].headers.get(l.docNo);
      if (kid?.cancelled) continue;
      took.set(l.fromSoDtlKey, (took.get(l.fromSoDtlKey) || 0) + l.qty);
    }
  }
  const rows = [];
  for (const l of allLines(book, spec.parent)) {
    const h = book[spec.parent].headers.get(l.docNo);
    if (h?.cancelled) continue;
    const claimed = l[spec.counter];
    if (claimed == null) continue;
    const t = took.get(l.dtlKey) || 0;
    if (claimed !== t) rows.push({ docNo: l.docNo, key: l.dtlKey, itemKey: l.itemKey, claimed, took: t });
  }
  return rows;
}

/* transfer TO, at a chosen grain. `keyOf` decides doc grain vs (doc,item) grain.
   Cancelled children are excluded and cancelled parents are not asked about —
   a cancelled document is not a broken link, it is a document nobody expects to
   have moved anything. */
function counterVsChildren(book, spec, keyOf) {
  const claim = new Map();
  const meta = new Map();
  for (const l of allLines(book, spec.parent)) {
    const h = book[spec.parent].headers.get(l.docNo);
    if (h?.cancelled) continue;
    if (l[spec.counter] == null) continue;
    const k = keyOf(l);
    claim.set(k, (claim.get(k) || 0) + l[spec.counter]);
    if (!meta.has(k)) meta.set(k, { docNo: l.docNo, itemKey: l.itemKey, docDate: h?.docDate ?? "" });
  }
  const took = new Map();
  for (const c of spec.consumers) {
    for (const l of allLines(book, c.child)) {
      const names = c.fromType === null ? !!l.fromSoDtlKey : l.fromDocType === c.fromType && !!l.fromDocNo;
      if (!names) continue;
      const kid = book[c.child].headers.get(l.docNo);
      if (kid?.cancelled) continue;
      /* For the line-keyed edge the parent DOC comes from the key, not from
         FromDocNo, so a stamped-but-wrong FromDocNo cannot move the total. */
      const pDoc = c.fromType === null
        ? book[spec.parent].byKey.get(l.fromSoDtlKey)?.docNo
        : l.fromDocNo;
      if (pDoc == null) continue;
      const pLine = c.fromType === null ? book[spec.parent].byKey.get(l.fromSoDtlKey) : null;
      const k = keyOf({ docNo: pDoc, itemKey: pLine ? pLine.itemKey : l.itemKey });
      took.set(k, (took.get(k) || 0) + l.qty);
    }
  }
  const rows = [];
  for (const [k, c] of claim) {
    const t = took.get(k) || 0;
    if (c !== t) rows.push({ ...meta.get(k), claimed: c, took: t, noChildAtAll: !took.has(k) && c > 0 });
  }
  return rows;
}

/* Trap 1, PROVED rather than asserted: FromDocType is stamped on every edge
   except SO->PO. If the book ever changes, the checker must not keep quietly
   applying a rule that no longer holds. */
function assertFromDocTypeShape(book) {
  const poNamed = allLines(book, "PO").filter((l) => !!l.fromSoDtlKey);
  const poTyped = poNamed.filter((l) => l.fromDocType !== "");
  const others = [];
  for (const e of EDGES.filter((x) => !x.lineKeyed)) {
    const named = allLines(book, e.child).filter((l) => !!l.fromDocNo);
    const typed = named.filter((l) => l.fromDocType !== "");
    others.push({ edge: e.id, named: named.length, typed: typed.length });
  }
  return { poNamed: poNamed.length, poTyped: poTyped.length, others };
}

/* Trap 3, re-measured every run. */
function fromDocDtlKeyPopulation(book) {
  const per = {};
  let total = 0;
  for (const t of Object.keys(book)) {
    const n = allLines(book, t).filter((l) => !!l.fromDocDtlKey).length;
    per[t] = n;
    total += n;
  }
  return { per, total };
}

/* ══ self-test: a checker that cannot match must REFUSE ═════════════════════
 *
 * A synthetic mini-book with FOUR planted defects and one deliberate
 * NON-defect. Every analyser must find exactly its own plant and nothing else.
 * This runs against the same functions the real check calls — a self-test that
 * exercised a copy would prove nothing. */
function runSelfTest() {
  const fail = [];
  const snap = {
    header_fields: ["docNo", "docDate", "cancelled"],
    line_fields: ["docNo", "dtlKey", "seq", "itemKey", "qty", "transferedQty",
      "transferedPoQty", "transferable", "fromDocType", "fromDocNo", "fromDocDtlKey", "fromSoDtlKey"],
    types: {
      SO: {
        headers: [["SO-1", "2026-01-01", "F"], ["SO-9", "2026-01-01", "T"]],
        lines: [
          // claims 5 delivered; the DO below takes 2  -> ONE over-claim
          ["SO-1", "100", "1", "ITEM-A", "5.0000", "5.0000", "0.0000", "T", "", "", "", ""],
          // claims 3 purchased; the PO below takes 3   -> clean, line-keyed
          ["SO-1", "101", "2", "ITEM-B", "3.0000", "0.0000", "3.0000", "T", "", "", "", ""],
          ["SO-9", "109", "1", "ITEM-C", "1.0000", "0.0000", "0.0000", "T", "", "", "", ""],
        ],
      },
      PO: {
        headers: [["PO-1", "2026-01-02", "F"]],
        lines: [
          // real SO->PO shape: FromDocType EMPTY, FromSODtlKey set (trap 1)
          ["PO-1", "200", "1", "ITEM-B", "3.0000", "0.0000", "", "T", "", "SO-1", "", "101"],
          // ORPHAN: names a source line that does not exist
          ["PO-1", "201", "2", "ITEM-Z", "1.0000", "0.0000", "", "T", "", "SO-404", "", "999"],
        ],
      },
      DO: {
        headers: [["DO-1", "2026-01-03", "F"]],
        lines: [["DO-1", "300", "1", "ITEM-A", "2.0000", "0.0000", "", "T", "SO", "SO-1", "", ""]],
      },
      IV: {
        headers: [["IV-1", "2026-01-04", "F"]],
        // ORPHAN at document grain: DO-404 does not exist
        lines: [["IV-1", "400", "1", "ITEM-A", "2.0000", "", "", "T", "DO", "DO-404", "", ""]],
      },
      GR: {
        headers: [["GR-1", "2026-01-05", "F"]],
        // live child of a CANCELLED parent
        lines: [["GR-1", "500", "1", "ITEM-C", "1.0000", "0.0000", "", "T", "PO", "PO-9", "", ""]],
      },
      PI: { headers: [], lines: [] },
    },
  };
  snap.types.PO.headers.push(["PO-9", "2026-01-02", "T"]);
  const b = loadBook(snap);

  const orphPo = orphans(b, EDGES.find((e) => e.id === "PO <- SO"));
  if (orphPo.lineMissing.length !== 1 || orphPo.lineMissing[0].dtlKey !== "201") {
    fail.push(`SO->PO orphan matcher found ${orphPo.lineMissing.length}, expected the 1 planted (DtlKey 201)`);
  }
  const orphIv = orphans(b, EDGES.find((e) => e.id === "IV <- DO"));
  if (orphIv.docMissing.length !== 1) {
    fail.push(`IV<-DO orphan matcher found ${orphIv.docMissing.length}, expected the 1 planted`);
  }
  const orphDo = orphans(b, EDGES.find((e) => e.id === "DO <- SO"));
  if (orphDo.docMissing.length !== 0) fail.push("DO<-SO reported an orphan on a clean edge");

  const cp = cancelledParentLiveChild(b, EDGES.find((e) => e.id === "GR <- PO"));
  if (cp.length !== 1) fail.push(`cancelled-parent matcher found ${cp.length}, expected the 1 planted`);

  const dv = counterVsChildren(b, COUNTERS.find((c) => c.id === "SO -> DO/IV"), (l) => l.docNo);
  if (dv.length !== 1 || dv[0].claimed !== Q(5) || dv[0].took !== Q(2)) {
    fail.push(`SO delivery counter: expected one 5-vs-2 over-claim, got ${JSON.stringify(dv)}`);
  }
  const pv = counterVsChildrenByLine(b, COUNTERS.find((c) => c.id === "SO -> PO"));
  if (pv.length !== 0) {
    fail.push(`SO purchase counter reported ${pv.length} on a line that balances exactly: ${JSON.stringify(pv)}`);
  }

  const shape = assertFromDocTypeShape(b);
  if (shape.poTyped !== 0) fail.push("trap-1 prover did not see the empty FromDocType on the SO->PO edge");
  if (!shape.others.every((o) => o.typed === o.named)) {
    fail.push("trap-1 prover did not see FromDocType stamped on the non-SO->PO edges");
  }

  /* A counter that balances must NEVER be reported. This is the assertion that
     stops a matcher which "finds" everything from passing as a clean run. */
  const clean = counterVsChildren(b, COUNTERS.find((c) => c.id === "DO -> IV"), (l) => l.docNo);
  if (clean.some((r) => r.docNo === "DO-1" && r.claimed === 0 && r.took === 0)) {
    fail.push("a balanced 0-vs-0 line was reported as an asymmetry");
  }
  return fail;
}

/* ══ run ════════════════════════════════════════════════════════════════════ */

const selfTestFailures = runSelfTest();
if (selfTestFailures.length) {
  console.error("REFUSED: the symmetry matchers do not match. Reporting a clean run would be a verdict");
  console.error("computed by code that cannot see the defect it exists to find.");
  for (const f of selfTestFailures) console.error(`  - ${f}`);
  process.exit(2);
}
out("self-test: every planted asymmetry found, and the balanced lines left alone. Proceeding.");

if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is missing. Run export-ac-convert-edges.mjs against the book first.`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
out(`AutoCount snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)`);
out(`source=${snap.source}`);
out(`book rows: ${JSON.stringify(snap.counts)}`);
if (!(ageDays <= MAX_AGE_DAYS)) {
  console.error(
    `REFUSED: the snapshot is ${ageDays.toFixed(1)} days old (limit ${MAX_AGE_DAYS}). Re-run ` +
      "export-ac-convert-edges.mjs. The file mtime is a checkout artifact and is deliberately not consulted.",
  );
  process.exit(2);
}
const book = loadBook(snap);

/* ── trap 1 and trap 3, proved from this snapshot ─────────────────────────── */
head("0.  HOW THIS BOOK RECORDS A CONVERSION  (proved from the snapshot, not assumed)");
const shape = assertFromDocTypeShape(book);
out(`SO -> PO edge : ${shape.poNamed} lines name a source line (FromSODtlKey);`);
out(`                ${shape.poTyped} of them also carry FromDocType.`);
for (const o of shape.others) out(`${o.edge.padEnd(14)}: ${o.named} lines name a source; ${o.typed} carry FromDocType.`);
if (shape.poNamed > 0 && shape.poTyped === 0) {
  log(
    "CONFIRMED: SO->PO is the ONE edge AutoCount does not stamp with FromDocType. A check that " +
      "tests FromDocType uniformly reports a FALSE failure here (qa-matrix.ps1 ' 5a link PO<-SO' did).",
  );
} else if (shape.poTyped > 0) {
  log(
    `CHANGED: ${shape.poTyped} of ${shape.poNamed} SO->PO lines now carry FromDocType. The book no longer ` +
      "behaves as measured on 2026-09-07 - re-read this edge before trusting any FromDocType rule.",
  );
}
const fdk = fromDocDtlKeyPopulation(book);
out("");
out(`FromDocDtlKey populated on ${fdk.total} of ${Object.values(snap.counts).reduce((a, c) => a + c.lines, 0)} lines ` +
  `${JSON.stringify(fdk.per)}`);
if (fdk.total === 0) {
  log(
    "CONSEQUENCE (trap 3): AutoCount records the SOURCE LINE for SO->PO only. For DO<-SO, IV<-DO, " +
      "IV<-SO, GR<-PO and PI<-GR the book stores a document number and nothing finer, so those five " +
      "edges are checked at DOCUMENT grain and at (document, item) grain. That is a limit of the book, " +
      "not of this check.",
  );
} else {
  log(`FromDocDtlKey has started being populated (${fdk.total} rows) - line-grain checks are now possible on more edges.`);
}

/* ── direction 1: transfer FROM ───────────────────────────────────────────── */
head("1.  TRANSFER FROM  (child -> parent):  does the source a child names exist?");
const fromRows = [];
for (const e of EDGES) {
  const kids = childrenOf(book, e);
  const o = orphans(book, e);
  fromRows.push({ edge: e.id, named: kids.length, docMissing: o.docMissing.length, lineMissing: o.lineMissing.length });
  out(
    `${e.id.padEnd(10)} ${String(kids.length).padStart(6)} children name a source | ` +
      `${String(o.docMissing.length).padStart(3)} parent DOC missing | ` +
      `${e.lineKeyed ? String(o.lineMissing.length).padStart(3) + " parent LINE missing" : "  - no line key in the book (trap 3)"}`,
  );
  /* A line-keyed orphan usually fails BOTH ways (no parent doc, no parent
     line); print each offending line once. */
  const shown = [...new Map([...o.docMissing, ...o.lineMissing].map((l) => [l.dtlKey, l])).values()].slice(0, SHOW);
  for (const l of shown) {
    const h = book[e.child].headers.get(l.docNo);
    out(
      `      ORPHAN ${l.docNo} (${h?.cancelled ? "CANCELLED" : "live"}) line ${l.dtlKey} ${l.itemKey} ` +
        `qty ${fmtQ(l.qty)} -> ${l.fromDocNo || "(no doc)"}${l.fromSoDtlKey ? ` line ${l.fromSoDtlKey}` : ""}`,
    );
  }
}
const totalOrphans = fromRows.reduce((a, r) => a + Math.max(r.docMissing, r.lineMissing), 0);
log(`transfer FROM: ${totalOrphans} orphan child line(s) across all six edges.`);

/* ── validity ─────────────────────────────────────────────────────────────── */
head("2.  VALIDITY:  a LIVE child hanging off a CANCELLED parent");
let cancelledTotal = 0;
for (const e of EDGES) {
  const bad = cancelledParentLiveChild(book, e);
  cancelledTotal += bad.length;
  out(`${e.id.padEnd(10)} ${String(bad.length).padStart(4)}`);
  for (const l of bad.slice(0, SHOW)) out(`      ${l.docNo} line ${l.dtlKey} ${l.itemKey} -> CANCELLED ${l.parentDocNo}`);
}
log(`validity: ${cancelledTotal} live child line(s) whose parent is cancelled.`);

/* ── direction 2: transfer TO ─────────────────────────────────────────────── */
head("3.  TRANSFER TO  (parent -> child):  does the parent's own counter equal what the children took?");
const toSummary = [];
for (const spec of COUNTERS) {
  out("");
  out(`--- ${spec.id}   (parent counter: ${spec.parent}DTL.${spec.counter})`);
  if (spec.note) out(`    ${spec.note}`);

  if (spec.lineKeyed) {
    const rows = counterVsChildrenByLine(book, spec);
    const parentLines = allLines(book, spec.parent).filter(
      (l) => !book[spec.parent].headers.get(l.docNo)?.cancelled && l[spec.counter] != null,
    );
    const claiming = parentLines.filter((l) => l[spec.counter] > 0).length;
    out(`    LINE grain: ${parentLines.length} live parent lines, ${claiming} claiming a transfer, ${rows.length} DISAGREE`);
    for (const r of rows.slice(0, SHOW)) {
      out(`      ${r.docNo} line ${r.key} ${r.itemKey}: parent says ${fmtQ(r.claimed)}, children took ${fmtQ(r.took)}`);
    }
    toSummary.push({ id: spec.id, grain: "line", groups: parentLines.length, mismatch: rows.length,
      over: rows.filter((r) => r.claimed > r.took).length, under: rows.filter((r) => r.claimed < r.took).length,
      noChild: rows.filter((r) => r.took === 0 && r.claimed > 0).length });
    continue;
  }

  const byDoc = counterVsChildren(book, spec, (l) => l.docNo);
  const byItem = counterVsChildren(book, spec, (l) => `${l.docNo}${l.itemKey}`);
  const docGroups = new Set(
    allLines(book, spec.parent)
      .filter((l) => !book[spec.parent].headers.get(l.docNo)?.cancelled && l[spec.counter] != null)
      .map((l) => l.docNo),
  ).size;
  const over = byDoc.filter((r) => r.claimed > r.took);
  const under = byDoc.filter((r) => r.claimed < r.took);
  const noChild = byDoc.filter((r) => r.noChildAtAll);
  const itemDocs = new Set(byItem.map((r) => r.docNo));
  /* Trap 4: a document that disagrees per item but balances per document had
     the goods taken under a DIFFERENT item code. Not a quantity error. */
  const driftOnly = [...itemDocs].filter((d) => !byDoc.some((r) => r.docNo === d));

  out(`    DOC  grain: ${docGroups} live parent documents, ${byDoc.length} DISAGREE ` +
    `(${over.length} parent claims MORE, ${under.length} children took MORE, ` +
    `${noChild.length} claim a transfer with NO child document at all)`);
  out(`    ITEM grain: ${byItem.length} (document, item) groups disagree across ${itemDocs.size} documents`);
  out(`    of those, ${driftOnly.length} document(s) balance exactly at document grain -> item-code drift, NOT a quantity error (trap 4)`);
  const shortfall = over.reduce((a, r) => a + (r.claimed - r.took), 0);
  if (over.length) out(`    total quantity claimed but not accounted for: ${fmtQ(shortfall)}`);
  /* WHEN these happened decides what to do about them. A 2023 document whose
     delivery note was deleted years ago is history the cutover inherits; one
     dated this month would mean the CURRENT write path is producing them. */
  const recent = byDoc.filter((r) => r.docDate >= "2026-01-01");
  const thisMonth = byDoc.filter((r) => r.docDate >= "2026-08-01");
  out(`    WHEN: ${byDoc.length - recent.length} dated before 2026 | ${recent.length - thisMonth.length} earlier in 2026 | ${thisMonth.length} since 2026-08-01`);
  for (const r of byDoc.slice(0, SHOW)) {
    out(`      ${r.docNo} (${r.docDate}): parent says ${fmtQ(r.claimed)}, children took ${fmtQ(r.took)}` +
      `${r.noChildAtAll ? "  <- NO child document exists" : ""}`);
  }
  toSummary.push({ id: spec.id, grain: "doc", groups: docGroups, mismatch: byDoc.length,
    over: over.length, under: under.length, noChild: noChild.length,
    itemGroups: byItem.length, itemDocs: itemDocs.size, driftOnly: driftOnly.length,
    shortfall });
}

/* ── the ERP side ─────────────────────────────────────────────────────────── */
head("4.  THE SAME TWO QUESTIONS INSIDE THE ERP");
if (SKIP_ERP) {
  out("SKIP_ERP=1 - the ERP half was not measured.");
} else {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("REFUSED: DATABASE_URL not set and SKIP_ERP is not 1.");
    process.exit(2);
  }
  const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    /* The ERP's conversion edges are real FOREIGN KEYS, all line-level. Prove
       the columns are there before measuring: a check whose anti-join silently
       matches nothing because a column was renamed reports a clean run. */
    const cols = await pg`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='scm' AND (table_name, column_name) IN (
         ('purchase_order_items','so_item_id'), ('delivery_order_items','so_item_id'),
         ('sales_invoice_items','so_item_id'), ('grn_items','purchase_order_item_id'),
         ('purchase_invoice_items','grn_item_id'),
         ('mfg_sales_order_items','po_qty_picked'), ('purchase_order_items','received_qty'))`;
    const have = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
    const need = ["purchase_order_items.so_item_id", "delivery_order_items.so_item_id",
      "sales_invoice_items.so_item_id", "grn_items.purchase_order_item_id",
      "purchase_invoice_items.grn_item_id", "mfg_sales_order_items.po_qty_picked",
      "purchase_order_items.received_qty"];
    const missing = need.filter((n) => !have.has(n));
    if (missing.length) {
      console.error(`REFUSED: the ERP no longer carries ${missing.join(", ")}. The edges this check is `
        + "defined on have moved; an anti-join against a column that is not there matches nothing and "
        + "would report a clean run.");
      await pg.end({ timeout: 5 });
      process.exit(2);
    }
    out(`ERP conversion columns present: ${need.length}/${need.length}. Company ${CO}.`);

    out("");
    out("4a. TRANSFER FROM inside the ERP - a child line pointing at a parent line that is not there");
    const erpOrphans = await pg`
      SELECT 'PO line -> SO line' AS edge, count(*) FILTER (WHERE i.so_item_id IS NOT NULL) AS named,
             count(*) FILTER (WHERE i.so_item_id IS NOT NULL AND s.id IS NULL) AS orphan,
             count(*) FILTER (WHERE i.so_item_id IS NULL) AS unlinked
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders h ON h.id = i.purchase_order_id AND h.company_id = ${CO}
        LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
      UNION ALL
      SELECT 'DO line -> SO line', count(*) FILTER (WHERE i.so_item_id IS NOT NULL),
             count(*) FILTER (WHERE i.so_item_id IS NOT NULL AND s.id IS NULL),
             count(*) FILTER (WHERE i.so_item_id IS NULL)
        FROM scm.delivery_order_items i
        JOIN scm.delivery_orders h ON h.id = i.delivery_order_id AND h.company_id = ${CO}
        LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
      UNION ALL
      SELECT 'SI line -> SO line', count(*) FILTER (WHERE i.so_item_id IS NOT NULL),
             count(*) FILTER (WHERE i.so_item_id IS NOT NULL AND s.id IS NULL),
             count(*) FILTER (WHERE i.so_item_id IS NULL)
        FROM scm.sales_invoice_items i
        JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id AND h.company_id = ${CO}
        LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
      UNION ALL
      SELECT 'GRN line -> PO line', count(*) FILTER (WHERE i.purchase_order_item_id IS NOT NULL),
             count(*) FILTER (WHERE i.purchase_order_item_id IS NOT NULL AND p.id IS NULL),
             count(*) FILTER (WHERE i.purchase_order_item_id IS NULL)
        FROM scm.grn_items i
        JOIN scm.grns h ON h.id = i.grn_id AND h.company_id = ${CO}
        LEFT JOIN scm.purchase_order_items p ON p.id = i.purchase_order_item_id
      UNION ALL
      SELECT 'PI line -> GRN line', count(*) FILTER (WHERE i.grn_item_id IS NOT NULL),
             count(*) FILTER (WHERE i.grn_item_id IS NOT NULL AND g.id IS NULL),
             count(*) FILTER (WHERE i.grn_item_id IS NULL)
        FROM scm.purchase_invoice_items i
        JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id AND h.company_id = ${CO}
        LEFT JOIN scm.grn_items g ON g.id = i.grn_item_id`;
    for (const r of erpOrphans) {
      out(`    ${String(r.edge).padEnd(20)} ${String(r.named).padStart(6)} linked | ${String(r.orphan).padStart(4)} ORPHAN | ${String(r.unlinked).padStart(6)} carry no parent link at all`);
    }
    log(`ERP transfer FROM: ${erpOrphans.reduce((a, r) => a + Number(r.orphan), 0)} orphan child line(s).`);

    out("");
    out("4b. TRANSFER TO inside the ERP - the two denormalised counters that gate the convert");
    out("    (SO->PO ceiling is qty - po_qty_picked; PO->GRN ceiling is qty - received_qty.");
    out("     Drift in either weakens the guard that stops an over-convert.)");
    /* COUNT and EXAMPLES are two queries on purpose. A single LIMITed SELECT
       counted in JS reports the LIMIT as the answer the moment the real number
       exceeds it — this said exactly "500 of 14492" on its first run against
       production, which is the limit, not a measurement. */
    const pickedAgg = await pg`
      WITH j AS (
        SELECT s.id, o.doc_no, s.po_qty_picked AS claimed, COALESCE(k.took,0) AS took
          FROM scm.mfg_sales_order_items s
          JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
          LEFT JOIN (SELECT i.so_item_id, sum(i.qty) AS took
                       FROM scm.purchase_order_items i
                       JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
                      WHERE i.so_item_id IS NOT NULL AND h.status <> 'CANCELLED'
                      GROUP BY i.so_item_id) k ON k.so_item_id = s.id
         WHERE o.status <> 'CANCELLED')
      SELECT count(*)::int AS lines,
             count(*) FILTER (WHERE claimed <> took)::int AS differ,
             count(*) FILTER (WHERE claimed < took)::int  AS reads_low,
             count(*) FILTER (WHERE claimed > took)::int  AS reads_high,
             count(*) FILTER (WHERE claimed <> took AND doc_no LIKE 'HC-%')::int AS migrated
        FROM j`;
    const pa = pickedAgg[0];
    const picked = await pg`
      SELECT o.doc_no, s.item_code, s.po_qty_picked AS claimed, COALESCE(k.took,0) AS took
        FROM scm.mfg_sales_order_items s
        JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
        LEFT JOIN (SELECT i.so_item_id, sum(i.qty) AS took
                     FROM scm.purchase_order_items i
                     JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
                    WHERE i.so_item_id IS NOT NULL AND h.status <> 'CANCELLED'
                    GROUP BY i.so_item_id) k ON k.so_item_id = s.id
       WHERE o.status <> 'CANCELLED' AND s.po_qty_picked <> COALESCE(k.took,0)
       ORDER BY o.doc_no LIMIT ${SHOW}`;
    out(`    SO line po_qty_picked vs its PO children : ${pa.differ} of ${pa.lines} live SO lines DISAGREE`);
    /* DIRECTION decides the risk, and it is the opposite of the intuition.
       The SO->PO ceiling is qty - po_qty_picked, so a counter that reads LOW
       makes the ceiling too GENEROUS: the guard would let someone raise a
       second purchase order for goods already bought. A counter that reads
       HIGH only blocks a legitimate purchase, which staff notice immediately.
       Migrated orders are split out because the importer writing PO lines
       without bumping the counter is a different defect from the live write
       path drifting. */
    out(`      ${pa.reads_low} read LOW (ceiling too generous - an over-convert could get through)`);
    out(`      ${pa.reads_high} read HIGH (ceiling too tight - blocks a legitimate purchase)`);
    out(`      ${pa.migrated} of the ${pa.differ} sit on a MIGRATED order (HC-*); ${pa.differ - pa.migrated} on an ERP-native one`);
    for (const r of picked) {
      out(`      ${r.doc_no} ${r.item_code}: ERP says picked ${r.claimed}, PO lines total ${r.took}`);
    }

    /* qty_received or qty_accepted? Measure BOTH and let the book say which
       convention received_qty actually follows, rather than guessing. */
    const recv = await pg`
      SELECT count(*)::int AS lines,
             count(*) FILTER (WHERE p.received_qty <> COALESCE(g.recv,0))::int AS differs_received,
             count(*) FILTER (WHERE p.received_qty <> COALESCE(g.acc,0))::int  AS differs_accepted
        FROM scm.purchase_order_items p
        JOIN scm.purchase_orders h ON h.id = p.purchase_order_id AND h.company_id = ${CO}
        LEFT JOIN (SELECT i.purchase_order_item_id AS k, sum(i.qty_received) AS recv, sum(i.qty_accepted) AS acc
                     FROM scm.grn_items i JOIN scm.grns gh ON gh.id = i.grn_id
                    WHERE i.purchase_order_item_id IS NOT NULL AND gh.status <> 'CANCELLED'
                    GROUP BY i.purchase_order_item_id) g ON g.k = p.id
       WHERE h.status <> 'CANCELLED'`;
    const rv = recv[0];
    const conv = rv.differs_received <= rv.differs_accepted ? "qty_received" : "qty_accepted";
    const differs = Math.min(rv.differs_received, rv.differs_accepted);
    out(`    PO line received_qty vs its GRN children: ${differs} of ${rv.lines} live PO lines DISAGREE ` +
      `(measured against ${conv}; the other convention differs on ${Math.max(rv.differs_received, rv.differs_accepted)})`);
    const recvEx = await pg`
      SELECT h.po_number, p.item_code, p.received_qty AS claimed, COALESCE(g.recv,0) AS took
        FROM scm.purchase_order_items p
        JOIN scm.purchase_orders h ON h.id = p.purchase_order_id AND h.company_id = ${CO}
        LEFT JOIN (SELECT i.purchase_order_item_id AS k, sum(i.qty_received) AS recv
                     FROM scm.grn_items i JOIN scm.grns gh ON gh.id = i.grn_id
                    WHERE i.purchase_order_item_id IS NOT NULL AND gh.status <> 'CANCELLED'
                    GROUP BY i.purchase_order_item_id) g ON g.k = p.id
       WHERE h.status <> 'CANCELLED' AND p.received_qty <> COALESCE(g.recv,0)
       ORDER BY h.po_number LIMIT ${SHOW}`;
    for (const r of recvEx) out(`      ${r.po_number} ${r.item_code}: ERP says received ${r.claimed}, GRN lines total ${r.took}`);

    out("");
    out("4c. VALIDITY inside the ERP - a live child line whose parent document is cancelled");
    const erpCancel = await pg`
      SELECT 'PO line under cancelled SO' AS cls, count(*)::int AS n
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders h ON h.id = i.purchase_order_id AND h.company_id = ${CO} AND h.status <> 'CANCELLED'
        JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
        JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.status = 'CANCELLED'
      UNION ALL
      SELECT 'DO line under cancelled SO', count(*)::int
        FROM scm.delivery_order_items i
        JOIN scm.delivery_orders h ON h.id = i.delivery_order_id AND h.company_id = ${CO} AND h.status <> 'CANCELLED'
        JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
        JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.status = 'CANCELLED'
      UNION ALL
      SELECT 'GRN line under cancelled PO', count(*)::int
        FROM scm.grn_items i
        JOIN scm.grns h ON h.id = i.grn_id AND h.company_id = ${CO} AND h.status <> 'CANCELLED'
        JOIN scm.purchase_order_items p ON p.id = i.purchase_order_item_id
        JOIN scm.purchase_orders po ON po.id = p.purchase_order_id AND po.status = 'CANCELLED'`;
    for (const r of erpCancel) out(`    ${String(r.cls).padEnd(30)} ${String(r.n).padStart(5)}`);

    out("");
    out("4d. DOES THE ERP MIRROR THE BOOK'S EDGES?  (the linked_ac_docno trap)");
    out("    scm.grns.linked_ac_docno holds the PO number, NOT the GR number - the AC GR numbers live");
    out("    on purchase_orders.linked_ac_grn_docnos. Matching GRNs the other way reported all 216 as");
    out("    missing once (check-ac-erp-doc-links.mjs:104). Resolved through the stamped array here.");
    const erpDocs = await pg`
      SELECT 'SO' AS t, count(*)::int AS n FROM scm.mfg_sales_orders WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL
      UNION ALL SELECT 'PO', count(*)::int FROM scm.purchase_orders WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL
      UNION ALL SELECT 'DO', count(*)::int FROM scm.delivery_orders WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL
      UNION ALL SELECT 'PI', count(*)::int FROM scm.purchase_invoices WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`;
    const grStamps = await pg`
      SELECT linked_ac_grn_docnos FROM scm.purchase_orders
       WHERE company_id=${CO} AND linked_ac_grn_docnos IS NOT NULL`;
    const erpGr = new Set();
    for (const r of grStamps) for (const g of r.linked_ac_grn_docnos ?? []) erpGr.add(String(g).trim());
    for (const r of erpDocs) out(`    ERP carries ${String(r.n).padStart(6)} ${r.t} documents stamped with an AutoCount number`);
    out(`    ERP carries ${String(erpGr.size).padStart(6)} GR documents (resolved through purchase_orders.linked_ac_grn_docnos, not grns.linked_ac_docno)`);

    /* The asymmetric documents that matter most: the book's over-claiming
       parents. Are they in the ERP, or only in AutoCount? */
    const overDocs = [];
    for (const spec of COUNTERS.filter((c) => !c.lineKeyed)) {
      for (const r of counterVsChildren(book, spec, (l) => l.docNo)) {
        if (r.claimed > r.took) overDocs.push({ type: spec.parent, docNo: r.docNo, claimed: r.claimed, took: r.took });
      }
    }
    const bySo = overDocs.filter((d) => d.type === "SO").map((d) => d.docNo);
    const byPo = overDocs.filter((d) => d.type === "PO").map((d) => d.docNo);
    const byDo = overDocs.filter((d) => d.type === "DO").map((d) => d.docNo);
    const inErpSo = bySo.length
      ? (await pg`SELECT linked_ac_docno FROM scm.mfg_sales_orders WHERE company_id=${CO} AND linked_ac_docno = ANY(${bySo})`).length : 0;
    const inErpPo = byPo.length
      ? (await pg`SELECT linked_ac_docno FROM scm.purchase_orders WHERE company_id=${CO} AND linked_ac_docno = ANY(${byPo})`).length : 0;
    const inErpDo = byDo.length
      ? (await pg`SELECT linked_ac_docno FROM scm.delivery_orders WHERE company_id=${CO} AND linked_ac_docno = ANY(${byDo})`).length : 0;
    out("");
    out("    Of the book's over-claiming parents, how many did the ERP import?");
    out(`      SO: ${bySo.length} in AutoCount, ${inErpSo} of them also in the ERP (${bySo.length - inErpSo} AutoCount-only)`);
    out(`      PO: ${byPo.length} in AutoCount, ${inErpPo} of them also in the ERP (${byPo.length - inErpPo} AutoCount-only)`);
    out(`      DO: ${byDo.length} in AutoCount, ${inErpDo} of them also in the ERP (${byDo.length - inErpDo} AutoCount-only)`);
    log(`over-claiming parents that the ERP also carries: SO ${inErpSo}, PO ${inErpPo}, DO ${inErpDo}.`);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

/* ── verdict ──────────────────────────────────────────────────────────────── */
head("VERDICT");
out("transfer FROM (a child pointing at a parent that is not there):");
for (const r of fromRows) {
  out(`  ${r.edge.padEnd(10)} ${String(Math.max(r.docMissing, r.lineMissing)).padStart(4)} orphan(s) of ${r.named} linked child lines`);
}
out("");
out("transfer TO (a parent claiming a quantity its children do not account for):");
for (const s of toSummary) {
  out(`  ${s.id.padEnd(12)} ${String(s.mismatch).padStart(4)} of ${String(s.groups).padStart(6)} ${s.grain} groups disagree ` +
    `| ${String(s.over).padStart(4)} claim MORE | ${String(s.under).padStart(3)} claim LESS | ${String(s.noChild).padStart(4)} have NO child at all` +
    (s.driftOnly != null ? ` | +${s.driftOnly} item-code drift only` : ""));
}
out("");
log(
  `SUMMARY: ${totalOrphans} orphan child lines; ` +
    `${toSummary.reduce((a, s) => a + s.over, 0)} parent groups claim more than their children took; ` +
    `${cancelledTotal} live children under a cancelled parent.`,
);
out("");
out("Every number above is an ANSWER, not a failure. This check exits 0 unless it could not be trusted.");
