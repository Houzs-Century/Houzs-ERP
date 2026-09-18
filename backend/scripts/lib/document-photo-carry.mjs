// ---------------------------------------------------------------------------
// document-photo-carry — "does this Purchase / Delivery Order line show the
// photograph its Sales Order line shows?", decided in one place.
//
// A PO or DO line raised from a Sales Order line carries that line's photo keys
// (migs 0274 and 20260828T0746). The carry is a SNAPSHOT taken at convert time
// and it is correct: measured on production 2026-09-11, ZERO ERP-raised PO
// lines are missing a key their source SO line holds.
//
// The lines that ARE missing one all sit on AutoCount-IMPORTED documents, where
// no convert ever ran, and they come in two shapes that must NOT be treated
// alike:
//
//   FILL   — the document line carries NOTHING and the SO line has a photo.
//            The document shows no picture at all. 117 PO lines / 68 DO lines.
//
//   MIRROR — the document line already carries its OWN photograph (the book's
//            `po-items/.../ac-<DtlKey>-n.jpg` attachment, put on the PURCHASE
//            document in AutoCount) and the SO line carries a DIFFERENT one.
//            193 PO lines, 0 DO lines. Nothing is invisible here; adding the
//            SO's shot puts a SECOND sketch on an already-received purchase
//            order, which is a printing decision and not a repair.
//
// Reading both as "missing a key" is the trap this repo keeps paying for — a
// query that answers a slightly different question than the one asked. So
// `includeMirror` is REQUIRED, not defaulted (CLAUDE.md: a parameter that
// decides something must fail to compile when a caller forgets it).
//
// NEVER REPLACES. The next value is the line's own keys followed by the source
// keys it lacks — a purchaser's own upload keeps its place, because the PDF's
// photo chips and the on-screen strip both render in array order.
// ---------------------------------------------------------------------------

/**
 * One candidate line, as the repair reads it.
 * @typedef {object} CarryRow
 * @property {string}   id
 * @property {string}   table    'purchase_order_items' | 'delivery_order_items'
 * @property {string}   docNo    the printed document number, for the log
 * @property {string}   itemCode
 * @property {string[]} docKeys  what the document line carries now
 * @property {string[]} soKeys   what its source Sales Order line carries
 */

/**
 * Split the candidates into what to write, what to hold back, and what is
 * already right.
 *
 * @param {CarryRow[]} rows
 * @param {{ includeMirror: boolean }} opts  includeMirror decides whether a
 *   line that already shows a photograph of its own also gains the Sales
 *   Order's. REQUIRED — the two answers touch different populations.
 * @returns {{ fills: Array<CarryRow & {next: string[]}>,
 *             mirrors: Array<CarryRow & {next: string[]}>,
 *             writes: Array<CarryRow & {next: string[]}>,
 *             complete: CarryRow[] }}
 */
export function planPhotoCarry(rows, opts) {
  if (typeof opts?.includeMirror !== 'boolean') {
    throw new Error('planPhotoCarry: includeMirror must be passed explicitly (true or false)');
  }
  const fills = [];
  const mirrors = [];
  const complete = [];
  for (const r of rows) {
    const have = new Set(r.docKeys);
    const missing = r.soKeys.filter((k) => !have.has(k));
    if (missing.length === 0) { complete.push(r); continue; }
    const planned = { ...r, next: [...r.docKeys, ...missing] };
    if (r.docKeys.length === 0) fills.push(planned);
    else mirrors.push(planned);
  }
  return {
    fills,
    mirrors,
    complete,
    writes: opts.includeMirror ? [...fills, ...mirrors] : fills,
  };
}

/**
 * What is WRONG after the write, read back from a fresh connection.
 *
 * Asserts the SHAPE, not a row count: a count of updates would be true even if
 * an array had landed empty, or had dropped the purchaser's own key while
 * gaining the Sales Order's.
 *
 * @param {Array<CarryRow & {next: string[]}>} written
 * @param {Map<string, {docKeys: string[]}>} after  by row id
 * @returns {string[]} one line per problem; empty means verified
 */
export function verifyPhotoCarry(written, after) {
  const bad = [];
  for (const w of written) {
    const now = after.get(w.id);
    if (!now) { bad.push(`${w.docNo} ${w.itemCode}: row is gone`); continue; }
    const have = new Set(now.docKeys);
    const absent = w.soKeys.filter((k) => !have.has(k));
    const lost = w.docKeys.filter((k) => !have.has(k));
    if (absent.length) bad.push(`${w.docNo} ${w.itemCode}: ${absent.length} source key(s) still absent`);
    if (lost.length) bad.push(`${w.docNo} ${w.itemCode}: LOST ${lost.length} key(s) of its own`);
  }
  return bad;
}
