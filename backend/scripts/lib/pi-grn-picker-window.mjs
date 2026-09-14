// The read and the verdicts behind check-pi-grn-picker-window.mjs.
//
// What is being measured: GET /purchase-invoices/outstanding-grn-items read the
// newest PICKER_WINDOW posted, not-held goods-received notes by received_at and
// only THEN kept the lines with qty_accepted - invoiced_qty - returned_qty > 0,
// so the window is spent on every posted note, billed or not.
//
// The SQL lives here rather than in the script so that
// tests-pg/piGrnPickerWindowSql.pg.test.ts can EXECUTE it against real Postgres:
// a workflow_dispatch check cannot run until it is on main, and there is no
// local database, so without that suite the first time the statement met a
// parser would be production (probeTransferCensusSql.pg.test.ts records the
// probe that died exactly that way). The sentences live here so a light test
// can pin what each measured shape is CALLED — "0 hidden" printed for a company
// whose window was never full reads as a pass that nothing measured.

/** The handler's `.limit(500)`. */
export const PICKER_WINDOW = 500;

/** PostgREST's per-response row ceiling as this tree ASSUMES it. The real number
 *  is still unmeasured (docs/bugs/0447), so every sentence that leans on it
 *  says "assumed". */
export const ASSUMED_ROW_CEILING = 1000;

/** The one datum for URI length: ~19.5KB of `in.(…)` uuids was REFUSED at the
 *  gateway on 2026-08-17/18 (backend/src/scm/lib/paginate-all.ts). */
export const REFUSED_URI_BYTES = 19500;

/** Serialized cost of one uuid in `grn_id=in.(…)`: 36 characters plus `%2C`. */
export const UUID_IN_LIST_BYTES = 36 + '%2C'.length;

const n = (v) => (v == null ? 0 : Number(v));
const span = (lo, hi) => (lo === hi ? `${hi}` : `${lo} to ${hi}`);

/**
 * Turn one company's measured row into facts and verdicts.
 *
 * Counts arrive from postgres as strings (bigint), so each is coerced once here.
 *
 * WHY THERE ARE RANGES. The handler orders by `received_at` alone, which is a
 * date, so every note sharing the 500th note's date is placed arbitrarily by the
 * database and can fall either side of the window from one request to the next.
 * The script counts with a deterministic tie-break (received_at DESC, id) AND
 * reports the bounds, so a tie can never be what makes a verdict read clean.
 */
