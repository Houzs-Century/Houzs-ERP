import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ═══════════════════════════════════════════════════════════════════════════
   ONE RULE, ONE HOME — "may a sofa share an order with a bedframe or mattress?"

   The LOGIC is unit-tested in src/scm/lib/main-mix.test.ts. This file is about
   WIRING, because the logic was never the thing that broke. The rule was written
   five times, enforced at four of them, and the two that were missing were
   invisible: nothing errored, nothing logged, the document simply got built.
   That is the whole failure mode — a refusal that is absent looks exactly like a
   request that was allowed.

   So the population here is not "the call sites we happen to know about". It is
   every place in these two routers where a caller-supplied item code can land on
   a line — identified mechanically by the catalogue guard `validateItemCodes`,
   which by construction runs on exactly those paths (see the header of
   src/scm/lib/validate-item-codes.ts: "every line write ... POST
   header-with-items, POST add-line, PATCH change-line-code"). A unit that has
   the catalogue guard and NOT the composition rule fails here and must be
   argued, not assumed.
   ═══════════════════════════════════════════════════════════════════════════ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

/* Line endings normalised for the same reason soLocationGateWiring.test.ts
   normalises them: these are source-TEXT assertions, and a CRLF checkout on
   Windows made every multi-line anchor miss while CI stayed green on Linux. */
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const SO_ROUTER = 'scm/routes/mfg-sales-orders.ts';
const CO_ROUTER = 'scm/routes/consignment-orders.ts';
const HOME = 'scm/lib/main-mix.ts';

const soSource = read(SO_ROUTER);
const coSource = read(CO_ROUTER);

/** Every .ts source file under backend/src, tests excluded. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(abs);
    }
  };
  walk(SRC);
  return out;
}

/* A top-level unit: a route registration, a named function, or a named const.
   Verified against both routers — it resolves createSalesOrderCore,
   tbcSwapCommandHandler and tbcSwapSofaCommandHandler as their own units, which
   a "nearest preceding route registration" scan does not. */
const UNIT_ANCHOR =
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*[:=].*\(|^(\w+)\.(get|post|patch|put|delete)\(\s*'([^']*)'/;

type Unit = { name: string; start: number; end: number; body: string };

function unitsOf(source: string): Unit[] {
  const lines = source.split('\n');
  const heads: Array<{ name: string; start: number }> = [];
  lines.forEach((l, i) => {
    const m = UNIT_ANCHOR.exec(l);
    if (m) heads.push({ name: m[1] ?? m[2] ?? `${(m[4] ?? '').toUpperCase()} ${m[5] ?? ''}`.trim(), start: i + 1 });
  });
  return heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1]!.start - 1 : lines.length;
    return { name: h.name, start: h.start, end, body: lines.slice(h.start - 1, end).join('\n') };
  });
}

