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
import { normalizeSofaTier } from '@2990s/shared';
import type { Column } from '../../components/DataTable';
import { parseMoneyToSen } from '../../lib/money';
import { parseCSV } from '../../lib/csv';
import { normalizeImportHeader } from '../../lib/import-sheet';
import type { BatchImportRow, SeatHeightPrice } from '../../vendor/scm/lib/mfg-products-queries';

/* Case and space-vs-underscore never matter in a header (one rule for every
   importer since HC-0003 T5, lib/import-sheet.ts). */
export { normalizeImportHeader };

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
  return header.map((h) => {
    const key = GRID_LABEL_TO_KEY[asLabel(h)];
    /* A sheet with its own `name` keeps `description` as the real field it is. */
    return (key && !header.includes(key) ? key : null) ?? gridSizeHeaderToKey(h) ?? h;
  });
}

/** The keys a sheet's rows are read under. A sheet with a `code` column already
 *  speaks the importer's keys (the round-trip export, which also writes a real
 *  `description`); any other sheet is read through the label map, grid export
 *  or hand-made (HC-0141: `Product Code,Description,category`, no size column).
 *  Reading and the failure message both route through here so they agree. */
export function skuHeaderKeys(raw: string[]): string[] {
  return raw.includes('code') ? raw : mapGridHeaders(raw);
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
  const mapped = skuHeaderKeys(rawHeader);
  return {
    needsCategory: !mapped.includes('category'),
    needsTier: rawHeader.some((h) => gridSizeHeaderToKey(h) !== null) && !mapped.includes('price_tier'),
  };
}

/** What to tell the operator when a file yielded no importable row.
 *
 *  Lives here, beside the rules it is explaining, rather than inline in the
 *  page: the page is one of the large ones and the size ratchet refuses growth,
 *  which is the repo asking for the prose to sit next to the rule. It also
 *  keeps the two in step — a message that drifts from the check it describes is
 *  how "No rows had a code" came to be printed over 163 rows that all had one.
 *
 *  `headersSeen` are the RAW normalised headings, so the missing-facts test can
 *  see a size column before it is mapped. */
export function importFailureMessage(headersSeen: string[]): string {
  const columns = headersSeen.join(', ') || '(none)';
  if (!skuHeaderKeys(headersSeen).includes('code')) {
    return `No column in this file was recognised as the product code. The columns are: ${columns}.`
      + ' Head that column `code` (or `Product Code`, as the table export writes it).';
  }
  const missing = missingGridFacts(headersSeen);
  const lacks = [
    missing.needsCategory ? 'a category column' : '',
    missing.needsTier ? 'the price tier its prices belong to' : '',
  ].filter(Boolean).join(' and ');
  if (lacks) {
    return `This sheet is missing ${lacks}. Older exports left both out — the table`
      + ' now writes them, so export the page again and edit THAT file. They are not'
      + ' guessed here: a price filed under the wrong tier is worse than one not filed.';
  }
  return `No rows had a code. The columns in this file are: ${columns}.`
    + ' A row needs a `code`; a code the system does not have yet also needs `name`'
    + ' and `category`.';
}

/** sen → "1535.00" / "1535.50" (blank when unset). */
export const priceSheetRinggit = (sen: number | null | undefined): string =>
  sen == null ? '' : (sen / 100).toFixed(2);

/* HC-0003: the table export writes the importer's own column names and money
   in ringgit, so the file it writes is the file the import reads. Keyed on the
   grid's column keys in Products.tsx. A sofa size column becomes `price_<size>`,
   never the bare size, so it cannot be mistaken for an older file in sen. */
const SKU_EXPORT_KEY: Record<string, string> = {
  code: 'code', desc: 'name', model: 'base_model', category: 'category', price_tier: 'price_tier',
  branding: 'branding', size: 'size_label', status: 'status',
  price: 'base_price', price2: 'base_price', price1: 'price1',
};
const SKU_MONEY_KEYS = new Set(['base_price', 'price1']);

export function withSkuImportHeaders<T>(cols: Column<T>[]): Column<T>[] {
  return cols.map((c) => {
    const size = c.key.startsWith('size-') ? c.key.slice('size-'.length) : null;
    const key = size !== null ? `price_${size}` : SKU_EXPORT_KEY[c.key];
    const get = c.getValue;
    if (!key || !get) return c;
    if (size === null && !SKU_MONEY_KEYS.has(key)) return { ...c, exportLabel: key };
    /* The grid's getValue is sen, with -1 for "no price" (it sorts last); neither leaves as a number. */
    const exportValue = (r: T) => { const v = get(r); return typeof v === 'number' && v >= 0 ? priceSheetRinggit(v) : ''; };
    return { ...c, exportLabel: key, exportValue };
  });
}

/** The SKU import's CSV path: the shared parser, then header-keyed rows. */
export function parseSkuCsv(text: string): Array<Record<string, string | undefined>> {
  return gridToSkuRecords(parseCSV(text));
}

/** Header-key a parsed grid, reading BOTH files this page writes (bugs/0662). */
export function gridToSkuRecords(grid: string[][]): Array<Record<string, string | undefined>> {
  if (grid.length < 1) return [];
  const raw = (grid[0] ?? []).map(normalizeImportHeader);
  const fromGrid = looksLikeGridExport(raw);
  const header = skuHeaderKeys(raw);
  const out: Array<Record<string, string | undefined>> = [];
  for (const cells of grid.slice(1)) {
    if (cells.every((c) => c.trim() === '')) continue;
    const obj: Record<string, string | undefined> = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      const cell = (cells[c] ?? '').trim();
      /* -1 is the grid's "no price", never a price — see isGridNoPrice. */
      if (fromGrid && isGridNoPrice(cell)) continue;
      obj[key] = cell;
    }
    out.push(obj);
  }
  return out;
}

