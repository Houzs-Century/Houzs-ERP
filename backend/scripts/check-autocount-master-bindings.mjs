// Read-only: which ERP master values does the account book ALREADY hold, under
// a different spelling — and which are genuinely new?
//
// WHY THIS EXISTS. The owner, 2026-08-14: *"Branding、venue、sales、location、
// agent，你都可以做 binding 吧？把我目前的东西全部都跟 AutoCount AI binding 起来
// 吗？这样子之后就不用新开那么多，很多其实都已经有了。"* He is right, and the
// proof was already in this repo. `/ensure-masters` opens a master AutoCount
// cannot find, under exactly the string it was given — so a value the book
// already holds under another spelling does not fail, it opens a DUPLICATE. For
// a stock location that splits one physical place's stock across two rows in a
// licensed book, permanently.
//
// The field-alignment report says twelve `scm.warehouses` codes are unknown to
// both `LOCATION_MAP` and the book's location list. Eleven of the twelve are
// the book's own locations spelled differently: `SUNWAY SHOWROOM` is `SUNWAY`
// (DUNLOPILLO SUITE SUNWAY), `C&C DISPLAY` is `C&C DISP`, `KL SERVICE` is
// `SERV KL`. Only `CHINA WAREHOUSE` is new.
//
// WHAT THIS IS. A MATCHER RUN AS A REPORT, WHOSE OUTPUT A HUMAN CONFIRMS. Not
// an automatic binder: a wrong bind writes the wrong place or the wrong
// salesperson into a licensed account book, and the owner has to be able to see
// the pairs before they take effect. Every proposal carries the REASON it was
// proposed — a bare score is not reviewable.
//
// THE LOOP, END TO END:
//   1. this report proposes a pair, with its reason and its row count;
//   2. a human moves the pair into scripts/data/autocount-so-writeback-mappings.json;
//   3. `node scripts/gen-autocount-master-maps.mjs` writes the compiled map.
// No step of that edits TypeScript by hand, and `npm run audit:ac-master-maps`
// fails CI if step 3 was skipped.
//
// THE MAPS AND `bookSpelling` ARE IMPORTED FROM THE COMPOSER, never retyped —
// which is why this runs under tsx, the same as its sibling
// check-autocount-field-alignment.mjs:
//
//   npx tsx scripts/check-autocount-master-bindings.mjs
//
// Strictly read-only: SELECTs only, no DDL, no writes, no transaction. Exits 0
// for every legitimate answer — the ANSWER is the output, and a red job reads as
// "the check broke". Only an unreachable database, or a matcher that fails its
// own self-test, exits non-zero.
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import {
  AGENT_MAP,
  LOCATION_MAP,
  VENUE_MAP,
  BRANDING_MAP,
  bookSpelling,
} from "../src/services/autocount-writeback.ts";
import { buildIndex, matchValue, selfTest } from "./lib/ac-master-matcher.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "data");

/* CLAUDE.md: "a checker that cannot match reports a clean run". A matcher whose
   rules had rotted would bucket everything as NO MATCH, which reads exactly
   like a book that holds nothing — and acting on that opens duplicates. So the
   worked examples are asserted before a single row is read. */
const broken = selfTest();
if (broken.length) {
  console.error(`::error::ac-master-matcher failed its own self-test, refusing to report: ${broken.join("; ")}`);
  process.exit(1);
}

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

/* THE WRITE-BACK IS PER COMPANY, SO THE MEASUREMENT MUST BE TOO — the same rule
   PR #2201 had to teach the field-alignment report. `scm.autocount_writeback`
   names the companies that sync (1 today) and enqueueSoCreate returns early for
   any other, so counting 2990's rows inflates every figure here. */
const COMPANY_ID = Number(process.env.COMPANY_ID ?? 1);

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const line = (m) => console.log(m);

const book = JSON.parse(readFileSync(join(DATA, "autocount-so-writeback-mappings.json"), "utf8"));

