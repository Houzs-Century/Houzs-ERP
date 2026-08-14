// DB-free core shared by the AutoCount purchase-order LINE-level top-up
// (scripts/topup-ac-po-lines.mjs) and by the line-level half of
// scripts/check-cutover-completeness.mjs.
//
// ONE FILE, TWO CALLERS, ON PURPOSE. The repair that inserts the missing lines
// and the check that reports them must agree on what "missing" means, or the
// check reads green while the rows are still absent - or, worse, the repair
// inserts a duplicate of a row the check can already see. That is the class
// BUG-HISTORY records for findColour: five hand-copies, and the weakest one is
// what production stored.
//
// ── THE MATCHING RULE (read this before trusting any number here) ────────────
//
// 1. linked_ac_dtlkey FIRST, WHERE IT EXISTS. Migration 0273 (#1819, merged
//    2026-08-10) gave scm.purchase_order_items a linked_ac_dtlkey, so the
//    AutoCount line identity finally has a home. It is only as good as its
//    coverage: it is nullable by design, backfill-ac-line-keys fills it by
//    matching (AutoCount DocNo + ERP code), and that match cannot reach a
//    decomposed sofa compartment, whose ERP code is `${model}-{piece}` and not
//    the mapped code. So it is the strongest signal and never the only one -
//    and the top-up SETS it on every row it writes, which is the one place a
//    new row can be given the key for free.
//
// 2. supplier_sku NEXT. Both cutover importers write the AutoCount ItemCode
//    there, and a decomposed sofa piece writes `${ItemCode} ${compartment}`
//    (import-ac-outstanding-po.mjs:159, import-ac-so-linked-pos.mjs:224). A row
//    is claimed by the LONGEST matching ItemCode, so a code that prefixes
//    another cannot steal its rows.
//
// 3. material_code AS FALLBACK, and ONLY for a row that has NO supplier_sku.
//    Measured against prod on 2026-08-10: 225 of the 862 lines on migrated
//    purchase orders carry no supplier_sku at all - 206 written in one batch at
//    04:46-04:50 and 19 later - and NOT by the two importers, which always set
//    it. apply-sofa-compartment-corrections.mjs:212-217 is one such writer: it
//    INSERTs a corrected compartment by SELECTing from the source row and does
//    not carry the column. Zero of those 225 rows duplicate a
//    with-supplier_sku row's code on the same PO, so they ARE the AutoCount
//    lines, just unlabelled. Keying on supplier_sku alone declared 183 of them
//    missing in the first DRY-RUN - 183 duplicates, had it been applied.
//    A no-supplier_sku row is claimed by exact material_code, or - for a sofa
//    line, whose ONE AutoCount line becomes many `${model}-{compartment}` rows -
//    by the model prefix. A row two families could both claim is claimed by
//    NEITHER; it is reported as ambiguous.
//
// 4. THE REPAIR IS ALL-OR-NOTHING PER FAMILY. A family (= one AutoCount ItemCode
//    on one document) with ZERO claimed rows is the confirmed defect shape and
//    gets its rows written. A family with SOME rows but fewer than expected is
//    REPORTED and left alone: a half-written sofa build can equally be a build
//    somebody corrected by hand, and guessing which would double a compartment.
//    Under-repair, never duplicate.
//
// The family view is also what makes the completeness check decoder-independent:
// one AutoCount line can only ever produce ONE OR MORE ERP rows, so a family
// holding fewer rows than it has AutoCount lines is proof of missing rows no
// matter what the sofa decoder does today.

const normSku = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const isSofaCode = (c) => /SOFA/i.test(String(c ?? ""));

function belongsToFamily(supplierSku, itemCode) {
  const s = normSku(supplierSku);
  const f = normSku(itemCode);
  if (!s || !f) return false;
  return s === f || s.startsWith(f + " ");
}

const acNum = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : null;
};

