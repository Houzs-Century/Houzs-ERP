/* ---------------------------------------------------------------------------
   vocabulary.mjs — ONE registry of the words this system has agreed on.

   THE PROBLEM, in the owner's words (2026-08-18): 「我跟你讲 Processing Date,
   你却去找成 Process Date」. The same thing carries several spellings, so every
   conversation starts by re-agreeing which word we mean, and every audit script
   that guesses wrong queries a column that no longer exists.

   THE PATTERN ALREADY EXISTED — THREE TIMES, HAND-BUILT EACH TIME. Processing
   Date got `so-processing-date.mjs` plus its own 80-line directory-walking test;
   transfer got `transfer-vocabulary.ts` plus another; the catalogue series got a
   third. Each new concept therefore cost somebody remembering to write a fourth
   test, and the concept that nobody remembers is exactly the one that drifts.
   That is the root, and it is what this file removes: a concept is now an ENTRY,
   and the guard, the glossary and the doc rule all read the entry.

   WHAT AN ENTRY OWES:
     concept     what a human calls it, and what the glossary prints
     canonical   the ONE spelling code may use
     retired     spellings that must not appear in CODE. Comments are allowed —
                 a rename is a story worth telling, and `so-processing-date.mjs`
                 quotes the owner naming the column verbatim
     declaredIn  where the canonical value actually lives, so the glossary can
                 point a reader at the source rather than restating it
     allow       files entitled to spell a retired name in code: the declaration
                 itself, and the migrations that performed the rename

   WHY `retired` IS NOT "every wrong spelling anyone might type": a guard that
   fires on a word nobody uses teaches people to ignore it. Every entry below was
   verified against this tree on 2026-08-18 — `proceeded_at` appears 52 times and
   NOT ONCE in code, which is the state this registry is meant to hold, not a
   violation of it.
   --------------------------------------------------------------------------- */

/** Paths whose matches are always historical, whatever the concept: a migration
 *  records the rename it performed, and a test names the thing it forbids. */
export const ALWAYS_HISTORICAL = [
  "src/db/migrations-pg/",
  "src/db/migrations/",
];

/* A TEST that pins a rename has to name the retired side — that is the whole
   assertion. Excluding tests is not a loophole in the guard, it is the guard
   declining to fail the only files whose job is to hold the line. A test never
   reaches production, so a dropped column named here costs a red test, not a
   42703 in front of the owner. */
export const isTestPath = (relPath) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(String(relPath));