/** Parsed sheet rows -> the batch-import rows, grouped by code. Rows whose price or tier cannot be read are reported, never written. */
export function buildSkuImportRows(parsed: Array<Record<string, string | undefined>>, sofaSizes: string[]): { rows: BatchImportRow[]; tierErrors: Array<{ code: string; reason: string }> } {
  // Group rows by code — a sofa with PRICE_1 / PRICE_2 / PRICE_3 rows
  // becomes ONE product carrying all its size × tier prices.
  const byCode = new Map<string, Array<Record<string, string | undefined>>>();
  for (const p of parsed) {
    const code = (p.code ?? '').trim();
    if (!code) continue;
    const list = byCode.get(code);
    if (list) list.push(p); else byCode.set(code, [p]);
  }

  const rows: BatchImportRow[] = [];
  // SKUs skipped because a price row's tier couldn't be recognised — shown
  // to the operator so a mislabelled price is never silently mis-filed.
  const tierErrors: Array<{ code: string; reason: string }> = [];
  for (const [code, group] of byCode) {
    const first = group[0]; // never undefined: a code is only grouped with its first row
    // A field is only carried when its cell is non-empty, so a blank cell
    // never overwrites existing data on the SKU.
    const has = (v: string | undefined): v is string => v != null && v !== '';
    const out: BatchImportRow = {
      code,
      name:     first.name ?? '',
      category: first.category ?? '',
    };
    if (has(first.description)) out.description = first.description;
    if (has(first.base_model)) out.base_model = first.base_model;
    if (has(first.size_label)) out.size_label = first.size_label;
    if (has(first.status))     out.status = first.status.toUpperCase();
    if (has(first.branding))   out.branding = first.branding;

    // Money is read in RINGGIT (new export, e.g. 1535.00 → 153500 sen). A
    // legacy `_sen` column is still honoured as a fallback so any file from
    // an earlier export round-trips. Returns null when neither is present.
    // A bad money cell skips the whole SKU (reported like tier errors)
    // rather than ever writing a corrupted price.
    /* This used to carry its OWN copy of the accept/reject rule (strip
       "RM " and commas, then a regex). It was the right rule — it is where
       the "parseFloat('1,535.00') is RM 1.00" hazard was first written
       down — but a second copy of a money rule is how the two halves come
       to disagree, so it now calls the shared parser. The shared parser is
       strictly stricter: it also catches ambiguous comma grouping and more
       than two decimal places, both of which this regex let through. */
    let moneyError: string | null = null;
    const senOf = (rm: string | undefined, sen: string | undefined): number | null => {
      if (has(rm)) {
        const parsed = parseMoneyToSen(rm, 'That price');
        if (!parsed.ok) {
          moneyError ??= `price "${(rm as string).trim()}" could not be read — ${parsed.message}`;
          return null;
        }
        return parsed.empty ? null : parsed.sen;
      }
      /* Legacy `_sen` column — an integer count of sen, not ringgit. An
         unreadable one used to return null, which this caller reads as
         "the column wasn't filled in", so a corrupt legacy file imported
         as a price-less SKU with nothing said. Report it like the ringgit
         branch does. */
      if (has(sen)) {
        const n = Number(String(sen).trim());
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          moneyError ??= `price "${String(sen).trim()}" could not be read — this column is a whole number of sen, for example 153500.`;
          return null;
        }
        return n;
      }
      return null;
    };

    // base_price / price1 — take the first row that filled them.
    const baseRow = group.find((g) => has(g.base_price) || has(g.base_price_sen));
    if (baseRow) { const v = senOf(baseRow.base_price, baseRow.base_price_sen); if (v != null) out.base_price_sen = v; }
    const p1Row = group.find((g) => has(g.price1) || has(g.price1_sen));
    if (p1Row) { const v = senOf(p1Row.price1, p1Row.price1_sen); if (v != null) out.price1_sen = v; }
    const m3Row = group.find((g) => has(g.unit_m3_milli));
    if (m3Row) out.unit_m3_milli = Number(m3Row.unit_m3_milli);

    // Sofa per-size × per-tier prices, gathered across all of this code's
    // tier rows. A row that carries any price MUST name a recognisable tier
    // (P1/P2/P3) — otherwise the SKU is skipped with a clear reason so a
    // price never lands in the wrong tier.
    const seat: SeatHeightPrice[] = [];
    let tierError: string | null = null;
    for (const g of group) {
      const hasAnyPrice = sofaSizes.some((size) => has(g[`price_${size}`]) || has(g[`price_${size}_sen`]));
      if (!hasAnyPrice) continue;
      const t = normalizeSofaTier(g.price_tier);
      if (!t) { tierError = (g.price_tier ?? '').trim() || '(blank)'; break; }
      for (const size of sofaSizes) {
        const ps = senOf(g[`price_${size}`], g[`price_${size}_sen`]);
        if (ps == null) continue;
        seat.push({ height: size, priceSen: ps, tier: t });
      }
    }
    if (tierError) {
      tierErrors.push({ code, reason: `price tier "${tierError}" not recognized — use P1, P2, P3 or P4` });
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- senOf sets it inside a closure, which narrowing does not see
    if (moneyError) {
      tierErrors.push({ code, reason: moneyError });
      continue;
    }
    if (seat.length > 0) out.seatHeightPrices = seat;

    rows.push(out);
  }
  return { rows, tierErrors };
}
