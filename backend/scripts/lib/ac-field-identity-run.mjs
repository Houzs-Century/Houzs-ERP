/* ac-field-identity-run — section 5 of check-ac-erp-reconcile.mjs, executed.
 *
 * Reads the AutoCount side from the MIGRATION EXPORTS — the very files the
 * importers read — so the checker and the writers cannot drift apart, and
 * compares every field of FIELD_MAP against the ERP column the writer names.
 *
 * TWO CUTS, AND THIS FILE SAYS WHICH IS WHICH.  `ac-reconcile-truth.json.gz`
 * (the scope + the book's own totals) and the `ac-outstanding-*` migration
 * exports are cut by different runs.  On go-live day the truth snapshot was
 * taken at 07:34Z and the migration exports at 08:21Z, one minute after the
 * book was locked view-only.  Documents that entered or left the outstanding
 * population between the two are reported as their own line — WINDOW — never
 * folded into a gap.
 *
 * READ-ONLY.  SELECTs and one information_schema introspection.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import {
  AC_BLANK, AGREE, BOTH_BLANK, CARRIED, DERIVED, DIFFER, ERP_BLANK, FIELD_MAP, NOISE, NOT_CARRIED,
  UNMATCHED, VERDICTS, blankTally, compareValue, runSelfTest, senOf,
} from "./ac-field-identity.mjs";

const gz = (dir, f) => {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8").replace(/^﻿/, ""));
};

const nz = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());

/* ── the AutoCount side, assembled from the migration exports ────────────── */
export function loadAcFieldSide(dataDir, book) {
  const missing = [];
  const need = (f) => {
    const r = gz(dataDir, f);
    if (!r) missing.push(f);
    return r || [];
  };

  const soRows = need("ac-outstanding-so.json.gz");
  const remarks = need("ac-so-remarks.json.gz");
  const status = gz(dataDir, "ac-so-status.json.gz") || [];
  const poRows = need("ac-outstanding-po.json.gz");
  const linkedPo = need("ac-so-linked-pos.json.gz");
  const doRows = need("ac-partial-dos.json.gz");

  const remByDoc = new Map(remarks.map((r) => [r.DocNo, r]));
  const statusByDoc = new Map(status.map((r) => [r.DocNo, r]));

  /* The book's own document total and line amount. The migration exports carry
     neither, and the line amount is the ONLY place a line discount is visible:
     AutoCount stores UnitPrice and SubTotal separately, and SubTotal is the
     discounted one. */
  const bookTotal = (t, docNo) => book[t]?.headers.get(docNo)?.totalSen ?? null;
  const bookLineTotal = (t, dtlKey) => book[t]?.byDtlKey.get(String(dtlKey))?.subTotalSen ?? null;

  const group = (rows, docField, lineKeyField, type) => {
    const headers = new Map();
    const lines = new Map(); // docNo -> [line]
    for (const r of rows) {
      const d = nz(r[docField]);
      if (!d) continue;
      if (!headers.has(d)) headers.set(d, { ...r, __doc: d });
      if (!lines.has(d)) lines.set(d, []);
      const key = r[lineKeyField];
      lines.get(d).push({ ...r, __key: key == null ? null : String(key), __bookLineTotalSen: bookLineTotal(type, key) });
    }
    for (const [d, h] of headers) {
      const ls = lines.get(d) || [];
      const dates = ls.map((l) => l.DeliveryDate).filter(Boolean).map((x) => String(x).slice(0, 10)).sort();
      h.__earliestDeliveryDate = dates[0] ?? null;
      h.__bookTotalSen = bookTotal(type, d);
    }
    return { headers, lines };
  };

  /* THE HEADER-MASTER CUT, merged in as a FILL-ONLY enrichment.
   *
   * WHY. The migration exports are the right source for anything an importer
   * read, which is why this file takes them and not a convenience snapshot. But
   * three fields the owner ruled in on 2026-09-07 are not in them at all:
   * SO.DisplayTerm, PO.Attention and PO.DisplayTerm. `export-ac-reimport.py`'s
   * `hdr` section already exports every one of them into ac-doc-headers.json.gz
   * — it exists precisely because the migration cut is filtered to the
   * OUTSTANDING population and carries none of the fields no importer read. So
   * the value is in the tree; without this merge the checker would report
   * "AutoCount blank" on a field the book fills on all 13,365 orders.
   *
   * FILL-ONLY, and that is the owner's own rule, not a convenience: 「保留 ERP
   * 的价钱 — 空白不覆盖」. A key the migration cut already carries is NEVER
   * overwritten from here, so the comparison keeps reading the file the writers
   * read and this cut can only ADD a field, never move one. A blank in this cut
   * cannot erase a value in that one either.
   *
   * ABSENT IS FINE. The file is optional: on a checkout without it, the three
   * fields simply stay unfilled and land in the `notExported` block, which is
   * the honest answer rather than a fabricated blank. It is deliberately NOT in
   * `need()` — a missing header cut must not make the whole section refuse. */
  const hdrCut = gz(dataDir, "ac-doc-headers.json.gz");
  const hdrBy = { SO: new Map(), PO: new Map() };
  if (hdrCut?.rows) {
    for (const [kind, fieldsKey, rowsKey] of [["SO", "so_fields", "so"], ["PO", "po_fields", "po"]]) {
      const fields = hdrCut.rows[fieldsKey] || [];
      const iDoc = fields.indexOf("DocNo");
      if (iDoc < 0) continue;
      for (const r of hdrCut.rows[rowsKey] || []) {
        const o = {};
        for (let i = 0; i < fields.length; i++) o[fields[i]] = r[i];
        hdrBy[kind].set(String(r[iDoc]).trim(), o);
      }
    }
  }
  const enrich = (kind, headers) => {
    const by = hdrBy[kind];
    if (!by.size) return;
    for (const [docNo, h] of headers) {
      const extra = by.get(docNo);
      if (!extra) continue;
      for (const [k, v] of Object.entries(extra)) {
        if (h[k] === undefined) h[k] = v; // FILL ONLY — never overwrite the migration cut
      }
    }
  };

  const SO = group(soRows, "DocNo", "DtlKey", "SO");
  for (const [d, h] of SO.headers) {
    const rem = remByDoc.get(d);
    if (rem) Object.assign(h, { Remark2: rem.Remark2, Remark3: rem.Remark3, Remark4: rem.Remark4, UDF_Note: rem.UDF_Note, SalesExemptionExpiryDate: rem.SalesExemptionExpiryDate });
    const st = statusByDoc.get(d);
    if (st) h.ToPONo = st.ToPONo;
  }
  enrich("SO", SO.headers);

  /* Both PO exports feed one population: the outstanding lane and the
     SO-dedicated lane. ac-scope.mjs states them as PO lane 1 and lane 2. */
  const PO = group([...poRows, ...linkedPo], "DocNo", "DtlKey", "PO");
  enrich("PO", PO.headers);
  const DO = group(doRows, "DoNo", "DoDtlKey", "DO");

  /* The owner's blank rule needs to know which orders were PROCEEDED. The book
     is the authority: UDF_PDate is what the ERP's processing_date is copied
     from. A purchase order inherits the state of the sales order its line is
     dedicated to; an undedicated purchase order is PROCEEDED, because every
     purchase order in this ERP is at least SUBMITTED — the supplier is already
     being asked to build it. */
  const soProceeded = new Map();
  for (const [d, h] of SO.headers) soProceeded.set(d, h.UDF_PDate != null && String(h.UDF_PDate).trim() !== "");
  const lineProceeded = { SO: new Map(), PO: new Map(), DO: new Map() };
  const docProceeded = { SO: soProceeded, PO: new Map(), DO: new Map() };
  for (const [d, ls] of SO.lines) for (const l of ls) lineProceeded.SO.set(l.__key, soProceeded.get(d) === true);
  for (const [d, ls] of PO.lines) {
    let any = false;
    for (const l of ls) {
      const src = nz(l.FromSODocList);
      const p = src ? src.split(/[,;\s]+/).some((n) => soProceeded.get(n) === true) : true;
      lineProceeded.PO.set(l.__key, p);
      any = any || p;
    }
    docProceeded.PO.set(d, any);
  }
  for (const [d, ls] of DO.lines) {
    docProceeded.DO.set(d, true);
    for (const l of ls) lineProceeded.DO.set(l.__key, true);
  }

  return { SO, PO, DO, docProceeded, lineProceeded, missing };
}

