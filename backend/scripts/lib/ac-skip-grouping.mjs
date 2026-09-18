// ONE ROW, ONE REFUSAL CLASS — the grouping the outbox reports read from.
//
// WHY IT IS A MODULE AND NOT SIX LINES IN THE SCRIPT. It was six lines in the
// script, and it re-implemented the classification rule instead of calling it:
// once per kind, `rows.filter(r => r.last_error.includes(needle))`, with
// nothing excluding a row an earlier kind had already claimed. AC_SKIP_KINDS is
// a PRIORITY order and says so in its own comments; `classifyAcSkip` honours it
// by returning the FIRST match; that loop did not, so a stored sentence
// containing two needles was reported twice, under two different remedies.
//
// Measured on production run 33593927462 (2026-09-02): two skipped rows on ONE
// document, printed as `skipped 2` twice — once telling the reader to backfill
// this document's line keys, once telling them to backfill a SOURCE document
// that an edit does not have. Four report lines for two rows.
//
// It lives here so a test can address it. It is imported by a vitest suite, so
// it carries NO shebang (CLAUDE.md, #2062).
import {
  AC_SKIP_KINDS,
  AC_SKIP_UNRECOGNISED,
  classifyAcSkip,
} from "./autocount-skip-kinds.mjs";

/**
 * Bucket outbox rows by refusal class, each row in exactly one bucket.
 *
 * @param {Array<{ last_error?: string | null }>} rows
 * @returns {{ ordered: Array<{kind: string, remedy: string, rows: Array<object>}>,
 *             unrecognised: Array<object> }}
 *   `ordered` follows AC_SKIP_KINDS, which is the priority order a reader
 *   should see the classes in. `unrecognised` is returned separately rather
 *   than folded into a neighbour: a reason no code path here recognises is a
 *   refusal that grew somewhere else, and counting it away is how it stays
 *   invisible.
 */
export function groupAcSkipsByKind(rows) {
  const byKind = new Map();
  for (const r of rows) {
    const { kind } = classifyAcSkip(r.last_error);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(r);
  }
  const ordered = [];
  for (const k of AC_SKIP_KINDS) {
    const hits = byKind.get(k.kind);
    if (hits && hits.length) ordered.push({ kind: k.kind, remedy: k.remedy, rows: hits });
  }
  return { ordered, unrecognised: byKind.get(AC_SKIP_UNRECOGNISED) ?? [] };
}
