// Read-only: does the ERP keep each write-back field where the composer READS it?
//
// WHY THIS EXISTS. Three faults of one shape have reached the live account book,
// each found only when a real document failed:
//
//   FK_SODTL_Location  (2026-08-11) a line carried no stock location
//   ItemCodeError      (2026-08-13) an ERP code resolved to no single AC item
//   FK_SO_SalesAgent   (2026-08-13) `composeCreateSo` reads mfg_sales_orders.agent,
//                                   a LEGACY column; the ERP's salesperson identity
//                                   is salesperson_id -> scm.staff. The UI reads
//                                   both, so the screen showed a name while the
//                                   column the write-back reads was empty.
//
// The shape: a value the ERP holds in one place, the composer reads from another,
// and nothing opens it on the AutoCount side. This report puts a NUMBER on each
// remaining instance, per field, so "are they all aligned" stops being an opinion.
//
// THE MAPS ARE IMPORTED, NEVER RETYPED. AGENT_MAP / LOCATION_MAP / VENUE_MAP /
// BRANDING_MAP and `mapOrPassthrough` come from the composer itself, so this
// report cannot drift from what the write-back actually does — which is why it
// runs under tsx:
//
//   npx tsx scripts/check-autocount-field-alignment.mjs
//
// WHAT MAKES A NULL FATAL. `mapOrPassthrough` returns null for a value none of
// its maps knows. On Agent and SalesLocation that null reaches AcSyncService as
// a present-but-null key, `Str()` turns it into "", the property is assigned
// UNCONDITIONALLY, and "" is not a row in dbo.SalesAgent / dbo.Location — so the
// whole document dies on a foreign key. On BRANDING and VENUE the null is
// dropped by `udf()` and the field silently never reaches the account book.
//
// Strictly read-only: SELECTs only, no DDL, no writes, no transaction. Exits 0
// for every legitimate answer — the ANSWER is the output, and a red job reads as
// "the check broke". Only an unreachable database exits non-zero.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import {
  AGENT_MAP,
  LOCATION_MAP,
  VENUE_MAP,
  BRANDING_MAP,
  AC_DEBTOR_CODE,
  mapOrPassthrough,
} from "../src/services/autocount-writeback.ts";

const here = dirname(fileURLToPath(import.meta.url));

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const raw = readFileSync(join(here, "..", ".dev.vars"), "utf8");
    const m = raw.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const blank = (v) => v == null || String(v).trim() === "";

/* The account book's own vocabularies, as harvested read-only from the live
   AED_HOUZS maintenance screens on 2026-08-06 and committed beside this script.
   Used ONLY to answer "would a pass-through have landed on a master the book
   already holds, or would it have opened a new one" — never as a gate. */
