/* ---------------------------------------------------------------------------
   Which file is this, and what are its columns called?

   Split out of Products.tsx rather than added to it: that page is one of the
   large ones and the file-size ratchet refuses growth past its ceiling, which
   is the repo asking for a module instead of a bigger number.

   THE OWNER'S CASE (2026-09-07). He exported the SKU page, edited prices,
   imported it back, and got "No rows had a code" over a file whose 164 rows
   parse perfectly. The page has TWO exports and the dialog says only "exported
   from this page", which is true of both. He also recognised it —
   「这个问题好像之前也是有」 — and he was right: docs/bugs/0605 gave the FABRIC
   import tolerant headers on 2026-09-02 and this importer never got them.
   -------------------------------------------------------------------------- */

/* Tolerant of case AND of space-vs-underscore, so a hand-made sheet with
   "Base Price" maps to the same column as the export's `base_price`. This is
   the rule `vendor/scm/lib/fabric-csv.ts` has run since 0605. Runs of
   whitespace and underscore collapse to one underscore; the export's own
   headers are already lower snake_case, so this is IDENTITY on an exported file
   and only ever LOOSENS matching. */
export function normalizeImportHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_]+/g, '_');
}

/* THE OTHER FILE ON THIS PAGE, and why it can never be imported.
 *
 * The grid's export writes what is ON SCREEN: a column per sofa SIZE, headed
 * with the bare size ("24", "26", "28"). It is not enough to alias those
 * headers, and aliasing them would be the DANGEROUS fix — the grid writes the
 * price for whichever tier was selected and carries NO tier column, so an
 * imported price would have no tier, and a price filed under the wrong tier is
 * worse than one not filed. The importer already refuses a priced row whose
 * tier it cannot read; this makes the refusal name the right button.
 *
 * DETECTED ON SHAPE, NOT ON ONE LABEL. Two facts together, neither of which the
 * round-trip export can produce: it has no `code` column at all, and at least
 * one header is a bare number. Keying on the grid's own code-column heading
 * would have been the obvious test and is the worse one — that spelling is
 * retired vocabulary (the catalogue's term is `item_code`), and a detector
 * pinned to one label breaks the day somebody renames a column header. */
export function looksLikeGridExport(header: string[]): boolean {
  return !header.includes('code') && header.some((h) => /^\d+$/.test(h));
}
