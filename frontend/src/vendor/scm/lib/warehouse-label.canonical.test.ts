/* The frontend half of the ONE warehouse display rule.
 *
 * THE BUG. The Purchase Orders list printed `purchase_location?.name ||
 * purchase_location?.code`, so its "Purchase Location" column read
 * "BALAKONG WAREHO…" — a full name truncated by the grid — while the very same
 * page's PDF export printed the CODE (`purchase_location_name: wh.code`). One
 * page, two answers for one warehouse.
 *
 * THE ROOT CAUSE was not that one line. `warehouseLabel` existed only in
 * `backend/src/scm/lib/warehouse-label.ts`, and the frontend cannot import from
 * `backend/src` — so every frontend surface that had to show a warehouse
 * hand-wrote its own order, and they drifted in both directions. The fix is the
 * repo's existing MIRROR pattern (phone.ts, total-height.ts, do-shipped-states.ts):
 * a byte-identical copy plus a test that referees it.
 *
 * WHY THESE TWO PATHS EXACTLY. `backend/scripts/check-shared-mirrors.mjs`
 * enumerates `backend/src/scm/shared` + `backend/src/scm/lib` and looks each
 * basename up in `frontend/src/vendor/shared` + `frontend/src/vendor/scm/lib`.
 * Landing the copy at `frontend/src/vendor/scm/lib/warehouse-label.ts` buys a
 * CI referee with no new script — the enumeration is non-recursive and matches
 * by basename, so the file must stay at the top level of that directory.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { warehouseLabel } from './warehouse-label';

/* ── the two copies of the module ───────────────────────────────────────── */

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/warehouse-label.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/warehouse-label.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/warehouse-label.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

/* ── the rule itself ────────────────────────────────────────────────────────
   Mirrors backend/src/scm/lib/warehouse-label.test.ts. Both halves assert it
   because byte-identity alone would still pass if someone flipped the order in
   BOTH files at once — the order is the thing the owner reported, so it gets an
   assertion of its own on each side. */

