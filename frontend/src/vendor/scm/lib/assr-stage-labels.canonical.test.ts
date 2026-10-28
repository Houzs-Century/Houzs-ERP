/* The frontend half of the ASSR stage vocabulary.
 *
 * THE BUG. One stage — `voided` — had three different answers across five
 * hand-written copies of this table, and the copy a CUSTOMER reads
 * (backend caseTracking.ts `customerStatusFor`) had no answer at all and
 * rendered the raw database slug. On this side the shape was: the ordered
 * stepper `ASSR_STAGES` legitimately has no row for `voided` (it is a terminal
 * alt-outcome, not a funnel step) but it also owned the WORDS, so every surface
 * that needed a word for a non-step had to invent one. Mobile bolted a literal
 * on top of the stepper; the desktop Cases page spelled the same string in
 * three more places; MyCases and the supplier portal each kept a fourth and
 * fifth copy.
 *
 * Two questions had been fused into one table. They are separate now:
 * ASSR_STAGES answers ORDER, assr-stage-labels answers WORDS.
 *
 * ── WHY SOURCE-SLICE ASSERTIONS ────────────────────────────────────────────
 * Every copy in this story was written by someone who could not reach the layer
 * that already had the answer. The way it comes back is one screen quietly
 * retyping the string, which renders fine and errors nowhere. So these assert
 * against the SOURCE of each surface that it reaches the shared table and
 * spells no stage label itself. Same idiom as so-slip-optional-contract.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ASSR_STAGE_LABEL, assrStageLabel } from './assr-stage-labels';
import { ASSR_STAGES } from './assr/stages';

/** The BACKEND call sites are pinned by backend/tests/assrStageLabelOneHome.test.ts
 *  — the backend's own gate refereeing the backend's own surfaces. This file
 *  owns the frontend half plus the byte-identity of the pair. */
const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

/** Source with comments removed — a label named in a comment is not a copy of
 *  the rule, and `expect(source).not.toContain(...)` on a 2,000-line screen
 *  prints the whole file on failure, so these assertions compare booleans. */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

