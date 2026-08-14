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
// BRANDING_MAP and every per-field decision come from the composer itself, so this
// report cannot drift from what the write-back actually does — which is why it
// runs under tsx:
//
//   npx tsx scripts/check-autocount-field-alignment.mjs
//
// WHAT MAKES A NULL FATAL. On Agent and SalesLocation a null reaches
// AcSyncService as a present-but-null key, `Str()` turns it into "", the
// property is assigned UNCONDITIONALLY, and "" is not a row in dbo.SalesAgent /
// dbo.Location — so the whole document dies on a foreign key. On BRANDING and
// VENUE the null is dropped by `udf()` and the field silently never reaches the
// account book.
//
// UPDATED 2026-08-14, WITH THE FIXES. Until then this report asked one question
// per field — "does the MAP resolve the column the composer reads" — and that
// stopped being the right question the moment the composer grew a decision of
// its own. It already had one for the agent (#2148's `resolveAcAgent`, which
// passes an unmapped staff name through), and the report was still counting map
// hits, so it reported 96 unrescuable orders that the composer would in fact
// have written. Every section below now calls the COMPOSER'S OWN function and
// reports what it would actually send, plus the masters that value would OPEN —
// the two numbers an owner needs before a pass-through ships.
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
  AC_PURCHASE_AGENT,
  bookSpelling,
  bookSpellingOrOwn,
  resolveAcAgent,
  soBranding,
  soCustomerRef,
  soInvoiceAddress,
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

const top = (m, n = 10) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, c]) => `${v} (${c})`).join(", ");

/**
 * WHAT THE COMPOSER WOULD ACTUALLY SEND for one field, on every order that can
 * still be written — and what that value costs.
 *
 * `send(row)` is the composer's OWN decision, imported and never
 * re-implemented, which is the property this whole report exists for: an
 * assertion about the write-back computed from anything other than the
 * write-back can be right on the day it is written and wrong forever after.
 *
 * Two numbers come out, and they are the pair an owner needs:
 *   MISSING — orders where the composer still has nothing to send. On a
 *             foreign-key field that is not "nothing to write": it is `""` and
 *             the whole document is lost. On a UDF the key is dropped and the
 *             value is silently never written.
 *   OPENS   — distinct values that are NOT already a master in the account
 *             book, so `/ensure-masters` would CREATE them. A pass-through is
 *             only as safe as this number is small and this list is readable.
 */