/* ── the ERP side ───────────────────────────────────────────────────────── */
/* Column names are checked against information_schema before they are named in
 * a SELECT. A field whose column does not exist is not an error: it is the
 * NOT_CARRIED finding, reported as the ERP having nothing where the book has a
 * value. What WOULD be an error is naming it in SQL and killing the statement. */
async function columnsOf(sql, schema, table) {
  const rows = await sql`SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(rows.map((r) => r.column_name));
}

export async function loadErpFieldSide(sql, CO) {
  const cols = {
    so: await columnsOf(sql, "scm", "mfg_sales_orders"),
    soi: await columnsOf(sql, "scm", "mfg_sales_order_items"),
    po: await columnsOf(sql, "scm", "purchase_orders"),
    poi: await columnsOf(sql, "scm", "purchase_order_items"),
    do: await columnsOf(sql, "scm", "delivery_orders"),
    doi: await columnsOf(sql, "scm", "delivery_order_items"),
  };
  const pick = (set, name, alias = name) => (set.has(name) ? `h.${name} AS ${alias}` : `NULL AS ${alias}`);
  const pickI = (set, name, alias = name) => (set.has(name) ? `i.${name} AS ${alias}` : `NULL AS ${alias}`);

  const soHead = [
    "h.linked_ac_docno AS ac_no", "h.doc_no AS erp_no",
    pick(cols.so, "so_date"), pick(cols.so, "debtor_code"), pick(cols.so, "debtor_name"),
    pick(cols.so, "agent"), pick(cols.so, "attention"), pick(cols.so, "phone"), pick(cols.so, "ref"),
    pick(cols.so, "customer_so_no"), pick(cols.so, "address1"), pick(cols.so, "address2"),
    pick(cols.so, "address3"), pick(cols.so, "address4"),
    /* mig 20260907T1026. `pick` degrades to `NULL AS <name>` when the column is
       absent, so a checkout whose database predates the migration reports these
       as "the ERP has nowhere to put it" rather than killing the statement. */
    pick(cols.so, "delivery_address1"), pick(cols.so, "delivery_address2"),
    pick(cols.so, "delivery_address3"), pick(cols.so, "delivery_address4"),
    pick(cols.so, "display_term"), pick(cols.so, "ac_to_po_no"),
    pick(cols.so, "emergency_contact_phone"), pick(cols.so, "sales_location"),
    pick(cols.so, "venue"), pick(cols.so, "branding"), pick(cols.so, "processing_date"),
    pick(cols.so, "balance_sen"), pick(cols.so, "customer_delivery_date"),
    pick(cols.so, "remark2"), pick(cols.so, "remark3"), pick(cols.so, "remark4"),
    pick(cols.so, "note"), pick(cols.so, "sales_exemption_expiry"), pick(cols.so, "currency"),
    pick(cols.so, "local_total_sen"),
    cols.so.has("salesperson_id") ? "CASE WHEN h.salesperson_id IS NOT NULL THEN '(an agent is named)' END AS salesperson_bound" : "NULL AS salesperson_bound",
    cols.so.has("approval_code") ? "CASE WHEN h.approval_code IS NOT NULL OR h.payment_method IS NOT NULL THEN '(a payment is stated)' END AS payment_udf_present" : "NULL AS payment_udf_present",
  ].join(", ");

  const soLine = [
    "h.linked_ac_docno AS ac_no", pickI(cols.soi, "linked_ac_dtlkey", "ac_dtlkey"),
    "COALESCE(i.line_no, 0) AS line_no",
    pickI(cols.soi, "item_code"), "i.qty::float8 AS qty", pickI(cols.soi, "unit_price_sen"),
    pickI(cols.soi, "total_sen"), pickI(cols.soi, "description"), pickI(cols.soi, "description2"),
    pickI(cols.soi, "location"), pickI(cols.soi, "line_delivery_date"),
    cols.soi.has("warehouse_id") ? "CASE WHEN i.warehouse_id IS NOT NULL THEN '(a location is named)' END AS warehouse_bound" : "NULL AS warehouse_bound",
  ].join(", ");

  const poHead = [
    "h.linked_ac_docno AS ac_no", "h.po_number AS erp_no",
    pick(cols.po, "po_date"), pick(cols.po, "expected_at"), pick(cols.po, "currency"),
    pick(cols.po, "total_sen"),
    pick(cols.po, "attention"), pick(cols.po, "display_term"), // mig 20260907T1026
    "s.code AS supplier_code", "s.name AS supplier_name",
    "w.code AS purchase_location",
  ].join(", ");

  const poLine = [
    "h.linked_ac_docno AS ac_no", pickI(cols.poi, "linked_ac_dtlkey", "ac_dtlkey"),
    "0 AS line_no",
    pickI(cols.poi, "item_code"), "i.qty::float8 AS qty", pickI(cols.poi, "unit_price_sen"),
    pickI(cols.poi, "line_total_sen"), "i.received_qty::float8 AS received_qty",
    pickI(cols.poi, "description"), pickI(cols.poi, "description2"), pickI(cols.poi, "delivery_date"),
    cols.poi.has("warehouse_id") ? "CASE WHEN i.warehouse_id IS NOT NULL THEN '(a location is named)' END AS warehouse_bound" : "NULL AS warehouse_bound",
  ].join(", ");

  const doHead = [
    "h.linked_ac_docno AS ac_no", "h.do_number AS erp_no",
    pick(cols.do, "do_date"), pick(cols.do, "debtor_code"), pick(cols.do, "debtor_name"),
    pick(cols.do, "currency"), pick(cols.do, "local_total_sen"),
    "so.linked_ac_docno AS so_ac_docno",
  ].join(", ");

  const doLine = [
    "h.linked_ac_docno AS ac_no", "COALESCE(i.line_no, 0) AS line_no",
    pickI(cols.doi, "item_code"), "i.qty::float8 AS qty", pickI(cols.doi, "unit_price_sen"),
    pickI(cols.doi, "description"),
  ].join(", ");

  /* No LIMIT anywhere, deliberately. A LIMIT 500 on a sibling check reported a
     drift of 842 as 500 earlier today; the row count is the answer, so it may
     never be capped. The counts are asserted against COUNT(*) below. */
  const q = async (text) => sql.unsafe(text);
  const out = {
    SO: {
      headers: await q(`SELECT ${soHead} FROM scm.mfg_sales_orders h WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`),
      lines: await q(`SELECT ${soLine} FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`),
    },
    PO: {
      headers: await q(`SELECT ${poHead} FROM scm.purchase_orders h LEFT JOIN scm.suppliers s ON s.id = h.supplier_id LEFT JOIN scm.warehouses w ON w.id = h.purchase_location_id WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`),
      lines: await q(`SELECT ${poLine} FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`),
    },
    DO: {
      headers: await q(`SELECT ${doHead} FROM scm.delivery_orders h LEFT JOIN scm.mfg_sales_orders so ON so.doc_no = h.so_doc_no WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`),
      lines: await q(`SELECT ${doLine} FROM scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id = i.delivery_order_id WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`),
    },
  };

  /* The no-LIMIT claim, asserted rather than trusted. */
  const counts = {};
  for (const [t, spec] of [
    ["SO", ["scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no"]],
    ["PO", ["scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id"]],
    ["DO", ["scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id = i.delivery_order_id"]],
  ]) {
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM ${spec[0]} WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`);
    counts[t] = n;
  }
  return { ...out, cols, lineCounts: counts };
}

