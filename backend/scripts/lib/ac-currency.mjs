/* ac-currency — the ONE place the migration decides what currency an AutoCount
 * document is in.
 *
 * WHY IT EXISTS. Four writers hard-coded the string 'MYR' into the currency
 * column of a migrated document: import-ac-outstanding-po.mjs:403,
 * import-ac-outstanding-so.mjs:442, import-ac-so-linked-pos.mjs:390 and
 * create-migrated-documents.mjs:141. On the 2026-09-07 17:36+08 header cut the
 * book holds 22 CNY purchase orders out of 9,408 — so on those the constant is
 * simply wrong, and being wrong there is what let a repair read an exchange rate
 * as a 38.06% discount and take RM 13,068.55 off `HC-PO-009335`
 * (docs/bugs/0665-*). Four copies of one rule is how the first copy came to be
 * wrong and stayed wrong; this is the fifth statement of it and the last.
 *
 * THE RULE: A MIGRATION COPIES, IT NEVER COMPUTES. The book's own CurrencyCode
 * is what the ERP stores, verbatim apart from trimming and upper-casing. There
 * is no translation table here on purpose — 'CNY' is written as CNY and NOT
 * folded into the ERP's older 'RMB' spelling, because a silent rename is
 * exactly the kind of computed value this rule forbids. Both codes are valid
 * (VALID_CURRENCIES, mig 20260907T2330).
 *
 * THE FALLBACK IS 'MYR' AND IT IS NOT A GUESS. MYR is the book's own base
 * currency and the value on 9,386 of its 9,408 purchase orders and all 13,365
 * of its sales orders. A row with no CurrencyCode field at all is a row from a
 * cut taken BEFORE the exporter carried the column (export-ac-reimport.py grew
 * it on 2026-09-07 and the committed migration cuts predate that), so falling
 * back reproduces exactly today's behaviour rather than inventing a new one.
 * `sawColumn` lets a caller SAY which of the two happened instead of reporting a
 * clean copy over a cut that could not answer.
 */

/** The currency code a migrated document should be stored with. */
export function bookCurrency(row) {
  const raw = row?.CurrencyCode ?? row?.currency_code ?? row?.currency;
  const code = String(raw ?? "").trim().toUpperCase();
  return code || "MYR";
}

/** True when the row's cut actually carried a currency column at all. */
export function sawCurrencyColumn(row) {
  if (!row) return false;
  for (const k of ["CurrencyCode", "currency_code", "currency"]) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") return true;
  }
  return false;
}

/** Counts, for a writer that wants to report what it copied vs what it defaulted. */
export function currencyTally(rows) {
  const tally = new Map();
  let copied = 0;
  let defaulted = 0;
  for (const r of rows) {
    const code = bookCurrency(r);
    tally.set(code, (tally.get(code) ?? 0) + 1);
    if (sawCurrencyColumn(r)) copied += 1;
    else defaulted += 1;
  }
  return { tally, copied, defaulted };
}