function verdict(label, rows, send, { fatal, book, map, howItFails, opensWhat }) {
  const missing = [];
  const values = new Map();
  for (const r of rows) {
    const v = send(r);
    if (!v) { missing.push(r.doc_no ?? r.po_number ?? "?"); continue; }
    values.set(v, (values.get(v) ?? 0) + 1);
  }
  notice(
    `${label}: ${missing.length} of ${rows.length} still send NOTHING` +
      (missing.length
        ? `. ${fatal ? `"" reaches the book and ${howItFails}` : howItFails}` +
          ` First few: ${missing.slice(0, 6).join(", ")}`
        : " (every one of them now carries a value)."),
  );
  /* WHAT A PASS-THROUGH WOULD OPEN. Two ways to answer it, and the difference
     matters: where the book's own vocabulary is committed beside this script we
     can name exactly what is NEW; where it is not (BRANDING — recorded only as
     prose), the honest answer is the values the MAP does not know, which is an
     over-count of the truth rather than a comfortable silence. Printing nothing
     because the reference list is missing is how a real consequence goes
     unreviewed. */
  if (book) {
    const fresh = [...values.entries()].filter(([v]) => !book.has(v.toUpperCase()));
    const freshRows = fresh.reduce((a, [, n]) => a + n, 0);
    notice(
      `  OPENS ${fresh.length} new ${opensWhat} in the licensed book, on ${freshRows} order(s): ` +
        `${fresh.map(([v, n]) => `${v} (${n})`).join(", ") || "none"}`,
    );
    return;
  }
  if (!map) return;
  const unmapped = [...values.entries()].filter(([v]) => !bookSpelling(v, map));
  const unmappedRows = unmapped.reduce((a, [, n]) => a + n, 0);
  notice(
    `  MAY OPEN up to ${unmapped.length} new ${opensWhat} on ${unmappedRows} order(s) — these are the ` +
      `values ${"the map"} does not know, and this book's option list is not committed here, so some ` +
      `may already exist: ${unmapped.map(([v, n]) => `${v} (${n})`).join(", ") || "none"}`,
  );
}

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
      if (bookSpelling(v, map)) resolved += 1;
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

  /* THE LINE-LEVEL FACTS THE COMPOSER NEEDS, fetched once. The composer is
     PURE — `enqueueSoCreate` does the reads and hands it rows — so the same
     division is drawn here rather than re-implementing what the composer
     decides from them. */
  const lineBrandRows = soItemCols.has("branding")
    ? await pg`
        SELECT s.doc_no, min(i.branding) AS branding
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
         WHERE s.linked_ac_docno IS NULL AND i.branding IS NOT NULL AND i.branding <> ''
           ${soItemCols.has("cancelled") ? pg`AND i.cancelled = false` : pg``}
         GROUP BY s.doc_no`
    : [];
  const lineBrandByDoc = new Map(lineBrandRows.map((r) => [r.doc_no, r.branding]));
  /* Every stock location the document's own lines resolve to. The header's
     SalesLocation falls back to these, and they are codes /ensure-masters is
     opening off the line anyway — which is why that fallback opens nothing
     new. `warehouses.code` is what `warehouseLabel` prefers, and `withLocations`
     falls back to the name, so this mirrors both. */
  const lineLocRows = soItemCols.has("warehouse_id")
    ? await pg`
        SELECT s.doc_no, min(COALESCE(NULLIF(btrim(w.code), ''), w.name)) AS loc
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
          JOIN scm.warehouses w ON w.id = i.warehouse_id
         WHERE s.linked_ac_docno IS NULL
           ${soItemCols.has("cancelled") ? pg`AND i.cancelled = false` : pg``}
         GROUP BY s.doc_no`
    : [];
  const lineLocByDoc = new Map(lineLocRows.map((r) => [r.doc_no, r.loc]));

  // ── 1. SALESPERSON ────────────────────────────────────────────────────────
  /* #2148. `agent` is a legacy free-text column no SO form has ever written;
     the ERP's real identity is salesperson_id -> scm.staff, and `resolveAcAgent`
     prefers the book's own spelling, then the staff name mapped, then the staff
     name AS ITSELF for /ensure-masters to open. The raw `agent` text
     deliberately never passes through — production rows hold bare uuids. */
  if (soCols.has("agent")) {
    verdict(
      "AGENT (resolveAcAgent: agent -> AGENT_MAP, else scm.staff.name)",
      unlinked,
      (r) => resolveAcAgent(r.agent, staffName.get(String(r.salesperson_id ?? "")) ?? null),
      {
        fatal: true,
        book: bookAgents,
        opensWhat: "sales agent(s)",
        howItFails:
          "so.Agent is assigned unconditionally — FK_SO_SalesAgent, whole document lost.",
      },
    );
  }

  // ── 2. SALES LOCATION ─────────────────────────────────────────────────────
  /* `soSalesLocation`: the book's spelling, else the ERP's own value, else the
     stock location the document's own LINES resolve to. The last step is what
     closes the live gap — every failing order here has a BLANK sales_location,
     not an unmapped one. */
  if (soCols.has("sales_location")) {
    verdict(
      "SALES LOCATION (soSalesLocation: sales_location, else the lines')",
      unlinked,
      (r) => bookSpellingOrOwn(r.sales_location, LOCATION_MAP)
        ?? bookSpellingOrOwn(lineLocByDoc.get(r.doc_no) ?? null, LOCATION_MAP),
      {
        fatal: true,
        book: bookLocations,
        opensWhat: "stock location(s)",
        howItFails:
          "SalesLocation is assigned unconditionally — FK_SO_SalesLocation. The composer now REFUSES " +
          "these by name instead of sending it, so they are a visible skipped row rather than a lost " +
          "document — but they are still not WRITTEN.",
      },
    );
    /* WHY a document is still unanswerable, split by remedy, because "21 fail"
       and "21 need the same fix" are different statements and only the second
       one tells anybody what to do. A blank sales_location falls back to the
       lines; if the lines cannot answer either, there are exactly two reasons
       and they are fixed by different people. */
    const stuck = unlinked.filter((r) =>
      !bookSpellingOrOwn(r.sales_location, LOCATION_MAP)
      && !bookSpellingOrOwn(lineLocByDoc.get(r.doc_no) ?? null, LOCATION_MAP));
    const liveLineRows = await pg`
      SELECT s.doc_no, count(i.id)::int AS n
        FROM scm.mfg_sales_orders s
        LEFT JOIN scm.mfg_sales_order_items i
          ON i.doc_no = s.doc_no ${soItemCols.has("cancelled") ? pg`AND i.cancelled = false` : pg``}
       WHERE s.linked_ac_docno IS NULL
       GROUP BY s.doc_no`;
    const liveLines = new Map(liveLineRows.map((r) => [r.doc_no, r.n]));
    const noLines = stuck.filter((r) => !liveLines.get(r.doc_no));
    notice(
      `  of those ${stuck.length}: ${noLines.length} have NO live line at all (MissingSalesLocationError ` +
        `— nothing to sell, so nothing to take a warehouse from), and ${stuck.length - noLines.length} ` +
        `have lines that carry no warehouse_id (MissingLocationError, which already refused them ` +
        `before this change). Both are named skipped rows; the remedy for the second is to set the ` +
        `warehouse on the line or the sales location on the order.`,
    );
  }

  // ── 3. VENUE ──────────────────────────────────────────────────────────────
  /* Venue is deliberately free text — "every roadshow hall is a one-off" (mig
     0229) — and a 7-entry map was never going to cover it. What matters now is
     the OPENS line: a pass-through appends an option to the book's own VENUE
     dropdown, which is reversible from AutoCount's UDF maintenance screen. */
  if (soCols.has("venue")) {
    verdict(
      "VENUE (bookSpellingOrOwn -> UDF VENUE)",
      unlinked,
      (r) => bookSpellingOrOwn(r.venue, VENUE_MAP),
      {
        fatal: false,
        book: bookVenues,
        opensWhat: `VENUE option(s), against the book's ${bookVenues.size}`,
        howItFails: "udf() drops a null, so the VENUE UDF is simply never written.",
      },
    );
  }

  // ── 4. BRANDING ───────────────────────────────────────────────────────────
  /* The HEADER column is NULL on every ERP-created order — no client sends it,
     which is why the detail page derives `first_item_branding` from the LINES.
     `soBranding` reads the header, then the first live line's own text. */
  if (soCols.has("branding")) {
    verdict(
      "BRANDING (soBranding: header, else the lines -> UDF BRANDING)",
      unlinked,
      (r) => bookSpellingOrOwn(
        blank(r.branding) ? lineBrandByDoc.get(r.doc_no) ?? null : r.branding,
        BRANDING_MAP,
      ),
      {
        fatal: false,
        /* The book's BRANDING option list is recorded only as prose in
           autocount-so-writeback-mappings.json, so there is no set to say what
           is NEW. Falling back to "what the map does not know" over-counts
           rather than staying silent — see verdict(). */
        book: null,
        map: BRANDING_MAP,
        opensWhat: "BRANDING option(s)",
        howItFails: "udf() drops a null, so the BRANDING UDF is never written.",
      },
    );
    const headerBlank = unlinked.filter((r) => blank(r.branding)).length;
    const rescued = unlinked.filter(
      (r) => blank(r.branding) && !blank(lineBrandByDoc.get(r.doc_no)),
    ).length;
    notice(
      `  ${headerBlank} of ${unlinked.length} carry NO header branding at all; ${rescued} of those ` +
        `are answered by the LINES (mfg_sales_order_items.branding, snapshotted from the catalog) — ` +
        `the value the detail page shows as first_item_branding.`,
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
  /* `soCustomerRef`: po_doc_no, then customer_po, then customer_so_no. PR #140
     dropped the Customer PO card, so the first two are written by nothing and
     the operator's reference lands in the third — which SO_HEADER_COLS did not
     even select. Free text, no master, so no OPENS line. */
  if (soCols.has("po_doc_no")) {
    verdict(
      "CUSTOMER PO (soCustomerRef: po_doc_no, customer_po, customer_so_no -> UDF ToPONo)",
      unlinked,
      (r) => soCustomerRef(r),
      { fatal: false, book: null, howItFails: "a blank UDF is dropped, so ToPONo never reaches the book." },
    );
  }
  if (soCols.has("ref")) {
    const n = unlinked.filter((r) => blank(r.ref)).length;
    notice(
      `REF (mfg_sales_orders.ref): blank on ${n} of ${unlinked.length}. On a CREATE that is harmless. ` +
        `On an EDIT soEditHeader now OMITS the key when the column is empty, so the account book keeps ` +
        `its own reference; it used to send Ref: null, which Str() turns into "".`,
    );
  }
  if (soCols.has("processing_date")) {
    const n = unlinked.filter((r) => blank(r.processing_date)).length;
    notice(`PROCESSING DATE -> UDF PDate: blank on ${n} of ${unlinked.length} unlinked SO(s); a blank is dropped, never blanked in the book.`);
  }

  // ── 6b. THE CUSTOMER'S ADDRESS ────────────────────────────────────────────
  /* `soInvoiceAddress` packs five ERP fields into AutoCount's four numbered
     lines: address3 / address4 win where the cutover import wrote them, and an
     ERP-created order falls back to postcode + city, then customer_state. */
  if (soCols.has("address3") && soCols.has("city")) {
    const packed = unlinked.filter((r) => {
      const a = soInvoiceAddress(r);
      return blank(r.address3) && blank(r.address4) && (!blank(a.InvAddr3) || !blank(a.InvAddr4));
    }).length;
    const stillEmpty = unlinked.filter((r) => {
      const a = soInvoiceAddress(r);
      return blank(a.InvAddr3) && blank(a.InvAddr4);
    }).length;
    notice(
      `ADDRESS: ${packed} of ${unlinked.length} unlinked SO(s) have address3 AND address4 blank and ` +
        `are now filled from city / postcode / customer_state — the town, postcode and state that used ` +
        `to reach the AutoCount document as two empty lines. ${stillEmpty} still send both blank ` +
        `(the ERP holds nothing for them either).`,
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
    `PO AGENT: scm.purchase_orders still has no agent column — readPoHeader now supplies the CONSTANT ` +
      `"${AC_PURCHASE_AGENT}", which mastersOf opens as a PurchaseAgent, so all ${poUnlinked.length} ` +
      `unlinked PO(s) name one. It used to send null, which reaches po.Agent as "" and fails ` +
      `FK_PO_PurchaseAgent — the same shape as FK_SO_SalesAgent, and unproven on the live book only ` +
      `because no PO has been pushed yet. Which purchase agent the book's reports group by is an ` +
      `OWNER decision; the constant is declared once, in AC_PURCHASE_AGENT.`,
  );
  if (poCols.has("supplier_id")) {
    const sup = await pg`SELECT id, code FROM scm.suppliers`;
    const code = new Map(sup.map((s) => [String(s.id), s.code]));
    const noCred = poUnlinked.filter((r) => blank(r.supplier_id) || blank(code.get(String(r.supplier_id))));
    notice(
      `PO CREDITOR: ${noCred.length} of ${poUnlinked.length} unlinked PO(s) resolve to no ` +
        `scm.suppliers.code. CreditorCode is applied DIRECTLY by CreatePo (not even through Set), so ` +
        `those would fail FK_PO_Creditor — the composer now REFUSES them instead, as a skipped outbox ` +
        `row naming the supplier, rather than losing the whole document to a 500.`,
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
     and /ensure-masters CREATES a stock location it cannot find. So an ERP
     warehouse code the account book has never held opens a new location in a
     licensed book on the first document that names it.
     THIS IS THE LINE PATH AND IT IS UNCHANGED BY THE 2026-08-14 FIXES — it has
     behaved this way since the write-back went live, and the header's
     SalesLocation now falls back to the SAME code the line already carries, so
     nothing here got wider. The comment above EnsureMasters used to deny that
     locations are created at all; that text was corrected on 2026-08-14 rather
     than the behaviour, because the owner asked for "开everything" on
     2026-08-11 and the module guide records it. This number is what that
     decision costs, printed every run so it stays visible. */
  const wh = await pg`SELECT code, name FROM scm.warehouses`;
  const unknown = wh
    .map((w) => (w.code ?? w.name ?? "").trim())
    .filter(Boolean)
    .filter((c) => !bookSpelling(c, LOCATION_MAP) && !bookLocations.has(c.toUpperCase()));
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
