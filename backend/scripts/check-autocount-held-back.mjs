// WHICH document is held back from AutoCount, and is it the one you think?
//
// WHY THIS EXISTS, and it is a different question from outbox health. The daily
// health check answers "is anything stuck". This answers "WHICH document, and
// does the number somebody just said to me name a real one" — because the two
// are not the same question and getting the second one wrong is irreversible.
//
// On 2026-09-02 a Houzs Century order had been held back since 2026-08-31 and
// was being discussed under two different numbers, one of which is outside the
// range AutoCount has ever issued. Pushing the WRONG document into a licensed
// account book cannot be undone, so the number has to be settled by rows, not
// by deciding which one somebody probably meant.
//
// Three sections, in the order the question actually gets asked:
//
//   1. HELD BACK   every outbox row that is not `sent`, as a document number, a
//                  reason CODE and an age. If exactly one document is listed,
//                  that on its own settles which document is being talked about.
//   2. DOES IT EXIST  a doc_no search for a number, across every table in the
//                  database that has a doc_no column — so "no such document"
//                  is a measurement and not a shrug. It runs the SAME search
//                  for a number that MUST be found (CONTROL below), because a
//                  matcher that cannot match reports a clean run.
//   3. STATE       one document, in full: its AutoCount number, how many of its
//                  lines carry an AutoCount line key, whether a purchase order
//                  was raised from it, and what is downstream of it. The last
//                  two are what decide whether the document may be REBUILT: a
//                  rebuild reissues every AutoCount line key, and a purchase
//                  line raised from a sales line records which sales line it
//                  came from, so rebuilding voids that link silently.
//
// THE LOG IS PUBLIC. This repository and its Actions logs are readable by
// anyone, so this prints document numbers, counts, dates, reason codes and
// booleans — never a customer, an address, an item description, an amount, or a
// `last_error` string verbatim. Errors are CLASSIFIED into the shared reason
// codes instead (scripts/lib/autocount-skip-kinds.mjs), which is also the more
// useful output: a code names a remedy, a sentence names an incident.
//
// Strictly read-only: SELECTs only, no DDL, no writes, no transaction. EXITS 0
// for every legitimate answer including "nothing is held back" — the ANSWER is
// the output and a red job reads as "the check broke". Only an unreachable
// database exits non-zero.
//
// RE-RUN: idempotent. It reads and prints, and holds no state between runs.
import { readFileSync } from "node:fs";
import postgres from "postgres";

/* The reason-code taxonomy is shared with the ERP's own outbox page and with
   the daily health check, so all three name a refusal the same way. */
import {
  classifyAcSkip,
  acOutboxState,
  isRequeuedNote,
  AC_SKIP_UNRECOGNISED,
} from "./lib/autocount-skip-kinds.mjs";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("check-autocount-held-back: no DATABASE_URL.");
  process.exit(1);
}

/** The document to report in full. */
const DOC = process.env.DOC || "HC-SO-013394";

/** The number being CHECKED FOR EXISTENCE — the one nobody can find. */
const SEARCH = process.env.SEARCH || "013884";

/** A number the search MUST find. Without this the search proves nothing: a
 *  broken pattern and an absent document produce the same empty result, and
 *  this repo has shipped a checker that reported a clean run from a dead
 *  matcher more than once (CLAUDE.md). */
const CONTROL = process.env.CONTROL || "013394";

const out = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/** Which columns a table actually has, so a missing one is a reported absence
 *  rather than a 42703 that kills the run three sections in. */
async function columnsOf(schema, table) {
  const rows = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(rows.map((r) => r.column_name));
}

/** A reason CODE for any outbox row, never the stored sentence.
 *
 *  Falls back to the exception class name AutoCount/the composer put in
 *  parentheses, which is a type and not content, and then to `unrecognised` —
 *  which is a finding, not a bucket to hide in. */
function reasonCode(status, lastError) {
  const text = String(lastError ?? "");
  if (!text.trim()) return status === "pending" ? "not-yet-attempted" : "no-reason-recorded";
  const { kind } = classifyAcSkip(text);
  if (kind !== AC_SKIP_UNRECOGNISED) return kind;
  const cls = text.match(/\(([A-Za-z]+(?:Error|Exception))\)/);
  if (cls) return `error-class:${cls[1]}`;
  const http = text.match(/\b(4\d\d|5\d\d)\b/);
  if (http) return `http-${http[1]}`;
  return AC_SKIP_UNRECOGNISED;
}

