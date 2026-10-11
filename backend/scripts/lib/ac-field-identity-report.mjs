/* ac-field-identity-report — section 5 printed.
 *
 * Kept apart from the comparison so the table the owner reads has ONE author.
 * Every count is split PROCEEDED / not proceeded, because an order that has not
 * been proceeded is allowed to be blank (owner, 2026-09-04) and quoting the
 * all-orders figure as the backlog has already cost him time twice.
 */
import {
  AC_BLANK, AGREE, BOTH_BLANK, CARRIED, DERIVED, DIFFER, ERP_BLANK, NOISE, NOT_CARRIED, UNMATCHED,
} from "./ac-field-identity.mjs";

const pad = (s, n) => String(s).padEnd(n);
const num = (n, w) => String(n).padStart(w);

const STATUS_TAG = { [CARRIED]: "copy", [DERIVED]: "deriv", [NOT_CARRIED]: "NOT-C" };

export function printFieldTable({ result, plain, log, SHOW }) {
  const { t, headerFields, lineFields, notExported, tally, examples, pop } = result;
  plain("");
  plain(`─── ${t} — FIELD BY FIELD ───`);
  plain(
    `documents compared: ${pop.docs}` +
      (pop.docsAbsent ? `; in scope but not in the ERP: ${pop.docsAbsent} (the presence section owns that finding)` : "") +
      (pop.window ? `; in scope on the truth snapshot but absent from the migration export: ${pop.window} (the WINDOW between the two cuts, not a gap)` : "") +
      `; lines compared: ${pop.lines}` +
      (pop.linesUnmatched ? `, of which ${pop.linesUnmatched} found no ERP counterpart to compare against` : "") +
      (pop.decomposed ? `; ${pop.decomposed} extra ERP lines share an AutoCount line key (sofa decomposition — the lead piece is the commensurable one)` : ""),
  );
  plain("");
  plain("field                    kind |      PROCEEDED (the backlog)      |        not proceeded        ");
  plain("                              | agree noise differ ERPbl ACbl unm | agree noise differ ERPbl ACbl");

  const rows = [];
  for (const f of [...headerFields, ...lineFields]) {
    const y = tally[f.key].yes;
    const n = tally[f.key].no;
    const seen = Object.values(y).reduce((a, b) => a + b, 0) + Object.values(n).reduce((a, b) => a + b, 0);
    if (!seen) continue;
    rows.push({ f, y, n });
    plain(
      `${pad(f.label, 24)} ${pad(STATUS_TAG[f.status], 5)}|` +
        `${num(y[AGREE], 6)}${num(y[NOISE], 6)}${num(y[DIFFER], 7)}${num(y[ERP_BLANK], 6)}${num(y[AC_BLANK], 5)}${num(y[UNMATCHED], 4)} |` +
        `${num(n[AGREE], 6)}${num(n[NOISE], 6)}${num(n[DIFFER], 7)}${num(n[ERP_BLANK], 6)}${num(n[AC_BLANK], 5)}`,
    );
  }
  if (!rows.length) {
    log(`${t} — no field produced a single comparison. Do NOT read that as agreement; the population was empty.`);
    return { differ: 0, erpBlank: 0, noise: 0, rows: 0 };
  }

  /* The four buckets the owner asked for, on the PROCEEDED half only. */
  let differ = 0;
  let erpBlank = 0;
  let acBlank = 0;
  let noise = 0;
  let notCarried = 0;
  for (const { f, y } of rows) {
    if (f.status === CARRIED) {
      differ += y[DIFFER];
      erpBlank += y[ERP_BLANK];
      acBlank += y[AC_BLANK];
    }
    noise += y[NOISE];
    if (f.status === NOT_CARRIED) notCarried += y[ERP_BLANK];
  }
  plain("");
  plain(
    `   copy = the writer copies the book's value, so a difference is a DEFECT.  ` +
      `deriv = the writer computes it by a stated rule, so a difference measures the derivation.  ` +
      `NOT-C = the book has the column and NO importer names an ERP column for it.`,
  );
  plain(
    `   ${t}: on the copied fields of PROCEEDED documents — ${differ} differ, ${erpBlank} blank in the ERP where ` +
      `the book states a value, ${acBlank} stated in the ERP where the book is blank. ` +
      `${noise} more agreed only after normalising transport artefacts (curly quotes, newlines) and are NOT spec changes. ` +
      `${notCarried} values sit in fields no importer carries at all.`,
  );

  /* Examples, so a count can be checked rather than believed. */
  for (const { f } of rows) {
    const ex = examples[f.key];
    if (!ex.length) continue;
    plain(`   ${f.label} [${STATUS_TAG[f.status]}] — ${f.writer}`);
    if (f.note) plain(`      note: ${f.note}`);
    for (const e of ex.slice(0, Math.min(SHOW, 5))) {
      plain(
        `      ${e.doc}${e.key ? `/${e.key}` : ""} ${e.half === "yes" ? "[proceeded]" : "[not proceeded]"} ` +
          `book=${JSON.stringify(e.ac ?? null).slice(0, 60)} erp=${JSON.stringify(e.erp ?? null).slice(0, 60)}`,
      );
    }
    if (ex.length > 5) plain(`      ... and ${ex.length - 5} more of the first ${SHOW} collected`);
  }
  if (notExported.length) {
    plain("");
    plain(
      `   NOT MEASURABLE ON THIS CUT — ${notExported.length} field(s) export-ac-reimport.py does not pull, so ` +
        "there is no book value to compare and they are counted in NO bucket above:",
    );
    for (const f of notExported) {
      plain(`      ${pad(f.label, 24)} would need ${f.notExported} added to the exporter's SELECT. ${f.writer}`);
    }
  }
  return { differ, erpBlank, acBlank, noise, notCarried, notExported: notExported.length, rows: rows.length };
}

export function printPoDiscount({ disc, plain, log }) {
  plain("");
  plain("═══════════ THE PO LINE DISCOUNT — ITS OWN ROW ═══════════");
  log(
    `AutoCount purchase-order lines carry a LINE DISCOUNT. The book stores the unit price and the line amount ` +
      `separately and the line amount is the discounted one; every ERP importer writes qty x unit price, ` +
      `undiscounted. Whole book: ${disc.whole.lines} lines across ${disc.whole.docs.size} purchase orders, ` +
      `RM ${(disc.whole.sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ` +
      `of difference. Inside the migrated set: ${disc.inScope.lines} lines across ${disc.inScope.docs.size} ` +
      `purchase orders, RM ${(disc.inScope.sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
  );
  for (const e of disc.examples.slice(0, 10)) {
    plain(
      `   ${e.doc} ${e.item} qty ${e.qty} @ RM ${(e.unitSen / 100).toFixed(2)} -> ` +
        `book RM ${(e.bookSen / 100).toFixed(2)}, ERP RM ${(e.erpSen / 100).toFixed(2)} ` +
        `(${(100 - (e.bookSen / e.erpSen) * 100).toFixed(1)}% off)`,
    );
  }
  if (!disc.inScope.lines) {
    plain("   No line inside the migrated set carries a discount on this cut.");
  }
}
