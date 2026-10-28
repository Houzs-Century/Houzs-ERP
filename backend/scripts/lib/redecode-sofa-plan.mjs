// ---------------------------------------------------------------------------
// redecode-sofa-plan.mjs — the PURE half of redecode-collapsed-sofa-lines.mjs.
//
// NO SHEBANG, ON PURPOSE (CLAUDE.md, "Anything a TEST imports lives in
// backend/scripts/lib/"): backend/tests/redecodeSofaPlan.test.mjs imports this,
// and a `#!` in an imported .mjs is a load-time SyntaxError on Windows vitest.
//
// Everything here is text and objects in, plans out. No filesystem, no
// database, no process.exit — the runner does the I/O and owns the verdict.
//
// The one non-obvious member is buildCloneInsert(). A new sofa piece is a CLONE
// of the collapsed row it came out of, and the expensive way to get that wrong
// is by OMISSION: apply-sofa-compartment-corrections.mjs listed `warehouse_id`
// on its purchase-order branch and not on its sales-order branch, so seven prod
// lines landed with a NULL warehouse, matched no allocation bucket, and sat at
// PENDING forever while their goods were in the right bin
// (backend/tests/sofaCorrectionsWarehouse.test.ts). A hand-written column list
// cannot be tested for the column somebody forgot. So the list is DISCOVERED
// from information_schema and every column is copied unless this file names a
// reason not to — and the test asserts the reasons, not the list.
// ---------------------------------------------------------------------------

/** Columns never carried onto a clone: the row's own identity and its clock. */
export const NEVER_CLONE = ['id', 'created_at', 'updated_at'];

/** `8030-1A(LHF)` -> `8030`, then through the AutoCount model alias map. */
export function modelOf(code, alias = {}) {
  const c = String(code ?? '').trim().toUpperCase();
  const dash = c.indexOf('-');
  const base = dash < 0 ? c : c.slice(0, dash);
  return alias[base] || base;
}

/**
 * `8030-1A(LHF)` -> `1A(LHF)`; a code with no dash has no compartment.
 *
 * UPPER-CASED, so it is for COMPARING and never for anything that gets written
 * or printed as evidence — `8038-Console` comes back as `CONSOLE` here, which is
 * a real product code spelled wrong. Use compartmentOfVerbatim() for a value
 * that lands in a column or in a log somebody will read as proof.
 */
export function compartmentOf(code) {
  const c = String(code ?? '').trim().toUpperCase();
  const dash = c.indexOf('-');
  return dash < 0 ? '' : c.slice(dash + 1);
}

/** The same suffix, spelled as the code spells it. Feeds `supplier_sku`, which
 *  the PO importer writes as `<AutoCount item code> <compartment>`. */
export function compartmentOfVerbatim(code) {
  const c = String(code ?? '').trim();
  const dash = c.indexOf('-');
  return dash < 0 ? '' : c.slice(dash + 1);
}

/**
 * The importer's own placeholder test, restated — and BOTH halves are required.
 * It wrote `SOFA UNPARSED` into the remark (the PO importer writes it into
 * `notes`) AND opened the line on the bare `{model}-1S`. A genuine one-seater is
 * also `-1S` and is not a placeholder; a line carrying the marker that somebody
 * has since re-coded is not one either.
 */
export function isPlaceholderLine({ itemCode, remark }) {
  return /SOFA UNPARSED/.test(String(remark ?? '')) && /^1S$/i.test(compartmentOf(itemCode));
}

/**
 * `['1A(LHF)','CNR']` + model -> `['8030-1A(LHF)','8030-CNR']`.
 *
 * CASE IS PRESERVED, and the prefix test is case-insensitive. The decoder emits
 * `Console`, and so does the catalogue (`8038-Console`) — upper-casing on the
 * way through would write an item_code that no longer matches the product master
 * it was checked against. Existence is asked case-insensitively; what gets
 * WRITTEN is the master's own spelling, via canonicaliser() below.
 */
export function pieceCodes(model, pieces) {
  const m = String(model ?? '').trim();
  return (pieces ?? []).map((p) => {
    const c = String(p ?? '').trim();
    return c.toUpperCase().startsWith(`${m.toUpperCase()}-`) ? c : `${m}-${c}`;
  });
}