export const VOCABULARY = [
  {
    concept: "Processing Date",
    canonical: "processing_date",
    alsoCanonical: ["processingDate"],
    /* `proceeded_at` is NOT on this list, and the first draft of this file had it
       there. Checked against production 2026-08-18 before shipping: the COLUMN
       STILL EXISTS on scm.mfg_sales_orders, and the diagnostic probes read it on
       purpose to see whether the split finished. Listing it produced 175
       findings, essentially all of them false — the exact failure this file's
       header warns about, committed by its own author. `internal_expected_dd`
       is different in kind: information_schema has no such column any more, so
       any code naming it is querying nothing. */
    retired: ["internal_expected_dd"],
    declaredIn: "backend/scripts/lib/so-processing-date.mjs",
    allow: [
      "scripts/lib/so-processing-date.mjs",
      "scripts/lib/vocabulary.mjs",
      "scripts/lib/drift-catalogue.mjs",
      "src/scm/shared/so-processing-date.ts",
    ],
    note:
      "The date the order is prepared on. It had SEVEN names; migration 0286 retired the " +
      "column `internal_expected_dd`, which no longer exists — code naming it queries nothing " +
      "and postgres fails the WHOLE statement with 42703. The camelCase PAYLOAD key " +
      "`internalExpectedDd` is a DIFFERENT thing and is NOT retired: the status route still " +
      "accepts it from old clients on purpose. `proceeded_at` is a SECOND STORAGE " +
      "the application no longer reads, but the column is still there and diagnostics may read " +
      "it. It is NOT a production date.",
  },
  {
    concept: "Delivery Date",
    canonical: "customer_delivery_date",
    alsoCanonical: ["customerDeliveryDate"],
    /* NOT retired, and NOT this concept: `line_delivery_date` is a SECOND,
       REAL column — the per-LINE date that cascades from this header value and
       can then be hand-overridden per line (MobileNewSO's `ddate`). Listing it
       as an alias would fold two live columns into one name, which is the exact
       fault this registry exists to prevent. Its display name is "Line Delivery
       Date" and it stays distinguishable on screen. `amended_delivery_date` is
       likewise its own column (the rescheduled date the delivery board writes),
       not a spelling of this one. */
    retired: [],
    declaredIn: "backend/src/scm/shared/so-date-pair.ts",
    allow: [
      "scripts/lib/vocabulary.mjs",
      "scripts/lib/drift-catalogue.mjs",
    ],
    note:
      "The date the customer is promised the goods. ONE column, and until 2026-08-21 it was " +
      "shown under FOUR different labels on seven screens — \"Customer Delivery Date\" on the " +
      "Sales Order list and both Consignment Note screens, \"Delivery date\" on the SO detail, " +
      "the SI detail, the DO list and mobile, \"Delivery Date\" on the SO form. The owner, " +
      "2026-08-21: \"为什么我外面的 listing 写着 customer delivereydate，里面却是 delivery date？" +
      "这种应该要统一的吧\" — and he chose the name: Delivery Date, everywhere. It drifted " +
      "because the concept was never registered here while its partner Processing Date was, " +
      "which is why the pair could be half-governed. Paired with Processing Date by the " +
      "both-or-neither rule (soDatePairRefusal): an order carries both dates or neither.",
  },
  {
    concept: "Transfer (document conversion)",
    canonical: "Transfer to / Transfer from",
    alsoCanonical: [],
    retired: [],
    declaredIn: "backend/src/scm/shared/transfer-vocabulary.ts",
    allow: [],
    note:
      "One rule generates every transfer label. \"Transfer to\" names the DOCUMENT a " +
      "document converts into — it never means a warehouse.",
  },
  {
    concept: "Branding",
    canonical: "branding",
    alsoCanonical: [],
    retired: [],
    declaredIn: "backend/src/scm/shared/so-branding-label.ts",
    allow: [],
    note:
      "The label rule: SOFA is the company's house brand (ZANOTTI / 2990s Sofa) and does not " +
      "read the line; MATTRESS is the SKU's branding, falling back to the category noun. " +
      "The VALUES are maintained by the owner in PMS -> Project Maintenance -> BRANDS " +
      "(`project_brands`, per company) and checked by `audit:branding-vocabulary`.",
  },
  {
    concept: "Item code (SKU reference)",
    canonical: "item_code",
    alsoCanonical: [],
    retired: ["material_code", "product_code"],
    declaredIn: "backend/src/scm/routes/mfg-products.ts",
    allow: ["scripts/lib/vocabulary.mjs", "scripts/lib/drift-catalogue.mjs"],
    note:
      "The SKU reference on a line item. AutoCount (the system of record) calls it " +
      "ItemCode, so item_code is canonical; material_code (purchasing) and product_code " +
      "(inventory) were the drift, renamed on 18 columns by migration 0307 (2026-08-19). " +
      "The master table mfg_products keys the SKU as `code`; item_code is the reference. " +
      "The dead `public`-schema copies still carry the old names and are out of scope.",
  },
  {
    concept: "Money (minor unit)",
    canonical: "_sen",
    alsoCanonical: [],
    retired: ["_centi"],
    declaredIn: "frontend/src/lib/money.ts",
    allow: [
      "scripts/lib/vocabulary.mjs",
      "scripts/lib/drift-catalogue.mjs",
      /* The mirror receiver's alias derivation must spell the RETIRED suffix:
         its whole job is translating 2990's still-`_centi` payloads onto the
         `_sen` columns (2990 is a separate repo on its own deploy schedule —
         the 2026-08-19 outbox breakage in BUG-HISTORY is what happens without
         it). The one place the old name is load-bearing. */
      "src/scm/lib/mirror-map.ts",
    ],
    note:
      "Money is stored as an INTEGER count of sen (the Malaysian subunit AutoCount " +
      "speaks; 100 sen = RM 1) and displayed as RM at the edge. The column/field " +
      "suffix is `_sen` / `Sen`; `_centi` was the drift (291 columns across 70 tables, " +
      "renamed by migration 0305 on 2026-08-18). Storing decimals is what money.ts " +
      "exists to prevent — the retirement is of the NAME, not the integer type. Bare " +
      "`centi` local helpers in one-off scripts are not `_centi` and are not retired.",
  },
  {
    concept: "Salesperson (order attribution)",
    canonical: "salesperson_id",
    alsoCanonical: ["salespersonId"],
    /* NOTHING is retired here yet, on purpose. The canonical column
       `salesperson_id` (uuid -> scm.staff) ALREADY exists and is the ERP's real
       attribution; `agent` is a SECOND, legacy free-text column kept BY DESIGN —
       it is the one field AutoCount is given and is written together with the
       salesperson by `so-agent.ts` (see the sales-order guide, "stamped TWICE").
       So `agent` is NOT drift and is NOT retired. The genuinely-drifted spellings
       the 2026-08-18 screening named — `sales_reps`/`rep_id` (the legacy integer
       roster), `sales_agent`/`SalesAgent` (the AutoCount mirror), `salesRep`,
       `salespeople` — are DIFFERENT identifiers reconciled at runtime, not casing
       twins of this column, so renaming them is not behaviour-preserving and none
       is listed. This entry records the agreed word; there is no migration to run. */
    retired: [],
    declaredIn: "backend/src/scm/lib/so-agent.ts",
    allow: [],
    note:
      "Who the ERP records as having sold a Sales Order. The canonical identity is " +
      "`salesperson_id` (a uuid into scm.staff) — scope, commission, the Fair Report " +
      "and the SO PDF all read it, and its camelCase twin is `salespersonId`. `agent` " +
      "is a SEPARATE legacy free-text column kept on purpose: it is the single field the " +
      "AutoCount book is given, and `so-agent.ts` fills it from the stamped salesperson's " +
      "`scm.staff.name` unless a caller supplies one (an FK_SO_SalesAgent refusal on " +
      "go-live day is why). It is NOT a retired spelling of salesperson_id. The screening " +
      "spellings `sales_reps`/`rep_id`, `sales_agent`/`SalesAgent`, `salesRep`, " +
      "`salespeople` are genuinely different identifiers (a legacy integer roster and the " +
      "AutoCount mirror), still reconciled at runtime, and are out of scope for a rename.",
  },
  {
    concept: "Warehouse (which building ships)",
    canonical: "warehouse_id",
    alsoCanonical: ["warehouseId"],
    /* STAGED, not enforced. The per-line binding `warehouse_id` (uuid ->
       scm.warehouses) is canonical and already the value MRP, allocation and
       costing read. The SO HEADER still carries the human-derived snapshot as
       free-text `sales_location`; collapsing that column onto a uuid needs a
       BACKFILL (resolve each free-text label to a warehouse id) and touches
       scm.mfg_sales_orders — a money/stock-adjacent table also projected by
       views — so it is a reviewed follow-up migration, NOT this PR. `sales_location`
       is therefore NOT retired yet: retiring it while the column is still read and
       written would fail the guard on live code. `purchase_location_id` (PO-side)
       and `showroom_warehouse_id` are DIFFERENT columns, not drift of this one. */
    retired: [],
    declaredIn: "backend/src/scm/lib/warehouse-label.ts",
    allow: [],
    note:
      "The building an order ships from. The canonical binding is `warehouse_id` (uuid " +
      "-> scm.warehouses), per LINE, which MRP/allocation/costing read; its camelCase " +
      "twin is `warehouseId` and its display label is one rule in `warehouse-label.ts` " +
      "(code first, then name). The SO header additionally stores a free-text snapshot " +
      "`sales_location` (what the SO says, written by warehouseLabel()); unifying that " +
      "onto `warehouse_id` needs a data BACKFILL and lands on a money/stock-adjacent " +
      "table, so it is STAGED as a reviewed migration rather than enforced here. " +
      "`sales_location` stays live until that migration. `purchase_location_id` " +
      "(PO header) and `showroom_warehouse_id` are separate columns, not drift.",
  },
  {
    concept: "Customer reference (their own PO / order number)",
    canonical: "ref",
    alsoCanonical: [],
    /* STAGED, not enforced. Owner ruling 2026-08-18 (PR #2429, audited against
       production): `ref` is the correct customer-reference field — filled on 2717
       orders — and the ONE display rule is `customerRefOf` = ref || customer_so_no
       || po_doc_no. `customer_so_no` is a near-duplicate transitional fallback;
       `po_doc_no` / `customer_po*` are 0%-filled DEAD columns. They are NOT retired
       here because (a) the backend router still SELECTs them until the drop lands,
       and (b) they are projected by a VIEW — dropping them is the 0189 grant-loss
       hazard and must recreate the view WITH its grants, so it is a reviewed
       follow-up migration, not this PR. Listing them now would fail the guard on the
       router that still reads them. NOTE: an earlier progress doc named
       `customer_so_no` canonical; #2429's owner ruling supersedes that with `ref`. */
    retired: [],
    declaredIn: "frontend/src/lib/customer-ref.ts",
    allow: [],
    note:
      "The customer's own reference (their PO / order number) on a sales document. " +
      "Owner ruling 2026-08-18 (#2429): the canonical field is `ref`, resolved on every " +
      "relationship map by the ONE shared helper `customerRefOf` = ref || customer_so_no " +
      "|| po_doc_no. `customer_so_no` is a near-duplicate kept as a transitional " +
      "fallback; `po_doc_no` and `customer_po`/`customer_po_id`/`customer_po_date` are " +
      "0%-filled DEAD columns still SELECTed by the backend router and projected by a " +
      "view. Dropping the dead columns is a STAGED migration (the 0189 view-grant " +
      "hazard: the recreate must restore the view's grants), so none of these spellings " +
      "is retired in the guard yet — the retirement waits for that drop.",
  },
];