const DATA = join(here, "data");
const bookVenues = new Set(
  readFileSync(join(DATA, "autocount-venue-options.txt"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.toUpperCase()),
);
const bookMaps = JSON.parse(readFileSync(join(DATA, "autocount-so-writeback-mappings.json"), "utf8"));
const bookAgents = new Set(bookMaps.autocount_agents_reference_79.map((a) => a.toUpperCase()));
const bookLocations = new Set(Object.keys(bookMaps.autocount_locations_reference).map((a) => a.toUpperCase()));

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/** Only ask for columns the table actually has: one phantom name fails the whole query. */
async function columnsOf(table) {
  const rows = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table}`;
  return new Set(rows.map((r) => r.column_name));
}

/**
 * One field's verdict.
 *
 * `read` is the column the composer reads; `alt` is the other column holding the
 * same fact. The headline number is rows where the composer's column is BLANK
 * and the alternative is populated — the ERP knows the answer and the write-back
 * does not, which is the agent bug exactly.
 */
function alignment(rows, read, alt, map, { fatal }) {
  const out = {
    total: rows.length,
    bothBlank: 0,
    readBlankAltSet: 0,
    resolved: 0,
    nulled: 0,
    nulledValues: new Map(),
  };
  for (const r of rows) {
    const v = r[read];
    if (blank(v)) {
      if (alt && !blank(r[alt])) out.readBlankAltSet += 1;
      else out.bothBlank += 1;
      continue;
    }
    if (map ? mapOrPassthrough(v, map) : true) out.resolved += 1;
    else {
      out.nulled += 1;
      const k = String(v).trim();
      out.nulledValues.set(k, (out.nulledValues.get(k) ?? 0) + 1);
    }
  }
  /* WHAT COUNTS AS A LOSS DEPENDS ON WHICH WAY THE FIELD FAILS.
     On a FATAL field an empty value is not "nothing to send" — it is sent, as
     "", and it fails a foreign key, so an order with no value anywhere is just
     as dead as one whose value the map dropped. On a UDF, blank everywhere means
     the ERP genuinely has nothing and nothing is lost by not sending it; only a
     value the ERP HOLDS and the composer does not read is a loss. Counting
     those two the same way is how a report turns an empty column into a
     scandal, or a scandal into a footnote. */
  out.broken = out.readBlankAltSet + out.nulled + (fatal ? out.bothBlank : 0);
  out.fatal = fatal;
  return out;
}

const top = (m, n = 10) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, c]) => `${v} (${c})`).join(", ");

/**
 * What the four maps do to the ACCOUNT BOOK's own vocabulary.
 *
 * Needs no database — it reads the committed 2026-08-11 export of the live book
 * (13,015 SO headers) — and it is here so that every number in
 * docs/autocount-field-alignment-audit.md's headline table is REGENERATED by the
 * same command that produces the ERP-side counts, rather than typed once into a
 * document and left to rot. A stale number is worse than no number (CLAUDE.md).
 */
function bookSideCoverage() {
  let rows;
  try {
    rows = JSON.parse(gunzipSync(readFileSync(join(DATA, "ac-fidelity-so-headers.json.gz"))).toString());
  } catch (e) {
    notice(`book-side coverage skipped: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const known = { SalesAgent: bookAgents, SalesLocation: bookLocations, UDF_VENUE: bookVenues, UDF_BRANDING: null };
  for (const [key, map, label] of [
    ["SalesAgent", AGENT_MAP, "AGENT_MAP"],
    ["SalesLocation", LOCATION_MAP, "LOCATION_MAP"],
    ["UDF_VENUE", VENUE_MAP, "VENUE_MAP"],
    ["UDF_BRANDING", BRANDING_MAP, "BRANDING_MAP"],
  ]) {
    let empty = 0;
    let resolved = 0;
    const dropped = new Map();
    for (const r of rows) {
      const v = String(r[key] ?? "").trim();
      if (!v) { empty += 1; continue; }
      if (mapOrPassthrough(v, map)) resolved += 1;
      else dropped.set(v, (dropped.get(v) ?? 0) + 1);
    }
    const droppedRows = [...dropped.values()].reduce((a, b) => a + b, 0);
    const set = known[key];
    const heldByBook = set ? [...dropped.keys()].filter((v) => set.has(v.toUpperCase())) : [];
    const heldRows = heldByBook.reduce((a, v) => a + dropped.get(v), 0);
    /* Every target the map can EMIT, checked against the book. A map that can
       only emit real masters is not protecting anything by dropping the rest. */
    const badTargets = set ? [...new Set(Object.values(map))].filter((v) => !set.has(v.toUpperCase())) : [];
    notice(
      `${label} over ${rows.length} live-book SOs (export 2026-08-11): resolves ${resolved}, ` +
        `DROPS ${droppedRows} across ${dropped.size} distinct value(s), ${empty} blank in the book. ` +
        (set
          ? `${heldByBook.length} of those ${dropped.size} dropped values (${heldRows} rows) are ALREADY ` +
            `masters in the book. Targets this map can emit that the book does NOT hold: ` +
            `${badTargets.join(", ") || "none"}.`
          : "The book's BRANDING option list is recorded only as prose in "
            + "autocount-so-writeback-mappings.json, so 'already a master' is not checked here."),
    );
    if (dropped.size) notice(`  most-dropped: ${top(dropped, 6)}`);
  }
}

