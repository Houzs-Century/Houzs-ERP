/* ----------------------------------------------------------------------------
   EVERY CATEGORY A PRODUCT CAN CARRY MUST BE REACHABLE FROM AN MRP TAB.

   WHY THIS EXISTS. The MRP page picks a tab's rows with
   `s.category === VIEW_CATEGORY[view]` and the server drops everything else
   before it ever renders (`?category=<tab>` -> `if (catFilter && cat !== catFilter)
   continue`, mrp.ts section 6, with NO tally). So a demand line whose category is
   not one of the tabs is planned by the engine, given a real quantity, and shown
   on NO tab — with no empty state, no count and no warning. A missing row and a
   covered row look identical on this screen; the shortage is found on delivery
   day.

   That is the shape of docs/bugs/0777 (eight accessory codes, 62 open lines, 110
   units, invisible), whose fix aligned the row's category with the filter's for
   the NULL case. This test is the other half: a category that is a real,
   catalogued, non-null value the page simply has no tab for.

   THE VOCABULARY IS READ FROM SQL AND FROM THE COMMITTED ALIGNMENT PAYLOAD,
   NEVER HAND-COPIED — a typed list here would be one more copy to drift, which
   is the fault being tested. Same reasoning, and the same enum-scan shape, as
   backend/tests/statusBucketsEnumMembership.test.mjs.

   SERVICE is the ONE member that legitimately has no tab: `isServiceLine` skips
   service lines BEFORE the category filter (mrp.ts, "they never create purchase
   demand"), so a SERVICE tab could only ever be empty. It is named explicitly
   rather than filtered out silently.
   ---------------------------------------------------------------------------- */

import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mrpViews, mrpCategoryOf } from './mrp-views';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA_SQL = path.join(repoRoot, 'backend/scripts/scm-schema/2990s-full-schema.sql');
const MIGRATIONS_PG = path.join(repoRoot, 'backend/src/db/migrations-pg');
const ALIGN_PAYLOAD = path.join(repoRoot, 'backend/scripts/data/align-skus-houzs-century.json');

/** Service lines never create MRP demand, so SERVICE never gets a tab. */
const NEVER_A_TAB = new Set(['SERVICE']);

const CREATE_TYPE =
  /CREATE\s+TYPE\s+(?:"?(?:public|scm)"?\s*\.\s*)?"?(\w+)"?\s+AS\s+ENUM\s*\(([^)]*)\)/gi;
const ADD_VALUE =
  /ALTER\s+TYPE\s+(?:"?(?:public|scm)"?\s*\.\s*)?"?(\w+)"?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi;

/** Members of one enum, assembled from the baseline DDL plus every ALTER TYPE
 *  in the LIVE migration tree — which is where four of these came from. */
function enumMembers(typeName: string): string[] {
  const members = new Set<string>();
  const files = [SCHEMA_SQL];
  for (const name of fs.readdirSync(MIGRATIONS_PG).sort()) {
    if (name.endsWith('.sql')) files.push(path.join(MIGRATIONS_PG, name));
  }
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    for (const m of sql.matchAll(CREATE_TYPE)) {
      if (m[1] !== typeName) continue;
      for (const v of [...m[2]!.matchAll(/'([^']*)'/g)]) members.add(v[1]!);
    }
    for (const m of sql.matchAll(ADD_VALUE)) {
      if (m[1] === typeName) members.add(m[2]!);
    }
  }
  return [...members];
}

describe('the checker itself', () => {
  test('the SQL scan finds the real mfg_product_category vocabulary', () => {
    const members = enumMembers('mfg_product_category');
    expect(fs.existsSync(SCHEMA_SQL)).toBe(true);
    /* The four baseline members prove the CREATE TYPE half ran; DINING can only
       have come from migration 0258, so it proves the ALTER TYPE half reached
       the migration tree. Without both, an empty scan would pass vacuously. */
    for (const baseline of ['SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE']) {
      expect(members).toContain(baseline);
    }
    expect(members).toContain('DINING');
    expect(members.length).toBeGreaterThanOrEqual(9);
  });
});

describe('every category a product can carry is reachable from an MRP tab', () => {
  test('the mfg_product_category enum', () => {
    const members = enumMembers('mfg_product_category');
    const tabs = mrpViews(members).map((v) => v.category);
    const unreachable = members.filter((m) => !NEVER_A_TAB.has(m) && !tabs.includes(m));
    expect(
      unreachable,
      `mfg_product_category has ${unreachable.join(', ')} but the MRP page has no tab for it. `
      + `A sales-order line on such a product is planned by computeMrp and rendered on NO tab: `
      + `the server drops it at the category filter (mrp.ts section 6, no tally) and the page `
      + `filters it out again at s.category === VIEW_CATEGORY[view]. Nothing warns.`,
    ).toEqual([]);
  });

  test('the categories actually written into mfg_products by the SKU alignment', () => {
    /* MEASURED, not reasoned: scripts/align-open-skus.mjs INSERTS these rows into
       scm.mfg_products for company 1, category and all. This is the population,
       committed in the repo, that the enum test above is abstract about. */
    const payload = JSON.parse(fs.readFileSync(ALIGN_PAYLOAD, 'utf8')) as {
      rows: Array<{ category: string }>;
    };
    const bySku = new Map<string, number>();
    for (const r of payload.rows) bySku.set(r.category, (bySku.get(r.category) ?? 0) + 1);

    const tabs = mrpViews([...bySku.keys()]).map((v) => v.category);
    const stranded = [...bySku.entries()]
      .filter(([cat]) => !NEVER_A_TAB.has(cat) && !tabs.includes(cat))
      .map(([cat, n]) => `${cat} (${n} SKUs)`);
    expect(
      stranded,
      `${ALIGN_PAYLOAD} opens SKUs the MRP page can never show: ${stranded.join(', ')}.`,
    ).toEqual([]);
  });
});

describe('what the tab list does and does not invent', () => {
  test('the four original tabs stand even when the server says nothing', () => {
    /* A response from a backend that predates `categories`, or one still in
       flight, must not blank the page's tab bar. */
    expect(mrpViews(undefined).map((v) => v.category))
      .toEqual(['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY']);
  });

  test('SERVICE never becomes a tab', () => {
    expect(mrpViews(['SOFA', 'SERVICE']).map((v) => v.category)).not.toContain('SERVICE');
  });

  test('a category is never duplicated when the server also names a base one', () => {
    const cats = mrpViews(['ACCESSORY', 'SOFA', 'DINING']).map((v) => v.category);
    expect(new Set(cats).size).toBe(cats.length);
  });

  test('the tab a click selects asks the server for the tab it displays', () => {
    /* THE ROUND-TRIP. The page must pick a `?category=` from the tab id BEFORE
       it has a response to derive tabs from, so the id and the category are two
       expressions. Pinned on every tab the catalogue can produce, because a tab
       whose id says one thing while its rows are filtered by another is this
       whole bug with extra steps. */
    const views = mrpViews(enumMembers('mfg_product_category'));
    expect(views.length).toBeGreaterThan(4);
    for (const v of views) expect(mrpCategoryOf(v.value)).toBe(v.category);
  });

  test('an unrecognised category still gets a tab, labelled with its own name', () => {
    /* No guessing and no dropping: a category the label table has never heard of
       is title-cased and shown, because the alternative is the bug. */
    const v = mrpViews(['SOFA', 'WALLPAPER']).find((x) => x.category === 'WALLPAPER');
    expect(v).toBeDefined();
    expect(v!.label).toBe('Wallpaper');
    expect(v!.value).toBe('wallpaper');
  });
});
