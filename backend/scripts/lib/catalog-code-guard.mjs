// ---------------------------------------------------------------------------
// catalog-code-guard.mjs — refuse to write an internal item_code that no
// product row carries.
//
// NO SHEBANG, ON PURPOSE. backend/tests/catalogCodeGuard.test.mjs imports this
// module, and a `#!` in an imported .mjs is a load-time SyntaxError on Windows
// vitest (CLAUDE.md, "Anything a TEST imports lives in backend/scripts/lib/").
//
// WHY THIS EXISTS. The AutoCount importers resolve a book ItemCode to an ERP
// code through data/autocount-erp-mapping-1561.csv, then fall back to that raw
// mapped code whenever the shape they wanted is not in the catalog:
//
//     const code = codeSet.has(ph.toUpperCase()) ? ph : l.erp;   // <- the fallback
//
// The fallback is silent, and a mapping row that points at a code nobody minted
// makes it write an ORPHAN: `5540-1S` reached production document lines while
// the catalog, the sales orders and the customer paperwork all spell that sofa
// `8030-*`. Nothing refused it, because item_code is plain text with no foreign
// key to scm.mfg_products — every screen that joins on the code then shows a
// blank product, and the PO that should have linked to its sales order did not.
//
// So the guard is not "validate the CSV once": it is a WRITE-TIME refusal that
// names the rows, on the same principle as the rest of this tree — a checker
// that cannot see its subject must not report a pass, and an importer that
// cannot resolve a code must not invent one.
//
// Everything here is PURE: rows in, findings out. No filesystem, no database,
// no process.exit — the caller owns the verdict, exactly like
// lib/release-discipline.mjs.
// ---------------------------------------------------------------------------

/**
 * The internal code an aliased model should be spelled with, or null when the
 * alias table says nothing about it.
 *
 * The ERP's own statement of sofa identity is lib/parse-sofa.mjs's
 * SOFA_MODEL_ALIAS (5540 -> 8030 and three more), and every sofa path applies
 * it — which is why the sales orders, the compartment SKUs and the catalog all
 * spell those four models by their alias, and only the AutoCount binding file
 * did not. The table is passed IN rather than imported so this stays pure and
 * so a caller cannot accidentally resolve against a stale copy.
 *
 * The split is on the FIRST hyphen: a compartment suffix has hyphens of its own
 * (`5540-1A(LHF)` -> `8030-1A(LHF)`), and a bare model (`5540`) has none.
 *
 * @param {string} code       the code as written on the line
 * @param {Record<string,string>} aliasTable  e.g. SOFA_MODEL_ALIAS
 * @returns {string|null}
 */
export function aliasedCode(code, aliasTable) {
  const c = String(code ?? '').trim();
  if (!c) return null;
  const cut = c.indexOf('-');
  const base = cut < 0 ? c : c.slice(0, cut);
  const rest = cut < 0 ? '' : c.slice(cut);
  const to = (aliasTable ?? {})[base];
  return to ? to + rest : null;
}

/**
 * Which mapped codes have to be FOLDED before they are written, and to what.
 *
 * The mapping file names the sofa model the BOOK uses — `HOK-5540 SOFA` is
 * mapped to `5540-1S` — and the ERP spells the four folded models by their
 * alias. Every other sofa path applies SOFA_MODEL_ALIAS on the way in; the two
 * places that did not are how `5540-1S` reached 31 production document lines.
 *
 * THE FOLD BELONGS HERE, NOT IN THE MAPPING FILE, and that is measured rather
 * than preferred. `src/services/autocount-item-map.ts` is compiled from the
 * same CSV and read in the OTHER direction, to decide which AutoCount item a
 * document is written back as. Repointing the four rows there put a HOK
 * candidate on `9028-1S` / `9058-1S`, which fires the owner's "prefer HOK"
 * tie-break (autocount-item-code.ts, rule 4) on codes that rule 5 was written
 * to own. Measured on the 697-line sofa corpus: 192 sales lines would have been
 * written back naming the wrong AutoCount item (105 on 9028-1S, 87 on 9058-1S)
 * and the purchase side went from 0 refusals to 18. Folding at READ time gives
 * the importers the right internal code and leaves the write-back untouched.
 *
 * Only a code the catalog does NOT have is folded, and only onto one it does —
 * so this can never move a code that already resolves.
 *
 * @param {Iterable<string>} erpCodes  the mapped codes, as the file spells them
 * @param {(code: string) => boolean} exists
 * @param {Record<string,string>} aliasTable
 * @returns {Map<string,string>} only the codes that MOVE, so the caller can log them
 */
