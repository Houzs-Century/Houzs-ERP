// Read-only: how many ERP values equal AutoCount's Detail Listing, column by
// column, for Goods Received (GR), Purchase Invoice (PI) and Sales Invoice (IV)
// lines.
//
// WHY. Owner 2026-09-15: a transaction list's Excel export must be 100%
// AutoCount's listing format — the same labels AND the same values. Before an
// export promises a value, this measures which ERP column holds it. AutoCount's
// side is the committed snapshot backend/scripts/data/ac-listing-lines.json.gz
// (producer: export-ac-listing-lines.py, run over ZeroTier; a CI runner cannot
// reach AutoCount). The ERP side is production through DATABASE_URL, read-only.
//
// Lines are paired by AutoCount's own detail key: grn_items /
// purchase_invoice_items / sales_invoice_items.linked_ac_dtlkey = DtlKey. For
// each AutoCount listing column it prints matched / compared for every ERP
// candidate source, and a few mismatching examples (no customer names: the
// snapshot holds only a hash of them, and none are printed).
//
// Company 1 only: 2990's Home (company 2) never syncs to AutoCount.
// Exits 0 for every answer; non-zero only when the database cannot be reached.
//
// RE-RUN: python backend/scripts/export-ac-listing-lines.py (office network),
//         then Actions -> "GRN / PI / SI line export check (read-only)".
import postgres from "postgres";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}
const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const pg = postgres(url, {
  ssl: "require",
  prepare: false,
  max: 1,
  types: { dateText: asText(1082), timestampText: asText(1114), timestamptzText: asText(1184) },
});

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(gunzipSync(readFileSync(join(here, "data", "ac-listing-lines.json.gz"))).toString("utf8"));
const manifest = JSON.parse(readFileSync(join(here, "data", "ac-listing-lines-manifest.json"), "utf8"));

const txt = (v) => (v === null || v === undefined ? "" : String(v).trim());
const day = (v) => txt(v).slice(0, 10);
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const sen = (v) => (v === null || v === undefined ? null : Number(v) / 100);
const hash = (v) => {
  const s = txt(v).toUpperCase();
  return s ? createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16) : null;
};
const eqText = (a, b) => txt(a) === txt(b);
const eqNum = (a, b) => {
  const x = num(a) ?? 0;
  const y = num(b) ?? 0;
  return Math.abs(x - y) < 0.005;
};
const eqDay = (a, b) => day(a) === day(b);