export function assessCompany(row) {
  const posted = n(row.posted_notes);
  const windowFull = posted > PICKER_WINDOW;

  const f = {
    companyId: n(row.company_id),
    companyCode: row.company_code ?? null,
    postedNotes: posted,
    postedLines: n(row.posted_lines),
    outstandingNotes: n(row.outstanding_notes),
    outstandingLines: n(row.outstanding_lines),
    windowFull,
    boundaryDate: row.boundary_date ?? null,
    hiddenNotes: n(row.outstanding_notes_outside_window),
    hiddenLines: n(row.outstanding_lines_outside_window),
    hiddenNotesMin: n(row.outstanding_notes_outside_window),
    hiddenNotesMax: n(row.outstanding_notes_outside_window),
    visibleNotes: n(row.visible_notes_now),
    visibleLines: n(row.visible_lines_now),
    windowLines: n(row.lines_in_window),
    windowLinesMin: n(row.lines_in_window),
    windowLinesMax: n(row.lines_in_window),
    idListBytes: Math.min(posted, PICKER_WINDOW) * UUID_IN_LIST_BYTES,
    maxLinesOneNote: n(row.max_lines_one_note),
    lineCompanyMismatch: n(row.line_company_mismatch),
    /* null = the view was not there to compare against, which is its own fact
       and must not print as "0 disagreements". */
    viewDisagreements: row.view_disagreements == null ? null : n(row.view_disagreements),
  };

  if (windowFull) {
    const newer = n(row.notes_newer_than_boundary);
    const onBoundary = n(row.notes_on_boundary_date);
    const outstandingOnBoundary = n(row.outstanding_notes_on_boundary_date);
    const strictlyOlder = n(row.outstanding_notes_strictly_older);
    const slots = PICKER_WINDOW - newer;
    const leftOut = onBoundary - slots;
    f.hiddenNotesMin = strictlyOlder + Math.max(0, outstandingOnBoundary - slots);
    f.hiddenNotesMax = strictlyOlder + Math.min(outstandingOnBoundary, leftOut);
    f.windowLinesMin = n(row.lines_newer_than_boundary) + n(row.min_lines_on_boundary_window);
    f.windowLinesMax = n(row.lines_newer_than_boundary) + n(row.max_lines_on_boundary_window);
  }

  const verdicts = [];
  if (posted === 0) {
    verdicts.push({ kind: 'EMPTY', text: 'no POSTED, not-held goods-received note in this company, so this run says nothing about the picker here' });
  } else if (!windowFull) {
    verdicts.push({ kind: 'NOT_HIDDEN_YET', text: `${posted} posted, not-held note(s) — under the ${PICKER_WINDOW}-note window, so the window hides nothing today. It starts hiding notes at ${PICKER_WINDOW + 1}.` });
  } else if (f.hiddenNotesMax === 0) {
    verdicts.push({ kind: 'NOT_HIDDEN', text: `${posted} posted notes overflow the window, but every note with an unbilled line is inside it` });
  } else if (f.hiddenNotesMin === 0) {
    verdicts.push({ kind: 'HIDDEN_BY_TIE', text: `up to ${f.hiddenNotesMax} goods-received note(s) with unbilled lines share the window's edge date and can drop out of the picker on any request` });
  } else {
    verdicts.push({ kind: 'HIDDEN', text: `${span(f.hiddenNotesMin, f.hiddenNotesMax)} goods-received note(s) with unbilled lines are ABSENT from the picker (${f.hiddenLines} line(s) at the id tie-break)` });
  }
  if (f.windowLinesMax > ASSUMED_ROW_CEILING) {
    verdicts.push({
      kind: f.windowLinesMin > ASSUMED_ROW_CEILING ? 'ROW_CEILING_EXCEEDED' : 'ROW_CEILING_AT_RISK',
      text: `the unpaged line read covers ${span(f.windowLinesMin, f.windowLinesMax)} row(s), above the assumed ${ASSUMED_ROW_CEILING}-row response ceiling, which drops the rest without an error`,
    });
  }
  if (f.idListBytes >= REFUSED_URI_BYTES) {
    verdicts.push({ kind: 'URI_AT_REFUSED_SIZE', text: `the line read's id list is ~${f.idListBytes} bytes, at or past the ~${REFUSED_URI_BYTES} bytes the gateway has refused, so that read can fail outright` });
  }
  if (f.lineCompanyMismatch > 0) {
    verdicts.push({ kind: 'LINE_COMPANY_MISMATCH', text: `${f.lineCompanyMismatch} line(s) carry a company_id different from their note's, so a line-level company predicate would not match the note-level one` });
  }
  if (f.viewDisagreements != null && f.viewDisagreements > 0) {
    verdicts.push({ kind: 'VIEW_DISAGREES', text: `scm.v_grn_outstanding disagrees with the line arithmetic on ${f.viewDisagreements} note(s)` });
  }
  return { facts: f, verdicts };
}

/**
 * The measurement: two SELECTs over `sql`, a postgres.js client the CALLER opened
 * (the script over DATABASE_URL, the pg suite over its disposable database).
 *
 * The view is looked up first because the join is optional: a missing view must
 * come back as "not compared", never as a statement that fails and takes the
 * rest of the answer with it.
 *
 * The window is replayed with the handler's own order, `received_at DESC` —
 * NULLS FIRST is Postgres's default for DESC and what PostgREST sends — plus
 * `id` as a tie-break for the point counts, and DENSE_RANK over the date alone
 * for the bounds `assessCompany` derives.
 */
