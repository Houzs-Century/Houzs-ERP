/* ac-field-identity — "一模一样" read FIELD BY FIELD, not as a total.
 *
 * WHY THIS FILE EXISTS.  check-ac-erp-reconcile.mjs compares document
 * presence, line count, item code, quantity, unit price, document total and
 * the VARIANTS inside a line.  Nothing compared the rest of the header, so a
 * wrong address, a wrong agent, a wrong delivery date or a wrong remark was
 * invisible while the checker printed CLEAN.  The owner's bar on go-live day
 * (2026-09-07) is narrower than the totals agreeing:
 *
 *   「我要确保这个数据一模一样 和最新的 … 不管是 sales agent 还是里面的数据
 *     我们全部都要,而且要跟 autocount 一模一样,然后再确保我们的规则是有跟着的。」
 *
 * ── THE FIELD LIST IS TAKEN FROM THE WRITERS, NOT INVENTED HERE ─────────────
 * Every row of FIELD_MAP below cites the importer line that writes it.  That
 * citation is the point: a field list typed independently of the writers drifts
 * away from them silently, and then the checker measures a migration nobody
 * ran.  When an importer starts or stops carrying a column, this file is wrong
 * in a way the citation makes findable.  The four writers are:
 *
 *   import-ac-outstanding-so.mjs      SO header + line   (HCOLS / ICOLS)
 *   import-ac-outstanding-po.mjs      PO header + line   (the INSERT at :376)
 *   import-ac-so-linked-pos.mjs       PO header + line   (the INSERT at :386)
 *   create-migrated-documents.mjs     DO header + line   (the INSERT at :317)
 *
 * ── THREE STATUSES, AND WHY A DIFFERENCE IS NOT AUTOMATICALLY A DEFECT ─────
 *   CARRIED    the writer copies the book's value.  A difference is a DEFECT.
 *   DERIVED    the writer computes the value from the book by a stated rule
 *              (postcode out of the address, the header ETA as the earliest
 *              line date, the ERP product name instead of AutoCount's own
 *              Description).  A difference is reported in its own column and
 *              is NOT counted as a gap — it measures the derivation.
 *   NOT_CARRIED  the book has the column, the writer names no ERP column for
 *              it.  This is the one the old checker could never see, and it is
 *              exactly "ERP blank while AutoCount has a value" at the level of
 *              a whole field rather than one document.
 *
 * ── THE OWNER'S BLANK RULE ─────────────────────────────────────────────────
 * 「还没proceed还没确认的就可以直接放空的」 (2026-09-04).  An order that has not
 * been proceeded may legitimately carry nothing.  Every count is split
 * PROCEEDED / not proceeded and the PROCEEDED half is the backlog.  Quoting the
 * all-orders figure as the amount of work has already cost him time twice.
 *
 * ── TRANSPORT NOISE IS SEPARATED, NOT SWALLOWED ────────────────────────────
 * The book goes through ODBC -> Python -> JSON -> gzip -> Node -> Postgres.
 * Curly quotes become straight, a newline becomes a space, NBSP becomes a
 * space.  A first pass on the variant lane reported 202 differences of which
 * 193 were exactly this.  So a difference that survives the raw comparison is
 * re-tested after normalising ONLY transport artefacts and lands in its own
 * NOISE bucket.  Case is deliberately NOT folded: the writers copy verbatim,
 * so a case change is a real change, not transport.
 *
 * READ-ONLY and dependency-free: pure functions over decoded rows.
 */

/* ── verdicts ───────────────────────────────────────────────────────────── */
export const AGREE = "agree";
export const NOISE = "noise"; // agrees once transport artefacts are normalised
export const DIFFER = "differ";
export const ERP_BLANK = "erpBlank"; // book states a value, ERP has none
export const AC_BLANK = "acBlank"; // ERP states a value, book has none
export const BOTH_BLANK = "bothBlank";
export const UNMATCHED = "unmatched"; // no counterpart row to compare against
export const VERDICTS = [AGREE, NOISE, DIFFER, ERP_BLANK, AC_BLANK, BOTH_BLANK, UNMATCHED];

export const CARRIED = "CARRIED";
export const DERIVED = "DERIVED";
export const NOT_CARRIED = "NOT_CARRIED";

/* ── normalisation ──────────────────────────────────────────────────────── */
const isBlank = (v) => v == null || String(v).trim() === "";

/** Raw text, only trimmed. This is what "verbatim copy" has to survive. */
export const rawText = (v) => (isBlank(v) ? null : String(v).trim());

/** Transport artefacts ONLY: unicode form, quote glyphs, dashes, whitespace.
 *  Nothing here changes a word, a number or a letter's case. */