describe('the two copies of this module are the same file', () => {
  /* The pair of paths is what makes the EXISTING gate referee this rule:
     backend/scripts/check-shared-mirrors.mjs --strict enumerates
     backend/src/scm/shared and looks each basename up in frontend/src/vendor/
     shared and frontend/src/vendor/scm/lib. Landing the table at exactly these
     two paths bought a CI referee with no new script — which is also why this
     file must stay at the TOP LEVEL of vendor/scm/lib and not inside assr/:
     the backend enumeration is non-recursive and the lookup is by basename. */
  test('backend/src/scm/shared/assr-stage-labels.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/assr-stage-labels.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/assr-stage-labels.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('voided has a word on every frontend surface', () => {
  test('the shared table names it', () => {
    expect(assrStageLabel('voided')).toBe('Voided — Not Valid');
  });

  test('the ordered stepper still does NOT list it, and that is correct', () => {
    /* The stepper is the funnel. A voided case is not at step 8 of 8; it left
       the funnel. Losing this distinction is the obvious wrong way to "fix"
       the missing label, so it is pinned. */
    expect(ASSR_STAGES.map((s) => s.key)).not.toContain('voided');
  });
});

describe('ASSR_STAGES owns the ORDER, not the words', () => {
  test('every stepper row reads its long label from the shared table', () => {
    for (const s of ASSR_STAGES) {
      expect(s.long, `${s.key} carries a hand-typed long label`).toBe(
        ASSR_STAGE_LABEL[s.key],
      );
    }
  });

  test('the workflow order is unchanged (Solution before Verification)', () => {
    expect(ASSR_STAGES.map((s) => s.key)).toEqual([
      'pending_review',
      'pending_solution',
      'under_verification',
      'pending_supplier_pickup',
      'pending_item_ready',
      'pending_delivery_service',
      'completed',
    ]);
  });

  test('the words themselves are unchanged from what shipped', () => {
    expect(ASSR_STAGES.map((s) => s.long)).toEqual([
      'Pending Review',
      'Pending Solution',
      'Under Verification',
      'Pickup / Return',
      'Pending Item Ready',
      'Pending Delivery / Service',
      'Completed',
    ]);
  });

  test('stages.ts spells no stage label of its own any more', () => {
    const source = code('src/vendor/scm/lib/assr/stages.ts');
    expect(source).toContain('assr-stage-labels');
    for (const label of ['Pending Review', 'Under Verification', 'Pickup / Return']) {
      expect(source.includes(`"${label}"`), `stages.ts still spells "${label}"`).toBe(false);
    }
  });
});

/* ── Every screen still reaches the shared table ─────────────────────────────
   Five surfaces spelled "Voided — Not Valid" by hand. Remove any one of these
   wirings and the assertion names the file that went its own way. */
describe('no frontend surface has re-grown its own voided label', () => {
  /* `screen` is the surface a person looks at; `labelHome` is the file on that
     surface's side that must actually import the shared table.
     They are the same file for three of the four. On mobile they are not, and
     that is deliberate rather than a leak: `prettyStage` moved into
     `src/mobile/assr-case-fields.ts` when MobileServiceCase.tsx hit its size
     ceiling. The rule did not move surfaces — it moved one hop along the same
     one — so the IMPORT is asserted where the label is resolved, and the
     "spells no literal" assertion runs over BOTH files. Nothing was dropped:
     this describe block makes strictly more assertions than it used to. */
  const SITES: Array<{ name: string; screen: string; labelHome: string }> = [
    {
      name: 'MobileServiceCase (mobile detail + timeline)',
      screen: 'src/mobile/MobileServiceCase.tsx',
      labelHome: 'src/mobile/assr-case-fields.ts',
    },
    {
      name: 'ServiceCases (desktop filter, stage select, void banner)',
      screen: 'src/pages/ServiceCases.tsx',
      labelHome: 'src/pages/ServiceCases.tsx',
    },
    {
      name: 'MyCases (agent case pills)',
      screen: 'src/pages/MyCases.tsx',
      labelHome: 'src/pages/MyCases.tsx',
    },
    {
      name: 'PortalSupplierCase (supplier portal header)',
      screen: 'src/portal/pages/PortalSupplierCase.tsx',
      labelHome: 'src/portal/pages/PortalSupplierCase.tsx',
    },
  ];

  for (const { name, screen, labelHome } of SITES) {
    test(`${name} imports the shared table`, () => {
      expect(
        read(labelHome).includes('assr-stage-labels'),
        `${name} no longer imports assr-stage-labels (checked in ${labelHome})`,
      ).toBe(true);
    });

    test(`${name} reaches its label home`, () => {
      /* A hop is only legitimate while the screen still goes through it. If
         MobileServiceCase stopped importing assr-case-fields, the assertion
         above would be checking a file nobody reads. */
      if (labelHome === screen) return;
      /* The EXACT specifier, closing quote included. A bare `includes` of
         "./assr-case-fields" is satisfied by "./assr-case-fields-RENAMED",
         which is how this assertion first shipped unable to fail — the
         "a checker that cannot match reports a clean run" trap, caught by
         renaming the import and watching the test stay green. */
      const spec = labelHome.replace(/^src\/mobile\//, './').replace(/\.tsx?$/, '');
      expect(
        code(screen).includes(`from "${spec}"`) || code(screen).includes(`from '${spec}'`),
        `${name} no longer imports ${labelHome}, so its label wiring is unchecked`,
      ).toBe(true);
    });

    for (const path of new Set([screen, labelHome])) {
      test(`${name} does not spell "Voided — Not Valid" itself (${path})`, () => {
        expect(
          code(path).includes('Voided — Not Valid'),
          `${name} has re-grown a literal voided label`,
        ).toBe(false);
      });
    }
  }

  test('mobile builds its stage confirm text from the labels, not the stepper', () => {
    /* `STAGES[STAGE_INDEX[target]]?.long ?? target` asked "Move to voided?" —
       the same missing-row hole as the portal's, in the file that had already
       patched around it once. */
    const mobile = code('src/mobile/MobileServiceCase.tsx');
    expect(mobile).toContain('prettyStage(target)');
    expect(
      mobile.includes('STAGES[STAGE_INDEX[target]]'),
      'mobile builds the confirm label from the ordered stepper again',
    ).toBe(false);
  });
});

/* ── ITEM 3 — the desktop detail printed DIFFERENT WORDS for the same stage ──
   `DETAIL_STAGES` in ServiceCases.tsx was a SIXTH hand-written copy of this
   table, and four of its rows disagreed with the canonical one: "Review",
   "Solution", "Verification" and "Delivery / Service" against the shared
   "Pending Review", "Pending Solution", "Under Verification" and "Pending
   Delivery / Service". Same stage, two names, depending on which device the
   reader picked up — the phone reads `ASSR_STAGES[].long`, the desktop read
   this local literal. It is exactly the shape the top of this file describes:
   a screen that could not reach the layer holding the answer retyped it.

   Source-scan for the reason stated at the top: ServiceCases.tsx is an
   8,800-line page that cannot be imported without a router and a query client.

   `declarationOf` slices to the END OF THE STATEMENT, not to the first `;` —
   the first semicolon in `const DETAIL_STAGES: { id: AssrStage; short: …` sits
   INSIDE the type annotation, and a window that stops there reads six
   characters of a type and calls the table clean. That first draft of this
   test passed against the unfixed tree. */
const declarationOf = (source: string, name: string): string => {
  const at = source.indexOf(`const ${name}`);
  expect(at, `${name} disappeared from the source`).toBeGreaterThan(-1);
  // End of statement = the first `;` that CLOSES a bracket — past the
  // annotation's inner semicolons and past every row of the initialiser,
  // whether the table is an array literal (`];`) or a call (`);`).
  const rest = source.slice(at);
  const end = rest.search(/[\])]\s*;/);
  expect(end, `${name} initialiser has no recognisable end`).toBeGreaterThan(-1);
  return rest.slice(0, end + 2);
};

