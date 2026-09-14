// The verdict half of check-pi-grn-picker-window.mjs, kept free of any database
// so a test can pin what each measured shape is CALLED. The script owns the
// read; this module owns the sentences, and the sentences are where a check like
// this goes wrong — "0 hidden" printed for a company whose window was never full
// reads as a pass that nothing measured.
//
// What is being measured: GET /purchase-invoices/outstanding-grn-items read the
// newest PICKER_WINDOW posted, not-held goods-received notes by received_at and
// only THEN kept the lines with qty_accepted - invoiced_qty - returned_qty > 0,
// so the window is spent on every posted note, billed or not.

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
