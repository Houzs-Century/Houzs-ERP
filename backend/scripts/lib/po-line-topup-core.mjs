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
// 1. DtlKey CANNOT be the join key. scm.purchase_order_items has no AutoCount
//    DtlKey column - the only DtlKey in the whole migrations-pg tree sits inside
//    a photo-object key comment (0274). The AutoCount line identity never
//    reached the database, so it has to be reconstructed.
//
// 2. supplier_sku FIRST. Both cutover importers write the AutoCount ItemCode
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

/* One AutoCount PO line, in the shape both exports can be read through.
   ac-outstanding-po.json.gz calls the received quantity TransferedQty;
   ac-so-linked-pos.json.gz calls it GrQty. They mean the same thing. */
function normaliseAcPoLine(r) {
  return {
    docNo: r.DocNo ?? null,
    dtlKey: r.DtlKey === null || r.DtlKey === undefined ? null : String(r.DtlKey),
    docDate: r.DocDate ?? null,
    creditorCode: r.CreditorCode ?? null,
    itemCode: r.ItemCode ?? "",
    description: r.Description ?? null,
    desc2: r.Desc2 ?? null,
    qty: acNum(r.Qty),
    receivedQty: acNum(r.TransferedQty ?? r.GrQty),
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
  const put = (raw, src) => {
    const n = normaliseAcPoLine(raw);
    if (!n.dtlKey) return;
    const prev = out.get(n.dtlKey);
    if (!prev) {
      n.sources = [src];
      out.set(n.dtlKey, n);
      return;
    }
    prev.sources.push(src);
    for (const k of Object.keys(n)) {
      if (k === "sources") continue;
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
        code: r.code ?? null, sofaModel: r.sofaModel ?? null,
        acLines: 0, lines: [], skuRows: 0, codeRows: 0, claimed: 0, rows: [],
      });
    }
    const f = m.get(key);
    f.acLines++;
    f.lines.push(l);
  }
  return [...m.values()];
}

/* Claim the document's ERP rows for its families. erpRows are
   { supplierSku, materialCode, ... }. Rules 2 and 3 above. */
function claimErpRows(families, erpRows) {
  for (const f of families) { f.skuRows = 0; f.codeRows = 0; f.claimed = 0; f.rows = []; }
  const byLongestKey = [...families].sort((a, b) => b.key.length - a.key.length);
  const unassigned = [];
  const ambiguous = [];
  for (const row of erpRows) {
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
