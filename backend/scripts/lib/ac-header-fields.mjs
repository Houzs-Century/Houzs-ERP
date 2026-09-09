// THE HEADER MASTER FIELD MAP — one declaration, read by the importer that
// INSERTS a document and by the lane that keeps it UP TO DATE.
//
// WHY THIS FILE EXISTS. `import-ac-outstanding-so.mjs` maps AutoCount's header
// onto the ERP's columns at INSERT and nowhere else; every already-migrated
// document whose AutoCount header later changed stayed on the value it was born
// with. The fix is an UPDATE lane — and the moment that lane retypes the map,
// the repo has two copies of one import rule, which is its most expensive
// recurring bug class. So the map lives here, once, and both directions read it.
//
// The owner's rule this file exists to serve (2026-09-07):
//   "不能只是照搬 而是最新的数据，不然就是不完整的 … 我们最重要的是搬进来数据，
//    然后再用我们的规则去处理这些数据。不能因为搬数据 而破坏了我们的规则。"
//   Completeness FIRST, our rules applied on top — never our rules used as a
//   reason to leave a field behind.
//
// COPY, NEVER COMPUTE (memory: migration-copy-never-compute). A field is
// `copy` only when the ERP column holds AutoCount's own value, possibly through
// a declared lookup. Anything the importer DERIVED — a postcode dug out of an
// address, a state guessed from a postcode, the earliest line date — is marked
// `derive` and is REPORTED but never written from this map: re-deriving it is
// exactly the inference the rule forbids, and the tool that owns the derivation
// owns the repair.
//
// A field whose `erp` is null has NO home in the ERP schema. It is still listed,
// because "AutoCount carries a value we have nowhere to put" is a completeness
// answer the owner asked for, and dropping the field would hide it.

/* AutoCount SalesLocation short code -> the ERP warehouse name the SO screen
   stores. MOVED here from import-ac-outstanding-so.mjs (pure move, same
   entries) so the update lane resolves `sales_location` exactly the way the
   insert did. The PO importer's same-named map is DIFFERENT — it carries the
   DISP display locations and feeds a warehouse-id lookup, not this text
   column — so the two are deliberately NOT merged. */
export const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
  HQ: "HQ", JB: "KL WAREHOUSE", KUANTAN: "KL WAREHOUSE",
};
export const salesLoc = (c) => (c ? (SALESLOC[c.trim().toUpperCase()] || c.trim()) : null);

export const txt = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

/* Whitespace and quote style travel through an ODBC driver, a JSON dump, a gzip
   and back. A difference that does not survive that normalisation is the round
   trip, not an edit in the book — and reporting the two as one number would
   hand the owner a "changed" count made mostly of curly apostrophes. */