/* ── the comparison ─────────────────────────────────────────────────────── */
export function compareType({ t, ac, erp, scope, mapped, modelOf, isSofaCode, docProceeded, lineProceeded, SHOW }) {
  const spec = FIELD_MAP[t];
  const erpHeadByAc = new Map(erp.headers.map((r) => [nz(r.ac_no), r]));

  /* SO and PO lines carry the AutoCount DtlKey. A sofa line decomposes into one
     ERP line per compartment sharing that key, and only the LEAD piece carries
     the price (parse-sofa's rule, import-ac-outstanding-so.mjs). So the lead —
     lowest line_no — is the commensurable one, and the extras are counted, not
     compared. */
  const erpLineByKey = new Map();
  const erpLinesByDoc = new Map();
  let decomposed = 0;
  for (const r of erp.lines) {
    const d = nz(r.ac_no);
    if (!erpLinesByDoc.has(d)) erpLinesByDoc.set(d, []);
    erpLinesByDoc.get(d).push(r);
    const k = r.ac_dtlkey == null ? null : String(r.ac_dtlkey).trim();
    if (!k) continue;
    const prev = erpLineByKey.get(k);
    if (!prev) erpLineByKey.set(k, r);
    else {
      decomposed++;
      if (Number(r.line_no) < Number(prev.line_no)) erpLineByKey.set(k, r);
    }
  }

  /* A field the current cut does not export has NOTHING to compare. Comparing
     it anyway would score every document as "AutoCount blank while the ERP has
     a value" — a defect-shaped number produced by missing instrumentation. */
  const headerFields = spec.header.filter((f) => !f.notExported);
  const lineFields = spec.line.filter((f) => !f.notExported);
  const notExported = [...spec.header, ...spec.line].filter((f) => f.notExported);

  const tally = {};
  const examples = {};
  for (const f of [...headerFields, ...lineFields]) {
    tally[f.key] = blankTally();
    examples[f.key] = [];
  }

  const pop = { docs: 0, docsAbsent: 0, window: 0, lines: 0, linesUnmatched: 0, decomposed };

  /* Population: in scope AND present in the migration export. A document in
     scope that the export does not carry is the WINDOW between the two cuts,
     and is reported as such, never as a gap. */
  const inScope = [...scope].sort();
  for (const docNo of inScope) {
    const acH = ac.headers.get(docNo);
    if (!acH) { pop.window++; continue; }
    const erpH = erpHeadByAc.get(docNo);
    if (!erpH) { pop.docsAbsent++; continue; }
    pop.docs++;
    const half = docProceeded.get(docNo) === true ? "yes" : "no";
    for (const f of headerFields) {
      const a = f.ac(acH);
      const e = f.erp ? erpH[f.erp] : null;
      const v = compareValue(a, e, f.kind);
      tally[f.key][half][v]++;
      if ((v === DIFFER || v === ERP_BLANK) && examples[f.key].length < SHOW) {
        examples[f.key].push({ doc: docNo, erpNo: erpH.erp_no, ac: a, erp: e, v, half });
      }
    }

    /* lines */
    const acLines = ac.lines.get(docNo) || [];
    const erpLines = (erpLinesByDoc.get(docNo) || []).slice().sort((x, y) => Number(x.line_no) - Number(y.line_no));
    const usedErp = new Set();
    for (const acL of acLines) {
      let erpL = acL.__key ? erpLineByKey.get(acL.__key) : null;
      /* Delivery-order lines carry no AutoCount line key — the writer names
         so_item_id instead — so they are paired on the translated item code,
         greedily and in document order. A line that finds no partner is
         UNMATCHED, never a difference: an unmatched pair proves nothing about
         a field. */
      if (!erpL) {
        const want = mapped(acL.ItemCode);
        const wantModel = isSofaCode(acL.ItemCode) ? modelOf(acL.ItemCode) : null;
        erpL = erpLines.find((r) => {
          if (usedErp.has(r)) return false;
          const got = mapped(r.item_code);
          if (got === want) return true;
          return wantModel != null && modelOf(r.item_code) === wantModel;
        }) || null;
      }
      pop.lines++;
      if (!erpL) {
        pop.linesUnmatched++;
        const half2 = lineProceeded.get(acL.__key) === true ? "yes" : "no";
        for (const f of lineFields) tally[f.key][half2][UNMATCHED]++;
        continue;
      }
      usedErp.add(erpL);
      const half2 = lineProceeded.get(acL.__key) === true ? "yes" : "no";
      for (const f of lineFields) {
        const a = f.ac(acL);
        let e = f.erp ? erpL[f.erp] : null;
        let v;
        if (f.kind === "code") {
          /* Trap 2 + trap 3, both already solved in the checker: codes are
             translated, and a sofa pair is commensurable only on the model. */
          const A = mapped(a);
          const E = e == null ? null : mapped(e);
          if (A == null || A === "") v = E ? AC_BLANK : BOTH_BLANK;
          else if (!E) v = ERP_BLANK;
          else if (A === E) v = AGREE;
          else if (isSofaCode(a) || isSofaCode(e)) {
            const ma = modelOf(a);
            const me = modelOf(e);
            v = ma != null && me != null && ma === me ? AGREE : DIFFER;
          } else v = DIFFER;
        } else {
          v = compareValue(a, e, f.kind);
        }
        tally[f.key][half2][v]++;
        if ((v === DIFFER || v === ERP_BLANK) && examples[f.key].length < SHOW) {
          examples[f.key].push({ doc: docNo, erpNo: erpL.erp_no ?? erpL.ac_no, key: acL.__key, ac: a, erp: e, v, half: half2 });
        }
      }
    }
  }
  return { t, spec, headerFields, lineFields, notExported, tally, examples, pop };
}

