// Pure planner for the SO-amendment line-NAME repair. No I/O, no DB, and NO
// SHEBANG — a test imports it, and a shebang not at byte 0 is a SyntaxError
// under Windows vitest (CLAUDE.md). The runnable script
// repair-so-amendment-line-names.mjs does the reads/writes and calls this to
// decide what to change.
//
// THE BUG (docs/bugs/0781): applySoAmendment's SPEC branch rewrote a line's
// item_code but left `description` (the product name) stale, so a code-swap
// amendment named the line by the OLD product on every name-first surface. The
// forward fix (so-revision.ts) now re-resolves the name from the catalogue;
// this repairs the rows already written. It touches `description` ONLY — the
// catalogue name for the line's CURRENT code — and never a price, qty, variant,
// status or date.

/**
 * Decide which lines carry a stale description and what to set it to.
 *
 * @param {Array<{ lineId: string, docNo: string, itemCode: string|null,
 *   description: string|null, catalogName: string|null }>} rows
 *   one row per DISTINCT so line that went through an applied SPEC amendment,
 *   carrying the line's CURRENT item_code + description and mfg_products.name for
 *   that current code (company-scoped; null when the code is not in the
 *   catalogue).
 * @returns {{ toFix: Array<{lineId:string,docNo:string,itemCode:string,from:string|null,to:string}>,
 *             skipped: Array<{lineId:string,reason:string}> }}
 */
export function planNameRepairs(rows) {
  const toFix = [];
  const skipped = [];
  for (const r of rows) {
    if (r.itemCode == null) { skipped.push({ lineId: r.lineId, reason: 'line no longer exists' }); continue; }
    const to = (r.catalogName ?? '').trim();
    // Fail-safe: never blank a name. A code with no catalogue row is LEFT as-is
    // and reported — a wrong-but-present name beats an orphan (same rule as the
    // migrated GRN item-code repair, docs/bugs/0691).
    if (!to) { skipped.push({ lineId: r.lineId, reason: `no catalogue name for code ${r.itemCode}` }); continue; }
    const from = (r.description ?? '').trim();
    if (from === to) { skipped.push({ lineId: r.lineId, reason: 'name already matches the catalogue' }); continue; }
    toFix.push({ lineId: r.lineId, docNo: r.docNo, itemCode: r.itemCode, from: r.description ?? null, to });
  }
  return { toFix, skipped };
}

/**
 * Shape assertion for the fresh-connection verify: every fixed line's stored
 * description now equals the catalogue name we wrote. Returns the lineIds that
 * FAILED (empty = clean); a row missing from `afterByLineId` is a failure — a
 * count of rows written is not a shape.
 *
 * @param {Array<{lineId:string,to:string}>} toFix
 * @param {Map<string,string|null>} afterByLineId  re-read `id -> description`
 * @returns {string[]}
 */
export function verifyNameRepairs(toFix, afterByLineId) {
  const failures = [];
  for (const f of toFix) {
    const got = afterByLineId.get(f.lineId);
    if (got == null || String(got).trim() !== f.to) failures.push(f.lineId);
  }
  return failures;
}