describe('warehouseLabel — CODE first, then name', () => {
  test('a warehouse with both prints the CODE', () => {
    expect(warehouseLabel({ code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' }))
      .toBe('KL WAREHOUSE');
  });

  test('the name is the FALLBACK, never the preference', () => {
    expect(warehouseLabel({ code: null, name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
    expect(warehouseLabel({ name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
  });

  test('a blank or whitespace code is not a code', () => {
    expect(warehouseLabel({ code: '', name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
    expect(warehouseLabel({ code: '   ', name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
  });

  test('the answer is trimmed', () => {
    expect(warehouseLabel({ code: '  KL WAREHOUSE  ', name: null })).toBe('KL WAREHOUSE');
  });

  test('nothing to show is null — never an empty-looking string', () => {
    expect(warehouseLabel({ code: null, name: null })).toBeNull();
    expect(warehouseLabel({ code: '', name: '  ' })).toBeNull();
    expect(warehouseLabel({})).toBeNull();
    expect(warehouseLabel(null)).toBeNull();
    expect(warehouseLabel(undefined)).toBeNull();
  });
});

/* ── the corpus pin ─────────────────────────────────────────────────────────
   Same idiom as total-height.canonical.test.ts. The rule got sixteen homes on
   the frontend one screen at a time, each new one copying the nearest, because
   there was nothing to import. Now there is — and these assertions are what
   make the next screen import instead of copy. They fail by NAMING the file
   that went its own way, so the failure reads as an instruction. */

const SRC = resolve(process.cwd(), 'src');
const SELF = 'src/vendor/scm/lib/warehouse-label.ts';

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full); continue; }
      if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(`src/${relative(SRC, full).split(/[\\/]/).join('/')}`);
      }
    }
  };
  walk(SRC);
  return out.sort();
}

/* TWO views of each file, and using the wrong one is a real trap this test hit
   on its first run. `text` has comments stripped, because a rule quoted in a WHY
   comment is not a second copy of it and several converted files now explain the
   rule in prose. But naive comment-stripping is NOT a parser: a comment-opening
   sequence inside a string or a regex literal opens a comment that runs to the
   next closing sequence and eats real code with it. That is exactly what hid
   Fleet.tsx's and GrnFromPo.tsx's import lines and reported them as offenders on
   this test's first run. So anything asserting that code EXISTS reads `raw`;
   only the scan for a re-grown copy reads `text`. */
const FILES = sourceFiles().map((p) => {
  const raw = readFileSync(resolve(process.cwd(), p), 'utf8');
  return {
    path: p,
    raw,
    text: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''),
  };
});

describe('a warehouse label is decided in exactly one place', () => {
  /* The OBJECT shape — `wh?.name || wh?.code`, or the reverse. This is the
     exact spelling the Purchase Orders list carried and the one the sweep
     removed. */
  const OBJECT_FALLBACK =
    /\?\.(?:code|name)\s*(?:\|\||\?\?)\s*[A-Za-z_$][\w$]*(?:\??\.[\w$]+)*\?\.(?:code|name)/;

  /* NOT an exemption list — a RATCHET, and it may only shrink. The one entry
     is `SalesOrderDetail.tsx:3028`, which resolves a venue's warehouse with
     `hit?.warehouse?.code ?? hit?.warehouse?.name`. It is already CODE-first,
     so it renders the right answer today; it is simply still a private copy.
     It was left out of this sweep because that file is owned by a PR running in
     parallel and a conflict there costs more than the copy does. Converting it
     FAILS this test until the entry is deleted, which is the point. */
  const PENDING = ['src/pages/scm-v2/SalesOrderDetail.tsx'];

  /* One more site is knowingly unconverted and CANNOT be listed above, because
     its copy is written over FLAT columns (`warehouse_code ?? warehouse_name`)
     which this object-shaped scan does not see: `pages/scm-v2/Inventory.tsx`,
     three cells. Already code-first, so it renders the right answer. It was
     reverted out of this sweep because Inventory.tsx sits AT its file-size
     ceiling and the adapter the conversion needs grew it — `npm run
     check:file-size` fails a file this change makes bigger, and hygiene is not
     worth a ceiling. Convert it when that file is next split. */

  test('no file spells its own warehouse code/name fallback on an object', () => {
    const offenders = FILES
      .filter((f) => f.path !== SELF)
      .filter((f) => /[Ww]arehouse|purchase_location|purchaseLocation/.test(f.text))
      .filter((f) => {
        for (const line of f.text.split('\n')) {
          if (!OBJECT_FALLBACK.test(line)) continue;
          if (/[Ww]arehouse|purchase_location|purchaseLocation/.test(line)) return true;
        }
        return false;
      })
      .map((f) => f.path);
    /* Sanity: the scan must actually be looking at files, or an empty corpus
       passes for the wrong reason. */
    expect(FILES.length).toBeGreaterThan(100);
    expect(offenders).toEqual(PENDING);
  });

  /* The surfaces converted on 2026-08-21. Listed by name because "some files
     call it" is not the property worth pinning — THESE files calling it is.
     Un-wire any one and this test names that exact path. A new caller may be
     added freely; the assertion above is what stops it arriving as a copy. */
  const CALL_SITES = [
    'src/mobile/MobileModuleList.tsx',
    'src/mobile/MobileStockCard.tsx',
    'src/pages/scm-v2/ConsignmentOrderDetail.tsx',
    'src/pages/scm-v2/DeliveryOrderNewV2.tsx',
    'src/pages/scm-v2/Fleet.tsx',
    'src/pages/scm-v2/GrnFromPo.tsx',
    'src/pages/scm-v2/LorryDetail.tsx',
    'src/pages/scm-v2/PurchaseOrdersListV2.tsx',
    'src/pages/scm-v2/StockTakesListV2.tsx',
    'src/pages/scm-v2/StockTransfersListV2.tsx',
    'src/vendor/scm/components/ScheduleTripDrawer.tsx',
    'src/vendor/scm/lib/propose-time.ts',
  ];

  test('every converted surface still reaches the shared rule', () => {
    const callers = new Set(
      FILES.filter((f) => f.path !== SELF && /warehouseLabel\(/.test(f.raw)).map((f) => f.path),
    );
    expect(callers.size).toBeGreaterThanOrEqual(CALL_SITES.length);
    const unwired = CALL_SITES.filter((p) => !callers.has(p));
    expect(unwired).toEqual([]);
  });

  test('every caller imports the rule rather than redeclaring it', () => {
    const unimported = FILES
      .filter((f) => f.path !== SELF && /warehouseLabel\(/.test(f.raw))
      .filter((f) => !/from ['"][^'"]*\/warehouse-label['"]/.test(f.raw))
      .map((f) => f.path);
    expect(unimported).toEqual([]);
  });
});