/* ── THE RECEIVED QUANTITY: ONE COLUMN IS PER-LINE, THE OTHER IS NOT ─────────
   These two columns do NOT mean the same thing, and reading them as if they did
   is what put 65 lines into production with received_qty > qty.

   ac-outstanding-po.json.gz carries PODTL.TransferedQty, which is per PO LINE.
   data/autocount-refetch-po.sql is the query that produced it and selects
   `pod.TransferedQty` straight off the detail row.

   ac-so-linked-pos.json.gz carries GrQty, which is AGGREGATED on
   (DocNo + ItemCode). It is not a per-line figure and must never be read as one.
   The export proves it against itself:
     - every one of the 38 (DocNo,ItemCode) groups holding 2+ lines carries an
       IDENTICAL GrQty on all of them - an aggregate cannot vary within its
       own group, a per-line quantity would;
     - 59 lines carry GrQty > Qty, impossible for a single line, and all 59 sit
       on such a group - ZERO on a single-line group;
     - PO-008944 holds two DSL-8050 SOFA lines, Qty 2 and Qty 1; both report
       GrQty 3, their SUM. Live PODTL.TransferedQty is 2 and 1.
   Confirmed against live AutoCount in review (read-only ODBC, the 738 merged
   DtlKeys joined to PODTL): 60 of 738 disagree with PODTL.TransferedQty, always
   INFLATED, and 0 disagree wherever TransferedQty supplied the value.

   So TransferedQty is taken and GrQty is REFUSED as a per-line quantity. The
   one thing an aggregate does prove is a ZERO: a sum of non-negative receipts
   that comes to 0 forces every member to 0. That inference is arithmetic, not
   trust - and it holds here, the export carrying no negative GrQty at all and
   all 163 overlapping zero rows agreeing at zero. A GrQty ABOVE zero yields no
   received quantity; the line carries null and is reported.

   Why not "trust it where the group holds one line" - the tempting rule that
   would cover 333 more lines: it rests on the export holding EVERY line of that
   ItemCode on that document, and nothing available here can establish that. The
   two exports never overlap on a received line (0 of the 179 shared DtlKeys
   have GrQty > 0), so the repo cannot check it even once, and
   GRDTL.FromDocDtlKey is NULL in this book so a per-line GR join is impossible.
   PODTL.TransferedQty is the only correct source. Until the export carries it
   those lines have no received quantity here, and say so out loud. */
const RECEIVED_PER_LINE = "per-line";
const RECEIVED_ZERO_AGGREGATE = "zero-aggregate";
const RECEIVED_INDETERMINATE = "indeterminate";
const RECEIVED_RANK = {
  [RECEIVED_PER_LINE]: 3, [RECEIVED_ZERO_AGGREGATE]: 2, [RECEIVED_INDETERMINATE]: 1,
};

/* Index the SO-linked export by the key GrQty is aggregated on. This is for the
   REPORT only - so it can separate "provably inflated" from "merely unprovable"
   - and the decision above never consults it. A rule that let group size decide
   is exactly the rule the comment above refuses. */