try {
  bookSideCoverage();
  const soCols = await columnsOf("mfg_sales_orders");
  const poCols = await columnsOf("purchase_orders");
  const soItemCols = await columnsOf("mfg_sales_order_items");
  const poItemCols = await columnsOf("purchase_order_items");

  /* Named once so a column that is renamed out from under this report shows up
     as "column absent" rather than as a zero somebody believes. */
  const WANT = [
    "doc_no", "company_id", "linked_ac_docno", "status",
    "agent", "salesperson_id",
    "venue", "venue_id",
    "branding",
    "sales_location",
    "debtor_code", "debtor_name",
    "po_doc_no", "customer_po", "customer_so_no",
    "processing_date", "so_date", "ref", "phone",
    "address3", "address4", "city", "postcode", "customer_state",
  ];
  const have = WANT.filter((c) => soCols.has(c));
  const missing = WANT.filter((c) => !soCols.has(c));
  notice(`scm.mfg_sales_orders: reading ${have.length} of ${WANT.length} candidate columns.`);
  if (missing.length) notice(`  NOT PRESENT on the table (so not read): ${missing.join(", ")}`);

  const sel = have.map((c) => `"${c}"`).join(", ");
  const sos = await pg.unsafe(`SELECT ${sel} FROM scm.mfg_sales_orders`);
  const staff = soCols.has("salesperson_id")
    ? await pg`SELECT id, name FROM scm.staff`
    : [];
  const staffName = new Map(staff.map((s) => [String(s.id), s.name]));

  /* THE POPULATION THAT MATTERS FOR A CREATE. An SO that already carries
     linked_ac_docno was imported at the cutover and enqueueSoCreate returns
     early for it — creating it again would duplicate the order. Everything else
     is a document /create-so can still be asked to write. */
  const unlinked = sos.filter((r) => blank(r.linked_ac_docno));
  notice(
    `${sos.length} sales order(s) in scm.mfg_sales_orders; ${unlinked.length} carry no ` +
      `linked_ac_docno — those are the ones create_so can still be asked to write.`,
  );

  const say = (label, a, howItFails) => {
    notice(
      `${label}: ${a.broken} of ${a.total} would ${a.fatal ? "FAIL" : "be LOST"} — ` +
        `${a.readBlankAltSet} blank here but set in the other column, ` +
        `${a.nulled} carry a value the map turns into null` +
        (a.fatal
          ? `, ${a.bothBlank} blank everywhere (still fatal — "" is sent either way). `
          : ` (a further ${a.bothBlank} are blank everywhere, so there is nothing to lose). `) +
        howItFails,
    );
    if (a.nulledValues.size) {
      notice(`  values the map nulls (${a.nulledValues.size} distinct): ${top(a.nulledValues)}`);
    }
  };

  // ── 1. SALESPERSON ────────────────────────────────────────────────────────
  if (soCols.has("agent")) {
    const a = alignment(unlinked, "agent", soCols.has("salesperson_id") ? "salesperson_id" : null, AGENT_MAP, { fatal: true });
    say(
      "AGENT (composer reads mfg_sales_orders.agent)",
      a,
      'Agent reaches AcSyncService as "" and so.Agent is assigned unconditionally — FK_SO_SalesAgent, whole document lost.',
    );
    /* WOULD THE OTHER COLUMN HAVE ANSWERED? This is the recommendation, measured
       rather than asserted: AGENT_MAP's keys are scm.staff display names
       ("Anthony", "Mei Ting", "Kar Jiun"), so the map was built for the column
       the composer is not reading. */
    if (soCols.has("salesperson_id")) {
      let rescued = 0;
      let stillNot = 0;
      for (const r of unlinked) {
        if (mapOrPassthrough(r.agent, AGENT_MAP)) continue;
        const nm = staffName.get(String(r.salesperson_id ?? ""));
        if (nm && mapOrPassthrough(nm, AGENT_MAP)) rescued += 1;
        else stillNot += 1;
      }
      notice(
        `  reading salesperson_id -> scm.staff.name instead would resolve ${rescued} of those ` +
          `${rescued + stillNot}; ${stillNot} would still not resolve.`,
      );
    }
    const notInBook = [...a.nulledValues.keys()].filter((v) => !bookAgents.has(v.toUpperCase()));
    notice(
      `  of the ${a.nulledValues.size} distinct nulled names, ${a.nulledValues.size - notInBook.length} ` +
        `are ALREADY sales agents in the account book (2026-08-06 harvest of 79) — the map is ` +
        `dropping values the book holds. Not in the book: ${notInBook.join(", ") || "none"}`,
    );
  }

  // ── 2. SALES LOCATION ─────────────────────────────────────────────────────
  if (soCols.has("sales_location")) {
    const a = alignment(unlinked, "sales_location", null, LOCATION_MAP, { fatal: true });
    say(
      "SALES LOCATION (composer reads mfg_sales_orders.sales_location)",
      a,
      'SalesLocation reaches AcSyncService as "" and is assigned unconditionally — FK_SO_SalesLocation.',
    );
    const notInBook = [...a.nulledValues.keys()].filter((v) => !bookLocations.has(v.toUpperCase()));
    notice(
      `  of the ${a.nulledValues.size} distinct nulled locations, ` +
        `${a.nulledValues.size - notInBook.length} are already locations in the account book. ` +
        `Not in the book: ${notInBook.join(", ") || "none"}`,
    );
  }

  // ── 3. VENUE ──────────────────────────────────────────────────────────────
  if (soCols.has("venue")) {
    const a = alignment(unlinked, "venue", soCols.has("venue_id") ? "venue_id" : null, VENUE_MAP, { fatal: false });
    say(
      "VENUE (composer reads mfg_sales_orders.venue -> UDF VENUE)",
      a,
      "udf() drops a null, so the VENUE UDF is simply never written and nothing reports it.",
    );
    const already = [...a.nulledValues.entries()].filter(([v]) => bookVenues.has(v.toUpperCase()));
    notice(
      `  ${already.reduce((s, [, n]) => s + n, 0)} of those ${a.nulled} carry a venue that is ALREADY ` +
        `an option in the book's own VENUE list (${bookVenues.size} options) — a pass-through would ` +
        `have written them with nothing to open.`,
    );
  }

  // ── 4. BRANDING ───────────────────────────────────────────────────────────
  if (soCols.has("branding")) {
    const a = alignment(unlinked, "branding", null, BRANDING_MAP, { fatal: false });
    say(
      "BRANDING (composer reads mfg_sales_orders.branding -> UDF BRANDING)",
      a,
      "udf() drops a null, so the BRANDING UDF is never written.",
    );
    /* The HEADER column is not where an ERP-created order keeps its branding —
       no client sends it, and the detail page derives `first_item_branding` from
       the LINES for exactly that reason (mfg-sales-orders.ts, deriveDisplayBrandingByDoc).
       So the same question the agent bug asked: does the ERP know it elsewhere? */
    const lineBrand = await pg`
      SELECT s.doc_no, min(i.branding) AS branding
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
       WHERE s.linked_ac_docno IS NULL AND i.branding IS NOT NULL AND i.branding <> ''
       GROUP BY s.doc_no`;
    const byDoc = new Map(lineBrand.map((r) => [r.doc_no, r.branding]));
    let rescued = 0;
    for (const r of unlinked) {
      if (!blank(r.branding)) continue;
      const b = byDoc.get(r.doc_no);
      if (b && mapOrPassthrough(b, BRANDING_MAP)) rescued += 1;
    }
    notice(
      `  ${rescued} of the header-blank orders DO carry a mappable branding on their LINES ` +
        `(mfg_sales_order_items.branding, snapshotted from the catalog) — the value the detail page ` +
        `shows as first_item_branding and the composer never looks at.`,
    );
  }

  // ── 5. DEBTOR — deliberate, but sized ─────────────────────────────────────
  if (soCols.has("debtor_code")) {
    const own = unlinked.filter((r) => !blank(r.debtor_code) && String(r.debtor_code).trim() !== AC_DEBTOR_CODE);
    notice(
      `DEBTOR: the composer sends the fixed ${AC_DEBTOR_CODE} and never opens a debtor — that is the ` +
        `owner's convention. ${own.length} of ${unlinked.length} unlinked SOs carry a DIFFERENT ` +
        `debtor_code of their own, which the write-back discards in favour of the fixed account.`,
    );
  }
  if (soCols.has("debtor_name")) {
    const n = unlinked.filter((r) => blank(r.debtor_name)).length;
    notice(`  debtor_name blank on ${n} unlinked SO(s) — DebtorName is assigned unconditionally, so those reach the book as an empty customer name.`);
  }

  // ── 6. CUSTOMER PO / REF / PROCESSING DATE ────────────────────────────────
  /* Same shape as the agent: the composer reads a column PR #140 stopped
     writing, and the value the operator typed sits in customer_so_no. */
  if (soCols.has("po_doc_no")) {
    const a = alignment(unlinked, "po_doc_no", soCols.has("customer_so_no") ? "customer_so_no" : null, null, { fatal: false });
    say("CUSTOMER PO (composer reads po_doc_no -> UDF ToPONo)", a, "a blank UDF is dropped, so ToPONo simply never reaches the book.");
  }
  if (soCols.has("ref")) {
    const a = alignment(unlinked, "ref", soCols.has("customer_so_no") ? "customer_so_no" : null, null, { fatal: false });
    say("REF (composer reads mfg_sales_orders.ref)", a, 'on a CREATE a blank Ref is harmless; on an EDIT soEditHeader sends Ref: null unconditionally and Str() turns it into "" — it BLANKS whatever the account book holds.');
  }
  if (soCols.has("processing_date")) {
    const n = unlinked.filter((r) => blank(r.processing_date)).length;
    notice(`PROCESSING DATE -> UDF PDate: blank on ${n} of ${unlinked.length} unlinked SO(s); a blank is dropped, never blanked in the book.`);
  }

  // ── 6b. THE CUSTOMER'S ADDRESS ────────────────────────────────────────────
  /* InvAddr3 / InvAddr4 are address3 / address4, which only the cutover import
     ever wrote. An ERP-created order keeps the same facts in city / postcode /
     customer_state, and SO_HEADER_COLS does not select those at all. */
  if (soCols.has("address3") && soCols.has("city")) {
    const lost = unlinked.filter(
      (r) => blank(r.address3) && blank(r.address4) && (!blank(r.city) || !blank(r.postcode) || !blank(r.customer_state)),
    ).length;
    notice(
      `ADDRESS: ${lost} of ${unlinked.length} unlinked SO(s) have address3 AND address4 blank while ` +
        `city / postcode / customer_state are populated — InvAddr3 and InvAddr4 go out empty and the ` +
        `town, postcode and state never reach the AutoCount document at all.`,
    );
  }

  // ── 7. LINE STOCK LOCATION ────────────────────────────────────────────────
  if (soItemCols.has("warehouse_id")) {
    const cancelled = soItemCols.has("cancelled") ? pg`AND i.cancelled = false` : pg``;
    const rows = await pg`
      SELECT s.doc_no, count(*)::int AS n
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
       WHERE i.warehouse_id IS NULL
         AND s.linked_ac_docno IS NULL ${cancelled}
       GROUP BY s.doc_no`;
    const byDoc = new Map(rows.map((r) => [r.doc_no, r.n]));
    let docs = 0;
    let lines = 0;
    for (const r of unlinked) {
      const n = byDoc.get(r.doc_no);
      if (!n) continue;
      /* The document's own sales location is inherited by a line that has none
         (composeCreateSo's defaultLocation). Only a line left with NOTHING is
         refused — and the header's location is inherited RAW, before the map,
         so an unmapped one still saves the line even though it kills the header. */
      if (blank(r.sales_location)) {
        docs += 1;
        lines += n;
      }
    }
    notice(
      `LINE STOCK LOCATION: ${lines} line(s) on ${docs} unlinked SO(s) carry no warehouse_id AND ` +
        `sit on a document with no sales_location to inherit — MissingLocationError, refused before ` +
        `sending (visible as a skipped outbox row, not a lost document).`,
    );
  }

  // ── 8. PURCHASE ORDERS ────────────────────────────────────────────────────
  const poHave = ["id", "po_number", "supplier_id", "linked_ac_docno", "notes"].filter((c) => poCols.has(c));
  const pos = await pg.unsafe(`SELECT ${poHave.map((c) => `"${c}"`).join(", ")} FROM scm.purchase_orders`);
  const poUnlinked = pos.filter((r) => blank(r.linked_ac_docno));
  notice(`${pos.length} purchase order(s); ${poUnlinked.length} carry no linked_ac_docno.`);
  notice(
    `PO AGENT: readPoHeader sets agent: null for EVERY purchase order (scm.purchase_orders has no ` +
      `such column), so all ${poUnlinked.length} would send Agent "" — the same shape as ` +
      `FK_SO_SalesAgent, against FK_PO_PurchaseAgent. Unproven on the live book only because no PO ` +
      `has been pushed yet.`,
  );
  if (poCols.has("supplier_id")) {
    const sup = await pg`SELECT id, code FROM scm.suppliers`;
    const code = new Map(sup.map((s) => [String(s.id), s.code]));
    const noCred = poUnlinked.filter((r) => blank(r.supplier_id) || blank(code.get(String(r.supplier_id))));
    notice(
      `PO CREDITOR: ${noCred.length} of ${poUnlinked.length} unlinked PO(s) resolve to no ` +
        `scm.suppliers.code — CreditorCode is applied unconditionally by CreatePo, so those would ` +
        `fail FK_PO_Creditor.`,
    );
  }
  if (poItemCols.has("warehouse_id")) {
    const [{ n }] = await pg`
      SELECT count(*)::int AS n
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
       WHERE i.warehouse_id IS NULL AND p.linked_ac_docno IS NULL`;
    notice(
      `PO LINE STOCK LOCATION: ${n} line(s) on unlinked POs carry no warehouse_id. A purchase order ` +
        `has no header location to inherit (composeCreatePo passes defaultLocation: null), so every ` +
        `one of these refuses its whole document with MissingLocationError.`,
    );
  }

  // ── 9. WAREHOUSE CODES THE BOOK DOES NOT HOLD ─────────────────────────────
  /* A line location is passed through RAW when LOCATION_MAP does not know it,
     and /ensure-masters CREATES a stock location it cannot find — despite the
     comment above EnsureMasters saying it never creates one. So an ERP warehouse
     code the account book has never held opens a new location in a licensed
     book, silently, on the first document that names it. */
  const wh = await pg`SELECT code, name FROM scm.warehouses`;
  const unknown = wh
    .map((w) => (w.code ?? w.name ?? "").trim())
    .filter(Boolean)
    .filter((c) => !mapOrPassthrough(c, LOCATION_MAP) && !bookLocations.has(c.toUpperCase()));
  notice(
    `WAREHOUSE CODES: ${unknown.length} of ${wh.length} scm.warehouses codes are neither in ` +
      `LOCATION_MAP nor in the book's 2026-08-06 location list. A line carrying one is sent RAW and ` +
      `/ensure-masters OPENS it as a new stock location in the live book: ${unknown.slice(0, 20).join(", ") || "none"}`,
  );
} catch (e) {
  /* An unreachable database is the ONE non-zero exit: everything else above is
     an answer, and a red job would read as "the check broke". */
  console.error(`::error::field-alignment check could not run: ${e instanceof Error ? e.message : String(e)}`);
  await pg.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

await pg.end({ timeout: 5 });
