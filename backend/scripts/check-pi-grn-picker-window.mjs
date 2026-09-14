// Read-only: does the "Bill a Goods-Received Note" picker hide notes that still
// have something to bill?
//
// WHY THIS EXISTS
//
// GET /purchase-invoices/outstanding-grn-items (backend/src/scm/routes/
// purchase-invoices.ts) reads the newest 500 POSTED, not-held goods-received
// notes by received_at, and only THEN keeps the lines that still have
// qty_accepted - invoiced_qty - returned_qty > 0. The cap is spent on every
// posted note, fully billed or not, so once a company holds more than 500 of
// them an older note with unbilled lines drops out of the picker — and out of
// its search — with nothing on the screen to say so. The follow-up grn_items
// read is one unpaged `.in('grn_id', <up to 500 ids>)`, so it can also lose rows
// to PostgREST's response ceiling, or be refused for its URI length.
//
// That is a reading of the code. Whether production is past either edge is a
// fact about production, and this reports it, per company:
//
//   - posted, not-held notes, and how many carry an unbilled line;
//   - how many of those fall OUTSIDE the newest 500 (with tie bounds: the
//     handler orders by a date alone, so notes sharing the 500th note's date
//     land either side of the window arbitrarily);
//   - how many grn_items rows the newest 500 carry (the unpaged read);
//   - two facts a fix leans on: line vs note company_id agreement, and whether
//     scm.v_grn_outstanding agrees with the line arithmetic.
//
// COUNTS AND DATES ONLY. The repository is public and so is every Actions log:
// no document number, supplier, item or amount is printed.
//
// Two SELECTs — a catalogue lookup for the view, then the measurement. No DDL,
// no writes, no transaction. Exits 0 for every answer, including "hidden"; only
// an unreachable database or a failed query exits non-zero.
//
// RE-RUN: harmless. It writes nothing, so a second run reads the same tables
// again and differs only by whatever staff billed in between.
import { appendFileSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { PICKER_WINDOW, assessCompany, describeCompany } from "./lib/pi-grn-picker-window.mjs";

// Same resolution order as check-soak-gate.mjs: env wins so CI needs no .dev.vars.
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
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const warning = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);
const redact = (s) => String(s).replace(/postgres(ql)?:\/\/\S+/gi, "postgres://<redacted>");

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const [{ has_view: hasView }] = await pg`
    SELECT to_regclass('scm.v_grn_outstanding') IS NOT NULL AS has_view`;

  const rows = await pg`
    WITH posted AS (
      SELECT g.id, g.company_id, g.received_at,
             ROW_NUMBER() OVER (PARTITION BY g.company_id ORDER BY g.received_at DESC NULLS FIRST, g.id) AS rn,
             DENSE_RANK() OVER (PARTITION BY g.company_id ORDER BY g.received_at DESC NULLS FIRST)       AS day_rank
        FROM scm.grns g
       WHERE g.status = 'POSTED' AND g.on_hold = false
    ),
    note_lines AS (
      SELECT gi.grn_id,
             COUNT(*) AS lines,
             COUNT(*) FILTER (
               WHERE COALESCE(gi.qty_accepted, 0) - COALESCE(gi.invoiced_qty, 0) - COALESCE(gi.returned_qty, 0) > 0
             ) AS outstanding_lines,
             COUNT(*) FILTER (WHERE gi.company_id IS DISTINCT FROM p.company_id) AS company_mismatch
        FROM scm.grn_items gi
        JOIN posted p ON p.id = gi.grn_id
       GROUP BY gi.grn_id
    ),
    edge AS (
      SELECT company_id, day_rank AS edge_rank, received_at AS edge_date
        FROM posted
       WHERE rn = ${PICKER_WINDOW}::int
    ),
    notes AS (
      SELECT p.company_id, p.rn, p.day_rank, p.received_at,
             COALESCE(l.lines, 0)             AS lines,
             COALESCE(l.outstanding_lines, 0) AS outstanding_lines,
             COALESCE(l.company_mismatch, 0)  AS company_mismatch,
             e.edge_rank, e.edge_date,
             ${hasView ? pg`v.is_outstanding` : pg`NULL::boolean`} AS view_outstanding
        FROM posted p
        LEFT JOIN note_lines l ON l.grn_id = p.id
        LEFT JOIN edge e ON e.company_id = p.company_id
        ${hasView ? pg`LEFT JOIN scm.v_grn_outstanding v ON v.id = p.id` : pg``}
    ),
    slots AS (
      SELECT company_id, ${PICKER_WINDOW}::int - COUNT(*) FILTER (WHERE day_rank < edge_rank) AS edge_slots
        FROM notes
       WHERE edge_rank IS NOT NULL
       GROUP BY company_id
    ),
    edge_notes AS (
      SELECT n.company_id, n.lines, s.edge_slots,
             ROW_NUMBER() OVER (PARTITION BY n.company_id ORDER BY n.lines ASC)  AS asc_rank,
             ROW_NUMBER() OVER (PARTITION BY n.company_id ORDER BY n.lines DESC) AS desc_rank
        FROM notes n
        JOIN slots s ON s.company_id = n.company_id
       WHERE n.day_rank = n.edge_rank
    ),
    edge_sums AS (
      SELECT company_id,
             COALESCE(SUM(lines) FILTER (WHERE asc_rank  <= edge_slots), 0) AS min_lines_on_boundary_window,
             COALESCE(SUM(lines) FILTER (WHERE desc_rank <= edge_slots), 0) AS max_lines_on_boundary_window
        FROM edge_notes
       GROUP BY company_id
    )
    SELECT n.company_id,
           MAX(c.code)                                                                  AS company_code,
           COUNT(*)                                                                     AS posted_notes,
           SUM(n.lines)                                                                 AS posted_lines,
           COUNT(*) FILTER (WHERE n.outstanding_lines > 0)                              AS outstanding_notes,
           SUM(n.outstanding_lines)                                                     AS outstanding_lines,
           COUNT(*) FILTER (WHERE n.outstanding_lines > 0 AND n.rn > ${PICKER_WINDOW}::int)  AS outstanding_notes_outside_window,
           COALESCE(SUM(n.outstanding_lines) FILTER (WHERE n.rn > ${PICKER_WINDOW}::int), 0) AS outstanding_lines_outside_window,
           COUNT(*) FILTER (WHERE n.outstanding_lines > 0 AND n.rn <= ${PICKER_WINDOW}::int) AS visible_notes_now,
           COALESCE(SUM(n.outstanding_lines) FILTER (WHERE n.rn <= ${PICKER_WINDOW}::int), 0) AS visible_lines_now,
           COALESCE(SUM(n.lines) FILTER (WHERE n.rn <= ${PICKER_WINDOW}::int), 0)             AS lines_in_window,
           MAX(n.edge_date)::text                                                       AS boundary_date,
           COUNT(*) FILTER (WHERE n.day_rank < n.edge_rank)                             AS notes_newer_than_boundary,
           COALESCE(SUM(n.lines) FILTER (WHERE n.day_rank < n.edge_rank), 0)            AS lines_newer_than_boundary,
           COUNT(*) FILTER (WHERE n.day_rank = n.edge_rank)                             AS notes_on_boundary_date,
           COUNT(*) FILTER (WHERE n.day_rank = n.edge_rank AND n.outstanding_lines > 0) AS outstanding_notes_on_boundary_date,
           COUNT(*) FILTER (WHERE n.day_rank > n.edge_rank AND n.outstanding_lines > 0) AS outstanding_notes_strictly_older,
           MAX(es.min_lines_on_boundary_window)                                         AS min_lines_on_boundary_window,
           MAX(es.max_lines_on_boundary_window)                                         AS max_lines_on_boundary_window,
           MAX(n.lines)                                                                 AS max_lines_one_note,
           COUNT(*) FILTER (WHERE n.received_at IS NULL)                                AS received_at_null,
           SUM(n.company_mismatch)                                                      AS line_company_mismatch,
           ${hasView
             ? pg`COUNT(*) FILTER (WHERE COALESCE(n.view_outstanding, false) <> (n.outstanding_lines > 0))`
             : pg`NULL::bigint`}                                                        AS view_disagreements
      FROM notes n
      LEFT JOIN edge_sums es ON es.company_id = n.company_id
      LEFT JOIN public.companies c ON c.id = n.company_id
     GROUP BY n.company_id
     ORDER BY n.company_id`;

  console.log(
    `Bill a Goods-Received Note picker — read-only, counts only. Window = the newest ${PICKER_WINDOW} ` +
      "POSTED, not-held GRNs by received_at, the handler's .limit(500).",
  );
  if (!hasView) warning("scm.v_grn_outstanding does not exist here; the view comparison is skipped, not passed.");

  if (rows.length === 0) {
    notice("ZERO ROWS — no POSTED, not-held goods-received note in any company. This answers nothing about the picker.");
  }

  const summary = [];
  for (const row of rows) {
    const assessed = assessCompany(row);
    console.log("");
    for (const line of describeCompany(assessed)) console.log(line);
    if (Number(row.received_at_null) > 0) {
      warning(`company ${row.company_id}: ${row.received_at_null} note(s) have no received_at; the handler sorts them FIRST.`);
    }
    for (const v of assessed.verdicts) {
      notice(`company ${assessed.facts.companyId}: ${v.kind} — ${v.text}`);
      summary.push(`| ${assessed.facts.companyId} | ${v.kind} | ${v.text} |`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY && summary.length > 0) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ["| company | verdict | detail |", "| --- | --- | --- |", ...summary, ""].join("\n"),
    );
  }
} catch (e) {
  console.error(`check failed: ${redact(e?.message ?? e)}`);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