function buildGrQtyGroups(soLinked = []) {
  const m = new Map();
  for (const r of soLinked) {
    const k = `${r.DocNo ?? ""}|${normSku(r.ItemCode)}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/* The per-line received quantity, or null when the export cannot supply one. */
function resolveReceivedQty(r, grQtyGroups) {
  const perLine = acNum(r.TransferedQty);
  const spans = grQtyGroups ? grQtyGroups.get(`${r.DocNo ?? ""}|${normSku(r.ItemCode)}`) ?? null : null;
  if (perLine !== null) return { receivedQty: perLine, receivedSource: RECEIVED_PER_LINE, aggregateSpans: null };
  if (acNum(r.GrQty) === 0) return { receivedQty: 0, receivedSource: RECEIVED_ZERO_AGGREGATE, aggregateSpans: spans };
  return { receivedQty: null, receivedSource: RECEIVED_INDETERMINATE, aggregateSpans: spans };
}

/* One AutoCount PO line, in the shape both exports can be read through. */
function normaliseAcPoLine(r, grQtyGroups) {
  return {
    ...resolveReceivedQty(r, grQtyGroups),
    docNo: r.DocNo ?? null,
    dtlKey: r.DtlKey === null || r.DtlKey === undefined ? null : String(r.DtlKey),
    docDate: r.DocDate ?? null,
    creditorCode: r.CreditorCode ?? null,
    itemCode: r.ItemCode ?? "",
    description: r.Description ?? null,
    desc2: r.Desc2 ?? null,
    qty: acNum(r.Qty),
    unitPrice: acNum(r.UnitPrice),
    location: r.Location ?? null,
    /* DeliveryDate is the column both exports carry. DelivDate is read too
       because import-ac-outstanding-po.mjs:179 asks for that spelling, which
       exists in neither export - see BUG-HISTORY. */
    deliveryDate: r.DeliveryDate ?? r.DelivDate ?? null,
    fromSoDtlKey: r.FromSODtlKey === null || r.FromSODtlKey === undefined ? null : String(r.FromSODtlKey),
    cancelled: String(r.Cancelled ?? "F").trim().toUpperCase() === "T",
    sources: [],
  };
}

/* Union of the two AutoCount PO exports, deduped on DtlKey. They overlap on 121
   documents and agree line-for-line there, so the merge only ever fills gaps:
   a field already set by the first source is never overwritten. */
function mergeAcPoLines(outstanding = [], soLinked = []) {
  const out = new Map();
  const grQtyGroups = buildGrQtyGroups(soLinked);
  const put = (raw, src) => {
    const n = normaliseAcPoLine(raw, grQtyGroups);
    if (!n.dtlKey) return;
    const prev = out.get(n.dtlKey);
    if (!prev) {
      n.sources = [src];
      out.set(n.dtlKey, n);
      return;
    }
    prev.sources.push(src);
    /* The received quantity moves as ONE unit and only ever UPGRADES - a
       per-line figure replaces an aggregate, never the reverse. It is kept out
       of the generic gap-fill below because that fills on null alone: an
       indeterminate line's null quantity would be filled from the other export
       while its label stayed "indeterminate", which is the worst of both. */
    if (RECEIVED_RANK[n.receivedSource] > RECEIVED_RANK[prev.receivedSource]) {
      prev.receivedQty = n.receivedQty;
      prev.receivedSource = n.receivedSource;
      prev.aggregateSpans = n.aggregateSpans;
    }
    for (const k of Object.keys(n)) {
      if (k === "sources" || k === "receivedQty" || k === "receivedSource" || k === "aggregateSpans") continue;
      if ((prev[k] === null || prev[k] === undefined || prev[k] === "") && n[k] !== null && n[k] !== undefined) prev[k] = n[k];
    }
  };
  for (const r of outstanding) put(r, "outstanding");
  for (const r of soLinked) put(r, "so-linked");
  return [...out.values()];
}

function groupByDoc(lines) {
  const m = new Map();
  for (const l of lines) {
    if (!m.has(l.docNo)) m.set(l.docNo, []);
    m.get(l.docNo).push(l);
  }
  return m;
}

/* One family per AutoCount ItemCode on one document. `resolve(itemCode)` is the
   caller's mapping into ERP terms: { code, sofaModel }. Both may be null - a
   family with neither simply cannot claim a no-supplier_sku row, which is the
   safe direction. */
function buildFamilies(acLines, resolve) {
  const m = new Map();
  for (const l of acLines) {
    const key = normSku(l.itemCode);
    if (!m.has(key)) {
      const r = (resolve ? resolve(l.itemCode) : null) || {};
      m.set(key, {
        key, itemCode: l.itemCode, sofa: isSofaCode(l.itemCode),
        code: r.code ?? null, sofaModel: r.sofaModel ?? null, dtlKeys: new Set(),
        acLines: 0, lines: [], keyRows: 0, skuRows: 0, codeRows: 0, claimed: 0, rows: [],
      });
    }
    const f = m.get(key);
    f.acLines++;
    f.lines.push(l);
    if (l.dtlKey !== null && l.dtlKey !== undefined) f.dtlKeys.add(String(l.dtlKey));
  }
  return [...m.values()];
}

/* Claim the document's ERP rows for its families. erpRows are
   { supplierSku, materialCode, ... }. Rules 2 and 3 above. */
function claimErpRows(families, erpRows) {
  for (const f of families) { f.keyRows = 0; f.skuRows = 0; f.codeRows = 0; f.claimed = 0; f.rows = []; }
  const byLongestKey = [...families].sort((a, b) => b.key.length - a.key.length);
  const unassigned = [];
  const ambiguous = [];
  for (const row of erpRows) {
    // rule 1: the AutoCount line key, when the row carries one
    const dk = row.linkedAcDtlKey === null || row.linkedAcDtlKey === undefined ? null : String(row.linkedAcDtlKey);
    if (dk) {
      const owner = families.find((f) => f.dtlKeys.has(dk));
      if (owner) { owner.keyRows++; owner.claimed++; owner.rows.push(row); continue; }
      /* A key naming a line that is not on this document is not a licence to
         fall through to a weaker signal - it is a fact that disagrees with the
         export, and it gets reported. */
      unassigned.push(row);
      continue;
    }
    const sku = normSku(row.supplierSku);
    if (sku) {
      const hit = byLongestKey.find((f) => belongsToFamily(sku, f.key));
      if (hit) { hit.skuRows++; hit.claimed++; hit.rows.push(row); } else unassigned.push(row);
      continue;
    }
    const code = normSku(row.materialCode);
    const hits = code
      ? families.filter((f) => (f.code && normSku(f.code) === code) || (f.sofaModel && code.startsWith(normSku(f.sofaModel) + "-")))
      : [];
    if (hits.length === 1) { hits[0].codeRows++; hits[0].claimed++; hits[0].rows.push(row); }
    else if (hits.length > 1) ambiguous.push(row);
    else unassigned.push(row);
  }
  return { families, unassigned, ambiguous };
}

/* What the completeness check reports: a family holding fewer rows than it has
   AutoCount lines is short by the difference. It never predicts how many pieces
   a build decomposes into, so it under-reports rather than false-alarms. */
function familyShortfall(families) {
  const list = families.map((f) => ({ ...f, short: Math.max(0, f.acLines - f.claimed) }));
  return { families: list, short: list.reduce((a, f) => a + f.short, 0) };
}

/* What the repair does with one family. Rule 4 above. */
function planFamilyInserts(family, expectedRows) {
  if (family.claimed === 0) return { verdict: "absent", insert: expectedRows };
  if (family.claimed < expectedRows.length) return { verdict: "partial", insert: [] };
  return { verdict: "present", insert: [] };
}

/* Belt and braces immediately before an INSERT runs: an exact MULTISET diff on
   supplier_sku, so even a family judged absent cannot write a supplier_sku the
   document already holds. material_code is NOT part of this key - a row present
   under a different code is still present, and keying on it too would duplicate.
   Code disagreements come back reported instead. */
function diffExpectedRows(expected, existing) {
  const have = new Map();
  for (const r of existing) {
    const k = normSku(r.supplierSku);
    if (!k) continue;
    if (!have.has(k)) have.set(k, []);
    have.get(k).push(r);
  }
  const toInsert = [];
  const codeDisagreements = [];
  for (const e of expected) {
    const q = have.get(normSku(e.supplierSku));
    if (q && q.length) {
      const hit = q.shift();
      if (e.materialCode && hit.materialCode && normSku(e.materialCode) !== normSku(hit.materialCode)) {
        codeDisagreements.push({ supplierSku: e.supplierSku, expected: e.materialCode, found: hit.materialCode });
      }
      continue;
    }
    toInsert.push(e);
  }
  const extra = [];
  for (const q of have.values()) for (const r of q) extra.push(r);
  return { toInsert, extra, codeDisagreements };
}

export {
  RECEIVED_PER_LINE,
  RECEIVED_ZERO_AGGREGATE,
  RECEIVED_INDETERMINATE,
  buildGrQtyGroups,
  resolveReceivedQty,
  normSku,
  isSofaCode,
  belongsToFamily,
  normaliseAcPoLine,
  mergeAcPoLines,
  groupByDoc,
  buildFamilies,
  claimErpRows,
  familyShortfall,
  planFamilyInserts,
  diffExpectedRows,
};
