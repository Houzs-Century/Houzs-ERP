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

/* ---------------------------------------------------------------------------
   READING THE TABLE EXPORT — the owner's file, not a hand-made one.

   「为什么我的文件不能用呢？」 It is the page's OWN export, 163 real rows, and
   the system could not read what it had just written. Three things stood in the
   way and only the first is a naming problem:

     1. the headers are what a person reads ("Product Code", not `code`)
     2. the CATEGORY is absent — the screen was already filtered to sofa, so
        the column that would have said so was never written
     3. the sofa PRICE TIER is absent — the grid shows one tier at a time and
        writes those numbers with nothing saying which tier they are

   (1) is ours to fix and this map fixes it. (2) and (3) are facts the file does
   not contain, so they are ASKED ONCE at import and applied to the batch —
   asked, never inferred, because a price filed under the wrong tier is worse
   than one not filed.
   -------------------------------------------------------------------------- */

/** The grid's LABEL, exactly as a person reads it (lower-cased, spaces kept)
 *  -> the key the importer reads.
 *
 *  KEYED ON THE LABEL, NOT ON A NORMALISED COLUMN NAME, and deliberately: these
 *  are the UI's words, not this system's field names. Writing the code column's
 *  heading as one underscored token would spell a term the catalogue retired
 *  (`audit:vocabulary` refuses it, and it is right to — the field is spelled
 *  `item_code` here). Keeping the label in its own spelling says what it is: a
 *  foreign string being translated, not one of our names.
 *
 *  Grounded in `gridColumns` in Products.tsx, where each column's `getValue`
 *  names the field it renders — "Description" really is the product NAME. */
const GRID_LABEL_TO_KEY: Record<string, string | undefined> = {
  'product code': 'code',
  description: 'name',
  model: 'base_model',
  status: 'status',
  branding: 'branding',
  size: 'size_label',
  category: 'category',
};

/** A heading as a person reads it: lower-cased, runs of space collapsed, and
 *  underscores read as the spaces they stand in for — so both the label and a
 *  hand-typed `product_code` land on the same entry above. */
function asLabel(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

/** The grid writes a bare seat height ("24") where the round-trip export writes
 *  `price_24`. Its numbers are already SEN, so they map to the `_sen` column and
 *  no conversion happens anywhere — 47250 stays 47250, and RM 472.50 cannot be
 *  lost to a rounding step that never runs. */
export function gridSizeHeaderToKey(h: string): string | null {
  return /^\d+$/.test(h) ? `price_${h}_sen` : null;
}

/** Map a table-export header row onto the importer's keys.
 *
 *  TRANSLATES WHAT NEEDS TRANSLATING AND LEAVES THE REST ALONE. Only a heading
 *  that is a display label ("Product Code") or a bare seat height ("24") is
 *  rewritten; anything else passes through unchanged, which is what lets a sheet
 *  exported AFTER the category and price_tier columns were added come back in
 *  answering both by itself — those two are written under the importer's own
 *  key names, so a mapper that blanked everything it did not recognise would
 *  have thrown away the very columns added to make the file self-describing.
 *  A passed-through heading the importer has no use for costs nothing: the row
 *  builder reads the keys it knows and ignores the rest. */
export function mapGridHeaders(header: string[]): string[] {
  return header.map((h) => GRID_LABEL_TO_KEY[asLabel(h)] ?? gridSizeHeaderToKey(h) ?? h);
}

/** THE GRID'S "NO PRICE" MARKER. `getValue` returns -1 when a size has no price
 *  for the shown tier, so the export writes -1 and it means ABSENT, not free.
 *  Reading it as a number would create a SKU priced at minus one sen. */
export function isGridNoPrice(raw: string): boolean {
  return raw.trim() === '-1';
}

/** What the file cannot tell us and the operator must. Returned so the dialog
 *  asks for exactly what is missing and nothing more.
 *
 *  TAKES THE RAW normalised headers, not the mapped ones. Reading the mapped
 *  list looked equivalent and was not: a size column is `24` before mapping and
 *  `price_24_sen` after, so the tier question — which only arises when a size
 *  column is present — answered NO on every file. Caught by the test over the
 *  owner's own header row. */
export function missingGridFacts(rawHeader: string[]): { needsCategory: boolean; needsTier: boolean } {
  const mapped = mapGridHeaders(rawHeader);
  return {
    needsCategory: !mapped.includes('category'),
    needsTier: rawHeader.some((h) => gridSizeHeaderToKey(h) !== null) && !mapped.includes('price_tier'),
  };
}