/**
 * The product master spells its own codes. Hand it every `scm.mfg_products.code`
 * and it hands back a function that turns any casing of a code into the one the
 * catalogue actually holds — so a decoded `8038-CONSOLE` is written as
 * `8038-Console`. A code the master does not have comes back untouched; deciding
 * that a piece is missing is the caller's job, not this function's.
 */
export function canonicaliser(codes) {
  const byUpper = new Map((codes ?? []).map((c) => [String(c).trim().toUpperCase(), c]));
  return (code) => byUpper.get(String(code ?? '').trim().toUpperCase()) ?? code;
}

/**
 * Do two decodes describe the SAME build? ORDER MATTERS and that is the point:
 * the piece list is a physical left-to-right layout facing the sofa, so
 * `1A(LHF)+CNR+1NA` and `1NA+CNR+1A(LHF)` are two different sofas, not one
 * written two ways. Used to decide whether the sales order and the purchase
 * order raised from it agree — if they do not, the build is refused rather than
 * reconciled, because reconciling would mean choosing one document over the
 * other without evidence.
 */
export function sameBuild(a, b) {
  const x = (a ?? []).map((s) => String(s).trim().toUpperCase());
  const y = (b ?? []).map((s) => String(s).trim().toUpperCase());
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * The SHAPE a verification asserts, as a sorted, counted multiset — because the
 * row order a fresh SELECT returns is not the plan's order and asserting the
 * sequence would fail on a correct write. `['A','B','A'] -> 'A x2 | B x1'`.
 */
export function multiset(codes) {
  const n = new Map();
  for (const c of codes ?? []) {
    const k = String(c).trim().toUpperCase();
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.entries()].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))
    .map(([k, v]) => `${k} x${v}`).join(' | ');
}

/**
 * What happens to ONE collapsed row.
 *
 *   { kind: 'noop' }    the decode is the single piece the row already is —
 *                       there is nothing to re-code. Left alone, marker and
 *                       all: clearing the marker would be a claim about the
 *                       build that this script did not make.
 *   { kind: 'expand', update: <first code>, inserts: [...] }
 *                       the row is RE-CODED as the first piece and the rest are
 *                       inserted beside it. Never dropped and re-inserted: the
 *                       row id carries the purchase_order_items.so_item_id
 *                       dedication that bound-mode readiness reads.
 */
export function planRow({ currentCode, targetCodes }) {
  /* Compared case-insensitively, RETURNED verbatim: what goes into item_code is
     the catalogue's own spelling, and normalising it here would undo that. */
  const want = (targetCodes ?? []).map((c) => String(c).trim());
  if (!want.length) return { kind: 'refuse', why: 'the decode produced no pieces' };
  const now = String(currentCode ?? '').trim().toUpperCase();
  if (want.length === 1 && want[0].toUpperCase() === now) return { kind: 'noop' };
  return { kind: 'expand', update: want[0], inserts: want.slice(1) };
}

/**
 * The money rule, as one function so the script cannot state it differently
 * from the test. The importer put the whole build's price on its FIRST piece
 * and 0 on every other one; this preserves that exactly, which is what makes
 * the expansion cost nothing:
 *
 *   the re-coded row       its money is NOT TOUCHED AT ALL. The UPDATE writes
 *                          item_code, variants and the remark and no money
 *                          column, so the first piece still holds the whole
 *                          build's price to the cent, by construction.
 *   every inserted piece    every `%_sen` column is 0.
 *
 * So the document total after = the document total before, and the script still
 * asserts it per build inside the transaction rather than trusting this comment.
 */
export function senColumns(columns) {
  return (columns ?? []).filter((c) => /_sen$/.test(c));
}