const ageOf = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "(unparseable)";
  const h = Math.floor((Date.now() - t) / 3600000);
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
const day = (iso) => (iso ? String(new Date(iso).toISOString().slice(0, 10)) : "-");

try {
  // ── 1. WHAT IS HELD BACK ────────────────────────────────────────────────
  const [totals, held] = await Promise.all([
    pg`SELECT status, count(*)::int AS n FROM scm.autocount_outbox GROUP BY status ORDER BY status`,
    pg`SELECT doc_type, doc_no, op, status, attempts, last_error, created_at
         FROM scm.autocount_outbox
        WHERE status <> 'sent'
        ORDER BY created_at ASC`,
  ]);

  out("== 1. HELD BACK — every AutoCount outbox row that is not `sent` ==");
  out(
    `   queue totals: ${totals.map((r) => `${r.status} ${r.n}`).join(" / ") || "(empty)"}` +
      `  — total ${totals.reduce((a, r) => a + r.n, 0)}`,
  );
  if (!held.length) {
    out("   NOTHING HELD BACK. Every row in the queue reached the account book.");
  } else {
    for (const r of held) {
      const state = acOutboxState(r.status, r.last_error);
      out(
        `   - ${r.doc_type} ${r.doc_no}  op=${r.op}  state=${state}` +
          `  reason=${reasonCode(r.status, r.last_error)}` +
          `  attempts=${r.attempts}  stuck ${ageOf(r.created_at)} (since ${day(r.created_at)})` +
          (isRequeuedNote(r.last_error) ? "  [already re-queued — history, not an open item]" : ""),
      );
    }
    const docs = [...new Set(held.map((r) => `${r.doc_type} ${r.doc_no}`))];
    out(`   DISTINCT DOCUMENTS HELD BACK: ${docs.length} -> ${docs.join(", ")}`);
    if (docs.length === 1) {
      out("   Exactly one. Any other number being discussed is not this document.");
    }
  }

  // ── 2. DOES A DOCUMENT WITH THAT NUMBER EXIST, ANYWHERE ─────────────────
  //
  // Every table in the database carrying a `doc_no` column is searched, so the
  // answer is not limited to the table somebody guessed. The CONTROL number
  // goes through the identical code path in the identical pass: if the control
  // comes back zero, the search is broken and the SEARCH result means nothing.
  /* VIEWS ARE INCLUDED, and that is a correction rather than a preference. The
     first run filtered `table_type = 'BASE TABLE'` and so never searched
     `public.sales_orders` — the AutoCount inbound mirror, the one relation
     whose doc_no vocabulary is AutoCount's own. A sweep that silently skips the
     table the question is about answers a different question, which is the trap
     CLAUDE.md names. A view counted alongside its base table double-counts, and
     that is visible: every relation is printed with its type. */
  const docNoTables = await pg`
    SELECT c.table_schema AS s, c.table_name AS t, tb.table_type AS kind
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.column_name = 'doc_no'
       AND c.table_schema IN ('public', 'scm')
     ORDER BY 1, 2`;

  out("");
  out("== 2. DOES ANY DOCUMENT NUMBERED LIKE THIS EXIST? ==");
  out(`   searching for '%${SEARCH}%'  (control, must be found: '%${CONTROL}%')`);
  out(`   tables with a doc_no column in schemas public+scm: ${docNoTables.length}`);

  let searchHits = 0;
  let controlHits = 0;
  const hitLines = [];
  for (const { s, t, kind } of docNoTables) {
    const q = pg.unsafe(
      `SELECT count(*) FILTER (WHERE doc_no LIKE $1)::int AS a,
              count(*) FILTER (WHERE doc_no LIKE $2)::int AS b,
              count(*)::int AS n
         FROM "${s}"."${t}"`,
      [`%${SEARCH}%`, `%${CONTROL}%`],
    );
    let row;
    try {
      [row] = await q;
    } catch (e) {
      hitLines.push(`   - ${s}.${t}: UNREADABLE (${e.code ?? "error"})`);
      continue;
    }
    searchHits += row.a;
    controlHits += row.b;
    if (row.a > 0 || row.b > 0) {
      hitLines.push(
        `   - ${s}.${t} [${kind === "VIEW" ? "view" : "table"}]:` +
          ` '${SEARCH}' ${row.a}   '${CONTROL}' ${row.b}   (rows ${row.n})`,
      );
    }
  }
  for (const l of hitLines) out(l);

  out(`   TOTAL for '${SEARCH}': ${searchHits}`);
  out(`   TOTAL for '${CONTROL}' (control): ${controlHits}`);
  if (controlHits === 0) {
    out("   ^ THE CONTROL FOUND NOTHING, so this search proves NOTHING about");
    out("     the number above. Fix the search before reading its zero.");
  } else if (searchHits === 0) {
    out(`   ^ NO DOCUMENT anywhere carries '${SEARCH}' in its number, and the same`);
    out("     search in the same pass found the control. The zero is real.");
  }

  /* The ceilings, so "outside the range ever issued" is a number and not a
     belief. Both sides: what the ERP has numbered, and what the AutoCount
     inbound mirror holds. */
  for (const [s, t, label] of [
    ["scm", "mfg_sales_orders", "ERP sales orders"],
    ["public", "sales_orders", "AutoCount inbound mirror"],
  ]) {
    try {
      const [r] = await pg.unsafe(
        `SELECT count(*)::int AS n, min(doc_no) AS lo, max(doc_no) AS hi FROM "${s}"."${t}"`,
      );
      out(`   ${s}.${t} (${label}): ${r.n} rows, doc_no ${r.lo ?? "-"} .. ${r.hi ?? "-"}`);
    } catch (e) {
      out(`   ${s}.${t} (${label}): UNREADABLE (${e.code ?? "error"})`);
    }
  }

  // ── 3. THE STATE OF ONE DOCUMENT ────────────────────────────────────────
  out("");
  out(`== 3. STATE OF ${DOC} ==`);

  const soCols = await columnsOf("scm", "mfg_sales_orders");
  /* `doc_date` / `cancelled` / `id` are NOT on this table — measured, not
     assumed: the first run printed them as absent. The date the document
     carries lives under one of the names below, so all of them are offered and
     whichever exists is read. */
  const wanted = ["doc_no", "company_id", "status", "cancelled", "doc_date", "so_date",
                  "order_date", "date", "linked_ac_docno", "created_at", "updated_at"];
  const have = wanted.filter((c) => soCols.has(c));
  const missing = wanted.filter((c) => !soCols.has(c));
  if (missing.length) out(`   (columns absent on scm.mfg_sales_orders: ${missing.join(", ")})`);

  const [so] = await pg.unsafe(
    `SELECT ${have.map((c) => `"${c}"`).join(", ")} FROM scm.mfg_sales_orders WHERE doc_no = $1`,
    [DOC],
  );

  if (!so) {
    out(`   NOT FOUND. scm.mfg_sales_orders has no row with doc_no = '${DOC}'.`);
  } else {
    out(`   company_id      ${so.company_id ?? "-"}`);
    out(`   status          ${so.status ?? "-"}${so.cancelled === undefined ? "" : `  cancelled=${so.cancelled}`}`);
    const docDate = so.doc_date ?? so.so_date ?? so.order_date ?? so.date ?? null;
    out(`   document date   ${day(docDate)}   created ${day(so.created_at)}   updated ${day(so.updated_at)}`);
    /* The AutoCount side of the cross-reference. NULL is meaningful: "this
       document has no AutoCount counterpart yet" (mig 0277). */
    out(`   linked_ac_docno ${so.linked_ac_docno ?? "NONE — no AutoCount counterpart recorded"}`);

    const itemCols = await columnsOf("scm", "mfg_sales_order_items");
    const hasCancelled = itemCols.has("cancelled");
    /* THE ORDER IS PART OF THE ANSWER. The refusal stored on the outbox row
       names a line by POSITION, and a position means nothing without the
       ordering that produced it — the first run of this check put the keyless
       line 8th while the stored refusal called it line 1. So the ordering
       column is chosen from what the table actually has, and PRINTED. */
    const seqCol = ["line_no", "seq", "sort_order", "line_number", "position"]
      .find((c) => itemCols.has(c));
    const orderBy = seqCol ?? (itemCols.has("created_at") ? "created_at, id" : "id");
    const lines = await pg.unsafe(
      `SELECT id, linked_ac_dtlkey${hasCancelled ? ", cancelled" : ""}
         FROM scm.mfg_sales_order_items WHERE doc_no = $1 ORDER BY ${orderBy}`,
      [DOC],
    );
    const live = hasCancelled ? lines.filter((l) => !l.cancelled) : lines;
    const keyed = live.filter((l) => l.linked_ac_dtlkey !== null && l.linked_ac_dtlkey !== undefined);
    const keyless = live
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => l.linked_ac_dtlkey === null || l.linked_ac_dtlkey === undefined)
      .map(([i]) => i);
    out(
      `   lines           ${lines.length} total` +
        (hasCancelled ? `, ${lines.length - live.length} cancelled, ${live.length} live` : "") +
        ` — ${keyed.length} carry linked_ac_dtlkey, ${keyless.length} do NOT`,
    );
    if (keyless.length) {
      /* Positions, not item codes: a position is enough to open the document
         and is not content. */
      out(
        `   keyless line positions (1-based, live lines ordered by ${orderBy}): ${keyless.join(", ")}`,
      );
    }

    /* THE REBUILD GATE. Mirrors the ERP's own `poRaisedFromSo` exactly —
       purchase_order_items.so_item_id naming any line of this order — because
       an answer that differs from the code's answer is worse than no answer. */
    /* THE REBUILD GATE, counted the way poRaisedFromSo counts it — and counted
       in PIECES, because the first run of this check answered the whole thing
       `UNREADABLE (42703)` and an undefined column somewhere in a three-table
       join names nothing. Each relation is probed for the columns the ERP's own
       query needs, so an absence is REPORTED as which column is missing on
       which table. That distinction is the finding: if
       purchase_order_items.so_item_id does not exist in production, then
       poRaisedFromSo — which THROWS on a failed read — throws on every save of
       a sales order, and this section is the only place that would say so. */
    const ids = lines.map((l) => l.id);
    const poiCols = await columnsOf("scm", "purchase_order_items");
    const poCols = await columnsOf("scm", "purchase_orders");
    const allocCols = await columnsOf("scm", "purchase_order_item_allocations");
    out(
      `   scm.purchase_order_items: so_item_id=${poiCols.has("so_item_id")}` +
        ` purchase_order_id=${poiCols.has("purchase_order_id")}` +
        `  | scm.purchase_orders: doc_no=${poCols.has("doc_no")} id=${poCols.has("id")}` +
        `  | allocations table: ${allocCols.size > 0 ? "present" : "ABSENT"}`,
    );

    let poRaised = null;
    let poDocs = [];
    if (!ids.length) {
      poRaised = false;
      out("   purchase lines raised from this SO: 0 (the order has no lines)");
    } else if (!poiCols.has("so_item_id")) {
      out("   purchase lines raised from this SO: UNKNOWN — scm.purchase_order_items");
      out("     has no so_item_id column, which is the column poRaisedFromSo reads.");
    } else {
      /* Joined through a SUBQUERY on the SO's own lines rather than by shipping
         the id list back as a parameter: the key types across these tables are
         not uniform, and `uuid = ANY(text[])` fails as an absent OPERATOR —
         which would surface as "no purchase order", the one wrong answer this
         check must never give. */
      try {
        const [c] = await pg`
          SELECT count(*)::int AS n FROM scm.purchase_order_items
           WHERE so_item_id IN (
             SELECT id FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC})`;
        poRaised = c.n > 0;
        out(`   purchase lines raised from this SO (purchase_order_items.so_item_id): ${c.n}`);
      } catch (e) {
        /* "I could not tell" and "no purchase order exists" are opposite facts
           and only one of them makes a rebuild safe (so-po-raised.ts says so in
           its own words). So an unreadable count is reported as UNKNOWN and
           never spent as a zero. */
        poRaised = null;
        out(`   purchase lines raised from this SO: UNREADABLE (${e.code ?? "error"}) — UNKNOWN, not zero`);
      }
      if (poRaised && poCols.has("doc_no") && poiCols.has("purchase_order_id")) {
        try {
          const rows = await pg`
            SELECT DISTINCT po.doc_no
              FROM scm.purchase_order_items poi
              JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
             WHERE poi.so_item_id IN (
               SELECT id FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC})`;
          poDocs = rows.map((r) => r.doc_no).filter(Boolean);
          out(`   purchase orders naming a line of this SO: ${poDocs.join(", ") || "(none named)"}`);
        } catch (e) {
          out(`   purchase order numbers: UNREADABLE (${e.code ?? "error"})`);
        }
      }
    }

    /* The finer-grained answer 0235 introduced. so-po-raised.ts says either one
       existing is enough, so a zero on the line column with rows here would
       still be a purchase raised from this order. */
    if (allocCols.has("so_item_id")) {
      try {
        const [a] = await pg`
          SELECT count(*)::int AS n FROM scm.purchase_order_item_allocations
           WHERE so_item_id IN (
             SELECT id FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC})`;
        out(`   purchase allocations naming a line of this SO: ${a.n}`);
        if (a.n > 0 && poRaised === false) poRaised = true;
      } catch (e) {
        out(`   purchase allocations: UNREADABLE (${e.code ?? "error"})`);
      }
    }

    /* Lines DELETED from this order. The rebuild rule fires on a change to the
       line SET, so "has a line ever been removed" is part of
       this document's state and not trivia. */
    if ((await columnsOf("scm", "mfg_so_item_deletions")).has("doc_no")) {
      try {
        const [d] = await pg`
          SELECT count(*)::int AS n FROM scm.mfg_so_item_deletions WHERE doc_no = ${DOC}`;
        out(`   line deletions recorded against this SO: ${d.n}`);
      } catch (e) {
        out(`   line deletions: UNREADABLE (${e.code ?? "error"})`);
      }
    }

    /* The ordinary downstream lock, for contrast: it counts DO and SI only —
       never a purchase order, which is the gap the rebuild gate exists for. */
    const downstream = {};
    for (const t of ["delivery_orders", "sales_invoices"]) {
      try {
        const [r] = await pg.unsafe(
          `SELECT count(*)::int AS n FROM "scm"."${t}" WHERE so_doc_no = $1 AND status <> 'CANCELLED'`,
          [DOC],
        );
        downstream[t] = r.n;
      } catch (e) {
        downstream[t] = `UNREADABLE (${e.code ?? "error"})`;
      }
    }
    out(`   live delivery orders ${downstream.delivery_orders}   live sales invoices ${downstream.sales_invoices}`);

    const ob = await pg`
      SELECT op, status, attempts, last_error, created_at
        FROM scm.autocount_outbox WHERE doc_no = ${DOC} ORDER BY created_at ASC`;
    out(`   outbox rows for this document: ${ob.length}`);
    for (const r of ob) {
      out(
        `     - op=${r.op} state=${acOutboxState(r.status, r.last_error)}` +
          ` reason=${reasonCode(r.status, r.last_error)} attempts=${r.attempts}` +
          ` since ${day(r.created_at)} (${ageOf(r.created_at)})`,
      );
    }

    out("");
    out("   -- VERDICT ---------------------------------------------------");
    out(
      `   rebuild BLOCKED (a PO was raised from this SO): ${
        poRaised === null ? "UNKNOWN — the purchase-line read failed" : poRaised ? "YES" : "NO"
      }`,
    );
    out(
      `   downstream lock:        ${
        typeof downstream.delivery_orders === "number" && typeof downstream.sales_invoices === "number"
          ? downstream.delivery_orders + downstream.sales_invoices > 0
            ? "LOCKED"
            : "OPEN"
          : "UNKNOWN — a downstream read failed"
      }`,
    );
  }

  out("");
  out("-- read-only. Nothing was written. --------------------------------");
} catch (e) {
  console.error(`check-autocount-held-back: query failed — ${e.message}`);
  await pg.end({ timeout: 5 });
  process.exit(1);
}

await pg.end({ timeout: 5 });