/** A retired spelling may appear here without being a defect. */
export function isHistoricalPath(relPath) {
  const p = String(relPath).replace(/\\/g, "/");
  return ALWAYS_HISTORICAL.some((h) => p.includes(h));
}

/**
 * Strip comments so a match in prose is not reported as a match in code.
 *
 * Character-for-character length-preserving, so a caller can still report a line
 * number. Deliberately simple: it does not parse strings, so a retired name
 * inside a string literal still counts — which is correct, because that is
 * exactly how one reaches a query.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const s = String(source);
  while (i < s.length) {
    if (s[i] === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end === -1 ? s.length : end + 2;
      for (let k = i; k < stop; k += 1) out += s[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    if (s[i] === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (s[i] === "-" && s[i + 1] === "-" && (i === 0 || s[i - 1] === "\n" || s[i - 1] === " ")) {
      while (i < s.length && s[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/** Every retired spelling found in `source`, as {term, concept, line}. */
export function findRetired(source, relPath) {
  if (isHistoricalPath(relPath) || isTestPath(relPath)) return [];
  const code = stripComments(source);
  const lines = code.split("\n");
  const hits = [];
  for (const entry of VOCABULARY) {
    if (entry.allow.some((a) => String(relPath).replace(/\\/g, "/").endsWith(a))) continue;
    for (const term of entry.retired) {
      const rx = new RegExp(`\\b${term}\\b`);
      lines.forEach((text, idx) => {
        if (rx.test(text)) hits.push({ term, concept: entry.concept, line: idx + 1, canonical: entry.canonical });
      });
    }
  }
  return hits;
}