describe('the desktop detail table spells no stage word of its own', () => {
  const DESKTOP = 'src/pages/ServiceCases.tsx';

  test('DETAIL_STAGES is DERIVED from ASSR_STAGES, not retyped under it', () => {
    const decl = declarationOf(code(DESKTOP), 'DETAIL_STAGES');
    expect(decl, 'DETAIL_STAGES no longer reads the canonical table').toContain(
      'ASSR_STAGES',
    );
  });

  test('the declaration quotes no stage wording at all', () => {
    /* The canonical words plus the four SHORT forms the desktop table used as
       its `long` values (those are not values of the canonical map, so the
       first loop cannot catch them). Agreement by coincidence is still a
       second copy — the next edit is what breaks it. */
    const decl = declarationOf(code(DESKTOP), 'DETAIL_STAGES');
    const words = [
      ...Object.values(ASSR_STAGE_LABEL),
      'Review',
      'Solution',
      'Verification',
      'Delivery / Service',
    ];
    for (const word of words) {
      expect(
        decl.includes(`"${word}"`) || decl.includes(`'${word}'`),
        `DETAIL_STAGES has re-grown a hand-typed "${word}"`,
      ).toBe(false);
    }
  });
});

/* ── ITEM 2 — the stage OPTION SET forked by device ─────────────────────────
   The desktop "Change to" <select> mapped the UNFILTERED module-level
   DETAIL_STAGES while being handed a `stages` prop that had already been
   filtered through the shared `isStageActive` — it used that prop only for the
   "Step n / N" counter beside the very same dropdown. So an internal-resolution
   case counted 5 steps and offered 7, including the two supplier-only stages
   the shared rule exists to remove (`stages.ts:1-16`). Mobile reads
   `activeAssrStages(...)` and offers 5.

   The prop, not the module constant, is the one source. */
describe('the desktop stage picker offers the ACTIVE stages of the case', () => {
  test('the "Change to" select maps the filtered prop, never the module table', () => {
    const source = code('src/pages/ServiceCases.tsx');
    /* The page says "Change to" in three places (a hint line elsewhere on the
       detail among them). Take the one that OPENS A SELECT — a plain indexOf
       lands on the hint and then slices forward into the add-note form's
       audience dropdown, which contains neither identifier and would report
       whatever the last edit happened to leave there. */
    let at = -1;
    for (let i = source.indexOf('Change to'); i > -1; i = source.indexOf('Change to', i + 1)) {
      const next = source.indexOf('<select', i);
      if (next > -1 && next - i < 400) {
        at = i;
        break;
      }
    }
    expect(at, 'no "Change to" label opens a <select> any more').toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf('</select>', at));
    expect(
      block.includes('DETAIL_STAGES.map'),
      'the stage picker maps the UNFILTERED DETAIL_STAGES again — an internal-resolution case would offer the two supplier-only stages',
    ).toBe(false);
    expect(block, 'the stage picker no longer maps the filtered `stages` prop').toContain(
      'stages.map',
    );
  });
});