export function aliasFoldsForCatalog(erpCodes, exists, aliasTable) {
  if (typeof exists !== 'function') throw new TypeError('aliasFoldsForCatalog needs an exists(code) predicate');
  const moves = new Map();
  for (const raw of new Set(erpCodes)) {
    const c = String(raw ?? '').trim();
    if (!c || exists(c)) continue;
    const to = aliasedCode(c, aliasTable);
    if (to && exists(to)) moves.set(c, to);
  }
  return moves;
}

/**
 * Build the `exists` predicate the two functions below take, from the set of
 * catalog codes an importer already reads out of scm.mfg_products.
 *
 * Case-insensitive because the importers compare `code.toUpperCase()` against a
 * set built the same way, and a code that differs only in case is the same
 * product — `codeSet` is the caller's, so this never re-queries.
 *
 * @param {Iterable<string>} codes
 * @returns {(code: string) => boolean}
 */
export function catalogPredicate(codes) {
  const set = new Set();
  for (const c of codes) set.add(String(c ?? '').trim().toUpperCase());
  return (code) => set.has(String(code ?? '').trim().toUpperCase());
}

/**
 * Every reference whose internal code is blank or absent from the catalog.
 *
 * A row keeps whatever context the caller attached (document number, AutoCount
 * code, supplier SKU) so the refusal can be ACTED ON rather than described —
 * the same reason repair-array-shaped-variants.mjs prints a refused row's id
 * and raw value instead of a count.
 *
 * @param {Array<{code: string}>} refs   rows about to be written, each with `code`
 * @param {(code: string) => boolean} exists
 * @returns {Array<{code: string, why: string}>} the offending rows, in input order
 */
export function nonCatalogRefs(refs, exists) {
  if (typeof exists !== 'function') throw new TypeError('nonCatalogRefs needs an exists(code) predicate');
  const bad = [];
  for (const r of refs ?? []) {
    const code = String(r?.code ?? '').trim();
    if (!code) { bad.push({ ...r, code, why: 'blank item_code' }); continue; }
    if (!exists(code)) bad.push({ ...r, code, why: 'no scm.mfg_products row carries this code' });
  }
  return bad;
}

/**
 * The refusal, as lines the caller logs one by one.
 *
 * Written as text rather than thrown so a caller can print the WHOLE plan first
 * and refuse afterwards: an operator who is told "line 7 is bad" and nothing
 * else has to run it again to find out what else is.
 *
 * @param {Array<{code: string, why: string}>} bad
 * @param {{ script: string, limit?: number }} opts
 * @returns {string[]}
 */
export function formatNonCatalogRefusal(bad, { script, limit = 40 } = {}) {
  if (!bad.length) return [];
  const codes = [...new Set(bad.map((b) => b.code))];
  const out = [
    `REFUSED — ${bad.length} line(s) would be written with an internal item code that is not in the catalog.`,
    `  ${codes.length} distinct code(s): ${codes.join(', ')}`,
    '  Nothing was written. An item_code has no foreign key to scm.mfg_products, so this would',
    '  land as an ORPHAN line: the product panel reads blank and the document cannot be matched',
    '  to the sales order that spells the same sofa with its real internal code.',
  ];
  for (const b of bad.slice(0, limit)) {
    const ctx = [
      b.doc ? `doc=${b.doc}` : null,
      b.acDoc && b.acDoc !== b.doc ? `ac=${b.acDoc}` : null,
      b.acCode ? `book=${b.acCode}` : null,
      b.sku ? `sku=${b.sku}` : null,
    ].filter(Boolean).join(' ');
    out.push(`    ${b.code || '(blank)'}${ctx ? `  ${ctx}` : ''}  — ${b.why}`);
  }
  if (bad.length > limit) out.push(`    ... and ${bad.length - limit} more`);
  out.push('  FIX: point the book code at a REAL ERP code in');
  out.push(`  backend/scripts/data/autocount-erp-mapping-1561.csv, or mint the product first, then re-run ${script}.`);
  return out;
}