const REACHES_RULE = /\b(lineMixRefusal|createMixRefusal|amendmentMixRefusal)\s*\(/;
const CATALOGUE_GUARD = /\bvalidateItemCodes\s*\(/;

describe('the refusal has exactly one author', () => {
  test('the error CODE is spelled in main-mix.ts and nowhere else in the tree', () => {
    const owners = sourceFiles()
      .filter((abs) => fs.readFileSync(abs, 'utf8').includes('so_sofa_no_other_main'))
      .map((abs) => path.relative(SRC, abs).replace(/\\/g, '/'))
      .sort();
    /* A scan that matched nothing would "prove" one home while reading the
       wrong tree. */
    expect(owners.length, 'so_sofa_no_other_main is spelled NOWHERE — this test is reading the wrong tree')
      .toBeGreaterThan(0);
    expect(
      owners,
      'a call site that spells the refusal code itself has become a second home for the '
      + 'rule\'s WORDING, which is how three different sentences for one rule came about. '
      + 'Return sofaMixRefusal() from lib/main-mix.ts instead.',
    ).toEqual([HOME]);
  });

  test('the rule is defined once and imported everywhere else', () => {
    const definers = sourceFiles()
      .filter((abs) => /export\s+async\s+function\s+(lineMixRefusal|createMixRefusal|amendmentMixRefusal)\b/
        .test(fs.readFileSync(abs, 'utf8')))
      .map((abs) => path.relative(SRC, abs).replace(/\\/g, '/'));
    expect(definers.sort()).toEqual([HOME]);
  });
});

describe('every caller is accounted for', () => {
  /* Callers outside the two routers must be NAMED with the reason, exactly as
     soLocationGateWiring.test.ts does for enqueueSoCreate: a promise about the
     repository that is only checked inside one file is not a promise about the
     repository. */
  const KNOWN_OUTSIDE_ROUTERS: Record<string, string> = {};

  test('the callers are the two sales routers, or a recorded exception', () => {
    const files = sourceFiles();
    expect(files.length, `only ${files.length} source file(s) walked — the path is wrong, not the tree`)
      .toBeGreaterThan(200);

    const callers = files.filter((abs) => {
      const rel = path.relative(SRC, abs).replace(/\\/g, '/');
      if (rel === HOME) return false;                       // the definition is not a call site
      return fs.readFileSync(abs, 'utf8').split('\n')
        .some((l) => REACHES_RULE.test(l) && !/^\s*(import|export)\b/.test(l));
    }).map((abs) => path.relative(SRC, abs).replace(/\\/g, '/')).sort();

    expect(callers.length, 'nobody calls the rule at all — it has been unwired, not unified')
      .toBeGreaterThan(0);

    const unexpected = callers.filter((f) => f !== SO_ROUTER && f !== CO_ROUTER && !(f in KNOWN_OUTSIDE_ROUTERS));
    expect(
      unexpected,
      'these files enforce the sofa-mix rule from outside the two sales routers:\n  '
      + unexpected.join('\n  ')
      + '\nEither that is a new document type that needs its own entry here with the reason, '
      + 'or the rule has been copied somewhere it should be called from.',
    ).toEqual([]);

    const stale = Object.keys(KNOWN_OUTSIDE_ROUTERS).filter((f) => !callers.includes(f));
    expect(stale, `recorded exceptions that no longer call the rule — delete them:\n  ${stale.join('\n  ')}`)
      .toEqual([]);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   THE POPULATION TEST. This is the one that catches the class.
   ─────────────────────────────────────────────────────────────────────────── */
describe('every path that puts a caller-supplied item code on a line reaches the rule', () => {
  /* A unit that runs the catalogue guard and NOT the composition rule, with the
     mechanism that makes it safe. "It looked fine" is not a mechanism. */
  const EXEMPT: Record<string, string> = {
    [`${SO_ROUTER}::tbcSwapSofaCommandHandler`]:
      'The sofa-exchange path is SOFA -> SOFA by construction and cannot move a MAIN '
      + "category: it refuses `prev.item_group !== 'sofa'` with `sofa_swap_only` "
      + "(\"This exchange path only replaces sofa builds.\"), and refuses a replacement "
      + "whose catalogue category is not SOFA with `sofa_swap_only` again (\"The "
      + 'replacement must be a sofa."). Both refusals are in that handler; if either is '
      + 'ever relaxed, delete this entry and call lineMixRefusal instead.',
  };

  const cases: Array<[string, string]> = [[SO_ROUTER, soSource], [CO_ROUTER, coSource]];

  for (const [rel, source] of cases) {
    test(`${rel} — no unit has the catalogue guard without the composition rule`, () => {
      const units = unitsOf(source);
      expect(units.length, `${rel} sliced into ${units.length} units — the slicer is broken, not the file`)
        .toBeGreaterThan(10);

      const guarded = units.filter((u) => CATALOGUE_GUARD.test(u.body));
      /* If the catalogue guard vanished from a router, this test would pass over
         an empty set and say nothing. */
      expect(guarded.length, `${rel} runs validateItemCodes nowhere — the slicer or the router moved`)
        .toBeGreaterThan(0);

      const holes = guarded
        .filter((u) => !REACHES_RULE.test(u.body))
        .filter((u) => !(`${rel}::${u.name}` in EXEMPT))
        .map((u) => `${u.name} (line ${u.start})`);

      expect(
        holes,
        `these ${rel} units accept a caller-supplied item code (they run validateItemCodes) and `
        + 'NEVER ask whether it puts a sofa next to a bedframe or mattress:\n  '
        + holes.join('\n  ')
        + '\nCall lineMixRefusal / createMixRefusal / amendmentMixRefusal from '
        + `${HOME}, or add the unit to EXEMPT above with the mechanism that makes it safe.\n`
        + 'This exact gap — guard present on the insert paths, absent on an edit path — is '
        + 'what let a Consignment Order carry a sofa next to a bedframe.',
      ).toEqual([]);
    });
  }
});

describe('the individual call sites are still wired the way they were argued', () => {
  const unit = (source: string, name: string): Unit => {
    const u = unitsOf(source).find((x) => x.name === name);
    expect(u, `unit not found: ${name} — it was renamed or removed, not merely edited`).toBeTruthy();
    return u!;
  };

  test('SO create asks the FLAT question, the three SO line paths ask the DIFFERENTIAL one', () => {
    expect(unit(soSource, 'createSalesOrderCore').body).toContain('await createMixRefusal(sb, items, companyId)');
    for (const name of ['POST /:docNo/items', 'PATCH /:docNo/items/:itemId', 'tbcSwapCommandHandler']) {
      expect(unit(soSource, name).body, `${name} lost its differential guard`)
        .toContain("lineMixRefusal(sb, 'mfg_sales_order_items'");
    }
  });

  test('CO create asks the FLAT question, and BOTH CO line paths now ask the differential one', () => {
    expect(unit(coSource, 'POST /').body).toContain('await createMixRefusal(sb, items, activeCompanyId(c))');
    for (const name of ['POST /:docNo/items', 'PATCH /:docNo/items/:itemId']) {
      expect(unit(coSource, name).body, `${name} is the hole this change closed — it has reopened`)
        .toContain("lineMixRefusal(sb, 'consignment_sales_order_items'");
    }
  });

  test('the amendment submit path is gated, and gated at SUBMIT', () => {
    const u = unit(soSource, 'POST /:docNo/amendments');
    expect(u.body).toContain('amendmentMixRefusal(sb, docNo, mixLines, activeCompanyId(c))');
    /* Before the amendment rows are built and written — a refusal must leave
       nothing in the approval queue. */
    const gateAt = u.body.indexOf('amendmentMixRefusal(');
    const buildAt = u.body.indexOf('buildAmendmentLineRows(');
    expect(buildAt, 'the amendment rows are no longer built here — re-anchor this test').toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(buildAt);
  });

  test('each CO line guard runs BEFORE that handler writes anything', () => {
    const add = unit(coSource, 'POST /:docNo/items');
    expect(add.body.indexOf('lineMixRefusal(')).toBeLessThan(
      add.body.indexOf(".from('consignment_sales_order_items').insert("),
    );
    const edit = unit(coSource, 'PATCH /:docNo/items/:itemId');
    expect(edit.body.indexOf('lineMixRefusal(')).toBeLessThan(
      edit.body.indexOf(".from('consignment_sales_order_items').update("),
    );
  });

  test('the CO edit guard only fires when the caller actually changes the code', () => {
    /* An untouched line cannot introduce anything, and asking anyway would put
       a catalogue read on every qty / price edit. */
    const edit = unit(coSource, 'PATCH /:docNo/items/:itemId');
    expect(edit.body).toContain('if (it.itemCode !== undefined) {\n    const mainMix = await lineMixRefusal(');
  });

  test('no unit that enforces the rule hand-rolls the classifier for it', () => {
    /* Both create paths carried a private `normCat` that was byte-for-byte
       so-readiness.normCategory, plus their own MAIN set. The rule now imports
       both; a fresh local copy inside a unit that ALSO calls the rule is the
       second home growing back, one line at a time.

       Scoped to units that call the rule, deliberately. mfg-sales-orders.ts:1531
       and delivery-planning.ts:576 both declare a MAIN_CATS set for the SO list's
       REPRESENTATIVE-CATEGORY display, which is a different question with a
       different answer, and a tree-wide ban would fail on them and get this test
       deleted rather than the copies removed. */
    for (const [rel, source] of [[SO_ROUTER, soSource], [CO_ROUTER, coSource]] as const) {
      for (const u of unitsOf(source).filter((x) => REACHES_RULE.test(x.body))) {
        expect(u.body, `${rel}::${u.name} declares its own MAIN-category set beside the shared rule`)
          .not.toMatch(/new Set\(\[\s*'(?:SOFA|BEDFRAME|MATTRESS)'/);
        expect(u.body, `${rel}::${u.name} has grown a private category normaliser again`)
          .not.toMatch(/const\s+normCat\w*\s*=\s*\(/);
      }
    }
  });

  test('and neither router keeps a private normCat for this gate at all', () => {
    for (const [rel, source] of [[SO_ROUTER, soSource], [CO_ROUTER, coSource]] as const) {
      expect(source, `${rel} still declares \`const normCat\` — the mix gate's old private classifier`)
        .not.toMatch(/const\s+normCat\s*=/);
    }
  });

  test('grandfathering is still the shape of the rule', () => {
    /* The single most dangerous edit to main-mix.ts is dropping the `&& !`:
       every order written before the rule existed would become uneditable. */
    const home = read('scm/lib/main-mix.ts');
    const differential = home.match(/mixesSofaWithOtherMain\(after\) && !mixesSofaWithOtherMain\(before\)/g) ?? [];
    /* Two differential forms: lineMixRefusal and amendmentMixRefusal. The flat
       create form is deliberately not one of them. */
    expect(
      differential.length,
      'a differential form lost its `&& !mixesSofaWithOtherMain(before)`. Without it the gate '
      + 'refuses every edit to an order that ALREADY mixes — which is every order written '
      + 'before this rule existed. That is a worse bug than the one the rule prevents.',
    ).toBe(2);
  });
});
