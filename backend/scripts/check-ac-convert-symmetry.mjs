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

/* PRESENCE, the third question: the book RECORDS an edge — does the ERP HOLD it?
 *
 * Returns the book's edge set at DOCUMENT grain, one entry per (child doc,
 * parent doc) pair. Deliberately a SET of document pairs and not a count of
 * lines: the ERP holds one link per LINE and decomposes a sofa into one row per
 * compartment while the book keeps it as one line (0273/0280 — one DtlKey is
 * claimed by six ERP rows). Comparing line COUNTS across the two systems would
 * report that decomposition as a missing link, which is the reading of a
 * denominator that answers a different question. A document pair either exists
 * on both sides or it does not, and that is the same fact in both systems.
 *
 * The parent document comes from the KEY on the line-keyed edge, never from
 * FromDocNo, for the reason counterVsChildren already records: a stamped-but-
 * wrong FromDocNo must not be able to invent a pair. */
function bookDocEdges(book, edge) {
  const pairs = new Map();
  for (const l of childrenOf(book, edge)) {
    const parentDocNo = edge.lineKeyed
      ? (book[edge.parent].byKey.get(l.fromSoDtlKey)?.docNo ?? l.fromDocNo)
      : l.fromDocNo;
    if (!parentDocNo) continue;
    const childHdr = book[edge.child].headers.get(l.docNo);
    const parentHdr = book[edge.parent].headers.get(parentDocNo);
    pairs.set(`${l.docNo}|${parentDocNo}`, {
      child: l.docNo,
      parent: parentDocNo,
      /* A cancelled document on either end is not an edge anyone expects the
         ERP to have imported — the cutover took OUTSTANDING documents. Kept in
         the set and flagged, so the denominator can exclude them explicitly
         rather than by a filter nobody can see. */
      cancelled: !!childHdr?.cancelled || !!parentHdr?.cancelled,
    });
  }
  return pairs;
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

  /* PRESENCE. The planted book has two SO->PO children: DtlKey 200 resolving to
     SO-1, and the orphan 201 whose key does not resolve and which falls back to
     its FromDocNo SO-404. Two DISTINCT document pairs from two lines, and the
     pair must come from the KEY where the key resolves. */
  const be = bookDocEdges(b, EDGES.find((e) => e.id === "PO <- SO"));
  if (be.size !== 2 || !be.has("PO-1|SO-1") || !be.has("PO-1|SO-404")) {
    fail.push(`bookDocEdges(PO<-SO) built ${[...be.keys()].join(",")}, expected PO-1|SO-1 and PO-1|SO-404`);
  }
  /* DEDUPLICATION is the property that makes the document-grain comparison
     legitimate: two child LINES naming one parent document are ONE edge. Prove
     it rather than trust it — without this the sofa decomposition would read as
     a missing link on every multi-line document. */
  const dupSnap = JSON.parse(JSON.stringify(snap));
  dupSnap.types.PO.lines.push(["PO-1", "202", "3", "ITEM-B", "1.0000", "0.0000", "", "T", "", "SO-1", "", "101"]);
  const beDup = bookDocEdges(loadBook(dupSnap), EDGES.find((e) => e.id === "PO <- SO"));
  if (beDup.size !== 2) {
    fail.push(`bookDocEdges counted a second line to the same parent as a second edge (${beDup.size}, expected 2)`);
  }
  /* The cancelled flag must be SET, not filtered away here: GR-1 hangs off the
     cancelled PO-9. A presence denominator that silently dropped it would hide
     the class instead of excluding it visibly. */
  const beGr = bookDocEdges(b, EDGES.find((e) => e.id === "GR <- PO"));
  if (beGr.get("GR-1|PO-9")?.cancelled !== true) {
    fail.push("bookDocEdges did not flag the edge whose parent document is cancelled");
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
         ('purchase_invoice_items','grn_item_id'), ('sales_invoice_items','do_item_id'),
         ('mfg_sales_order_items','po_qty_picked'), ('purchase_order_items','received_qty'),
         ('purchase_order_items','from_mrp'), ('grn_items','returned_qty'),
         ('grn_items','invoiced_qty'), ('grn_items','qty_accepted'))`;
    const have = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
    /* Every column any measurement below DEPENDS ON, including the three the
       write-path corrections added. from_mrp and returned_qty are not decorative:
       drop either from the query and the counter silently reverts to the naive
       rule that reported 962 and 241 false drifts. A renamed column must REFUSE,
       never quietly answer a different question. */
    const need = ["purchase_order_items.so_item_id", "delivery_order_items.so_item_id",
      "sales_invoice_items.so_item_id", "sales_invoice_items.do_item_id",
      "grn_items.purchase_order_item_id",
      "purchase_invoice_items.grn_item_id", "mfg_sales_order_items.po_qty_picked",
      "purchase_order_items.received_qty", "purchase_order_items.from_mrp",
      "grn_items.returned_qty", "grn_items.invoiced_qty", "grn_items.qty_accepted"];
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
      SELECT 'SI line -> DO line', count(*) FILTER (WHERE i.do_item_id IS NOT NULL),
             count(*) FILTER (WHERE i.do_item_id IS NOT NULL AND d.id IS NULL),
             count(*) FILTER (WHERE i.do_item_id IS NULL)
        FROM scm.sales_invoice_items i
        JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id AND h.company_id = ${CO}
        LEFT JOIN scm.delivery_order_items d ON d.id = i.do_item_id
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
    /* MEASURE THE RULE THE WRITE PATH ACTUALLY APPLIES, not a plausible one.
       This block compared po_qty_picked against a plain sum of non-cancelled PO
       lines and reported 962 of 15050 SO lines drifting, every one of them
       "reading LOW - an over-convert could get through". recomputeSoPicked
       (routes/mfg-purchase-orders.ts:2843-2887) does NOT count that population:

         - it DROPS lines with from_mrp = true. An MRP-origin PO line is
           reference-only by the 2026-05-31 decision and deliberately does not
           lock its source SO line; coverage is handled by the pooled-supply
           model instead.
         - it excludes DRAFT purchase orders as well as CANCELLED ones, because
           a draft PO must not drop the SO off the From-SO picker before it
           commits.

       Counting either population inflates `took`, which produces a difference
       in exactly the LOW direction — which is what the old query reported, on
       every one of the 962. A counter measured against a rule the system does
       not use is the trap this repo names "the check that answers a different
       question", and here it would have told the owner his convert ceiling was
       open on 962 sales-order lines the night of go-live.

       BOTH numbers are printed. The write-path figure is the answer; the naive
       one is kept beside it so the size of the artefact is visible and this
       cannot quietly regress into the old reading. */
    const pickedAgg = await pg`
      WITH child AS (
        SELECT i.so_item_id, sum(i.qty) AS took
          FROM scm.purchase_order_items i
          JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
         WHERE i.so_item_id IS NOT NULL
           AND i.from_mrp IS NOT TRUE
           AND h.status NOT IN ('CANCELLED','DRAFT')
         GROUP BY i.so_item_id),
      naive AS (
        SELECT i.so_item_id, sum(i.qty) AS took
          FROM scm.purchase_order_items i
          JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
         WHERE i.so_item_id IS NOT NULL AND h.status <> 'CANCELLED'
         GROUP BY i.so_item_id),
      j AS (
        SELECT s.id, o.doc_no, s.po_qty_picked AS claimed,
               COALESCE(k.took,0) AS took, COALESCE(n.took,0) AS naive_took
          FROM scm.mfg_sales_order_items s
          JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
          LEFT JOIN child k ON k.so_item_id = s.id
          LEFT JOIN naive n ON n.so_item_id = s.id
         WHERE o.status <> 'CANCELLED')
      SELECT count(*)::int AS lines,
             count(*) FILTER (WHERE claimed <> took)::int AS differ,
             count(*) FILTER (WHERE claimed < took)::int  AS reads_low,
             count(*) FILTER (WHERE claimed > took)::int  AS reads_high,
             count(*) FILTER (WHERE claimed <> took AND doc_no LIKE 'HC-%')::int AS migrated,
             count(*) FILTER (WHERE claimed <> naive_took)::int AS naive_differ
        FROM j`;
    const pa = pickedAgg[0];
    const picked = await pg`
      SELECT o.doc_no, s.item_code, s.po_qty_picked AS claimed, COALESCE(k.took,0) AS took
        FROM scm.mfg_sales_order_items s
        JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
        LEFT JOIN (SELECT i.so_item_id, sum(i.qty) AS took
                     FROM scm.purchase_order_items i
                     JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
                    WHERE i.so_item_id IS NOT NULL AND i.from_mrp IS NOT TRUE
                      AND h.status NOT IN ('CANCELLED','DRAFT')
                    GROUP BY i.so_item_id) k ON k.so_item_id = s.id
       WHERE o.status <> 'CANCELLED' AND s.po_qty_picked <> COALESCE(k.took,0)
       ORDER BY o.doc_no LIMIT ${SHOW}`;
    out(`    SO line po_qty_picked vs its PO children : ${pa.differ} of ${pa.lines} live SO lines DISAGREE`);
    out(`      (measured the way recomputeSoPicked writes it: from_mrp lines dropped, DRAFT and CANCELLED POs excluded.`);
    out(`       A plain non-cancelled sum - the rule the system does NOT use - would have reported ${pa.naive_differ}.)`);
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

    /* The same correction, on the other stored counter. This block used to guess
       the convention — "qty_received or qty_accepted? Measure BOTH and take the
       smaller difference" — and reported 241 of 1333 either way. It is not a
       guess and it is neither column on its own. recomputePoReceived
       (routes/grns.ts:840-891) writes

           received_qty = SUM over live GRN lines of max(0, qty_accepted - returned_qty)

       excluding DRAFT GRNs as well as CANCELLED ones, because a draft GRN has
       committed no receipt. Picking whichever raw column happened to disagree
       less is not the same question, and a checker that resolves a tie by taking
       the smaller number is choosing the flattering answer rather than the true
       one. All three are printed so the correction stays visible. */
    const recv = await pg`
      WITH live AS (
        SELECT i.purchase_order_item_id AS k,
               sum(greatest(0, coalesce(i.qty_accepted,0) - coalesce(i.returned_qty,0))) AS net,
               sum(i.qty_received) AS recv, sum(i.qty_accepted) AS acc
          FROM scm.grn_items i JOIN scm.grns gh ON gh.id = i.grn_id
         WHERE i.purchase_order_item_id IS NOT NULL AND gh.status NOT IN ('CANCELLED','DRAFT')
         GROUP BY i.purchase_order_item_id)
      SELECT count(*)::int AS lines,
             count(*) FILTER (WHERE p.received_qty <> COALESCE(g.net,0))::int  AS differs_net,
             count(*) FILTER (WHERE p.received_qty <> COALESCE(g.recv,0))::int AS differs_received,
             count(*) FILTER (WHERE p.received_qty <> COALESCE(g.acc,0))::int  AS differs_accepted,
             count(*) FILTER (WHERE p.received_qty < COALESCE(g.net,0))::int   AS reads_low,
             count(*) FILTER (WHERE p.received_qty > COALESCE(g.net,0))::int   AS reads_high
        FROM scm.purchase_order_items p
        JOIN scm.purchase_orders h ON h.id = p.purchase_order_id AND h.company_id = ${CO}
        LEFT JOIN live g ON g.k = p.id
       WHERE h.status <> 'CANCELLED'`;
    const rv = recv[0];
    out(`    PO line received_qty vs its GRN children: ${rv.differs_net} of ${rv.lines} live PO lines DISAGREE`);
    out("      (measured the way recomputePoReceived writes it: max(0, qty_accepted - returned_qty), DRAFT and CANCELLED GRNs excluded.");
    out(`       Raw qty_received alone would report ${rv.differs_received}; raw qty_accepted alone ${rv.differs_accepted}.)`);
    out(`      ${rv.reads_low} read LOW (a PO line still reads outstanding after the goods arrived)`);
    out(`      ${rv.reads_high} read HIGH (the PO reads received for goods that did not arrive)`);
    const recvEx = await pg`
      SELECT h.po_number, p.item_code, p.received_qty AS claimed, COALESCE(g.net,0) AS took
        FROM scm.purchase_order_items p
        JOIN scm.purchase_orders h ON h.id = p.purchase_order_id AND h.company_id = ${CO}
        LEFT JOIN (SELECT i.purchase_order_item_id AS k,
                          sum(greatest(0, coalesce(i.qty_accepted,0) - coalesce(i.returned_qty,0))) AS net
                     FROM scm.grn_items i JOIN scm.grns gh ON gh.id = i.grn_id
                    WHERE i.purchase_order_item_id IS NOT NULL AND gh.status NOT IN ('CANCELLED','DRAFT')
                    GROUP BY i.purchase_order_item_id) g ON g.k = p.id
       WHERE h.status <> 'CANCELLED' AND p.received_qty <> COALESCE(g.net,0)
       ORDER BY h.po_number LIMIT ${SHOW}`;
    for (const r of recvEx) out(`      ${r.po_number} ${r.item_code}: ERP says received ${r.claimed}, GRN lines total ${r.took}`);

    /* THE THIRD STORED COUNTER, which this check did not measure until now.
       `grn_items.invoiced_qty` gates GR->PI the way received_qty gates PO->GRN,
       so leaving it out meant one of the owner's five edges had NO transfer-TO
       answer at all on the ERP side.
       Its recompute is NOT "sum the child lines", and a check that assumed so
       would report a false positive on every one of them. recomputeGrnInvoiced
       (routes/purchase-invoices.ts:96-170) does two things this replicates:
         - it excludes PIs whose status is DRAFT *as well as* CANCELLED, because
           a draft PI consumes no GRN quantity until it is confirmed;
         - it CLAMPS the result into [0, qty_accepted] before writing.
       Comparing against a plain sum would read the clamp as drift. */
    const invAgg = await pg`
      WITH j AS (
        SELECT g.id, g.invoiced_qty AS claimed,
               least(coalesce(g.qty_accepted, 0), greatest(0, coalesce(p.inv, 0))) AS expected
          FROM scm.grn_items g
          JOIN scm.grns gh ON gh.id = g.grn_id AND gh.company_id = ${CO} AND gh.status <> 'CANCELLED'
          LEFT JOIN (SELECT i.grn_item_id AS k, sum(i.qty) AS inv
                       FROM scm.purchase_invoice_items i
                       JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
                      WHERE i.grn_item_id IS NOT NULL AND h.status NOT IN ('CANCELLED','DRAFT')
                      GROUP BY i.grn_item_id) p ON p.k = g.id)
      SELECT count(*)::int AS lines,
             count(*) FILTER (WHERE claimed <> expected)::int AS differ,
             count(*) FILTER (WHERE claimed < expected)::int  AS reads_low,
             count(*) FILTER (WHERE claimed > expected)::int  AS reads_high
        FROM j`;
    const iv = invAgg[0];
    out(`    GRN line invoiced_qty vs its PI children : ${iv.differ} of ${iv.lines} live GRN lines DISAGREE`);
    out(`      ${iv.reads_low} read LOW (the GRN line could be invoiced a second time)`);
    out(`      ${iv.reads_high} read HIGH (blocks a legitimate invoice)`);
    out("      (measured the way recomputeGrnInvoiced writes it: DRAFT and CANCELLED PIs excluded, clamped to qty_accepted)");

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

    /* ══ 5. PRESENCE ══════════════════════════════════════════════════════════
     *
     * The question sections 1-4 never asked. 1 and 2 measure the book against
     * ITSELF; 4a-4c measure the ERP against ITSELF. Both can be perfectly clean
     * while the ERP simply never imported an edge the book records, because
     * NEITHER side is compared to the other. That is this checker's own version
     * of CLAUDE.md's first trap: 4a counts `unlinked` — a NULL — and a NULL is
     * not evidence of a missing link. A purchase order raised on its own has no
     * sales order and its NULL is correct. Only the BOOK can say which of those
     * NULLs should have been a link.
     *
     * Matched at DOCUMENT grain through both headers' `linked_ac_docno`, and
     * both directions are reported with their own denominator:
     *
     *   FORWARD   the book records the edge -> does the ERP hold it?
     *   BACKWARD  the ERP holds an edge     -> does the book record it?
     *
     * A BACKWARD miss is the more serious of the two: it is a relationship the
     * ERP asserts and the account book does not, which is the invented edge
     * `migration-copy-never-compute` forbids. */
    head("5.  PRESENCE - THE BOOK RECORDS AN EDGE. DOES THE ERP HOLD IT? (both directions)");

    /* Which document types the ERP can even be ASKED about. Measured from
       information_schema, not assumed: a stamp column that was renamed would
       otherwise make every edge read "the ERP holds none of them", which is the
       clean-looking catastrophe this file's header warns about. */
    const stampCols = await pg`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema='scm' AND column_name='linked_ac_docno'
         AND table_name = ANY(${["mfg_sales_orders", "purchase_orders", "delivery_orders",
        "sales_invoices", "purchase_invoices", "grns"]})`;
    const stamped = new Set(stampCols.map((r) => r.table_name));
    out(`    tables carrying linked_ac_docno: ${[...stamped].sort().join(", ")}`);
    out("");
    out("    WHAT CANNOT BE ASKED, and why - the GOODS RECEIPT has no AutoCount number of its own.");
    out("    scm.grns.linked_ac_docno holds its PURCHASE ORDER's number (the cutover convention,");
    out("    autocount-outbox.ts:1069-1099). A PO received in several deliveries has several AC");
    out("    receipt numbers on purchase_orders.linked_ac_grn_docnos and nothing says which GRN is");
    out("    which, so the system itself refuses to pick one. GR<-PO and PI<-GR therefore have no");
    out("    document-grain identity on the child side, and no amount of wanting changes that. The");
    out("    strongest question that IS answerable for GR<-PO is asked below instead.");

    /* The ERP's edge set, resolved to AutoCount document numbers on both ends.
       DISTINCT because the ERP holds one link per LINE and the book pair is a
       DOCUMENT fact — a sofa decomposed into six ERP rows is still one edge. */
    const erpEdgeQ = {
      "PO <- SO": pg`
        SELECT DISTINCT ch.linked_ac_docno AS c, ph.linked_ac_docno AS p
          FROM scm.purchase_order_items i
          JOIN scm.purchase_orders ch ON ch.id = i.purchase_order_id AND ch.company_id = ${CO}
          JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
          JOIN scm.mfg_sales_orders ph ON ph.doc_no = s.doc_no AND ph.company_id = ${CO}
         WHERE ch.linked_ac_docno IS NOT NULL AND ph.linked_ac_docno IS NOT NULL`,
      "DO <- SO": pg`
        SELECT DISTINCT ch.linked_ac_docno AS c, ph.linked_ac_docno AS p
          FROM scm.delivery_order_items i
          JOIN scm.delivery_orders ch ON ch.id = i.delivery_order_id AND ch.company_id = ${CO}
          JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
          JOIN scm.mfg_sales_orders ph ON ph.doc_no = s.doc_no AND ph.company_id = ${CO}
         WHERE ch.linked_ac_docno IS NOT NULL AND ph.linked_ac_docno IS NOT NULL`,
      "IV <- DO": pg`
        SELECT DISTINCT ch.linked_ac_docno AS c, ph.linked_ac_docno AS p
          FROM scm.sales_invoice_items i
          JOIN scm.sales_invoices ch ON ch.id = i.sales_invoice_id AND ch.company_id = ${CO}
          JOIN scm.delivery_order_items d ON d.id = i.do_item_id
          JOIN scm.delivery_orders ph ON ph.id = d.delivery_order_id AND ph.company_id = ${CO}
         WHERE ch.linked_ac_docno IS NOT NULL AND ph.linked_ac_docno IS NOT NULL`,
      /* THE SIXTH EDGE, and the one a five-edge summary quietly drops. AutoCount
         raises an invoice STRAIGHT off a sales order on 169 lines, without a
         delivery order in between, and the book records it as its own edge. The
         ERP's own invoice flow has no such shape — autocount-convert-lines.ts
         gives the invoice ONE sourceFk and it is do_item_id — so this is the
         edge most likely to be silently absent, which is exactly why it must be
         counted rather than assumed away. sales_invoice_items.so_item_id exists,
         so the question is answerable; whether it is ever populated is the
         finding, not the reason to skip it. */
      "IV <- SO": pg`
        SELECT DISTINCT ch.linked_ac_docno AS c, ph.linked_ac_docno AS p
          FROM scm.sales_invoice_items i
          JOIN scm.sales_invoices ch ON ch.id = i.sales_invoice_id AND ch.company_id = ${CO}
          JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
          JOIN scm.mfg_sales_orders ph ON ph.doc_no = s.doc_no AND ph.company_id = ${CO}
         WHERE ch.linked_ac_docno IS NOT NULL AND ph.linked_ac_docno IS NOT NULL`,
    };
    /* The imported-document sets, so FORWARD gets an honest denominator. The
       ERP cannot hold an edge whose documents it never imported, and counting
       those as failures would drown the real ones. */
    const importedQ = {
      SO: pg`SELECT linked_ac_docno AS d FROM scm.mfg_sales_orders WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`,
      PO: pg`SELECT linked_ac_docno AS d FROM scm.purchase_orders   WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`,
      DO: pg`SELECT linked_ac_docno AS d FROM scm.delivery_orders   WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`,
      IV: pg`SELECT linked_ac_docno AS d FROM scm.sales_invoices    WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`,
    };
    const imported = {};
    for (const [t, q] of Object.entries(importedQ)) {
      imported[t] = new Set((await q).map((r) => String(r.d).trim()));
    }
    out("");
    out(`    ERP imported: SO ${imported.SO.size} | PO ${imported.PO.size} | DO ${imported.DO.size} | IV ${imported.IV.size} documents`);

    const presenceRows = [];
    for (const [edgeId, q] of Object.entries(erpEdgeQ)) {
      const edge = EDGES.find((e) => e.id === edgeId);
      const bookPairs = bookDocEdges(book, edge);
      const erpPairs = new Set((await q).map((r) => `${String(r.c).trim()}|${String(r.p).trim()}`));

      /* FORWARD. Denominator = book edges BOTH of whose documents the ERP
         imported and neither of which is cancelled. Everything excluded is
         counted and printed, so the denominator can be audited rather than
         taken on trust. */
      let inScope = 0; let held = 0; let missing = 0;
      let outOfScope = 0; let cancelledSkipped = 0;
      const missingEx = [];
      for (const [k, v] of bookPairs) {
        if (v.cancelled) { cancelledSkipped++; continue; }
        if (!imported[edge.child]?.has(v.child) || !imported[edge.parent]?.has(v.parent)) { outOfScope++; continue; }
        inScope++;
        if (erpPairs.has(k)) held++;
        else { missing++; if (missingEx.length < SHOW) missingEx.push(k); }
      }
      /* BACKWARD. Every ERP edge is by construction between two MIGRATED
         documents (the query demands a stamp on both ends), so the denominator
         is the whole set. One the book does not record is an INVENTED edge. */
      let recorded = 0; const invented = [];
      for (const k of erpPairs) {
        if (bookPairs.has(k)) recorded++;
        else if (invented.length < SHOW) invented.push(k);
      }
      const inventedTotal = erpPairs.size - recorded;

      out("");
      out(`    --- ${edgeId}`);
      out(`        book records ${bookPairs.size} document edge(s); ${cancelledSkipped} sit on a cancelled document, `
        + `${outOfScope} name a document the ERP did not import (out of cutover scope)`);
      out(`        FORWARD  book -> ERP : ${held} of ${inScope} held by the ERP | ${missing} MISSING`);
      out(`        BACKWARD ERP -> book : ${recorded} of ${erpPairs.size} recorded in the book | ${inventedTotal} NOT IN THE BOOK`);
      for (const m of missingEx) out(`          missing: ${m.replace("|", " <- ")}`);
      for (const m of invented) out(`          not in the book: ${m.replace("|", " <- ")}`);
      presenceRows.push({ edgeId, inScope, held, missing, erp: erpPairs.size, recorded, invented: inventedTotal });
    }

    /* ── GR <- PO, AT DOCUMENT GRAIN AGAINST THE BOOK ──────────────────────
     *
     * This checker used to print "no document-grain book comparison possible"
     * for this edge and stop, on the reasoning that scm.grns.linked_ac_docno
     * holds the PURCHASE ORDER's number rather than the receipt's. That
     * reasoning is sound and the conclusion drawn from it was still wrong: the
     * cutover DOES record which AutoCount receipts brought a purchase order in,
     * on `purchase_orders.linked_ac_grn_docnos` (mig 0275, whose header calls it
     * "naming the source documents instead of fabricating an ERP one"). A PO row
     * carrying linked_ac_docno = P and linked_ac_grn_docnos = {G1,G2} is the ERP
     * asserting the edges G1<-P and G2<-P in AutoCount's own numbering, which is
     * exactly the pair bookDocEdges() produces. So the edge is answerable, and
     * the owner asked for it three times while this block said it could not be
     * asked. It is asked here.
     *
     * The FORWARD denominator scopes on the PARENT only. An ERP goods receipt
     * has no AutoCount receipt number of its own, so "did the ERP import this
     * GR" is not a question that can be put; requiring it would silently drop
     * the whole edge. Scoping on the purchase order is the honest denominator:
     * of the book's receipt edges whose PURCHASE ORDER the ERP holds, how many
     * does the ERP name the receipt for. */
    out("");
    out("    --- GR <- PO  (document grain, through purchase_orders.linked_ac_grn_docnos)");
    {
      const grStampRows = await pg`
        SELECT linked_ac_docno AS p, linked_ac_grn_docnos AS gs
          FROM scm.purchase_orders
         WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL
           AND coalesce(array_length(linked_ac_grn_docnos, 1), 0) > 0`;
      const erpPairs = new Set();
      for (const r of grStampRows) {
        for (const g of r.gs ?? []) erpPairs.add(`${String(g).trim()}|${String(r.p).trim()}`);
      }
      const bookPairs = bookDocEdges(book, EDGES.find((e) => e.id === "GR <- PO"));
      let inScope = 0; let held = 0; let missing = 0; let outOfScope = 0; let cancelledSkipped = 0;
      const missingEx = [];
      for (const [k, v] of bookPairs) {
        if (v.cancelled) { cancelledSkipped++; continue; }
        if (!imported.PO.has(v.parent)) { outOfScope++; continue; }
        inScope++;
        if (erpPairs.has(k)) held++;
        else { missing++; if (missingEx.length < SHOW) missingEx.push(k); }
      }
      let recorded = 0; const invented = [];
      for (const k of erpPairs) {
        if (bookPairs.has(k)) recorded++;
        else if (invented.length < SHOW) invented.push(k);
      }
      out(`        book records ${bookPairs.size} document edge(s); ${cancelledSkipped} sit on a cancelled document, `
        + `${outOfScope} name a purchase order the ERP did not import (out of cutover scope)`);
      out(`        FORWARD  book -> ERP : ${held} of ${inScope} held by the ERP | ${missing} MISSING`);
      out(`        BACKWARD ERP -> book : ${recorded} of ${erpPairs.size} recorded in the book | ${erpPairs.size - recorded} NOT IN THE BOOK`);
      for (const m of missingEx) out(`          missing: ${m.replace("|", " <- ")}`);
      for (const m of invented) out(`          not in the book: ${m.replace("|", " <- ")}`);
      presenceRows.push({ edgeId: "GR <- PO", inScope, held, missing, erp: erpPairs.size, recorded, invented: erpPairs.size - recorded });
    }

    /* ── PI <- GR, COMPOSED THROUGH THE PURCHASE ORDER ─────────────────────
     *
     * The direct edge cannot be compared and that part of the old note stands:
     * the book names a GOODS RECEIPT as the invoice's parent, and no ERP row
     * carries an AutoCount receipt number it could be matched against. What CAN
     * be compared is the same relationship one hop wider. Compose the book's
     * PI<-GR with its GR<-PO to get (purchase invoice, purchase order), and read
     * the ERP's own assertion of the same pair off linked_ac_pinv_docnos.
     *
     * A COMPOSED edge is a WEAKER question and is labelled as one everywhere it
     * is printed. It cannot tell two receipts of one purchase order apart, so it
     * proves the invoice hangs off the right ORDER, never off the right RECEIPT.
     * That is less than the owner asked for and it is more than "unknown"; both
     * halves are said out loud rather than one of them quietly standing in for
     * the other. */
    out("");
    out("    --- PI <- GR  (COMPOSED to PI <- PO - see the limit stated below)");
    {
      const piStampRows = await pg`
        SELECT linked_ac_docno AS p, linked_ac_pinv_docnos AS ps
          FROM scm.purchase_orders
         WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL
           AND coalesce(array_length(linked_ac_pinv_docnos, 1), 0) > 0`;
      const erpPairs = new Set();
      for (const r of piStampRows) {
        for (const p of r.ps ?? []) erpPairs.add(`${String(p).trim()}|${String(r.p).trim()}`);
      }
      /* The book's composition. A receipt drawing on more than one purchase
         order yields one pair per order — 1,291 of 5,353 receipts do, so
         collapsing them to a single parent would silently drop real edges. */
      const grParents = new Map();
      for (const l of allLines(book, "GR")) {
        if (l.fromDocType !== "PO" || !l.fromDocNo) continue;
        if (!grParents.has(l.docNo)) grParents.set(l.docNo, new Set());
        grParents.get(l.docNo).add(l.fromDocNo);
      }
      const bookPairs = new Map();
      let piLinesNoPo = 0;
      for (const l of allLines(book, "PI")) {
        if (l.fromDocType !== "GR" || !l.fromDocNo) continue;
        const pos = grParents.get(l.fromDocNo);
        if (!pos) { piLinesNoPo++; continue; }
        for (const p of pos) {
          bookPairs.set(`${l.docNo}|${p}`, {
            child: l.docNo, parent: p,
            cancelled: !!book.PI.headers.get(l.docNo)?.cancelled || !!book.PO.headers.get(p)?.cancelled,
          });
        }
      }
      let inScope = 0; let held = 0; let missing = 0; let outOfScope = 0; let cancelledSkipped = 0;
      const missingEx = [];
      for (const [k, v] of bookPairs) {
        if (v.cancelled) { cancelledSkipped++; continue; }
        if (!imported.PO.has(v.parent)) { outOfScope++; continue; }
        inScope++;
        if (erpPairs.has(k)) held++;
        else { missing++; if (missingEx.length < SHOW) missingEx.push(k); }
      }
      let recorded = 0; const invented = [];
      for (const k of erpPairs) {
        if (bookPairs.has(k)) recorded++;
        else if (invented.length < SHOW) invented.push(k);
      }
      out(`        LIMIT: this proves the invoice hangs off the right ORDER, never off the right RECEIPT.`);
      out(`        book composes ${bookPairs.size} (invoice, order) edge(s) from ${piLinesNoPo === 0 ? "every" : "most"} PI line naming a receipt;`);
      out(`        ${piLinesNoPo} PI line(s) name a receipt that names no purchase order, so they compose to nothing`);
      out(`        ${cancelledSkipped} sit on a cancelled document, ${outOfScope} name a purchase order the ERP did not import`);
      out(`        FORWARD  book -> ERP : ${held} of ${inScope} held by the ERP | ${missing} MISSING`);
      out(`        BACKWARD ERP -> book : ${recorded} of ${erpPairs.size} recorded in the book | ${erpPairs.size - recorded} NOT IN THE BOOK`);
      for (const m of missingEx) out(`          missing: ${m.replace("|", " <- ")}`);
      for (const m of invented) out(`          not in the book: ${m.replace("|", " <- ")}`);
      presenceRows.push({ edgeId: "PI <- GR (composed)", inScope, held, missing, erp: erpPairs.size, recorded, invented: erpPairs.size - recorded });
    }

    /* The two-routes cross-check kept from the previous version: the GRN header
       carries its PURCHASE ORDER's AutoCount number, and the GRN's LINES each
       resolve to a purchase-order line whose header carries one too. Those two
       are the same fact by two routes, so a disagreement is a genuine one-sided
       link: the header says the receipt came off one order and the lines say
       another. This is not a substitute for the book comparison above and is
       not counted as one. */
    out("");
    out("    --- GR <- PO  ERP-internal cross-check: header vs lines");
    const grAgree = await pg`
      WITH j AS (
        SELECT g.id, g.linked_ac_docno AS header_says,
               array_agg(DISTINCT ph.linked_ac_docno) FILTER (WHERE ph.linked_ac_docno IS NOT NULL) AS lines_say
          FROM scm.grns g
          JOIN scm.grn_items i ON i.grn_id = g.id
          JOIN scm.purchase_order_items p ON p.id = i.purchase_order_item_id
          JOIN scm.purchase_orders ph ON ph.id = p.purchase_order_id
         WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
         GROUP BY g.id, g.linked_ac_docno)
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE header_says IS NULL)::int AS header_unstamped,
             count(*) FILTER (WHERE header_says IS NOT NULL AND lines_say IS NOT NULL
                                AND NOT (header_says = ANY(lines_say)))::int AS disagree,
             count(*) FILTER (WHERE coalesce(array_length(lines_say,1),0) > 1)::int AS multi_parent
        FROM j`;
    const ga = grAgree[0];
    out(`        ${ga.total} live GRNs have at least one line resolving to a purchase order`);
    out(`        header's AutoCount PO number vs the PO its LINES resolve to: ${ga.disagree} DISAGREE`);
    out(`        ${ga.header_unstamped} carry no AutoCount number on the header; ${ga.multi_parent} draw on more than one purchase order`);
    presenceRows.push({ edgeId: "GR <- PO header/lines", headerVsLines: ga.disagree, total: ga.total });

    log(`PRESENCE: ${presenceRows.filter((r) => r.missing != null).reduce((a, r) => a + r.missing, 0)} book edges the ERP does not hold; `
      + `${presenceRows.filter((r) => r.invented != null).reduce((a, r) => a + r.invented, 0)} ERP edges the book does not record; `
      + `${ga.disagree} GRNs whose header and lines name different purchase orders.`);

    /* ══ 6. IDENTITY ══════════════════════════════════════════════════════════
     *
     * The third question, and the one presence and symmetry between them cannot
     * reach. A link can be PRESENT on both sides and SYMMETRIC and still name
     * the wrong thing: docs/bugs/0672 is that class, and it produced fifteen
     * real wrong links in production including ten bedframes, where a hard-bound
     * line reads READY off its own dedicated purchase order and a customer's
     * REGAL therefore lights up when a TRION arrives.
     *
     * Counted here so the matrix is complete in ONE run. probe-link-identity.mjs
     * asks the same question in more shapes (the swap signature, the colour) and
     * remains the deeper tool; this is the row of the matrix, not a replacement
     * for it. */
    head("6.  IDENTITY - THE LINK IS PRESENT AND SYMMETRIC. DO THE TWO ENDS NAME THE SAME ITEM?");
    const NORMC = (e) => `upper(regexp_replace(btrim(coalesce(${e}, '')), '\\s+', ' ', 'g'))`;
    const idEdges = [
      { id: "PO <- SO", table: "purchase_order_items", col: "so_item_id", parent: "mfg_sales_order_items" },
      { id: "DO <- SO", table: "delivery_order_items", col: "so_item_id", parent: "mfg_sales_order_items" },
      { id: "IV <- SO", table: "sales_invoice_items", col: "so_item_id", parent: "mfg_sales_order_items" },
      { id: "IV <- DO", table: "sales_invoice_items", col: "do_item_id", parent: "delivery_order_items" },
      { id: "GR <- PO", table: "grn_items", col: "purchase_order_item_id", parent: "purchase_order_items" },
      { id: "PI <- GR", table: "purchase_invoice_items", col: "grn_item_id", parent: "grn_items" },
    ];
    const idRows = [];
    for (const e of idEdges) {
      const r = (await pg.unsafe(`
        SELECT count(*)::int AS rows,
               count(c.${e.col})::int AS linked,
               count(*) FILTER (WHERE c.${e.col} IS NULL)::int AS unlinked,
               count(*) FILTER (WHERE c.${e.col} IS NOT NULL AND p.id IS NULL)::int AS dangling,
               count(*) FILTER (WHERE p.id IS NOT NULL
                 AND ${NORMC("c.item_code")} <> ${NORMC("p.item_code")})::int AS wrong_item
          FROM scm.${e.table} c
          LEFT JOIN scm.${e.parent} p ON p.id = c.${e.col}`))[0];
      idRows.push({ id: e.id, ...r });
      out(`    ${e.id.padEnd(10)} ${String(r.linked).padStart(6)} linked of ${String(r.rows).padStart(6)} rows `
        + `(${r.unlinked} carry no link) | ${r.dangling} dangling | ${r.wrong_item} name a DIFFERENT product`);
    }
    /* A count taken only over rows that ALREADY carry a link cannot see a link
       that was never written, so the unlinked column above is printed next to
       the answer rather than filtered away. Which of those NULLs SHOULD have
       been a link is section 5's question, not this one's. */
    log(`IDENTITY: ${idRows.reduce((a, r) => a + r.wrong_item, 0)} link(s) whose two ends name a different product; `
      + `${idRows.reduce((a, r) => a + r.dangling, 0)} dangling.`);

    /* ── the shared AutoCount line key, SETTLED rather than assumed ─────────
     *
     * 296 sales-order and 98 purchase-order DtlKeys are carried by more than one
     * ERP row, and the standing reading is "LIKELY all sofa decomposition,
     * UNPROVEN". probe-link-identity.mjs cannot settle it: it counts how many of
     * those keys carry rows naming DIFFERENT products, and a sofa decomposed
     * into compartments produces exactly that — each compartment is its own
     * piece code — so a high count is equally consistent with both readings.
     *
     * What DOES settle it is the BOOK line the key belongs to. This checker
     * holds the snapshot, so the key can be resolved to its AutoCount ItemCode
     * and tested with the repo's own sofa predicate (the /\bSOFA\b/i used by
     * check-ac-erp-doc-links.mjs on this same question). A shared key whose book
     * line is not a sofa is the finding; a shared key whose book line IS one is
     * the expected decomposition. */
    out("");
    out("    --- shared AutoCount line keys: sofa decomposition, or something else?");
    const SOFA_RE = /\bSOFA\b/i;
    for (const [t, spec] of Object.entries({
      SO: { line: "mfg_sales_order_items", head: "mfg_sales_orders", fk: "doc_no", pk: "doc_no" },
      PO: { line: "purchase_order_items", head: "purchase_orders", fk: "purchase_order_id", pk: "id" },
    })) {
      const dups = await pg.unsafe(`
        SELECT c.linked_ac_dtlkey::text AS k, count(*)::int AS n
          FROM scm.${spec.line} c
          JOIN scm.${spec.head} h ON h.${spec.pk} = c.${spec.fk} AND h.company_id = ${CO}
         WHERE c.linked_ac_dtlkey IS NOT NULL
         GROUP BY 1 HAVING count(*) > 1`);
      let sofa = 0; const notSofa = []; let unresolved = 0;
      for (const d of dups) {
        const bookLine = book[t].byKey.get(d.k);
        if (!bookLine) { unresolved++; continue; }
        if (SOFA_RE.test(bookLine.itemKey || "")) sofa++;
        else if (notSofa.length < SHOW) notSofa.push(`${bookLine.docNo} key ${d.k} ${bookLine.itemKey} (${d.n} ERP rows)`);
        else notSofa.push("");
      }
      out(`        ${t}: ${dups.length} DtlKey(s) carried by more than one ERP row`);
      out(`           ${sofa} resolve to a book line whose item code is a SOFA - the expected decomposition`);
      out(`           ${notSofa.length} are NOT a sofa line; ${unresolved} do not resolve to any book line in this snapshot`);
      for (const n of notSofa.slice(0, SHOW)) if (n) out(`             ${n}`);
      if (dups.length > 0 && notSofa.length === 0 && unresolved === 0) {
        log(`SETTLED: every one of the ${dups.length} shared ${t} DtlKeys is a sofa line decomposed into compartments.`);
      } else if (notSofa.length > 0) {
        log(`NOT ALL SOFA: ${notSofa.length} shared ${t} DtlKey(s) resolve to a book line that is not a sofa - each is a key claimed by rows the book never split.`);
      }
    }

    /* ══ 7. THE MATRIX ═══════════════════════════════════════════════════════
     *
     * One row per edge, both directions, each count with its denominator. The
     * owner asked for the transfer-from / transfer-to half of this three times;
     * scattering it across six sections is how it kept not arriving. Every
     * number here is printed above with its working - this is the reading, not
     * a second measurement. */
    head("7.  THE MATRIX - every edge, both directions, each count with its denominator");
    const pRow = (id) => presenceRows.find((r) => r.edgeId === id);
    const iRow = (id) => idRows.find((r) => r.id === id);
    out("");
    out("    edge        | FORWARD book->ERP | BACKWARD ERP->book | wrong item | not linked");
    out("    " + "-".repeat(88));
    for (const id of ["PO <- SO", "DO <- SO", "IV <- SO", "IV <- DO", "GR <- PO", "PI <- GR (composed)"]) {
      const p = pRow(id);
      const i = iRow(id === "PI <- GR (composed)" ? "PI <- GR" : id);
      const fwd = p ? `${p.held} / ${p.inScope}` : "not comparable";
      const bwd = p ? `${p.recorded} / ${p.erp}` : "not comparable";
      out(`    ${id.padEnd(11)} | ${fwd.padStart(17)} | ${bwd.padStart(18)} | ${String(i?.wrong_item ?? "-").padStart(10)} | ${String(i?.unlinked ?? "-").padStart(10)}`);
    }
    out("");
    out("    FORWARD  denominator = book document edges BOTH of whose documents the ERP imported,");
    out("             neither cancelled. BACKWARD denominator = every edge the ERP asserts.");
    out("    'wrong item' and 'not linked' are LINE counts inside the ERP (section 6), not document counts.");
    out("    PI <- GR is COMPOSED to PI <- PO: it proves the right ORDER, never the right RECEIPT.");
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