/**
 * Build the `INSERT … SELECT` that clones one row and overrides a few columns.
 *
 * `$1` is always the source row id. Overrides take `$2`, `$3`, … in the order
 * they appear in `params`, which the caller reads back to bind its values.
 *
 * @param {object}   o
 * @param {string}   o.table       qualified table name, e.g. `scm.purchase_order_items`
 * @param {string[]} o.columns     every insertable column of that table (discovered)
 * @param {object}   o.overrides   column -> a postgres cast (`'text::jsonb'`) or null
 * @param {object}   o.exprs       column -> a raw SQL expression, for things a
 *                                 parameter cannot say (the next line number)
 * @param {boolean}  o.zeroSen     zero every `%_sen` column (an inserted piece
 *                                 carries no money)
 * @returns {{ text: string, params: string[], select: Object<string,string> }}
 *          `select` is the expression chosen for every column, by name — the
 *          thing a test can assert without re-parsing the SQL it just built.
 */
export function buildCloneInsert({ table, columns, overrides = {}, exprs = {}, zeroSen = true }) {
  const cols = (columns ?? []).filter((c) => !NEVER_CLONE.includes(c));
  if (!cols.length) throw new Error(`buildCloneInsert: no insertable columns for ${table}`);
  for (const c of Object.keys(overrides)) {
    if (!cols.includes(c)) throw new Error(`buildCloneInsert: override "${c}" is not a column of ${table}`);
  }
  for (const c of Object.keys(exprs)) {
    if (!cols.includes(c)) throw new Error(`buildCloneInsert: expression for "${c}" is not a column of ${table}`);
  }
  const params = [];
  const select = cols.map((c) => {
    if (Object.prototype.hasOwnProperty.call(exprs, c)) return exprs[c];
    if (Object.prototype.hasOwnProperty.call(overrides, c)) {
      params.push(c);
      /* ::text::jsonb, and the ::text is LOAD-BEARING. Without it the server
         types the parameter as jsonb, postgres.js runs its own JSON.stringify
         over an already-stringified value, and the row lands as a jsonb STRING
         that reads as empty to every consumer — docs/jsonb-double-encoding-coe.md,
         seven prod rows. The cast is the caller's to name, and it is named. */
      const cast = overrides[c];
      return `$${params.length + 1}${cast ? `::${cast}` : ''}`;
    }
    if (zeroSen && /_sen$/.test(c)) return '0';
    return `i.${quoteIdent(c)}`;
  });
  const text = `INSERT INTO ${table} (${cols.map(quoteIdent).join(', ')})\n`
    + `SELECT ${select.join(', ')}\n`
    + `  FROM ${table} i\n WHERE i.id = $1\nRETURNING id::text AS id`;
  return { text, params, select: Object.fromEntries(cols.map((c, i) => [c, select[i]])) };
}

/** A double-quoted identifier. Column names here come from information_schema,
 *  never from user text, but quoting keeps a column called `location` or `end`
 *  from turning into a syntax error the day somebody adds one. */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Merge the decoded variants onto the ones the placeholder row already holds.
 *
 * THE EXISTING ROW WINS ANYTHING A HUMAN MAY HAVE PUT THERE. A placeholder line
 * is exactly the line an operator is most likely to have opened and filled in
 * by hand while waiting for this repair, and overwriting the block wholesale
 * would delete that silently — the same class of loss as the 604 rows that were
 * nearly nulled because a backfill "knew better" (CLAUDE.md).
 *
 * Two deliberate exceptions:
 *   - the COLOUR GROUP moves as ONE unit when the decode resolved a colour
 *     against the live fabric library. Half-updating it is how a row ends up
 *     with new ids and the old label, which reads as a different cloth.
 *   - `specials` is derived from the same Desc2 the pieces came from, so the
 *     decode's list is the current answer.
 */
export const COLOUR_KEYS = ['fabricId', 'colourId', 'fabricCode', 'colourLabel', 'fabricLabel'];

export function mergeVariants(existing, decoded, { colourResolved }) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(decoded ?? {})) {
    if (COLOUR_KEYS.includes(k)) continue;
    if (k === 'specials') { out.specials = v; continue; }
    const have = out[k];
    if (have === undefined || have === null || have === '') out[k] = v;
  }
  if (colourResolved) for (const k of COLOUR_KEYS) out[k] = (decoded ?? {})[k] ?? null;
  return out;
}