/* ── the PO line-discount row, measured on its own ──────────────────────── */
/* AutoCount PO lines carry a line discount: PO-009948 has a unit price of
 * 1,880 on a line the book totals at 1,410 — exactly 75%. The ERP stores
 * qty x unit_price, undiscounted, so every discounted line is overstated. This
 * is reported apart from the field table because it is one defect with a money
 * value, not a per-field verdict. */
export function measurePoDiscount(book, scope) {
  const whole = { docs: new Set(), lines: 0, sen: 0 };
  const inScope = { docs: new Set(), lines: 0, sen: 0 };
  const examples = [];
  for (const [docNo, ls] of book.PO.lines) {
    for (const l of ls) {
      if (l.qty == null || l.unitPriceSen == null || l.subTotalSen == null) continue;
      const undiscounted = Math.round(l.qty * l.unitPriceSen);
      if (undiscounted === l.subTotalSen) continue;
      const delta = undiscounted - l.subTotalSen;
      whole.docs.add(docNo);
      whole.lines++;
      whole.sen += delta;
      if (scope.has(docNo)) {
        inScope.docs.add(docNo);
        inScope.lines++;
        inScope.sen += delta;
        if (examples.length < 20) {
          examples.push({ doc: docNo, item: l.itemKey, qty: l.qty, unitSen: l.unitPriceSen, bookSen: l.subTotalSen, erpSen: undiscounted });
        }
      }
    }
  }
  return { whole, inScope, examples };
}

export { runSelfTest, senOf, VERDICTS, AGREE, NOISE, DIFFER, ERP_BLANK, AC_BLANK, BOTH_BLANK, UNMATCHED, CARRIED, DERIVED, NOT_CARRIED };