export async function measurePickerWindow(sql) {
  const [{ has_view: hasView }] = await sql`
    SELECT to_regclass('scm.v_grn_outstanding') IS NOT NULL AS has_view`;

  const rows = await sql`
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
             ${hasView ? sql`v.is_outstanding` : sql`NULL::boolean`} AS view_outstanding
        FROM posted p
        LEFT JOIN note_lines l ON l.grn_id = p.id
        LEFT JOIN edge e ON e.company_id = p.company_id
        ${hasView ? sql`LEFT JOIN scm.v_grn_outstanding v ON v.id = p.id` : sql``}
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
           MAX(c.code)                                                                        AS company_code,
           COUNT(*)                                                                           AS posted_notes,
           SUM(n.lines)                                                                       AS posted_lines,
           COUNT(*) FILTER (WHERE n.outstanding_lines > 0)                                    AS outstanding_notes,
           SUM(n.outstanding_lines)                                                           AS outstanding_lines,
           COUNT(*) FILTER (WHERE n.outstanding_lines > 0 AND n.rn > ${PICKER_WINDOW}::int)   AS outstanding_notes_outside_window,
           COALESCE(SUM(n.outstanding_lines) FILTER (WHERE n.rn > ${PICKER_WINDOW}::int), 0)  AS outstanding_lines_outside_window,
           COUNT(*) FILTER (WHERE n.outstanding_lines > 0 AND n.rn <= ${PICKER_WINDOW}::int)  AS visible_notes_now,
           COALESCE(SUM(n.outstanding_lines) FILTER (WHERE n.rn <= ${PICKER_WINDOW}::int), 0) AS visible_lines_now,
           COALESCE(SUM(n.lines) FILTER (WHERE n.rn <= ${PICKER_WINDOW}::int), 0)             AS lines_in_window,
           MAX(n.edge_date)::text                                                             AS boundary_date,
           COUNT(*) FILTER (WHERE n.day_rank < n.edge_rank)                                   AS notes_newer_than_boundary,
           COALESCE(SUM(n.lines) FILTER (WHERE n.day_rank < n.edge_rank), 0)                  AS lines_newer_than_boundary,
           COUNT(*) FILTER (WHERE n.day_rank = n.edge_rank)                                   AS notes_on_boundary_date,
           COUNT(*) FILTER (WHERE n.day_rank = n.edge_rank AND n.outstanding_lines > 0)       AS outstanding_notes_on_boundary_date,
           COUNT(*) FILTER (WHERE n.day_rank > n.edge_rank AND n.outstanding_lines > 0)       AS outstanding_notes_strictly_older,
           MAX(es.min_lines_on_boundary_window)                                               AS min_lines_on_boundary_window,
           MAX(es.max_lines_on_boundary_window)                                               AS max_lines_on_boundary_window,
           MAX(n.lines)                                                                       AS max_lines_one_note,
           COUNT(*) FILTER (WHERE n.received_at IS NULL)                                      AS received_at_null,
           SUM(n.company_mismatch)                                                            AS line_company_mismatch,
           ${hasView
             ? sql`COUNT(*) FILTER (WHERE COALESCE(n.view_outstanding, false) <> (n.outstanding_lines > 0))`
             : sql`NULL::bigint`}                                                              AS view_disagreements
      FROM notes n
      LEFT JOIN edge_sums es ON es.company_id = n.company_id
      LEFT JOIN public.companies c ON c.id = n.company_id
     GROUP BY n.company_id
     ORDER BY n.company_id`;

  return { hasView, rows };
}

/** The lines a run prints for one company — counts and dates only, never a
 *  document number, a supplier or an amount: the repository is public and so is
 *  every Actions log. */
export function describeCompany({ facts: f }) {
  const who = f.companyCode ? `company ${f.companyId} (${f.companyCode})` : `company ${f.companyId}`;
  const out = [
    who,
    `  posted, not-held GRNs                  : ${f.postedNotes} (lines: ${f.postedLines})`,
    `  ...with at least one unbilled line     : ${f.outstandingNotes} (unbilled lines: ${f.outstandingLines})`,
    `  unbilled GRNs OUTSIDE the newest ${PICKER_WINDOW}   : ${span(f.hiddenNotesMin, f.hiddenNotesMax)}${f.windowFull ? ` (id tie-break: ${f.hiddenNotes} notes / ${f.hiddenLines} lines; window edge ${f.boundaryDate ?? 'null'})` : ' (window not full)'}`,
    `  grn_items rows across the newest ${PICKER_WINDOW}   : ${span(f.windowLinesMin, f.windowLinesMax)} (assumed row ceiling ${ASSUMED_ROW_CEILING}, unmeasured)`,
    `  what the picker can show today         : ${f.visibleLines} line(s) across ${f.visibleNotes} GRN(s)`,
    `  id list on the line read               : ~${f.idListBytes} bytes (~${REFUSED_URI_BYTES} refused before)`,
    `  most lines on one note                 : ${f.maxLinesOneNote}`,
    `  line company_id != note company_id     : ${f.lineCompanyMismatch}`,
    `  v_grn_outstanding disagreements        : ${f.viewDisagreements == null ? 'view absent, not compared' : f.viewDisagreements}`,
  ];
  return out;
}