export function denoise(v) {
  if (isBlank(v)) return null;
  return String(v)
    .normalize("NFKC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[   \t\r\n\v\f]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

/** A date on either side: AutoCount ships "2025-04-16 00:00:00", postgres.js
 *  ships a Date, a backfill ships "2025-04-16". All three are the same day. */
export function dayOf(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // The column is a DATE; render it in UTC so a runner in any timezone reads
    // the same day. A local-time render moves 2025-04-16 to the 15th west of
    // Greenwich and would report every date as different.
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

const numOf = (v) => {
  if (isBlank(v)) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
/** The writers' own money conversion: `centi()` in every importer. */
export const senOf = (v) => {
  const n = numOf(v);
  return n == null ? null : Math.round(n * 100);
};

/* ── the comparators ────────────────────────────────────────────────────── */
/** Returns one of VERDICTS. `kind` picks how equality is decided. */
export function compareValue(acVal, erpVal, kind = "text") {
  let a;
  let e;
  switch (kind) {
    case "date":
      a = dayOf(acVal);
      e = dayOf(erpVal);
      break;
    case "money":
      a = senOf(acVal);
      e = erpVal == null || erpVal === "" ? null : Math.round(Number(erpVal));
      if (e != null && !Number.isFinite(e)) e = null;
      break;
    case "sen": // both sides already in sen
      a = acVal == null || acVal === "" ? null : Math.round(Number(acVal));
      e = erpVal == null || erpVal === "" ? null : Math.round(Number(erpVal));
      break;
    case "num":
      a = numOf(acVal);
      e = numOf(erpVal);
      break;
    default:
      a = rawText(acVal);
      e = rawText(erpVal);
  }
  if (a == null && e == null) return BOTH_BLANK;
  if (a == null) return AC_BLANK;
  if (e == null) return ERP_BLANK;
  if (kind === "text") {
    if (a === e) return AGREE;
    return denoise(a) === denoise(e) ? NOISE : DIFFER;
  }
  return a === e ? AGREE : DIFFER;
}

/* `notExported: "<Table.Column>"` marks a field the CURRENT cut of
 * export-ac-reimport.py does not pull at all. It is NOT a verdict: with no book
 * value there is nothing to compare, and counting it as "AutoCount blank while
 * the ERP has a value" would read as a defect when it is only missing
 * instrumentation. Those rows are printed in their own block, naming the column
 * an exporter change would have to add. Nothing here guesses that the column
 * exists in AutoCount — that is UNKNOWN until somebody runs the exporter on the
 * office host, and breaking the one exporter on go-live day costs more than the
 * two fields are worth.
 */
/* ── the field map ──────────────────────────────────────────────────────── */
/* `ac` reads the AutoCount row, `erp` names the ERP column. `writer` is the
 * citation that keeps this file honest. `kind` picks the comparator. */

const SO_HEADER = [
  { key: "docDate", label: "document date", kind: "date", ac: (h) => h.DocDate, erp: "so_date", status: CARRIED, writer: "import-ac-outstanding-so.mjs HCOLS so_date" },
  { key: "debtorCode", label: "debtor code", kind: "text", ac: (h) => h.DebtorCode, erp: "debtor_code", status: CARRIED, writer: "HCOLS debtor_code" },
  { key: "debtorName", label: "debtor name", kind: "text", ac: (h) => h.DebtorName, erp: "debtor_name", status: CARRIED, writer: "HCOLS debtor_name (falls back to 'CUSTOMER' when the book is blank)" },
  { key: "salesAgent", label: "sales agent", kind: "text", ac: (h) => h.SalesAgent, erp: "agent", status: CARRIED, writer: "HCOLS agent" },
  { key: "salespersonId", label: "salesperson bound", kind: "text", ac: (h) => (h.SalesAgent ? "(an agent is named)" : null), erp: "salesperson_bound", status: DERIVED, writer: "HCOLS salesperson_id, resolved through data/agent-staff-binding.csv", note: "reports whether the named agent reached a staff row at all, not a spelling" },
  { key: "attention", label: "attention", kind: "text", ac: (h) => h.Attention, erp: "attention", status: CARRIED, writer: "lib/ac-header-fields.mjs SO_HEADER_FIELDS `attention` -> sync-ac-delta.mjs LANES=hdr (column added by mig 20260907T1026)" },
  { key: "phone", label: "phone", kind: "text", ac: (h) => h.Phone1, erp: "phone", status: CARRIED, writer: "HCOLS phone" },
  { key: "ref", label: "ref", kind: "text", ac: (h) => h.Ref, erp: "ref", status: CARRIED, writer: "HCOLS ref" },
  { key: "customerSoNo", label: "customer SO no", kind: "text", ac: (h) => h.Ref, erp: "customer_so_no", status: CARRIED, writer: "HCOLS customer_so_no (the same Ref, written twice)" },
  { key: "invAddr1", label: "invoice addr 1", kind: "text", ac: (h) => h.InvAddr1, erp: "address1", status: CARRIED, writer: "HCOLS address1" },
  { key: "invAddr2", label: "invoice addr 2", kind: "text", ac: (h) => h.InvAddr2, erp: "address2", status: CARRIED, writer: "HCOLS address2" },
  { key: "invAddr3", label: "invoice addr 3", kind: "text", ac: (h) => h.InvAddr3, erp: "address3", status: CARRIED, writer: "HCOLS address3" },
  { key: "invAddr4", label: "invoice addr 4", kind: "text", ac: (h) => h.InvAddr4, erp: "address4", status: CARRIED, writer: "HCOLS address4" },
  /* THE DELIVERY ADDRESS IS THE OPERATIONAL ONE. A driver needs the address the
     goods go to, and it is not always the invoice address: measured on the
     2026-09-07 header cut, the two agree on 12,667 of 13,365 book orders and
     genuinely DIFFER on 112, with 12 more carrying a delivery address and no
     invoice address. 124 documents is the whole prize, and it is worth having —
     but quoting 12,791 (the fill count) as the size of the problem would be the
     denominator error CLAUDE.md warns about. */
  { key: "delivAddr1", label: "delivery addr 1", kind: "text", ac: (h) => h.DeliverAddr1, erp: "delivery_address1", status: CARRIED, writer: "lib/ac-header-fields.mjs SO_HEADER_FIELDS `delivery_address1` -> sync-ac-delta.mjs LANES=hdr (mig 20260907T1026)" },
  { key: "delivAddr2", label: "delivery addr 2", kind: "text", ac: (h) => h.DeliverAddr2, erp: "delivery_address2", status: CARRIED, writer: "SO_HEADER_FIELDS `delivery_address2` -> LANES=hdr (mig 20260907T1026)" },
  { key: "delivAddr3", label: "delivery addr 3", kind: "text", ac: (h) => h.DeliverAddr3, erp: "delivery_address3", status: CARRIED, writer: "SO_HEADER_FIELDS `delivery_address3` -> LANES=hdr (mig 20260907T1026)" },
  { key: "delivAddr4", label: "delivery addr 4", kind: "text", ac: (h) => h.DeliverAddr4, erp: "delivery_address4", status: CARRIED, writer: "SO_HEADER_FIELDS `delivery_address4` -> LANES=hdr (mig 20260907T1026)" },
  { key: "delivContact", label: "delivery contact", kind: "text", ac: (h) => h.DeliverContact, erp: null, status: NOT_CARRIED, writer: "exported, not carried — 25 of 13,365 book orders carry one, and it was NOT among the four the owner ruled in on 2026-09-07" },
  { key: "displayTerm", label: "display term", kind: "text", ac: (h) => h.DisplayTerm, erp: "display_term", status: CARRIED, writer: "SO_HEADER_FIELDS `display_term` -> LANES=hdr (mig 20260907T1026)", note: "the migration cut does not carry DisplayTerm; the AutoCount side is filled from ac-doc-headers.json.gz, fill-only" },
  { key: "emergency", label: "emergency phone", kind: "text", ac: (h) => h.DeliverPhone1, erp: "emergency_contact_phone", status: DERIVED, writer: "HCOLS emergency_contact_phone — DeliverPhone1 only when it differs from Phone1, else the 2nd part of Phone1" },
  { key: "salesLocation", label: "warehouse / location", kind: "text", ac: (h) => h.SalesLocation, erp: "sales_location", status: DERIVED, writer: "HCOLS sales_location via the SALESLOC map (PG -> 'PG WAREHOUSE')" },
  { key: "venue", label: "venue (UDF)", kind: "text", ac: (h) => h.UDF_VENUE, erp: "venue", status: CARRIED, writer: "HCOLS venue", note: "scm.mfg_sales_orders.venue is canonicalised by a DB trigger, so a difference here can be the trigger rewriting the write" },
  { key: "branding", label: "branding (UDF)", kind: "text", ac: (h) => h.UDF_BRANDING, erp: "branding", status: CARRIED, writer: "HCOLS branding" },
  { key: "procDate", label: "processing date (PDate)", kind: "date", ac: (h) => h.UDF_PDate, erp: "processing_date", status: CARRIED, writer: "HCOLS processing_date" },
  { key: "balance", label: "balance (UDF)", kind: "money", ac: (h) => h.UDF_BALANCE, erp: "balance_sen", status: CARRIED, writer: "HCOLS balance_sen" },
  { key: "payment", label: "payment (UDF)", kind: "text", ac: (h) => (h.UDF_PAYEMENT ? "(a payment is stated)" : null), erp: "payment_udf_present", status: DERIVED, writer: "HCOLS approval_code + account_sheet, split by lib/ac-payment-udf.mjs", note: "reports whether a stated UDF_PAYEMENT reached the ERP at all, not its spelling" },
  /* THE WRITER'S OWN SOURCE COMES FIRST. `UDF_ToPONo` is the key
     lib/ac-header-fields.mjs reads out of the header cut, so comparing against
     it is comparing against what the lane will actually write; `ToPONo` is the
     same UDF under the name ac-so-status.json.gz gives it, kept as the fallback
     for a checkout with no header cut. Measured 2026-09-07 on the committed
     snapshots: 176 orders carry both, they DISAGREE on 0, and no order carries
     only the status-file spelling — so the order of the two is a statement
     about coupling, not a tie-break anyone is relying on today. */
  { key: "toPoNo", label: "ToPONo (UDF)", kind: "text", ac: (h) => h.UDF_ToPONo ?? h.ToPONo, erp: "ac_to_po_no", status: CARRIED, writer: "SO_HEADER_FIELDS `ac_to_po_no` -> LANES=hdr (mig 20260907T1026)", note: "NOT a customer PO: 7,068 of the 7,071 filled values in the book begin 'PO-' — they are the purchase orders AutoCount raised FROM the order" },
  { key: "delivDate", label: "delivery date (header)", kind: "date", ac: (h) => h.__earliestDeliveryDate, erp: "customer_delivery_date", status: DERIVED, writer: "HCOLS customer_delivery_date = earliest line DeliveryDate" },
  { key: "remark2", label: "remark2", kind: "text", ac: (h) => h.Remark2, erp: "remark2", status: CARRIED, writer: "HCOLS remark2, from ac-so-remarks.json.gz" },
  { key: "remark3", label: "remark3", kind: "text", ac: (h) => h.Remark3, erp: "remark3", status: CARRIED, writer: "HCOLS remark3" },
  { key: "remark4", label: "remark4", kind: "text", ac: (h) => h.Remark4, erp: "remark4", status: CARRIED, writer: "HCOLS remark4" },
  { key: "note", label: "note (UDF_Note)", kind: "text", ac: (h) => h.UDF_Note, erp: "note", status: CARRIED, writer: "HCOLS note" },
  { key: "exemption", label: "sales exemption expiry", kind: "date", ac: (h) => h.SalesExemptionExpiryDate, erp: "sales_exemption_expiry", status: CARRIED, writer: "HCOLS sales_exemption_expiry" },
  /* MEASURABLE SINCE 2026-09-07, and it was already measurable before anyone
     noticed: `notExported: "SO.CurrencyCode"` sat here while
     export-ac-reimport.py's `hdr` section had been exporting SO.CurrencyCode
     into ac-doc-headers.json.gz all along, and ac-field-identity-run.mjs's
     `enrich()` merges every field of that cut onto the header. The marker means
     "there is no book value to compare", and that was false — so a field the
     book fills on all 13,365 orders was being excluded from the comparison by a
     stale annotation rather than by a missing column. Measured on the 2026-09-07
     17:36+08 cut: 13,365 of 13,365 sales orders are MYR, so this row is expected
     to agree everywhere; the PO row below is the one that finds the defect. */
  { key: "currency", label: "currency", kind: "text", ac: (h) => h.CurrencyCode, erp: "currency", status: CARRIED, writer: "HCOLS currency — the importer writes the CONSTANT 'MYR'", note: "the book side comes from ac-doc-headers.json.gz through enrich(), not from the migration cut" },
  { key: "creditTerm", label: "credit term", kind: "text", ac: (h) => h.CreditTerm, erp: null, status: NOT_CARRIED, notExported: "SO.CreditTerm", writer: "NO importer names an ERP column for it" },
  { key: "docTotal", label: "document total", kind: "sen", ac: (h) => h.__bookTotalSen, erp: "local_total_sen", status: DERIVED, writer: "HCOLS local_total_sen = SUM(qty x unit price) over the IMPORTED lines", note: "the book's NetTotal is over ALL lines of the document; the ERP sums the lines the migration carried" },
];

const SO_LINE = [
  { key: "itemCode", label: "item code", kind: "code", ac: (l) => l.ItemCode, erp: "item_code", status: DERIVED, writer: "ICOLS item_code, translated through data/autocount-erp-mapping-1561.csv" },
  { key: "qty", label: "quantity", kind: "num", ac: (l) => Math.round(numOf(l.Qty) ?? 0) || 1, erp: "qty", status: CARRIED, writer: "ICOLS qty = round(Qty) || 1" },
  { key: "unitPrice", label: "unit price", kind: "money", ac: (l) => l.UnitPrice, erp: "unit_price_sen", status: CARRIED, writer: "ICOLS unit_price_sen" },
  { key: "lineTotal", label: "line total", kind: "sen", ac: (l) => l.__bookLineTotalSen, erp: "total_sen", status: CARRIED, writer: "ICOLS total_sen = unit_price_sen x qty", note: "compared against the BOOK's own line amount (SODTL.SubTotal), which is where a line discount would show" },
  { key: "description", label: "description", kind: "text", ac: (l) => l.Description, erp: "description", status: DERIVED, writer: "ICOLS description — deliberately the ERP PRODUCT NAME, not AutoCount's Description (a picker-selected line stores the product name)" },
  { key: "description2", label: "description2 (Desc2)", kind: "text", ac: (l) => l.Desc2, erp: "description2", status: CARRIED, writer: "ICOLS description2, verbatim" },
  { key: "location", label: "line location", kind: "text", ac: (l) => l.Location, erp: "location", status: CARRIED, writer: "ICOLS location" },
  { key: "warehouse", label: "warehouse resolved", kind: "text", ac: (l) => (l.Location ? "(a location is named)" : null), erp: "warehouse_bound", status: DERIVED, writer: "ICOLS warehouse_id = whId(Location)" },
  { key: "lineDeliv", label: "line delivery date", kind: "date", ac: (l) => l.DeliveryDate, erp: "line_delivery_date", status: CARRIED, writer: "ICOLS line_delivery_date" },
];

const PO_HEADER = [
  { key: "docDate", label: "document date", kind: "date", ac: (h) => h.DocDate, erp: "po_date", status: CARRIED, writer: "import-ac-outstanding-po.mjs:379 po_date" },
  { key: "creditorCode", label: "creditor code", kind: "text", ac: (h) => h.CreditorCode, erp: "supplier_code", status: CARRIED, writer: ":379 supplier_id, resolved from CreditorCode" },
  { key: "creditorName", label: "creditor name", kind: "text", ac: (h) => h.CreditorName, erp: "supplier_name", status: DERIVED, writer: "the supplier row's own name, reached through CreditorCode" },
  { key: "ref", label: "ref", kind: "text", ac: (h) => h.Ref, erp: null, status: NOT_CARRIED, writer: "exported (export-ac-reimport.py PO select), named by NO importer column" },
  { key: "attention", label: "attention", kind: "text", ac: (h) => h.Attention, erp: "attention", status: CARRIED, writer: "lib/ac-header-fields.mjs PO_HEADER_FIELDS `attention` -> sync-ac-delta.mjs LANES=hdr (mig 20260907T1026)", note: "the PO migration cut carries no Attention; the AutoCount side is filled from ac-doc-headers.json.gz, fill-only" },
  { key: "displayTerm", label: "display term", kind: "text", ac: (h) => h.DisplayTerm, erp: "display_term", status: CARRIED, writer: "PO_HEADER_FIELDS `display_term` -> LANES=hdr (mig 20260907T1026)", note: "same source as attention above" },
  { key: "location", label: "warehouse / location", kind: "text", ac: (h) => h.Location, erp: "purchase_location", status: DERIVED, writer: ":379 purchase_location_id = whId(Location)" },
  { key: "delivDate", label: "expected delivery", kind: "date", ac: (h) => h.__earliestDeliveryDate, erp: "expected_at", status: DERIVED, writer: ":374 expected_at = earliest line DeliveryDate" },
  /* THE ROW THE OWNER RULED ON. The importer writes the CONSTANT 'MYR'; the book
     holds 22 CNY purchase orders out of 9,408 on the 2026-09-07 17:36+08 header
     cut. It was marked notExported until 2026-09-07 — see the SO row above for
     why that marker was wrong: ac-doc-headers.json.gz has carried
     PO.CurrencyCode since the `hdr` section was written, and enrich() merges it. */
  { key: "currency", label: "currency", kind: "text", ac: (h) => h.CurrencyCode, erp: "currency", status: CARRIED, writer: ":379 currency — the importer writes the CONSTANT 'MYR'", note: "the book side comes from ac-doc-headers.json.gz through enrich(), not from the migration cut" },
  { key: "creditTerm", label: "credit term", kind: "text", ac: (h) => h.CreditTerm, erp: null, status: NOT_CARRIED, notExported: "PO.CreditTerm", writer: "NO importer names an ERP column for it" },
  { key: "docTotal", label: "document total", kind: "sen", ac: (h) => h.__bookTotalSen, erp: "total_sen", status: DERIVED, writer: ":379 total_sen = SUM(qty x unit price), UNDISCOUNTED — see the discount row" },
];

const PO_LINE = [
  { key: "itemCode", label: "item code", kind: "code", ac: (l) => l.ItemCode, erp: "item_code", status: DERIVED, writer: ":394 item_code, translated through the mapping CSV" },
  { key: "qty", label: "quantity", kind: "num", ac: (l) => Math.round(numOf(l.Qty) ?? 0) || 1, erp: "qty", status: CARRIED, writer: ":394 qty" },
  { key: "unitPrice", label: "unit price", kind: "money", ac: (l) => l.UnitPrice, erp: "unit_price_sen", status: CARRIED, writer: ":394 unit_price_sen" },
  { key: "lineTotal", label: "line total", kind: "sen", ac: (l) => l.__bookLineTotalSen, erp: "line_total_sen", status: CARRIED, writer: ":394 line_total_sen = qty x unit_price_sen", note: "compared against the BOOK's own PODTL.SubTotal — this is the line-discount row" },
  { key: "receivedQty", label: "received qty", kind: "num", ac: (l) => numOf(l.TransferedQty) ?? 0, erp: "received_qty", status: CARRIED, writer: ":394 received_qty = TransferedQty" },
  { key: "description", label: "description", kind: "text", ac: (l) => l.Description, erp: "description", status: CARRIED, writer: ":394 description = AutoCount Description, verbatim" },
  { key: "description2", label: "description2 (Desc2)", kind: "text", ac: (l) => l.Desc2, erp: "description2", status: CARRIED, writer: ":394 description2, verbatim" },
  { key: "lineDeliv", label: "line delivery date", kind: "date", ac: (l) => l.DeliveryDate, erp: "delivery_date", status: CARRIED, writer: ":394 delivery_date" },
  { key: "warehouse", label: "warehouse resolved", kind: "text", ac: (l) => (l.Location ? "(a location is named)" : null), erp: "warehouse_bound", status: DERIVED, writer: ":394 warehouse_id = whId(Location)" },
];

const DO_HEADER = [
  { key: "docDate", label: "document date", kind: "date", ac: (h) => h.DoDate, erp: "do_date", status: CARRIED, writer: "create-migrated-documents.mjs:317 do_date" },
  { key: "debtorCode", label: "debtor code", kind: "text", ac: (h) => h.DebtorCode, erp: "debtor_code", status: CARRIED, writer: ":317 debtor_code" },
  { key: "debtorName", label: "debtor name", kind: "text", ac: (h) => h.DebtorName, erp: "debtor_name", status: CARRIED, writer: ":317 debtor_name (falls back to the sales order's name when the note is blank)" },
  { key: "soNo", label: "source sales order", kind: "text", ac: (h) => h.SoNo, erp: "so_ac_docno", status: CARRIED, writer: ":317 so_doc_no, the ERP order carrying that AutoCount number" },
  /* STILL NOT MEASURABLE, and for a real reason rather than a stale one: the DO
     side is built from ac-partial-dos.json.gz, which has no header projection at
     all, and ac-doc-headers.json.gz carries only `so` and `po`. The `hdr` section
     of export-ac-reimport.py now has a DO lane, so this becomes measurable on the
     NEXT cut of that file — not on the committed one. */
  { key: "currency", label: "currency", kind: "text", ac: (h) => h.CurrencyCode, erp: "currency", status: CARRIED, notExported: "DO.CurrencyCode (the `hdr` DO lane, added 2026-09-07 — needs a re-cut)", writer: ":317 currency — the CONSTANT 'MYR'" },
  { key: "docTotal", label: "document total", kind: "sen", ac: (h) => h.__bookTotalSen, erp: "local_total_sen", status: DERIVED, writer: ":373 local_total_sen = SUM(line totals), and the LINE PRICE COMES FROM THE SALES ORDER, not from DODTL" },
];

const DO_LINE = [
  { key: "itemCode", label: "item code", kind: "code", ac: (l) => l.ItemCode, erp: "item_code", status: DERIVED, writer: ":359 item_code is taken from the SALES ORDER line by design, not from DODTL.ItemCode" },
  { key: "qty", label: "quantity", kind: "num", ac: (l) => Math.round(numOf(l.Qty) ?? 0), erp: "qty", status: CARRIED, writer: ":359 qty" },
  { key: "description", label: "description", kind: "text", ac: (l) => l.LineDesc, erp: "description", status: CARRIED, writer: ":359 description = the AutoCount delivery line's own text, verbatim" },
  { key: "unitPrice", label: "unit price", kind: "money", ac: (l) => l.UnitPrice, erp: "unit_price_sen", status: DERIVED, writer: ":359 unit_price_sen comes from the SALES ORDER line (bugs/0617), not from DODTL.UnitPrice" },
  /* CARRIED SINCE 2026-09-07. The owner ruled that AutoCount's HQ / PG / KL /
     SRW / SBH ARE the ERP's own stock warehouses, so the delivery line now has
     the same raw-code + resolved-uuid pair the sales-order line has always had
     (mig 20260907T2345). The book side is compared as TEXT against `location`;
     `warehouse_id` is the derived half and is reported on its own row below,
     the same split the SO line uses. */
  { key: "location", label: "line location", kind: "text", ac: (l) => l.Location, erp: "location", status: CARRIED, writer: "lib/migrated-do-writer.mjs `location`, verbatim from DODTL.Location" },
  { key: "warehouse", label: "warehouse resolved", kind: "text", ac: (l) => (l.Location ? "(a location is named)" : null), erp: "warehouse_bound", status: DERIVED, writer: "lib/migrated-do-writer.mjs `warehouse_id = resolveWarehouse(Location)` through the SHARED SALESLOC map in lib/ac-stock-compare.mjs", note: "reports whether the book's stated location reached an ERP warehouse at all, not which one; an unmapped code deliberately stays NULL" },
];

export const FIELD_MAP = {
  SO: { header: SO_HEADER, line: SO_LINE },
  PO: { header: PO_HEADER, line: PO_LINE },
  DO: { header: DO_HEADER, line: DO_LINE },
  GR: { header: [], line: [] },
  IV: { header: [], line: [] },
  PI: { header: [], line: [] },
};

/* ── the self-test ──────────────────────────────────────────────────────── */
/* A checker that cannot match must REFUSE, never report a clean run. Two real
 * precedents from go-live day: a bare /SOFA/i test pulled accessories into the
 * sofa branch and reported 231 false differences out of 240, and a LIMIT 500
 * reported a drift of 842 as 500. Both printed a confident number. So every
 * comparator below is handed a PLANTED defect it is required to find, and a
 * planted agreement it is required NOT to call a defect. */
export const SELF_TEST = [
  {
    name: "money comparator finds the PO-009948 line discount (1,880 x 1 vs a book amount of 1,410)",
    run: () => compareValue(141000, 188000, "sen") === DIFFER,
  },
  {
    name: "money comparator does not invent a difference across the sen conversion",
    run: () => compareValue("1880.00", 188000, "money") === AGREE,
  },
  {
    name: "date comparator reads AutoCount's midnight timestamp as the same day as a DATE column",
    run: () =>
      compareValue("2025-04-16 00:00:00", new Date(Date.UTC(2025, 3, 16)), "date") === AGREE &&
      compareValue("2025-04-16 00:00:00", "2025-04-16", "date") === AGREE,
  },
  {
    name: "date comparator finds a one-day slip",
    run: () => compareValue("2025-04-16 00:00:00", "2025-04-15", "date") === DIFFER,
  },
  {
    name: "text comparator separates transport noise from a real edit",
    run: () =>
      compareValue("1 ELT / T + NA", "1 ELT / T + NA", "text") === NOISE &&
      compareValue("COL: J9883‑1‑1", "COL: J9883-1-1", "text") === NOISE &&
      compareValue("28”", '28"', "text") === NOISE &&
      compareValue("1 ELT / T + NA", "1 ELT / T + 2ER", "text") === DIFFER,
  },
  {
    name: "text comparator does NOT fold case — the writers copy verbatim",
    run: () => compareValue("TAY HAN HONG", "Tay Han Hong", "text") === DIFFER,
  },
  {
    name: "blank directions are told apart and are not both 'agree'",
    run: () =>
      compareValue(null, "x", "text") === AC_BLANK &&
      compareValue("x", null, "text") === ERP_BLANK &&
      compareValue("  ", "", "text") === BOTH_BLANK &&
      compareValue(null, null, "date") === BOTH_BLANK,
  },
  {
    name: "quantity comparator finds a short quantity",
    run: () => compareValue(2, 1, "num") === DIFFER && compareValue("2.0", 2, "num") === AGREE,
  },
  {
    name: "every field in the map carries a writer citation and a known status",
    run: () =>
      Object.values(FIELD_MAP).every((t) =>
        [...t.header, ...t.line].every(
          (f) => f.writer && [CARRIED, DERIVED, NOT_CARRIED].includes(f.status) && typeof f.ac === "function",
        ),
      ),
  },
  {
    name: "a NOT_CARRIED field names no ERP column, and a CARRIED one always does",
    run: () =>
      Object.values(FIELD_MAP).every((t) =>
        [...t.header, ...t.line].every((f) => (f.status === CARRIED ? !!f.erp : true)),
      ),
  },
  {
    /* 2026-09-07,「四个都加」. These four were the whole NOT_CARRIED finding on
       the sales order: the book held them and the ERP had nowhere to put them.
       Migration 20260907T1026 gave each a column and lib/ac-header-fields.mjs
       named the writer, so the checker must now COMPARE them instead of
       reporting them as missing. If a column is dropped or a map row reverted,
       this fails rather than the section quietly going back to NOT_CARRIED. */
    name: "the four fields the owner ruled in are CARRIED, not NOT_CARRIED",
    run: () => {
      const want = {
        attention: "attention",
        delivAddr1: "delivery_address1",
        delivAddr2: "delivery_address2",
        delivAddr3: "delivery_address3",
        delivAddr4: "delivery_address4",
        displayTerm: "display_term",
        toPoNo: "ac_to_po_no",
      };
      const so = new Map(FIELD_MAP.SO.header.map((f) => [f.key, f]));
      for (const [key, col] of Object.entries(want)) {
        const f = so.get(key);
        if (!f || f.status !== CARRIED || f.erp !== col || f.notExported) return false;
      }
      const po = new Map(FIELD_MAP.PO.header.map((f) => [f.key, f]));
      for (const key of ["attention", "displayTerm"]) {
        const f = po.get(key);
        if (!f || f.status !== CARRIED || !f.erp) return false;
      }
      return true;
    },
  },
  {
    /* The delivery address is read off the book, never derived from the invoice
       address, and the two are genuinely different documents' worth of data.
       This pins the ACCESSOR, because the cheap wrong implementation — falling
       back to InvAddr when DeliverAddr is blank — would report 100% agreement
       and hide every one of the 124 orders the column exists for. */
    name: "delivery address reads DeliverAddr and never falls back to InvAddr — all FOUR lines",
    run: () => {
      /* All four, not just line 1. A first cut of this case checked delivAddr1
         alone and stayed green while delivAddr2 was deliberately given an
         InvAddr2 fallback — the exact defect it was written to catch, on three
         of the four fields it was written to cover. */
      for (const n of [1, 2, 3, 4]) {
        const f = FIELD_MAP.SO.header.find((x) => x.key === `delivAddr${n}`);
        const withBoth = { [`DeliverAddr${n}`]: "NO 8 JALAN GUDANG", [`InvAddr${n}`]: "NO 1 JALAN OFFICE" };
        const deliveryBlank = { [`DeliverAddr${n}`]: null, [`InvAddr${n}`]: "NO 1 JALAN OFFICE" };
        if (f.ac(withBoth) !== "NO 8 JALAN GUDANG") return false;
        if (f.ac(deliveryBlank) != null) return false;
      }
      return true;
    },
  },
  {
    /* Two files spell the same AutoCount UDF differently — ac-so-status.json.gz
       says `ToPONo`, the header cut says `UDF_ToPONo` — and reading only one of
       them would report the field as blank on whichever half is loaded. */
    name: "ToPONo is read under BOTH spellings the exports use",
    run: () => {
      const f = FIELD_MAP.SO.header.find((x) => x.key === "toPoNo");
      return f.ac({ ToPONo: "PO-000972" }) === "PO-000972"
        && f.ac({ UDF_ToPONo: "PO-010170" }) === "PO-010170"
        && f.ac({ ToPONo: null, UDF_ToPONo: "PO-010170" }) === "PO-010170"
        // the writer's own source wins when both are present
        && f.ac({ ToPONo: "PO-000001", UDF_ToPONo: "PO-000002" }) === "PO-000002";
    },
  },
];

export function runSelfTest() {
  const failed = [];
  for (const c of SELF_TEST) {
    let ok = false;
    try {
      ok = c.run() === true;
    } catch (e) {
      ok = false;
      c.error = e.message;
    }
    if (!ok) failed.push(c);
  }
  return failed;
}

/* ── tallying ───────────────────────────────────────────────────────────── */
export function blankTally() {
  const o = {};
  for (const half of ["yes", "no"]) {
    o[half] = {};
    for (const v of VERDICTS) o[half][v] = 0;
  }
  return o;
}

export const isGapVerdict = (v) => v === DIFFER || v === ERP_BLANK;
