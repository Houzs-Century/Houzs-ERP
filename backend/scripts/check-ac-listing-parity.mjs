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

  const acBy = { GR: new Map(), PI: new Map(), IV: new Map() };
  for (const r of snapshot) acBy[r.T].set(String(r.DtlKey), r);

  const measure = (label, erpRows, columns) => {
    const paired = erpRows.filter((e) => acBy[label].has(String(e.dtlkey)));
    const keyed = erpRows.length;
    notice(`${label}: ERP lines carrying an AutoCount detail key ${keyed}; found in the snapshot ${paired.length}`);
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
           po.po_number, po.linked_ac_docno AS po_ac_docno
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
    ["Item Code", [["item_code", (a, e) => [a.ItemCode, e.item_code], eqText], ["supplier_sku", (a, e) => [a.ItemCode, e.supplier_sku], eqText]]],
    ["Detail Description", [["material_name", (a, e) => [a.Description, e.material_name], eqText], ["description", (a, e) => [a.Description, e.description], eqText]]],
    ["Detail Description 2", [["description2", (a, e) => [a.Desc2, e.description2], eqText]]],
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
  ]);

  /* ── Purchase Invoices ──────────────────────────────────────────────── */
  const pi = await pg`
    SELECT pii.linked_ac_dtlkey::text AS dtlkey, p.invoice_number, p.linked_ac_docno, p.invoice_date::text AS invoice_date, p.supplier_invoice_ref,
           p.currency, p.exchange_rate, p.subtotal_sen, p.tax_sen, p.total_sen, p.status,
           s.code AS sup_code, s.name AS sup_name, w.code AS wh_code, w.name AS wh_name,
           pii.item_code, gi.supplier_sku, pii.material_name, pii.description, pii.description2, pii.uom, pii.qty,
           pii.unit_price_sen, pii.discount_sen, pii.line_total_sen, pii.item_group,
           po.po_number, po.linked_ac_docno AS po_ac_docno
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
  measure("PI", pi, [
    ["Doc No", [["linked_ac_docno", (a, e) => [a.DocNo, e.linked_ac_docno], eqText], ["invoice_number", (a, e) => [a.DocNo, e.invoice_number], eqText]]],
    ["Supplier Invoice No.", [["supplier_invoice_ref", (a, e) => [a.DocRef, e.supplier_invoice_ref], eqText]]],
    ["Doc Date", [["invoice_date", (a, e) => [a.DocDate, e.invoice_date], eqDay]]],
    ...party,
    ...money("PI", []),
    ...lineCols("line_total_sen/100", [["qty", (a, e) => [a.Qty, e.qty], eqNum]]),
    ["Location", [["GRN warehouse short code", (a, e) => [a.Location, short(e.wh_code, e.wh_name)], eqText]]],
    ["Our PO No.", [["PO linked_ac_docno", (a, e) => [a.LinkNo, e.po_ac_docno], eqText], ["PO po_number", (a, e) => [a.LinkNo, e.po_number], eqText]]],
  ]);

  /* ── Sales Invoices ─────────────────────────────────────────────────── */
  const iv = await pg`
    SELECT sii.linked_ac_dtlkey::text AS dtlkey, s.invoice_number, s.linked_ac_docno, s.invoice_date::text AS invoice_date,
           s.debtor_code, s.debtor_name, s.agent, st.name AS staff_name, s.ref, s.sales_location,
           s.currency, 1 AS exchange_rate, s.subtotal_sen, s.tax_sen, s.total_sen, s.status,
           d.warehouse_id, w.code AS wh_code, w.name AS wh_name, d.sales_location AS do_location,
           sii.item_code, sii.description, sii.description2, sii.uom, sii.qty,
           sii.unit_price_sen, sii.discount_sen, sii.line_total_sen, sii.item_group, sii.line_delivery_date::text AS delivery_date
    FROM scm.sales_invoice_items sii JOIN scm.sales_invoices s ON s.id = sii.sales_invoice_id
    LEFT JOIN scm.staff st ON st.id = s.salesperson_id
    LEFT JOIN scm.delivery_order_items di ON di.id = sii.do_item_id AND di.company_id = 1
    LEFT JOIN scm.delivery_orders d ON d.id = di.delivery_order_id AND d.company_id = 1
    LEFT JOIN scm.warehouses w ON w.id = d.warehouse_id
    WHERE s.company_id = 1 AND sii.company_id = 1 AND sii.linked_ac_dtlkey IS NOT NULL`;
  const [{ n: ivAll }] = await pg`SELECT count(*)::int AS n FROM scm.sales_invoice_items i JOIN scm.sales_invoices s ON s.id = i.sales_invoice_id WHERE s.company_id = 1 AND i.company_id = 1`;
  notice(`IV: company 1 lines ${ivAll}, with linked_ac_dtlkey ${iv.length}`);
  measure("IV", iv, [
    ["Doc No", [["linked_ac_docno", (a, e) => [a.DocNo, e.linked_ac_docno], eqText], ["invoice_number", (a, e) => [a.DocNo, e.invoice_number], eqText]]],
    ["Doc Date", [["invoice_date", (a, e) => [a.DocDate, e.invoice_date], eqDay]]],
    ["Debtor Code", [["debtor_code", (a, e) => [a.PartyCode, e.debtor_code], eqText]]],
    ["Debtor Name (hashed)", [["debtor_name", (a, e) => [a.PartyName ? "hash" : "", a.PartyName === hash(e.debtor_name) ? "hash" : "differs"], eqText]]],
    ["Agent (SalesAgent)", [["agent", (a, e) => [a.Agent, e.agent], eqText], ["staff.name", (a, e) => [a.Agent, e.staff_name], eqText]]],
    ["Ref.", [["ref", (a, e) => [a.DocRef, e.ref], eqText]]],
    ["Curr. Code", [["currency", (a, e) => [a.CurrencyCode, e.currency], eqText]]],
    ["SubTotal (Ex)", [["subtotal_sen/100", (a, e) => [a.TotalExTax, sen(e.subtotal_sen)], eqNum], ["total_sen/100", (a, e) => [a.TotalExTax, sen(e.total_sen)], eqNum]]],
    ["Total (header)", [["total_sen/100", (a, e) => [a.NetTotal, sen(e.total_sen)], eqNum]]],
    ["Cancelled", [["status = CANCELLED", (a, e) => [a.Cancelled === "T", String(e.status).toUpperCase() === "CANCELLED"], (x, y) => x === y]]],
    ...lineCols("line_total_sen/100", [["qty", (a, e) => [a.Qty, e.qty], eqNum]]).filter(([c]) => c !== "Item Code"),
    ["Item Code", [["item_code", (a, e) => [a.ItemCode, e.item_code], eqText]]],
    ["Location", [
      ["DO warehouse, else DO sales_location, else SI sales_location (short)", (a, e) => [a.Location, short(e.wh_code, e.wh_name) || short(e.do_location) || short(e.sales_location)], eqText],
      ["SI sales_location (short)", (a, e) => [a.Location, short(e.sales_location)], eqText],
    ]],
    ["Delivery Date", [["line_delivery_date", (a, e) => [a.DeliveryDate, e.delivery_date], eqDay]]],
  ]);
  notice("DONE: read-only listing parity measured.");
} catch (e) {
  console.error(e?.stack ?? e?.message ?? e);
  await pg.end({ timeout: 5 });
  process.exit(1);
}
await pg.end({ timeout: 5 });