const SINGLE_QUOTES = /[‘’ʼ′´`]/g;
const DOUBLE_QUOTES = /[“”″]/g;
export const flat = (v) => {
  const s = txt(v);
  return s == null ? null : s.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(/\s+/g, " ").trim();
};

export const day = (v) => {
  if (v == null) return null;
  const s = v instanceof Date ? v.toISOString() : String(v).trim();
  if (s === "") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : s.slice(0, 10);
};

/* kind:
     copy    the ERP column holds AutoCount's own value, optionally through
             `map`, a declared lookup. WRITABLE.
     resolve the value is AutoCount's but it NAMES a row in an ERP master table
             (staff, venue, supplier). Reported here; the resolution and any
             master-data write belong to a named lane.
     derive  the importer COMPUTED this from something else. Reported, never
             written from this map.
     money   the payment/balance lane already owns it (sync-ac-delta LANES=pay).
     const   the importer wrote a constant. Reported so a book value that
             disagrees is visible; never written.
   cmp: "text" (default) | "date" */
export const SO_HEADER_FIELDS = [
  { key: "so_date", book: "DocDate", erp: "so_date", kind: "copy", cmp: "date" },
  { key: "debtor_code", book: "DebtorCode", erp: "debtor_code", kind: "copy" },
  { key: "debtor_name", book: "DebtorName", erp: "debtor_name", kind: "copy" },
  { key: "agent", book: "SalesAgent", erp: "agent", kind: "copy",
    why: "the legacy text column the write-back composer reads (FK_SO_SalesAgent, 2026-08-13)" },
  { key: "salesperson_id", book: "SalesAgent", erp: "salesperson_id", kind: "resolve",
    why: "AutoCount agent -> data/agent-staff-binding.csv -> scm.staff; own lane, LANES=hdrstaff" },
  { key: "sales_location", book: "SalesLocation", erp: "sales_location", kind: "copy", map: "SALESLOC" },
  { key: "ref", book: "Ref", erp: "ref", kind: "copy" },
  { key: "customer_so_no", book: "Ref", erp: "customer_so_no", kind: "copy",
    why: "the importer writes Ref to BOTH columns; po_doc_no / customer_po were dropped in 0312" },
  { key: "venue", book: "UDF_VENUE", erp: "venue", kind: "copy",
    why: "a trigger canonicalises this column on write (memory: venue-canonicalised-by-trigger)" },
  { key: "venue_id", book: "UDF_VENUE", erp: "venue_id", kind: "resolve",
    why: "UDF_VENUE -> scm.venues by name; the importer's fuzzy contains-match is NOT re-run here" },
  { key: "branding", book: "UDF_BRANDING", erp: "branding", kind: "copy" },
  { key: "address1", book: "InvAddr1", erp: "address1", kind: "copy" },
  { key: "address2", book: "InvAddr2", erp: "address2", kind: "copy" },
  { key: "address3", book: "InvAddr3", erp: "address3", kind: "copy" },
  { key: "address4", book: "InvAddr4", erp: "address4", kind: "copy" },
  { key: "phone", book: "Phone1", erp: "phone", kind: "copy" },
  { key: "processing_date", book: "UDF_PDate", erp: "processing_date", kind: "copy", cmp: "date",
    why: "the live column name is resolved at runtime by lib/so-processing-date.mjs" },
  { key: "remark2", book: "Remark2", erp: "remark2", kind: "copy" },
  { key: "remark3", book: "Remark3", erp: "remark3", kind: "copy" },
  { key: "remark4", book: "Remark4", erp: "remark4", kind: "copy" },
  { key: "note", book: "UDF_Note", erp: "note", kind: "copy",
    why: "SO.Note itself is never read — its only 2 filled docs hold an RTF picture, not words" },
  { key: "sales_exemption_expiry", book: "SalesExemptionExpiryDate", erp: "sales_exemption_expiry", kind: "copy", cmp: "date" },

  { key: "postcode", book: "InvAddr1..4", erp: "postcode", kind: "derive",
    why: "dug out of the joined address by a regex at insert — re-deriving it is inference" },
  { key: "city", book: "InvAddr1..4", erp: "city", kind: "derive",
    why: "the text after the postcode minus the state name — inference" },
  { key: "customer_state", book: "InvAddr1..4", erp: "customer_state", kind: "derive",
    why: "guessed from the first two postcode digits — inference" },
  { key: "emergency_contact_phone", book: "DeliverPhone1", erp: "emergency_contact_phone", kind: "derive",
    why: "DeliverPhone1 when it differs from Phone1, else the 2nd half of a slash-split Phone1" },
  { key: "customer_delivery_date", book: "(line DeliveryDate)", erp: "customer_delivery_date", kind: "derive", cmp: "date",
    why: "earliest LINE delivery date; refresh-so-tail-from-book.mjs owns it" },

  { key: "currency", book: "CurrencyCode", erp: "currency", kind: "const",
    why: "the importer hard-codes 'MYR'; reported so a foreign-currency order is visible" },
  { key: "balance_sen", book: "UDF_BALANCE", erp: "balance_sen", kind: "money", cmp: "sen",
    why: "sync-ac-delta LANES=pay owns this, with total / paid / deposit" },
  { key: "approval_code", book: "UDF_PAYEMENT", erp: "approval_code", kind: "money",
    why: "parsed by lib/ac-payment-udf.mjs; the pay lane writes it" },

  /* THE FOUR THE OWNER RULED IN, 2026-09-07 —「四个都加」. Each was NOT_CARRIED:
     the book held the column and no importer named an ERP one, so the value had
     nowhere to land. Migration 20260907T1026 gives them a home.

     NOTE THE WRITER CITATION, because it is not the usual one. The SO importer's
     HCOLS does not carry these — it is INSERT-ONLY and was deliberately left
     alone mid-cutover — so the ONE writer is the update lane below, which runs
     over every row with a linked_ac_docno and therefore covers a document
     imported five minutes ago as readily as one imported in August. */
  { key: "attention", book: "Attention", erp: "attention", kind: "copy",
    why: "AutoCount's contact-person line; column added by 20260907T1026, written ONLY by sync-ac-delta LANES=hdr (import-ac-outstanding-so.mjs HCOLS does not carry it)" },
  { key: "delivery_address1", book: "DeliverAddr1", erp: "delivery_address1", kind: "copy",
    why: "the address the GOODS go to. Different from InvAddr on 112 of 13,365 book orders (+12 delivery-only) — small, and exactly the set a driver would otherwise be sent to the wrong place for. 20260907T1026; written by LANES=hdr" },
  { key: "delivery_address2", book: "DeliverAddr2", erp: "delivery_address2", kind: "copy",
    why: "20260907T1026; written by LANES=hdr" },
  { key: "delivery_address3", book: "DeliverAddr3", erp: "delivery_address3", kind: "copy",
    why: "20260907T1026; written by LANES=hdr" },
  { key: "delivery_address4", book: "DeliverAddr4", erp: "delivery_address4", kind: "copy",
    why: "20260907T1026; written by LANES=hdr" },
  { key: "display_term", book: "DisplayTerm", erp: "display_term", kind: "copy",
    why: "the credit term AutoCount PRINTS. The ERP keeps terms on the CUSTOMER, so this is the only place an order-level term is visible; one distinct value book-wide today ('C.O.D.'). 20260907T1026; written by LANES=hdr" },
  { key: "ac_to_po_no", book: "UDF_ToPONo", erp: "ac_to_po_no", kind: "copy",
    why: "the PURCHASE ORDER(S) AUTOCOUNT RAISED FROM THIS ORDER, comma-joined — NOT a customer PO number (7,068 of 7,071 filled values begin 'PO-'). The ERP expresses the relationship as a real SO->PO line link, which sync-ac-delta CASE 3 reports; this keeps the book's own text so the two can be compared. 20260907T1026; written by LANES=hdr" },

  { key: "(DeliverContact)", book: "DeliverContact", erp: null, kind: "copy",
    why: "delivery contact name — no ERP column. Filled on 25 of 13,365 book orders and NOT among the four the owner ruled in; listed so it stays visible" },
];

export const PO_HEADER_FIELDS = [
  { key: "po_date", book: "DocDate", erp: "po_date", kind: "copy", cmp: "date" },
  { key: "supplier_id", book: "CreditorCode", erp: "supplier_id", kind: "resolve",
    why: "CreditorCode -> scm.suppliers.code, exact match, no fuzzy fallback" },
  { key: "(CreditorName)", book: "CreditorName", erp: null, kind: "copy",
    why: "the supplier NAME lives on scm.suppliers and is never copied onto the order" },
  { key: "(Ref)", book: "Ref", erp: null, kind: "copy",
    why: "the PO importer selects Ref from the book and writes it nowhere — scm.purchase_orders has no ref column" },
  { key: "purchase_location_id", book: "(line Location)", erp: "purchase_location_id", kind: "derive",
    why: "the FIRST line's Location mapped to a warehouse id" },
  { key: "expected_at", book: "(line DeliveryDate)", erp: "expected_at", kind: "derive", cmp: "date",
    why: "earliest LINE delivery date, the derivation the app's own SO->PO convert uses" },
  { key: "currency", book: "CurrencyCode", erp: "currency", kind: "const",
    why: "the importer hard-codes 'MYR'" },
  { key: "attention", book: "Attention", erp: "attention", kind: "copy",
    why: "20260907T1026; written ONLY by sync-ac-delta LANES=hdr — neither PO importer carries it" },
  { key: "display_term", book: "DisplayTerm", erp: "display_term", kind: "copy",
    why: "20260907T1026; written ONLY by sync-ac-delta LANES=hdr" },
  { key: "(DeliverAddr1)", book: "DeliverAddr1", erp: null, kind: "copy",
    why: "no ERP column, and deliberately so: a PURCHASE order's delivery address is OUR OWN receiving address and is identical on all 9,408 book purchase orders. The owner's delivery-address ruling was about the SALES order" },
];

/* THE HUMAN VETO, DERIVED FROM THE MAP ABOVE — never typed separately, so a
   field cannot be added to the map and arrive without its veto.

   `version > 1` is deliberately ABSENT. It is an optimistic-locking token
   bumped by seven automated paths through scm/lib/so-generation.ts, and
   check-so-version-provenance.mjs (PR #3042) measured 80 of 81 "conflicts" as
   the automated stock-allocation sweep and exactly 1 as a person. Using it as
   an authorship test refuses the owner's own data on behalf of a robot. */
export function headerAuditNeedles(fields) {
  const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  const out = new Set();
  for (const f of fields) {
    if (!f.erp) continue;
    out.add(f.erp);
    out.add(camel(f.erp));
  }
  /* The screen labels an audit row can carry instead of a column name. Kept
     deliberately short: every needle here widens the refusal, and a refusal
     costs the owner a field that stays stale. */
  for (const label of ["Sales Agent", "Salesperson", "Customer Name", "Address", "Venue", "Branding"]) out.add(label);
  return [...out].map((n) => `%${n}%`);
}

/* Whole sen, the unit every money column on these tables is stored in. A book
   value of "1500.00" against an ERP `150000` is the SAME money; comparing them
   as text would report every single order as differing. */
const sen = (v) => {
  const s = txt(v);
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? String(Math.round(n * 100)) : null;
};

/* ONE comparison, used by the report AND by the write plan, so a field can
   never be reported as "differs" and then written under a different rule. */
export function compareField(f, bookRaw, erpRaw) {
  const bookVal = f.map === "SALESLOC" ? salesLoc(txt(bookRaw)) : bookRaw;
  const norm1 = f.cmp === "date" ? day : f.cmp === "sen" ? sen : flat;
  const b = norm1(bookVal);
  // the ERP side of a `sen` column is ALREADY in sen — normalise it as text
  const e = f.cmp === "date" ? day(erpRaw) : f.cmp === "sen" ? (txt(erpRaw) == null ? null : String(Math.round(Number(erpRaw)))) : flat(erpRaw);
  if (b === null && e === null) return { verdict: "bothBlank", book: b, erp: e };
  if (b === null) return { verdict: "bookBlank", book: b, erp: e };  // COPY NEVER COMPUTE: a blank never erases
  if (e === null) return { verdict: "erpBlank", book: b, erp: e };   // the fill case
  return { verdict: b === e ? "agree" : "differ", book: b, erp: e };
}

/* The value actually written for a `copy` field: AutoCount's own, through the
   declared lookup, and NEVER normalised. `flat()` exists to compare, not to
   store — writing the flattened text would replace the book's own spacing with
   ours, which is a change we invented. */
export function writeValue(f, bookRaw) {
  if (f.cmp === "date") return day(bookRaw);
  if (f.map === "SALESLOC") return salesLoc(txt(bookRaw));
  return txt(bookRaw);
}