try {
  await pg`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  notice(`AutoCount snapshot: exported ${manifest.exportedAt}, documents since ${manifest.since}, rows ${JSON.stringify(manifest.rows)}`);
  const { bookSpellingOrOwn } = await import("../src/services/autocount-writeback.ts");
  const { LOCATION_MAP } = await import("../src/services/autocount-master-maps.ts");
  const short = (code, name) => bookSpellingOrOwn(txt(code) || txt(name) || null, LOCATION_MAP) ?? "";
  const { resolveAcItemCode } = await import("../src/services/autocount-item-code.ts");
  const { resolveAcAgent } = await import("../src/services/autocount-writeback.ts");
  const { siExportAgent } = await import("../src/scm/lib/si-export-rows.ts");
  const { bindingsFor } = await import("../src/scm/lib/autocount-outbox.ts");
  const { buildVariantSummary } = await import("../src/scm/shared/variant-summary.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const { splitSofaCode } = await import("../src/services/autocount-sofa-collapse.ts");
  const { bookLineItem, acBookItemIndex } = await import("../src/services/autocount-book-item.ts");
  /* bookLineItem as shipped (no bindings), and the book item of the
     bindings-resolved code with the same ERP fallback rule. */
  const bookOf = (e, supplierCode, description) => bookLineItem({ itemCode: e.item_code, description, category: e.item_group, uom: e.uom }, supplierCode);
  const bookByBoundCode = (e, description) => {
    const b = e.ac_item_code ? acBookItemIndex().get(String(e.ac_item_code).trim().toUpperCase()) : undefined;
    return {
      description: txt(b?.description) || txt(description) || null,
      itemGroup: txt(b?.itemGroup) || txt(e.item_group).toUpperCase() || null,
      uom: txt(b?.baseUom) || txt(e.uom).toUpperCase() || null,
    };
  };
  const bookWith = (e, descOf) => bookLineItem({ itemCode: e.item_code, description: descOf(e), category: e.item_group, uom: e.uom }, e.supplier_code_for_book ?? null, { bindings: e.bindings });
  const bookCols = (supplierCodeOf, descOf) => [
    ["EXPORT: bookLineItem WITH bindings", [
      ["Item Code", (a, e) => [a.ItemCode, bookWith(e, descOf).itemCode], eqText],
      ["Detail Description", (a, e) => [a.Description, bookWith(e, descOf).description], eqText],
      ["Item Group", (a, e) => [a.ItemGroup, bookWith(e, descOf).itemGroup], eqText],
      ["UOM", (a, e) => [a.UOM, bookWith(e, descOf).uom], eqText],
    ]],
    ["Item Code (book)", [
      ["bookLineItem.itemCode (no bindings)", (a, e) => [a.ItemCode, bookOf(e, supplierCodeOf(e), descOf(e)).itemCode], eqText],
      ["resolveAcItemCode+bindings", (a, e) => [a.ItemCode, e.ac_item_code], eqText],
    ]],
    ["Detail Description (book)", [
      ["bookLineItem.description (no bindings)", (a, e) => [a.Description, bookOf(e, supplierCodeOf(e), descOf(e)).description], eqText],
      ["book item of bindings code", (a, e) => [a.Description, bookByBoundCode(e, descOf(e)).description], eqText],
    ]],
    ["Item Group (book)", [
      ["bookLineItem.itemGroup (no bindings)", (a, e) => [a.ItemGroup, bookOf(e, supplierCodeOf(e), descOf(e)).itemGroup], eqText],
      ["book item of bindings code", (a, e) => [a.ItemGroup, bookByBoundCode(e, descOf(e)).itemGroup], eqText],
    ]],
    ["UOM (book)", [
      ["bookLineItem.uom (no bindings)", (a, e) => [a.UOM, bookOf(e, supplierCodeOf(e), descOf(e)).uom], eqText],
      ["book item of bindings code", (a, e) => [a.UOM, bookByBoundCode(e, descOf(e)).uom], eqText],
    ]],
  ];
  const sb = pgrestShim(pg, "scm");
  const variantsOf = (v) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);
  const desc2Of = (e, labelled) => txt(buildVariantSummary(e.item_group, variantsOf(e.variants), { labelled })) || txt(e.description2);
  /* The write-back's own item-code resolution: bindings for the document's
     supplier (purchase side) or none (sales side), then resolveAcItemCode. */
  const resolveCodes = async (rows, supplierCodeOf, supplierIdOf) => {
    const bySupplier = new Map();
    for (const r of rows) {
      const k = supplierIdOf(r) ?? "";
      const arr = bySupplier.get(k) ?? [];
      arr.push(r);
      bySupplier.set(k, arr);
    }
    for (const [supplierId, group] of bySupplier) {
      const bindings = await bindingsFor(sb, 1, group.map((r) => r.item_code), supplierId || null);
      for (const r of group) {
        const res = r.item_code ? resolveAcItemCode(r.item_code, { supplierCode: supplierCodeOf(r), bindings }) : null;
        r.ac_item_code = res && res.ok ? res.acItemCode : null;
        r.bindings = bindings;
        r.supplier_code_for_book = supplierCodeOf(r);
      }
    }
    if (sb.__gaps.length) notice(`GAP in bindings read: ${sb.__gaps.join(" | ")}`);
  };

  const acBy = { GR: new Map(), PI: new Map(), IV: new Map() };
  for (const r of snapshot) acBy[r.T].set(String(r.DtlKey), r);

  const measure = (label, erpRows, columns) => {
    const paired = erpRows.filter((e) => acBy[label].has(String(e.dtlkey)));
    const keyed = erpRows.length;
    notice(`${label}: ERP lines carrying an AutoCount detail key ${keyed}; found in the snapshot ${paired.length}; of those, sofa PIECES (one ERP row per piece where the book holds one set line, owner 2026-09-15) ${paired.filter((e) => splitSofaCode(txt(e.item_code))).length}`);
    for (const [column, candidates] of columns) {
      const parts = [];
      for (const [source, pick, same] of candidates) {
        let ok = 0;
        const bad = [];
        for (const e of paired) {
          const a = acBy[label].get(String(e.dtlkey));
          const [acValue, erpValue] = pick(a, e);
          if (same(acValue, erpValue)) ok += 1;
          else if (bad.length < 3) bad.push(`${a.DocNo}#${a.Seq}: AC=${JSON.stringify(acValue)} ERP=${JSON.stringify(erpValue)}`);
        }
        const pct = paired.length ? ((100 * ok) / paired.length).toFixed(1) : "n/a";
        /* Examples name item codes and prices only: a column that could carry a
           person (agent, customer reference, customer name) prints counts alone. */
        const quiet = /Agent|Ref|Debtor/.test(column);
        parts.push(`${source} ${ok}/${paired.length} (${pct}%)${bad.length && !quiet ? ` e.g. ${bad.join(" | ")}` : ""}`);
      }
      notice(`${label} "${column}": ${parts.join(" ;; ")}`);
    }
  };

  /* ── Goods Received ─────────────────────────────────────────────────── */
  const gr = await pg`
    SELECT gi.linked_ac_dtlkey::text AS dtlkey, g.grn_number, g.linked_ac_docno, g.linked_ac_gr_docno, g.migrated_no_stock,
           g.received_at::text AS received_at, g.delivery_note_ref, g.currency, g.exchange_rate, g.subtotal_sen, g.tax_sen, g.total_sen, g.status,
           s.code AS sup_code, s.name AS sup_name, w.code AS wh_code, w.name AS wh_name,
           gi.item_code, gi.supplier_sku, gi.material_name, gi.description, gi.description2, gi.uom, gi.qty_accepted, gi.qty_received,
           gi.unit_price_sen, gi.discount_sen, gi.line_total_sen, gi.item_group, gi.delivery_date::text AS delivery_date,
           po.po_number, po.linked_ac_docno AS po_ac_docno, g.supplier_id::text AS supplier_id, gi.variants
    FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
    LEFT JOIN scm.suppliers s ON s.id = g.supplier_id
    LEFT JOIN scm.warehouses w ON w.id = g.warehouse_id
    LEFT JOIN scm.purchase_order_items poi ON poi.id = gi.purchase_order_item_id AND poi.company_id = 1
    LEFT JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id AND po.company_id = 1
    WHERE g.company_id = 1 AND gi.company_id = 1 AND gi.linked_ac_dtlkey IS NOT NULL`;
  const [{ n: grAll }] = await pg`SELECT count(*)::int AS n FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id WHERE g.company_id = 1 AND gi.company_id = 1`;
  notice(`GR: company 1 lines ${grAll}, with linked_ac_dtlkey ${gr.length}`);

  const party = [
    ["Creditor Code", [["suppliers.code", (a, e) => [a.PartyCode, e.sup_code], eqText]]],
    ["Creditor Name", [["suppliers.name", (a, e) => [a.PartyName, e.sup_name], eqText]]],
  ];
  const money = (label, headerOnly) => [
    ["Curr. Code", [["currency", (a, e) => [a.CurrencyCode, e.currency], eqText]]],
    ["Curr. Rate", [["exchange_rate", (a, e) => [a.CurrencyRate, e.exchange_rate ?? 1], eqNum]]],
    ["SubTotal (Ex)", [["subtotal_sen/100", (a, e) => [a.TotalExTax, sen(e.subtotal_sen)], eqNum], ["total_sen/100", (a, e) => [a.TotalExTax, sen(e.total_sen)], eqNum]]],
    ["Tax (header)", [["tax_sen/100", (a, e) => [a.Tax, sen(e.tax_sen)], eqNum]]],
    ["Total (header)", [["total_sen/100", (a, e) => [a.NetTotal, sen(e.total_sen)], eqNum]]],
    ["Local Total", [["total_sen/100 x rate", (a, e) => [a.LocalNetTotal, (sen(e.total_sen) ?? 0) * Number(e.exchange_rate ?? 1)], eqNum]]],
    ["Cancelled", [["status = CANCELLED", (a, e) => [a.Cancelled === "T", String(e.status).toUpperCase() === "CANCELLED"], (x, y) => x === y]]],
    ...headerOnly,
  ];
  const lineCols = (lineTotal, qtyCol) => [
    ["Item Code", [["item_code", (a, e) => [a.ItemCode, e.item_code], eqText], ["supplier_sku", (a, e) => [a.ItemCode, e.supplier_sku], eqText], ["resolveAcItemCode(+bindings)", (a, e) => [a.ItemCode, e.ac_item_code], eqText]]],
    ["Detail Description", [["material_name", (a, e) => [a.Description, e.material_name], eqText], ["description", (a, e) => [a.Description, e.description], eqText]]],
    ["Detail Description 2", [["description2", (a, e) => [a.Desc2, e.description2], eqText], ["buildVariantSummary || description2", (a, e) => [a.Desc2, desc2Of(e, false)], eqText], ["buildVariantSummary labelled || description2", (a, e) => [a.Desc2, desc2Of(e, true)], eqText]]],
    ["Detail Description (AutoCount line vs its OWN item master)", [["Item.Description", (a) => [a.Description, a.ItemMasterDesc], eqText]]],
    ["UOM (AutoCount line vs its OWN item master)", [["Item.BaseUOM", (a) => [a.UOM, a.ItemBaseUOM], eqText]]],
    ["Desc2 (UDF_Desc2)", [["description2", (a, e) => [a.UDF_Desc2, e.description2], eqText]]],
    ["UOM", [["uom", (a, e) => [a.UOM, e.uom], eqText]]],
    ["Qty", qtyCol],
    ["Unit Price", [["unit_price_sen/100", (a, e) => [a.UnitPrice, sen(e.unit_price_sen)], eqNum]]],
    ["Discount (DiscountAmt)", [["discount_sen/100", (a, e) => [a.DiscountAmt, sen(e.discount_sen)], eqNum]]],
    ["Total (line SubTotal)", [[lineTotal, (a, e) => [a.SubTotal, sen(e.line_total_sen)], eqNum]]],
    ["Item Group", [["item_group (case-insensitive)", (a, e) => [txt(a.ItemGroup).toUpperCase(), txt(e.item_group).toUpperCase()], eqText]]],
    ["Tax Code / Tax (line)", [["AutoCount blank / 0", (a) => [`${txt(a.TaxCode)}|${num(a.DtlTax) ?? 0}`, "|0"], eqText]]],
    ["Proj No", [["AutoCount blank", (a) => [a.ProjNo, ""], eqText]]],
    ["Agent", [["AutoCount blank", (a) => [a.Agent, ""], eqText]]],
  ];

  await resolveCodes(gr, (r) => r.sup_code, (r) => r.supplier_id);
  measure("GR", gr, [
    ["Doc No", [
      ["AC GR no. (linked_ac_gr_docno if migrated, else linked_ac_docno)", (a, e) => [a.DocNo, e.migrated_no_stock ? e.linked_ac_gr_docno : e.linked_ac_docno], eqText],
      ["grn_number", (a, e) => [a.DocNo, e.grn_number], eqText],
    ]],
    ["Supplier DO No", [["delivery_note_ref", (a, e) => [a.DocRef, e.delivery_note_ref], eqText]]],
    ["Doc Date", [["received_at", (a, e) => [a.DocDate, e.received_at], eqDay]]],
    ...party,
    ...money("GR", []),
    ...lineCols("line_total_sen/100", [["qty_accepted", (a, e) => [a.Qty, e.qty_accepted], eqNum], ["qty_received", (a, e) => [a.Qty, e.qty_received], eqNum]]),
    ["Location", [["warehouse short code", (a, e) => [a.Location, short(e.wh_code, e.wh_name)], eqText]]],
    ["Our PO No.", [["PO linked_ac_docno", (a, e) => [a.LinkNo, e.po_ac_docno], eqText], ["PO po_number", (a, e) => [a.LinkNo, e.po_number], eqText]]],
    ["Delivery Date", [["delivery_date", (a, e) => [a.DeliveryDate, e.delivery_date], eqDay]]],
    ...bookCols((e) => e.sup_code, (e) => txt(e.material_name) || txt(e.description)),
  ]);

  /* ── Purchase Invoices ──────────────────────────────────────────────── */
  const pi = await pg`
    SELECT pii.linked_ac_dtlkey::text AS dtlkey, p.invoice_number, p.linked_ac_docno, p.invoice_date::text AS invoice_date, p.supplier_invoice_ref,
           p.currency, p.exchange_rate, p.subtotal_sen, p.tax_sen, p.total_sen, p.status,
           s.code AS sup_code, s.name AS sup_name, w.code AS wh_code, w.name AS wh_name,
           pii.item_code, gi.supplier_sku, pii.material_name, pii.description, pii.description2, pii.uom, pii.qty,
           pii.unit_price_sen, pii.discount_sen, pii.line_total_sen, pii.item_group,
           po.po_number, po.linked_ac_docno AS po_ac_docno, p.supplier_id::text AS supplier_id, pii.variants
    FROM scm.purchase_invoice_items pii JOIN scm.purchase_invoices p ON p.id = pii.purchase_invoice_id
    LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
    LEFT JOIN scm.grn_items gi ON gi.id = pii.grn_item_id AND gi.company_id = 1
    LEFT JOIN scm.grns g ON g.id = gi.grn_id AND g.company_id = 1
    LEFT JOIN scm.warehouses w ON w.id = g.warehouse_id
    LEFT JOIN scm.purchase_order_items poi ON poi.id = gi.purchase_order_item_id AND poi.company_id = 1
    LEFT JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id AND po.company_id = 1
    WHERE p.company_id = 1 AND pii.company_id = 1 AND pii.linked_ac_dtlkey IS NOT NULL`;
  const [{ n: piAll }] = await pg`SELECT count(*)::int AS n FROM scm.purchase_invoice_items i JOIN scm.purchase_invoices p ON p.id = i.purchase_invoice_id WHERE p.company_id = 1 AND i.company_id = 1`;
  notice(`PI: company 1 lines ${piAll}, with linked_ac_dtlkey ${pi.length}`);
  await resolveCodes(pi, (r) => r.sup_code, (r) => r.supplier_id);
  measure("PI", pi, [
    ["Doc No", [["linked_ac_docno", (a, e) => [a.DocNo, e.linked_ac_docno], eqText], ["invoice_number", (a, e) => [a.DocNo, e.invoice_number], eqText]]],
    ["Supplier Invoice No.", [["supplier_invoice_ref", (a, e) => [a.DocRef, e.supplier_invoice_ref], eqText]]],
    ["Doc Date", [["invoice_date", (a, e) => [a.DocDate, e.invoice_date], eqDay]]],
    ...party,
    ...money("PI", []),
    ...lineCols("line_total_sen/100", [["qty", (a, e) => [a.Qty, e.qty], eqNum]]),
    ["Location", [["GRN warehouse short code", (a, e) => [a.Location, short(e.wh_code, e.wh_name)], eqText]]],
    ["Our PO No.", [["PO linked_ac_docno", (a, e) => [a.LinkNo, e.po_ac_docno], eqText], ["PO po_number", (a, e) => [a.LinkNo, e.po_number], eqText]]],
    ...bookCols((e) => e.sup_code, (e) => txt(e.material_name) || txt(e.description)),
  ]);

  /* ── Sales Invoices ─────────────────────────────────────────────────── */
  const iv = await pg`
    SELECT sii.linked_ac_dtlkey::text AS dtlkey, s.invoice_number, s.linked_ac_docno, s.invoice_date::text AS invoice_date,
           s.debtor_code, s.debtor_name, s.agent, st.name AS staff_name, s.ref, s.sales_location,
           s.currency, 1 AS exchange_rate, s.subtotal_sen, s.tax_sen, s.total_sen, s.status,
           d.warehouse_id, w.code AS wh_code, w.name AS wh_name, d.sales_location AS do_location,
           sii.item_code, sii.description, sii.description2, sii.uom, sii.qty,
           sii.unit_price_sen, sii.discount_sen, sii.line_total_sen, sii.item_group, sii.line_delivery_date::text AS delivery_date, sii.variants
    FROM scm.sales_invoice_items sii JOIN scm.sales_invoices s ON s.id = sii.sales_invoice_id
    LEFT JOIN scm.staff st ON st.id = s.salesperson_id
    LEFT JOIN scm.delivery_order_items di ON di.id = sii.do_item_id AND di.company_id = 1
    LEFT JOIN scm.delivery_orders d ON d.id = di.delivery_order_id AND d.company_id = 1
    LEFT JOIN scm.warehouses w ON w.id = d.warehouse_id
    WHERE s.company_id = 1 AND sii.company_id = 1 AND sii.linked_ac_dtlkey IS NOT NULL`;
  const [{ n: ivAll }] = await pg`SELECT count(*)::int AS n FROM scm.sales_invoice_items i JOIN scm.sales_invoices s ON s.id = i.sales_invoice_id WHERE s.company_id = 1 AND i.company_id = 1`;
  notice(`IV: company 1 lines ${ivAll}, with linked_ac_dtlkey ${iv.length}`);
  await resolveCodes(iv, () => null, () => null);
  measure("IV", iv, [
    ["Doc No", [["linked_ac_docno", (a, e) => [a.DocNo, e.linked_ac_docno], eqText], ["invoice_number", (a, e) => [a.DocNo, e.invoice_number], eqText]]],
    ["Doc Date", [["invoice_date", (a, e) => [a.DocDate, e.invoice_date], eqDay]]],
    ["Debtor Code", [["debtor_code", (a, e) => [a.PartyCode, e.debtor_code], eqText]]],
    ["Debtor Name (hashed)", [["debtor_name", (a, e) => [a.PartyName ? "hash" : "", a.PartyName === hash(e.debtor_name) ? "hash" : "differs"], eqText]]],
    ["Agent (SalesAgent)", [["agent", (a, e) => [a.Agent, e.agent], eqText], ["staff.name", (a, e) => [a.Agent, e.staff_name], eqText], ["resolveAcAgent(agent, staff.name)", (a, e) => [a.Agent, resolveAcAgent(e.agent, e.staff_name)], eqText], ["siExportAgent (upper-cased)", (a, e) => [a.Agent, siExportAgent(e.agent, e.staff_name)], eqText]]],
    ["Ref.", [["ref", (a, e) => [a.DocRef, e.ref], eqText]]],
    ["Curr. Code", [["currency", (a, e) => [a.CurrencyCode, e.currency], eqText]]],
    ["SubTotal (Ex)", [["subtotal_sen/100", (a, e) => [a.TotalExTax, sen(e.subtotal_sen)], eqNum], ["total_sen/100", (a, e) => [a.TotalExTax, sen(e.total_sen)], eqNum]]],
    ["Total (header)", [["total_sen/100", (a, e) => [a.NetTotal, sen(e.total_sen)], eqNum]]],
    ["Cancelled", [["status = CANCELLED", (a, e) => [a.Cancelled === "T", String(e.status).toUpperCase() === "CANCELLED"], (x, y) => x === y]]],
    ...lineCols("line_total_sen/100", [["qty", (a, e) => [a.Qty, e.qty], eqNum]]).filter(([c]) => c !== "Item Code"),
    ["Item Code", [["item_code", (a, e) => [a.ItemCode, e.item_code], eqText], ["resolveAcItemCode(+bindings)", (a, e) => [a.ItemCode, e.ac_item_code], eqText]]],
    ["Location", [
      ["DO warehouse, else DO sales_location, else SI sales_location (short)", (a, e) => [a.Location, short(e.wh_code, e.wh_name) || short(e.do_location) || short(e.sales_location)], eqText],
      ["SI sales_location (short)", (a, e) => [a.Location, short(e.sales_location)], eqText],
    ]],
    ["Delivery Date", [["line_delivery_date", (a, e) => [a.DeliveryDate, e.delivery_date], eqDay]]],
    ...bookCols(() => null, (e) => txt(e.description)),
  ]);
  for (const [label, rows] of [["GR", gr], ["PI", pi], ["IV", iv]]) {
    const paired = rows.filter((e) => acBy[label].has(String(e.dtlkey)));
    const nonSofa = paired.filter((e) => !splitSofaCode(txt(e.item_code)));
    const ok = nonSofa.filter((e) => eqText(acBy[label].get(String(e.dtlkey)).ItemCode, e.ac_item_code)).length;
    const bad = nonSofa.filter((e) => !eqText(acBy[label].get(String(e.dtlkey)).ItemCode, e.ac_item_code)).slice(0, 5)
      .map((e) => `${acBy[label].get(String(e.dtlkey)).DocNo}: AC=${JSON.stringify(acBy[label].get(String(e.dtlkey)).ItemCode)} ERP=${JSON.stringify(e.ac_item_code)} (erp code ${JSON.stringify(e.item_code)})`);
    notice(`${label} "Item Code" NON-SOFA lines: resolveAcItemCode(+bindings) ${ok}/${nonSofa.length} (${nonSofa.length ? ((100 * ok) / nonSofa.length).toFixed(1) : "n/a"}%); sofa pieces excluded ${paired.length - nonSofa.length}${bad.length ? ` e.g. ${bad.join(" | ")}` : ""}`);
  }
  {
    const { AGENT_MAP } = await import("../src/services/autocount-master-maps.ts");
    const mapKeys = new Set(Object.keys(AGENT_MAP).map((k) => k.trim().toUpperCase()));
    const mapVals = new Set(Object.values(AGENT_MAP).map((k) => String(k).trim().toUpperCase()));
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
    const classes = new Map();
    const add = (k, ex) => { const c = classes.get(k) ?? { n: 0, ex: [] }; c.n += 1; if (c.ex.length < 3) c.ex.push(ex); classes.set(k, c); };
    let hit = 0;
    for (const e of iv.filter((x) => acBy.IV.has(String(x.dtlkey)))) {
      const a = acBy.IV.get(String(e.dtlkey));
      const got = siExportAgent(e.agent, e.staff_name);
      if (eqText(a.Agent, got)) { hit += 1; continue; }
      const ex = `${a.DocNo}: AC=${JSON.stringify(a.Agent)} ERP agent=${JSON.stringify(e.agent)} staff=${JSON.stringify(e.staff_name)} resolved=${JSON.stringify(got)}`;
      if (!txt(a.Agent)) add("AutoCount agent blank", ex);
      else if (got && txt(got).toUpperCase().replace(/s+/g, " ") === txt(a.Agent).toUpperCase().replace(/s+/g, " ")) add("same name, different spacing", ex);
      else if (got && (txt(a.Agent).toUpperCase().includes(txt(got).toUpperCase()) || txt(got).toUpperCase().includes(txt(a.Agent).toUpperCase()))) add("one name contains the other (short vs full name)", ex);
      else if (!txt(e.agent) && !txt(e.staff_name)) add("ERP has no agent text and no salesperson", ex);
      else if (UUID.test(txt(e.agent)) && !txt(e.staff_name)) add("agent text is a staff uuid with no salesperson link", ex);
      else if (!got) add("nothing resolved", ex);
      else if (!mapKeys.has(txt(e.agent).toUpperCase()) && !mapKeys.has(txt(e.staff_name).toUpperCase()) && !mapVals.has(txt(got).toUpperCase())) add("salesperson name not in AGENT_MAP (sent as itself)", ex);
      else add("mapped to a DIFFERENT AutoCount agent than the book holds", ex);
    }
    notice(`IV Agent: siExportAgent (upper-cased) matches ${hit}; misses by class: ${[...classes].map(([k, c]) => `${k} ${c.n}`).join("; ")}`);
    for (const [k, c] of classes) notice(`IV Agent miss "${k}" examples: ${c.ex.join(" | ")}`);
  }
  /* Owner ruling 2026-09-15: Item Description 2 exports the variant summary,
     the stored text only as the fallback. How many lines would change? */
  for (const [table, parent, fk] of [["grn_items", "grns", "grn_id"], ["purchase_invoice_items", "purchase_invoices", "purchase_invoice_id"], ["sales_invoice_items", "sales_invoices", "sales_invoice_id"]]) {
    const rows = await pg.unsafe(`SELECT h.company_id, i.item_group, i.variants, i.description2 FROM scm.${table} i JOIN scm.${parent} h ON h.id = i.${fk} WHERE i.company_id = h.company_id`);
    const by = new Map();
    for (const r of rows) {
      const c = by.get(r.company_id) ?? { lines: 0, summary: 0, differs: 0, storedOnly: 0, bothBlank: 0 };
      const summary = txt(buildVariantSummary(r.item_group, variantsOf(r.variants)));
      const stored = txt(r.description2);
      c.lines += 1;
      if (summary) { c.summary += 1; if (summary !== stored) c.differs += 1; }
      else if (stored) c.storedOnly += 1;
      else c.bothBlank += 1;
      by.set(r.company_id, c);
    }
    for (const [cid, c] of by) {
      notice(`Description 2 ${table} company ${cid}: ${c.lines} lines; variant summary non-empty ${c.summary}, of which stored text DIFFERS ${c.differs}; summary empty but stored text present (fallback used) ${c.storedOnly}; both blank ${c.bothBlank}`);
    }
  }
  notice("DONE: read-only listing parity measured.");
} catch (e) {
  console.error(e?.stack ?? e?.message ?? e);
  await pg.end({ timeout: 5 });
  process.exit(1);
}
await pg.end({ timeout: 5 });