/* THE BOOK'S OWN VOCABULARY, from two sources that answer the same question
   differently and are therefore UNIONED:
     - the 2026-08-06 harvest of the maintenance screens: what masters EXIST;
     - the 2026-08-11 export of 13,015 live SO headers: what masters are USED,
       which is existence evidence too (a document cannot name a master the
       book does not hold — that is the foreign key this whole module is about).
   Neither alone is complete: the export shows 100 VENUE options against the
   harvest's 94, and the harvest shows locations no document has ever used. */
let headers = [];
try {
  headers = JSON.parse(gunzipSync(readFileSync(join(DATA, "ac-fidelity-so-headers.json.gz"))).toString());
} catch (e) {
  notice(`live-book export unreadable, falling back to the harvest alone: ${e instanceof Error ? e.message : String(e)}`);
}
const usedInBook = (key) => {
  const s = new Set();
  for (const r of headers) {
    const v = String(r[key] ?? "").trim();
    if (v) s.add(v);
  }
  return s;
};

const harvestVenues = readFileSync(join(DATA, "autocount-venue-options.txt"), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/* A location candidate carries BOTH its short code (what gets written) and the
   long description the maintenance screen shows — which is very often the only
   place the ERP's own wording appears (`SUNWAY` is `DUNLOPILLO SUITE SUNWAY`,
   `SBH` is `SABAH`). */
const locationCandidates = Object.entries(book.autocount_locations_reference)
  .map(([code, name]) => ({ value: code, aliases: [name] }));
for (const v of usedInBook("SalesLocation")) {
  if (!locationCandidates.some((c) => c.value.toUpperCase() === v.toUpperCase())) {
    locationCandidates.push({ value: v, aliases: [] });
  }
}

const unionOf = (harvest, used) => {
  const seen = new Map();
  for (const v of [...harvest, ...used]) {
    const k = v.toUpperCase().replace(/\s+/g, " ").trim();
    if (!seen.has(k)) seen.set(k, v);
  }
  return [...seen.values()];
};

const DIMENSIONS = [
  {
    key: "location",
    label: "STOCK LOCATION -> AutoCount dbo.Location",
    map: LOCATION_MAP,
    mapName: "LOCATION_MAP",
    jsonField: "location_map",
    candidates: locationCandidates,
    passesThrough: true,
  },
  {
    key: "venue",
    label: "VENUE -> AutoCount VENUE UDF option list",
    map: VENUE_MAP,
    mapName: "VENUE_MAP",
    jsonField: "venue_map",
    candidates: unionOf(harvestVenues, usedInBook("UDF_VENUE")),
    passesThrough: true,
  },
  {
    key: "agent",
    label: "SALESPERSON / AGENT -> AutoCount dbo.SalesAgent",
    map: AGENT_MAP,
    mapName: "AGENT_MAP",
    jsonField: "agent_map",
    candidates: unionOf(book.autocount_agents_reference_79, usedInBook("SalesAgent")),
    passesThrough: true,
  },
  {
    key: "branding",
    label: "BRANDING -> AutoCount BRANDING UDF option list",
    map: BRANDING_MAP,
    mapName: "BRANDING_MAP",
    jsonField: "branding_map",
    candidates: unionOf(book.autocount_branding_options_reference, usedInBook("UDF_BRANDING")),
    passesThrough: false,
  },
];

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function columnsOf(table) {
  const rows = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table}`;
  return new Set(rows.map((r) => r.column_name));
}
const tableExists = async (t) => (await columnsOf(t)).size > 0;

/** One ERP value, and what naming it would cost. */
function bucketOf(value, dim, index, bookHolds) {
  const already = bookSpelling(value, dim.map);
  if (already) {
    return {
      bucket: "mapped",
      target: already,
      reason: `${dim.mapName} already resolves it`,
      alternatives: [],
    };
  }
  /* A value that IS the book's own spelling needs no map entry ON A FIELD THAT
     PASSES THROUGH: `bookSpellingOrOwn` sends it verbatim and `/ensure-masters`
     finds it, so nothing is opened and there is nothing to confirm. On an
     ALLOW-LIST field the same value is DROPPED instead, so it still has to be
     added — which is why this is asked per dimension and not once. */
  if (dim.passesThrough && bookHolds.has(value.toUpperCase().replace(/\s+/g, " "))) {
    return {
      bucket: "mapped",
      target: value,
      reason: "already a master in the book, sent verbatim",
      alternatives: [],
    };
  }
  return matchValue(value, index);
}

const pad = (s, n) => String(s).padEnd(n);

try {
  const soCols = await columnsOf("mfg_sales_orders");
  const itemCols = await columnsOf("mfg_sales_order_items");
  const staffCols = await columnsOf("staff");
  const whCols = await columnsOf("warehouses");
  const prodCols = await columnsOf("mfg_products");
  const hasVenuesTable = await tableExists("venues");

  const scopedStaff = staffCols.has("company_id");
  const scopedProducts = prodCols.has("company_id");

  /* Two numbers per value, and they answer different questions. ORDERS is how
     much of the ERP's history names it — the size of the thing being bound.
     WRITABLE is how many of those the write-back can still be asked to create
     (no linked_ac_docno), i.e. what a wrong bind would corrupt TOMORROW. A
     value with 0 writable is not harmless: the vocabulary is what every FUTURE
     order draws from. */
  const countSql = (col) => pg.unsafe(
    `SELECT btrim(${col}) AS v,
            count(DISTINCT doc_no)::int AS orders,
            count(DISTINCT doc_no) FILTER (WHERE linked_ac_docno IS NULL)::int AS writable
       FROM scm.mfg_sales_orders
      WHERE company_id = $1 AND ${col} IS NOT NULL AND btrim(${col}) <> ''
      GROUP BY 1`,
    [COMPANY_ID],
  );

  const erp = { location: new Map(), venue: new Map(), agent: new Map(), branding: new Map() };
  /* `scoped` says whether the row this value came from could be attributed to
     company ${COMPANY_ID} at all. It is not a detail: `scm.staff` has NO
     company_id, so reading it whole pulls 2990's people into a report about
     Houzs — and on the first run that put 71 names into NO MATCH that no
     company-1 document has ever named. An unscoped value with zero orders is
     COUNTED and named, never bucketed as work. */
  const add = (dim, value, orders, writable, source, scoped) => {
    const v = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!v) return;
    const cur = erp[dim].get(v) ?? { value: v, orders: 0, writable: 0, sources: new Set(), scoped: false };
    cur.orders += orders;
    cur.writable += writable;
    cur.sources.add(source);
    cur.scoped = cur.scoped || scoped;
    erp[dim].set(v, cur);
  };

  // ── STOCK LOCATION ────────────────────────────────────────────────────────
  /* `warehouseLabel` prefers the code and falls back to the name, so that is
     the string a line actually sends and therefore the string to bind. */
  if (whCols.has("code")) {
    const rows = await pg`
      SELECT COALESCE(NULLIF(btrim(w.code), ''), w.name) AS v,
             count(DISTINCT s.doc_no)::int AS orders,
             count(DISTINCT s.doc_no) FILTER (WHERE s.linked_ac_docno IS NULL)::int AS writable
        FROM scm.warehouses w
        LEFT JOIN scm.mfg_sales_order_items i ON i.warehouse_id = w.id
        LEFT JOIN scm.mfg_sales_orders s
               ON s.doc_no = i.doc_no AND s.company_id = ${COMPANY_ID}
       WHERE w.company_id = ${COMPANY_ID}
       GROUP BY 1`;
    for (const r of rows) add("location", r.v, r.orders, r.writable, "scm.warehouses", true);
  }
  if (soCols.has("sales_location")) {
    for (const r of await countSql('"sales_location"')) {
      add("location", r.v, r.orders, r.writable, "mfg_sales_orders.sales_location", true);
    }
  }

  // ── VENUE ─────────────────────────────────────────────────────────────────
  if (soCols.has("venue")) {
    for (const r of await countSql('"venue"')) add("venue", r.v, r.orders, r.writable, "mfg_sales_orders.venue", true);
  }
  if (hasVenuesTable) {
    const rows = await pg`SELECT name FROM scm.venues WHERE company_id = ${COMPANY_ID}`;
    for (const r of rows) add("venue", r.name, 0, 0, "scm.venues (picker)", true);
  }

  // ── SALESPERSON / AGENT ───────────────────────────────────────────────────
  /* ONE AutoCount dimension out of two ERP columns — confirmed against the
     composer, not assumed: `resolveAcAgent` feeds the single `SalesAgent` field
     from `mfg_sales_orders.agent` through AGENT_MAP, else `scm.staff.name`
     through the same map, else the staff name AS ITSELF. The PURCHASE agent is
     a different master table (dbo.PurchaseAgent) fed by a constant, and is
     deliberately not part of this dimension. */
  if (soCols.has("salesperson_id")) {
    const rows = await pg`
      SELECT st.name AS v,
             count(DISTINCT s.doc_no)::int AS orders,
             count(DISTINCT s.doc_no) FILTER (WHERE s.linked_ac_docno IS NULL)::int AS writable
        FROM scm.mfg_sales_orders s
        JOIN scm.staff st ON st.id = s.salesperson_id
       WHERE s.company_id = ${COMPANY_ID}
       GROUP BY 1`;
    for (const r of rows) add("agent", r.v, r.orders, r.writable, "salesperson_id -> scm.staff", true);
  }
  if (staffCols.has("name")) {
    const rows = scopedStaff
      ? await pg`SELECT name FROM scm.staff WHERE company_id = ${COMPANY_ID}`
      : await pg`SELECT name FROM scm.staff`;
    for (const r of rows) add("agent", r.name, 0, 0, scopedStaff ? "scm.staff" : "scm.staff (NOT company-scoped)", scopedStaff);
  }
  /* The raw `agent` column is reported but never proposed: it is free text with
     no writer that keeps it honest — production rows hold bare uuids — and
     `resolveAcAgent` deliberately refuses to pass it through unmapped. */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let rawAgentUuid = 0;
  const rawAgentText = new Map();
  if (soCols.has("agent")) {
    for (const r of await countSql('"agent"')) {
      if (UUID_RE.test(r.v)) rawAgentUuid += r.orders;
      else rawAgentText.set(r.v, r.orders);
    }
  }

  // ── BRANDING ──────────────────────────────────────────────────────────────
  if (itemCols.has("branding")) {
    const cancelled = itemCols.has("cancelled") ? pg`AND i.cancelled = false` : pg``;
    const rows = await pg`
      SELECT btrim(i.branding) AS v,
             count(DISTINCT s.doc_no)::int AS orders,
             count(DISTINCT s.doc_no) FILTER (WHERE s.linked_ac_docno IS NULL)::int AS writable
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
       WHERE s.company_id = ${COMPANY_ID} AND i.branding IS NOT NULL AND btrim(i.branding) <> ''
         ${cancelled}
       GROUP BY 1`;
    for (const r of rows) add("branding", r.v, r.orders, r.writable, "mfg_sales_order_items.branding", true);
  }
  if (soCols.has("branding")) {
    for (const r of await countSql('"branding"')) add("branding", r.v, r.orders, r.writable, "mfg_sales_orders.branding", true);
  }
  if (prodCols.has("branding")) {
    const rows = scopedProducts
      ? await pg`SELECT DISTINCT btrim(branding) AS v FROM scm.mfg_products WHERE company_id = ${COMPANY_ID} AND branding IS NOT NULL AND btrim(branding) <> ''`
      : await pg`SELECT DISTINCT btrim(branding) AS v FROM scm.mfg_products WHERE branding IS NOT NULL AND btrim(branding) <> ''`;
    for (const r of rows) add("branding", r.v, 0, 0, "mfg_products.branding (catalog)", scopedProducts);
  }

  // ── THE REPORT ────────────────────────────────────────────────────────────
  notice(
    `AutoCount master bindings for company ${COMPANY_ID}. Book vocabulary: ` +
      DIMENSIONS.map((d) => `${d.key} ${d.candidates.length}`).join(", ") +
      ` (2026-08-06 maintenance-screen harvest UNION the 2026-08-11 export of ${headers.length} live SO headers).`,
  );

  const proposals = { company_id: COMPANY_ID, generated_at: new Date().toISOString(), dimensions: {} };

  for (const dim of DIMENSIONS) {
    const index = buildIndex(dim.candidates, dim.key);
    const bookHolds = new Set(
      index.entries.flatMap((e) => e.spellings.map((s) => s.toUpperCase().replace(/\s+/g, " ").trim())),
    );
    const all = [...erp[dim.key].values()].sort((a, b) => b.orders - a.orders || a.value.localeCompare(b.value));
    /* NOT WORK, AND SAYING SO. A value that no company-${COMPANY_ID} document
       names AND that came only from a table with no company_id cannot be
       attributed to this company at all — bucketing it would make 2990's people
       look like Houzs bindings nobody had done. */
    const unattributable = all.filter((v) => !v.scoped && v.orders === 0);
    const values = all.filter((v) => v.scoped || v.orders > 0);
    const buckets = { mapped: [], confident: [], ambiguous: [], likely: [], none: [] };
    for (const v of values) {
      const m = bucketOf(v.value, dim, index, bookHolds);
      buckets[m.bucket].push({ ...v, ...m, sources: [...v.sources] });
    }
    const rows = (b) => b.reduce((a, x) => a + x.orders, 0);
    line("");
    notice(
      `${dim.label}: ${values.length} distinct ERP value(s). ` +
        `ALREADY MAPPED ${buckets.mapped.length} (${rows(buckets.mapped)} orders), ` +
        `CONFIDENT ${buckets.confident.length} (${rows(buckets.confident)}), ` +
        `AMBIGUOUS ${buckets.ambiguous.length} (${rows(buckets.ambiguous)}), ` +
        `LIKELY ${buckets.likely.length} (${rows(buckets.likely)}), ` +
        `NO MATCH ${buckets.none.length} (${rows(buckets.none)}).`,
    );
    if (unattributable.length) {
      notice(
        `  plus ${unattributable.length} value(s) NOT COUNTED above: they come only from a table with no ` +
          `company_id and no company-${COMPANY_ID} document names one, so this report cannot say they are ` +
          `ours. They reach the book only if one becomes a live salesperson. First few: ` +
          `${unattributable.slice(0, 8).map((v) => v.value).join(", ")}`,
      );
    }
    /* MASTERS AVOIDED is the owner's actual question — "很多其实都已经有了". A
       confident or confirmed-likely pair is one master NOT opened in a licensed
       book. `mapped` is not counted: those were never going to open one. */
    if (dim.passesThrough) {
      notice(
        `  ${buckets.confident.length} new ${dim.key} master(s) AVOIDED if the confident pairs are confirmed; ` +
          `${buckets.likely.length + buckets.ambiguous.length} more depend on a human; ` +
          `${buckets.none.length} would be opened, correctly.`,
      );
    } else {
      notice(
        `  ${dim.mapName} is an ALLOW-LIST: nothing unmapped is sent, so the ${buckets.none.length} ` +
          `no-match value(s) open nothing — they are simply never written. Confirming a pair here ADDS a ` +
          `binding; it must never turn this map into a pass-through (PR #2200).`,
      );
    }

    for (const [name, title] of [
      ["confident", "CONFIDENT — normalisation alone explains the difference. Confirm and they are done"],
      ["ambiguous", "AMBIGUOUS — normalises onto TWO masters. A person must pick"],
      ["likely", "LIKELY — needs a human. ERP value, candidate, and why"],
      ["none", "NO MATCH — genuinely new; opening it is correct"],
    ]) {
      const b = buckets[name];
      if (!b.length) continue;
      line(`  --- ${title} (${b.length})`);
      for (const x of b) {
        const counts = `${x.orders} order(s), ${x.writable} still writable`;
        line(
          name === "none"
            ? `      ${pad(x.value, 32)} ${counts} [${x.sources.join(", ")}]`
            : `      ${pad(x.value, 32)} -> ${pad(x.target ?? "?", 32)} ${counts} — ${x.reason}` +
              (x.alternatives?.length ? ` | other candidates: ${x.alternatives.map((a) => `${a.value} (${a.reason})`).join("; ")}` : ""),
        );
      }
    }

    /* PASTE-READY. The confirming step is an edit to the JSON, so the report
       hands over exactly the fragment that edit needs — not a table someone has
       to retype into JSON, which is where a wrong bind would come from. */
    if (buckets.confident.length) {
      line(`  --- paste into "${dim.jsonField}" in scripts/data/autocount-so-writeback-mappings.json, then run: node scripts/gen-autocount-master-maps.mjs`);
      for (const x of buckets.confident) {
        line(`      ${JSON.stringify(x.value.toUpperCase())}: ${JSON.stringify(x.target)},`);
      }
    }

    proposals.dimensions[dim.key] = {
      json_field: dim.jsonField,
      map: dim.mapName,
      book_candidates: index.size,
      confident: Object.fromEntries(buckets.confident.map((x) => [x.value.toUpperCase(), x.target])),
      needs_a_person: [...buckets.ambiguous, ...buckets.likely].map((x) => ({
        erp: x.value, candidate: x.target, reason: x.reason, orders: x.orders,
        alternatives: x.alternatives?.map((a) => a.value) ?? [],
      })),
      no_match: buckets.none.map((x) => ({ erp: x.value, orders: x.orders })),
      already_mapped: buckets.mapped.length,
    };
  }

  // ── THE AGENT DECISIONS THAT ARE NOT MATCHING PROBLEMS ─────────────────────
  line("");
  notice(
    `RAW mfg_sales_orders.agent: ${rawAgentUuid} order(s) hold a bare uuid and ${rawAgentText.size} distinct ` +
      `text value(s) — ${[...rawAgentText.entries()].map(([v, n]) => `${v} (${n})`).join(", ") || "none"}. ` +
      `resolveAcAgent deliberately never passes this column through unmapped, so nothing here is proposed; ` +
      `it is listed because a value that IS in AGENT_MAP is still read from it.`,
  );
  /* `agent_excluded` is a record of a decision, not a gate — nothing in the
     composer reads it. A live salesperson that looks like a test account and is
     NOT on that list would be OPENED as a sales agent in the licensed book, so
     it is surfaced as a decision rather than silently added to the list. */
  const excluded = new Set(book.agent_excluded.reps.map((r) => r.toUpperCase()));
  const suspicious = [...erp.agent.values()]
    .filter((v) => /\b(TEST|DEMO|DUMMY|SAMPLE)\b/i.test(v.value) && !excluded.has(v.value.toUpperCase()))
    .sort((a, b) => b.orders - a.orders || a.value.localeCompare(b.value));
  const onLiveOrders = suspicious.filter((v) => v.orders > 0);
  notice(
    `AGENT_EXCLUDED holds ${excluded.size} rep(s) already decided against. ${suspicious.length} ERP staff ` +
      `name(s) read as a test account and are NOT on it, ${onLiveOrders.length} of them ON A LIVE ORDER — ` +
      `/ensure-masters would open each as a real sales agent in the licensed book. THIS IS A DECISION, not a ` +
      `match, so none of them is proposed: ` +
      `${suspicious.map((v) => `${v.value} (${v.orders} order(s), ${v.writable} writable)`).join(", ") || "none"}.`,
  );
  proposals.agent_excluded_decisions = suspicious.map((v) => ({ erp: v.value, orders: v.orders, writable: v.writable }));

  const out = process.env.PROPOSALS_OUT;
  if (out) {
    writeFileSync(out, `${JSON.stringify(proposals, null, 2)}\n`);
    notice(`proposals written to ${out}`);
  }
} catch (e) {
  /* An unreachable database is the ONE non-zero exit here: everything else
     above is an answer, and a red job would read as "the check broke". */
  console.error(`::error::master-binding check could not run: ${e instanceof Error ? e.message : String(e)}`);
  await pg.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

await pg.end({ timeout: 5 });
